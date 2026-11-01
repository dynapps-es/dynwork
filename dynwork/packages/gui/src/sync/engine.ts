export * as DynWorkSyncEngine from "./engine"

import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import { SpClient, type Catalog, type Manifest, type Profile } from "@dynwork/sp-client"
import type { DynWorkSyncClient } from "@dynwork/server-plugin/client"
import { DynWorkSync } from "@dynwork/server-plugin/contract"
import { DynWorkAccounts } from "../accounts/accounts"
import type { Counts, SyncError, SyncStatus } from "../accounts/contract"
import { DynWorkSyncMain } from "../accounts/sync"
import { DynWorkBundleFiles } from "./bundles"
import type { DynWorkRuntime } from "./runtime"

// The live sync (decision D4): one loop, for the active instance only, polls its signed manifest with the last ETag
// and pushes the verified content to DynWork's service only when it changed. The plugin replaces the instance's whole
// namespace on every `apply`, so main never sends partial changes; it only decides whether there is anything to send.
// Nothing here throws at a caller: every failure becomes a status.

/** The poll interval while a DynWork window has focus, varied by `jitter` either way. */
export const focusedInterval = 30_000
export const jitter = 0.2
/** The poll interval while no DynWork window has focus. */
export const unfocusedInterval = 300_000
/** The longest wait after an unreachable or rate-limiting instance. */
export const backoffCap = 300_000
/** How often the profile and the models catalog are read again. */
export const profileInterval = 1_800_000
/** The first wait after DynWork's own service did not answer; it may still be starting. */
export const serviceRetry = 2_000
/** The wait before following the plugin's events again after the stream ended. */
export const resubscribeAfter = 1_000

export type Plugin = Pick<ReturnType<typeof DynWorkSyncMain.make>, "apply" | "token" | "clear" | "listen">

export type Options = {
  accounts: DynWorkAccounts.Accounts
  plugin: Plugin
  /** Whether a DynWork window has focus at start; `focus` follows it. */
  focused: boolean
  /** Called after every change of `status()`. */
  changed: (status: SyncStatus) => void
  /** Delivers the skills' runtime files after an apply; without it they are not delivered. */
  runtime?: Pick<DynWorkRuntime.Runtime, "capture">
}

/** The bridge's tolerance for a manifest's `not_before` against the local clock. */
export const skewWindow = 5 * 60_000

/**
 * A manifest that verifies but must not be applied, as the systemprompt bridge refuses it: another user's, a
 * `manifest_version` that is not newer than the last applied one (`replay`) or does not parse (`version`), or a
 * `not_before` more than `skewWindow` from now (`skew`).
 */
export class Invalid extends Schema.TaggedError<Invalid>("DynWorkSyncEngine.Invalid")("Invalid", {
  reason: Schema.Literals(["user", "replay", "version", "skew"]),
}) {}

type Loop = {
  readonly id: string
  readonly account: { readonly label: string; readonly url: string }
  readonly instance: string
  readonly key: string
  readonly identity: string
  stopped: boolean
  timer?: ReturnType<typeof setTimeout>
  running: boolean
  again: boolean
  // The next poll asks the instance for a fresh build (`Cache-Control: no-cache`): only "Sync now" does
  fresh: boolean
  failures: number
  etag?: string
  manifest?: Manifest
  // The `manifest_version` of the newest manifest admitted and not yet applied
  version?: string
  gateway?: { profile?: Profile; catalog?: Catalog; at: number }
  // Digest of the content the plugin holds for this loop; undefined until an apply succeeds, and again when the
  // service may have lost it
  pushed?: string
  counts?: Counts
  // The last JWT the plugin got, so a renewal is pushed once
  sent?: string
  // The plugin bundle files fetched for this account, kept by digest across polls
  readonly bundles: ReturnType<typeof DynWorkBundleFiles.make>
  // Whether the skills' runtime files are all delivered for what the plugin holds: false until a capture says so
  captured: boolean
}

export function make(options: Options) {
  const accounts = options.accounts
  const plugin = options.plugin
  const life = { disposed: false, focused: options.focused, status: idle }
  const current: { loop?: Loop } = {}
  // The served key's fingerprint of an account whose sync stopped on a key change, until the user trusts that key
  const halted = new Map<string, string>()
  // The user of the last manifest admitted per account in this process
  const seen = new Map<string, string>()
  // Plugin calls run one at a time, so a clear never overtakes the apply before it
  const queue = { tail: Promise.resolve() }
  const listening = new AbortController()

  const serial = <A>(call: () => Promise<A>) => {
    const next = queue.tail.then(call)
    queue.tail = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  const set = (status: SyncStatus) => {
    life.status = status
    options.changed(status)
  }

  // What the engine should be syncing now: the active, signed-in account with a manifest key, unless halted.
  const target = () => {
    const id = accounts.active()
    const stored = id === undefined ? undefined : accounts.stored(id)
    const view = accounts.list().find((account) => account.id === id)
    const key = stored?.key ?? stored?.offeredKey
    if (stored === undefined || view?.status !== "signedIn" || key === undefined) return undefined
    const stop = halted.get(stored.id)
    if (stop !== undefined && (stored.key === undefined || SpClient.fingerprint(stored.key) !== stop))
      return { halted: true as const, id: stored.id }
    halted.delete(stored.id)
    return {
      halted: false as const,
      id: stored.id,
      account: { label: stored.label, url: stored.url },
      key,
      identity: [stored.id, stored.url, stored.label, key, stored.userId ?? ""].join("\n"),
    }
  }

  // Follows the accounts after each change: starts, keeps, swaps or stops the loop.
  const update = () => {
    if (life.disposed) return
    const next = target()
    const loop = current.loop
    if (next?.halted === false && loop?.identity === next.identity) return
    if (loop !== undefined) stop(loop, next?.id === loop.id)
    if (next === undefined) {
      if (life.status.status !== "idle") set(idle)
      return
    }
    if (next.halted) return
    const started: Loop = {
      id: next.id,
      account: next.account,
      instance: DynWorkSyncMain.key(next.account.label),
      key: next.key,
      identity: next.identity,
      stopped: false,
      running: false,
      again: false,
      fresh: false,
      failures: 0,
      captured: false,
      bundles: DynWorkBundleFiles.make(accounts),
    }
    current.loop = started
    request(started)
  }

  // A switch or sign-out takes the instance out of the service at once; the same account (a newly trusted key, a
  // renamed instance) keeps its content until the new loop applies again.
  const stop = (loop: Loop, same: boolean) => {
    loop.stopped = true
    clearTimeout(loop.timer)
    current.loop = undefined
    if (same || halted.has(loop.id)) return
    void serial(() => plugin.clear()).catch(() => undefined)
  }

  const request = (loop: Loop, fresh = false) => {
    if (loop.stopped) return
    loop.fresh ||= fresh
    if (loop.running) {
      loop.again = true
      return
    }
    clearTimeout(loop.timer)
    loop.running = true
    void cycle(loop)
      .catch(() => interval())
      .then((delay) => {
        loop.running = false
        if (loop.stopped) return
        if (loop.again) {
          loop.again = false
          return request(loop)
        }
        if (delay !== undefined) loop.timer = setTimeout(() => request(loop), delay)
      })
  }

  // One poll; resolves with the wait before the next, or undefined when the loop must wait for the user.
  const cycle = async (loop: Loop) => {
    if (!(life.status.status === "synced" && life.status.account === loop.id))
      set({ status: "syncing", account: loop.id })
    const failure = await attempt(loop).then(
      () => undefined,
      (error: unknown) => error,
    )
    if (loop.stopped) return undefined
    if (failure === undefined) {
      loop.failures = 0
      return interval()
    }
    loop.failures++
    const kind = classify(failure)
    // The served key is recorded first, so a window that reads this status finds the fingerprint to compare
    if (failure instanceof SpClient.KeyChanged) await halt(loop, failure)
    set({ status: "error", account: loop.id, kind, at: Date.now() })
    if (failure instanceof SpClient.KeyChanged) return undefined
    return retry(kind, loop.failures, failure instanceof SpClient.RateLimited ? failure.retryAfterMs : undefined)
  }

  const attempt = async (loop: Loop) => {
    const fresh = loop.fresh
    loop.fresh = false
    const result = await accounts.withJwt(loop.id, (token) =>
      Effect.runPromise(SpClient.manifest(loop.account.url, token, { key: loop.key, etag: loop.etag, fresh })),
    )
    if (loop.stopped) return
    if (result._tag === "Manifest") {
      admit(loop.id, result.manifest)
      loop.etag = result.etag
      loop.manifest = result.manifest
      loop.version = result.manifest.manifest_version
    }
    if (loop.gateway === undefined || Date.now() - loop.gateway.at >= profileInterval) await models(loop)
    const manifest = loop.manifest
    if (loop.stopped || manifest === undefined) return
    const digest = digestOf(manifest, loop.gateway)
    if (loop.pushed !== digest) {
      const session = await accounts.session(loop.id)
      const files = await loop.bundles.fetch({ id: loop.id, url: loop.account.url }, plugged(manifest))
      const counts = await serial(() =>
        loop.stopped
          ? Promise.resolve(undefined)
          : plugin.apply({
              account: loop.account,
              manifest,
              jwt: session.token,
              expiresAt: session.expiresAt,
              profile: loop.gateway?.profile,
              catalog: loop.gateway?.catalog,
              files,
            }),
      )
      if (loop.stopped || counts === undefined) return
      loop.pushed = digest
      loop.counts = counts
      loop.sent = session.token
      loop.captured = false
    }
    // Fully applied: the next manifest must be newer than this one
    if (loop.version !== undefined) accounts.applied(loop.id, loop.version)
    loop.version = undefined
    set({ status: "synced", account: loop.id, at: Date.now(), counts: loop.counts ?? empty })
    // After the status, so a slow instance never holds it; within the poll, so polls still never overlap. Its
    // failures are warnings: the next poll tries what is left.
    if (options.runtime === undefined || loop.captured) return
    const outcome = await options.runtime
      .capture({ id: loop.id, account: loop.account, manifest }, serial)
      .catch(() => undefined)
    loop.captured = outcome !== undefined && outcome.remaining === 0 && !outcome.undelivered
  }

  // The user's models: on activate and every `profileInterval`. A failure keeps what was read before.
  const models = async (loop: Loop) => {
    const read = <A>(call: (url: string, token: string) => Effect.Effect<A, SpClient.SpError>) =>
      accounts.withJwt(loop.id, (token) => Effect.runPromise(call(loop.account.url, token))).catch(() => undefined)
    const answers = await Promise.all([read(SpClient.profile), read(SpClient.models)])
    loop.gateway = {
      profile: answers[0] ?? loop.gateway?.profile,
      catalog: answers[1] ?? loop.gateway?.catalog,
      at: Date.now(),
    }
  }

  // The signature only says the instance issued it. It must also be this user's, within the clock skew and newer than
  // the last one fully applied. A 304 never gets here: the stored manifest was admitted when it came, and its
  // `not_before` is as old as that.
  const admit = (id: string, manifest: Manifest) => {
    const expected = accounts.stored(id)?.userId ?? seen.get(id)
    if (expected !== undefined && manifest.user_id !== expected) throw new Invalid({ reason: "user" })
    const incoming = parseVersion(manifest.manifest_version)
    const notBefore = manifest.not_before === undefined ? Number.NaN : Date.parse(manifest.not_before)
    if (incoming === undefined) throw new Invalid({ reason: "version" })
    if (!(Math.abs(notBefore - Date.now()) <= skewWindow)) throw new Invalid({ reason: "skew" })
    const last = parseVersion(accounts.stored(id)?.manifestVersion)
    if (last !== undefined && compareVersions(incoming, last) <= 0) throw new Invalid({ reason: "replay" })
    seen.set(id, manifest.user_id)
  }

  // Records the key the instance now serves for the user to compare, and stops until it is trusted.
  const halt = async (loop: Loop, error: SpClient.KeyChanged) => {
    halted.set(loop.id, error.served)
    const served = await Effect.runPromise(Effect.option(SpClient.publicKey(loop.account.url)))
    if (served._tag === "Some" && served.value.fingerprint === error.served && accounts.stored(loop.id) !== undefined)
      accounts.offerKey(loop.id, served.value.key)
    update()
  }

  const interval = () =>
    life.focused ? Math.round(focusedInterval * (1 + jitter * (2 * Math.random() - 1))) : unfocusedInterval

  const retry = (kind: SyncError, failures: number, after: number | undefined) => {
    if (kind === "unreachable" || kind === "rate-limited")
      return Math.min(backoffCap, Math.max(focusedInterval * 2 ** (failures - 1), after ?? 0))
    if (kind === "service") return Math.min(interval(), serviceRetry * 2 ** (failures - 1))
    return interval()
  }

  // Pushes a JWT the plugin has not had yet; a refusal means the service lost the instance, so it is applied again.
  const push = (loop: Loop, session: { token: string; expiresAt: number }) => {
    if (loop.stopped || loop.pushed === undefined || loop.sent === session.token) return
    loop.sent = session.token
    void serial(() => plugin.token({ account: loop.account, jwt: session.token, expiresAt: session.expiresAt }))
      .catch(() => false)
      .then((accepted) => {
        if (accepted || loop.stopped) return
        loop.pushed = undefined
        request(loop)
      })
  }

  const renewed = (id: string, session: { token: string; expiresAt: number }) => {
    const loop = current.loop
    if (loop?.id === id) push(loop, session)
  }

  // Handlers of the plugin's events must not throw: a throw ends the subscription without a word.
  const handlers: DynWorkSyncClient.Handlers = {
    refresh: (event) => {
      const loop = current.loop
      if (loop === undefined || event.instance !== loop.instance) return
      // A refused JWT is never handed out again: mint another one
      void accounts
        .session(loop.id, event.reason === "rejected")
        .then((session) => push(loop, session))
        .catch(() => undefined)
    },
    rejected: (event) => {
      const loop = current.loop
      if (loop === undefined || event.instance !== loop.instance) return
      void Promise.resolve()
        .then(() => accounts.signOut(loop.id))
        .catch(() => undefined)
    },
  }

  // Follows the plugin's events for the life of the engine. A stream that ends means the service stopped or
  // restarted and lost what it held, so the active instance is applied again.
  const follow = async () => {
    while (!life.disposed) {
      await plugin.listen(handlers, listening.signal).catch(() => undefined)
      if (life.disposed) return
      const loop = current.loop
      if (loop?.pushed !== undefined) {
        loop.pushed = undefined
        request(loop)
      }
      await new Promise((resolve) => setTimeout(resolve, resubscribeAfter))
    }
  }

  update()
  void follow()

  return {
    status: () => life.status,
    /** Re-reads the accounts; call it after every change of their state. */
    update,
    /** Pass to the accounts' `renewed` option. */
    renewed,
    /** Polls now ("Sync now"), asking the instance for a fresh build; every other poll may be answered from its memo. */
    now: () => {
      if (current.loop !== undefined) request(current.loop, true)
    },
    /** Whether a DynWork window has focus; gaining it polls at once. */
    focus: (focused: boolean) => {
      const was = life.focused
      life.focused = focused
      if (focused && !was && current.loop !== undefined) request(current.loop)
    },
    dispose: () => {
      life.disposed = true
      listening.abort()
      if (current.loop === undefined) return
      current.loop.stopped = true
      clearTimeout(current.loop.timer)
      current.loop = undefined
    },
  }
}

export type Engine = ReturnType<typeof make>

const idle: SyncStatus = { status: "idle" }
const empty: Counts = { skills: 0, agents: 0, mcp: 0, rules: 0 }

const plugged = Schema.decodeUnknownSync(DynWorkSync.Manifest)

// What the plugin would get, entry by entry: kind, id and a digest of the entry, sorted so that order alone is no
// change. The manifest's own metadata (`issued_at`, signature) is not part of it, so a re-signed catalog pushes nothing.
function digestOf(manifest: Manifest, gateway: Loop["gateway"]) {
  const content = plugged(manifest)
  const entries = [
    ...content.skills.map((entry) => ["skill", entry.id, entry] as const),
    ...content.agents.map((entry) => ["agent", entry.id, entry] as const),
    ...content.managed_mcp_servers.map((entry) => ["mcp", entry.id, entry] as const),
    ...content.rules.map((entry) => ["rule", entry.id, entry] as const),
    ...(content.marketplaces ?? []).map((entry) => ["marketplace", entry.id, entry] as const),
    ...(content.plugins ?? []).map((entry) => ["plugin", entry.id, entry] as const),
    ["hosts", "", content.enabled_hosts ?? null] as const,
    ["profile", "", gateway?.profile ?? null] as const,
    ["catalog", "", gateway?.catalog ?? null] as const,
  ]
    .map((entry) => `${entry[0]}:${entry[1]}:${hash(JSON.stringify(entry[2]))}`)
    .toSorted()
  return hash(entries.join("\n"))
}

// `<RFC3339>-<hex>`, at least 8 hex digits (`crates/shared/models/src/bridge/manifest_version.rs`). They order by
// timestamp, then by suffix.
const versionPattern = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))-([0-9a-fA-F]{8,})$/

function parseVersion(raw: string | undefined) {
  const found = raw === undefined ? null : versionPattern.exec(raw)
  if (found === null) return undefined
  const at = Date.parse(found[1] ?? "")
  return Number.isNaN(at) ? undefined : { at, suffix: found[2] ?? "" }
}

function compareVersions(
  a: NonNullable<ReturnType<typeof parseVersion>>,
  b: NonNullable<ReturnType<typeof parseVersion>>,
) {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1
  if (a.suffix === b.suffix) return 0
  return a.suffix < b.suffix ? -1 : 1
}

function hash(text: string) {
  return createHash("sha256").update(text).digest("hex")
}

// SAFETY: a rejection's reason is unknown by contract; this is the boundary that maps it, by `instanceof` only.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- see SAFETY above
function classify(error: unknown): SyncError {
  if (error instanceof SpClient.Unreachable) return "unreachable"
  if (error instanceof SpClient.RateLimited) return "rate-limited"
  if (error instanceof SpClient.Unauthorized || error instanceof DynWorkAccounts.NotSignedIn) return "refused"
  if (error instanceof SpClient.KeyChanged) return "key-changed"
  if (error instanceof DynWorkAccounts.SecureStorageUnavailable) return "insecure"
  if (
    error instanceof SpClient.SignatureInvalid ||
    error instanceof SpClient.Protocol ||
    error instanceof SpClient.Incompatible ||
    error instanceof Invalid
  )
    return "invalid"
  return "service"
}
