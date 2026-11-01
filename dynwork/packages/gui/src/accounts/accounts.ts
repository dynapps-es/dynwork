export * as DynWorkAccounts from "./accounts"

import { randomBytes, randomUUID } from "node:crypto"
import { Effect, Schema } from "effect"
import { SpClient, SpConsumer } from "@dynwork/sp-client"
import type { Account, Probe, SignIn, State } from "./contract"
import { Loopback } from "./loopback"

// Where secrets live: the PAT only as `safeStorage` ciphertext in the plugin's main storage, decrypted for the moment
// a JWT is minted; JWTs only in this module's memory. Neither ever reaches a window, a log or the OpenCode database.

// A receipt of skill runtime files on its way to the instance, as the bridge's outbox keeps it: `pending` until the
// instance acknowledges it, retried from `next` (epoch ms); `conflict` and `rejected` are never retried.
export const Receipt = Schema.Struct({
  receipt: SpConsumer.Receipt,
  state: Schema.Literals(["pending", "acknowledged", "conflict", "rejected"]),
  attempts: Schema.Number,
  next: Schema.Number,
})
export type Receipt = typeof Receipt.Type

// The device this install enrolled for the account's user (`POST /v1/bridge/device`). Its credential is sealed like the
// PAT; `installation` names this install in its receipts.
export const Device = Schema.Struct({
  id: Schema.String,
  consumer: Schema.String,
  installation: Schema.String,
  cipher: Schema.String,
  receipts: Schema.Array(Receipt),
})
export type Device = typeof Device.Type

export const Stored = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  label: Schema.String,
  user: Schema.optional(Schema.String),
  // The instance's id of the signed-in user (`whoami`): a manifest for anyone else is refused
  userId: Schema.optional(Schema.String),
  org: Schema.optional(Schema.String),
  // base64 of `safeStorage.encryptString(pat)`; absent while signed out
  patCipher: Schema.optional(Schema.String),
  // The manifest key the user trusted (base64 ed25519) and its fingerprint
  key: Schema.optional(Schema.String),
  keyFingerprint: Schema.optional(Schema.String),
  // A served key that differs from the trusted one, waiting for `trust`; kept across restarts
  offeredKey: Schema.optional(Schema.String),
  // The `manifest_version` of the last manifest the sync fully applied for this instance: the next one must be newer
  manifestVersion: Schema.optional(Schema.String),
  device: Schema.optional(Device),
  addedAt: Schema.Number,
})
export type Stored = typeof Stored.Type

export const Store = Schema.Struct({
  accounts: Schema.Array(Stored),
  active: Schema.optional(Schema.String),
  // This install's durable id, from which the device fingerprint of each user is derived
  install: Schema.optional(Schema.String),
})
export type Store = typeof Store.Type

export const initial: Store = { accounts: [] }

// Electron's `safeStorage`, as far as accounts need it.
export type SecureStorage = {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(cipher: Buffer): string
}

export type Options = {
  store: { readonly value: Store; set(value: Store): void }
  secure: SecureStorage
  // Opens the device-link page in the system browser
  open: (url: string) => Promise<void>
  // Names the PAT in the user's token list on the instance
  deviceName: string
  // Called after every change of `state()`
  changed: () => void
  // Called with every JWT minted for an account: at sign-in, at each renewal and at each forced re-mint
  renewed?: (id: string, session: { token: string; expiresAt: number }) => void
}

// The account has no PAT: never signed in, signed out or removed.
export class NotSignedIn extends Schema.TaggedError<NotSignedIn>("DynWorkAccounts.NotSignedIn")("NotSignedIn", {
  id: Schema.String,
}) {}

// The OS offers no encryption (`safeStorage.isEncryptionAvailable()` is false), so no PAT is accepted; or the stored
// PAT does not decrypt right now (a locked keyring, a denied Keychain prompt). The ciphertext is kept for a later try.
export class SecureStorageUnavailable extends Schema.TaggedError<SecureStorageUnavailable>(
  "DynWorkAccounts.SecureStorageUnavailable",
)("SecureStorageUnavailable", {}) {}

// No served manifest key with the fingerprint the user compared is waiting for `trust`.
export class NothingToTrust extends Schema.TaggedError<NothingToTrust>("DynWorkAccounts.NothingToTrust")(
  "NothingToTrust",
  { id: Schema.String },
) {}

// A JWT is renewed once 80 % of its lifetime has passed.
export const renewAt = 0.8
// Browser sign-in gives up after the one-time code's own lifetime.
export const browserTimeout = 600_000
// A failed renewal is tried again after this long, while the JWT still holds.
export const retryAfter = 30_000

type Session = SpClient.Session & { cipher: string; timer?: ReturnType<typeof setTimeout> }

export function make(options: Options) {
  const sessions = new Map<string, Session>()
  // Ciphertext of the PAT of an account signed in without "keep me signed in": sealed like the stored ones, but kept
  // only for this process, so it never reaches the store and the account is signed out on the next launch.
  const volatile = new Map<string, string>()
  const minting = new Map<string, Promise<Session>>()
  const browser: { url?: string; cancel?: () => void } = {}
  // After dispose, nothing in flight may arm a timer or open a browser
  const life = { disposed: false }

  const read = () => options.store.value
  const write = (next: Store) => {
    options.store.set(next)
    options.changed()
  }
  const find = (id: string) => read().accounts.find((account) => account.id === id)
  const cipherOf = (account: Stored | undefined) =>
    account === undefined ? undefined : (account.patCipher ?? volatile.get(account.id))

  const view = (account: Stored): Account => {
    const pending = account.offeredKey
    return {
      id: account.id,
      label: account.label,
      url: account.url,
      user: account.user,
      org: account.org,
      status: cipherOf(account) === undefined ? "signedOut" : "signedIn",
      active: read().active === account.id,
      fingerprint: pending === undefined ? account.keyFingerprint : SpClient.fingerprint(pending),
      pinned: account.keyFingerprint,
      trusted: pending === undefined && account.keyFingerprint !== undefined,
    }
  }

  const list = () => read().accounts.map(view)
  const state = (): Omit<State, "sync"> => ({ accounts: list(), signingIn: browser.url })

  const drop = (id: string) => {
    clearTimeout(sessions.get(id)?.timer)
    sessions.delete(id)
    minting.delete(id)
  }

  const forget = (id: string) => {
    drop(id)
    volatile.delete(id)
  }

  // The next active account when `id` leaves: the first other signed-in one, else none.
  const successor = (store: Store, id: string) =>
    store.active !== id
      ? store.active
      : store.accounts.find((account) => account.id !== id && cipherOf(account) !== undefined)?.id

  const signOut = (id: string) => {
    forget(id)
    const store = read()
    write({
      active: successor(store, id),
      accounts: store.accounts.map((account) =>
        account.id === id ? { ...account, patCipher: undefined, device: undefined } : account,
      ),
    })
  }

  const remove = (id: string) => {
    forget(id)
    const store = read()
    write({ active: successor(store, id), accounts: store.accounts.filter((account) => account.id !== id) })
  }

  const schedule = (id: string, session: Session) => {
    if (life.disposed) return
    // Timers overflow past 2^31 - 1 ms (about 24.8 days) and would fire at once: renew at least that often.
    session.timer = setTimeout(() => void renew(id), Math.min(session.ttl * 1000 * renewAt, 2 ** 31 - 1))
    sessions.set(id, session)
  }

  // Renewal in the background: a refused PAT signs the account out, any other failure tries again while the JWT holds.
  const renew = (id: string) =>
    mint(id).catch((error) => {
      const session = sessions.get(id)
      if (error instanceof NotSignedIn || session === undefined) return
      const left = session.expiresAt - Date.now()
      if (left <= 0) return drop(id)
      session.timer = setTimeout(() => void renew(id), Math.min(retryAfter, left))
    })

  // Mints a JWT from the stored PAT. Concurrent callers share one request; an `Unauthorized` means the PAT is dead.
  const mint = (id: string) => {
    const running = minting.get(id)
    if (running) return running
    const next = mintOnce(id).finally(() => {
      if (minting.get(id) === next) minting.delete(id)
    })
    minting.set(id, next)
    return next
  }

  const mintOnce = async (id: string) => {
    const account = find(id)
    const cipher = cipherOf(account)
    if (account === undefined || cipher === undefined) throw new NotSignedIn({ id })
    const pat = decrypt(options.secure, cipher)
    // The OS may open it later (a locked keyring, a denied prompt): keep the ciphertext, only the instance can sign out
    if (pat === undefined) throw new SecureStorageUnavailable()
    const session = await Effect.runPromise(
      SpClient.mintJwt(account.url, pat, { sessionId: sessions.get(id)?.sessionId }),
    ).catch((error) => {
      if (error instanceof SpClient.Unauthorized && cipherOf(find(id)) === cipher) signOut(id)
      throw error
    })
    // Signed out, removed or signed in again while the request ran: this JWT belongs to nobody.
    if (cipherOf(find(id)) !== cipher) throw new NotSignedIn({ id })
    clearTimeout(sessions.get(id)?.timer)
    const live = { ...session, cipher }
    schedule(id, live)
    options.renewed?.(id, live)
    return live
  }

  // The account's JWT and its expiry, minted on demand; `fresh` mints a new one even while the held one is valid (the
  // gateway refused it). For main code only (gateway, sync); never sent to a window.
  const session = async (id: string, fresh = false) => {
    const held = sessions.get(id)
    if (!fresh && held !== undefined && held.cipher === cipherOf(find(id)) && held.expiresAt - 60_000 > Date.now())
      return { token: held.token, expiresAt: held.expiresAt }
    const minted = await mint(id)
    return { token: minted.token, expiresAt: minted.expiresAt }
  }

  const jwt = async (id: string) => (await session(id)).token

  // Runs `use` with the account's JWT. When the instance refuses it, mints once more and retries once; a PAT the
  // instance refuses signs the account out.
  const withJwt = async <A>(id: string, use: (token: string) => Promise<A>) => {
    const token = await jwt(id)
    return use(token).catch(async (error) => {
      if (!(error instanceof SpClient.Unauthorized)) throw error
      if (sessions.get(id)?.token === token) drop(id)
      return use(await jwt(id))
    })
  }

  // The PAT is good: it mints, so it is stored and the account is signed in.
  const complete = async (instance: SpClient.Instance, pat: string, keep: boolean) => {
    const session = await Effect.runPromise(SpClient.mintJwt(instance.baseUrl, pat))
    const details = await Promise.all([
      optional(SpClient.whoami(instance.baseUrl, session.token)),
      optional(SpClient.profile(instance.baseUrl, session.token)),
      optional(SpClient.publicKey(instance.baseUrl)),
    ])
    const cipher = options.secure.encryptString(pat).toString("base64")
    const store = read()
    const known = store.accounts.find((account) => account.url === instance.baseUrl)
    const id = known?.id ?? randomUUID()
    const account: Stored = {
      ...(known ?? { id, url: instance.baseUrl, addedAt: Date.now() }),
      label: label(instance),
      user: details[0]?.email ?? details[0]?.display_name ?? known?.user,
      userId: details[0]?.user_id ?? known?.userId,
      org: details[1]?.organization_uuid ?? known?.org,
      patCipher: keep ? cipher : undefined,
      ...(details[2] === undefined ? {} : { offeredKey: details[2].key === known?.key ? undefined : details[2].key }),
    }
    drop(id)
    if (keep) volatile.delete(id)
    else volatile.set(id, cipher)
    schedule(id, { ...session, cipher })
    options.renewed?.(id, session)
    write({
      active: store.active ?? id,
      accounts: known
        ? store.accounts.map((entry) => (entry.id === id ? account : entry))
        : [...store.accounts, account],
    })
    return "signed-in" as const
  }

  const requireSecureStorage = () => {
    if (!options.secure.isEncryptionAvailable()) throw new SecureStorageUnavailable()
  }

  const signInToken = async (input: { url: string; token: string; keep?: boolean }) => {
    requireSecureStorage()
    const instance = await Effect.runPromise(SpClient.discover(input.url))
    const token = input.token.trim()
    if (!SpClient.isCode(token)) return complete(instance, token, input.keep !== false)
    return complete(
      instance,
      await Effect.runPromise(SpClient.exchangeCode(instance.baseUrl, token, options.deviceName)),
      input.keep !== false,
    )
  }

  // `signal` is the calling window's: closing it, or a second sign-in, or `cancel`, ends this one at any step.
  const signInBrowser = async (url: string, signal?: AbortSignal, keep = true): Promise<SignIn> => {
    requireSecureStorage()
    browser.cancel?.()
    const attempt = { cancelled: false, stop: () => {} }
    const cancel = () => {
      attempt.cancelled = true
      attempt.stop()
    }
    browser.cancel = cancel
    signal?.addEventListener("abort", cancel, { once: true })
    const outcome = await browserAnswer(url, attempt).finally(() => {
      attempt.stop()
      signal?.removeEventListener("abort", cancel)
      if (browser.cancel !== cancel) return
      browser.url = undefined
      browser.cancel = undefined
      options.changed()
    })
    if (outcome._tag === "Cancelled") return "cancelled"
    if (outcome._tag === "Expired") return "expired"
    if (outcome.answer._tag === "Denied") return "denied"
    return complete(
      outcome.instance,
      await Effect.runPromise(SpClient.exchangeCode(outcome.instance.baseUrl, outcome.answer.code, options.deviceName)),
      keep,
    )
  }

  const browserAnswer = async (url: string, attempt: { cancelled: boolean; stop: () => void }) => {
    const instance = await Effect.runPromise(SpClient.discover(url))
    if (attempt.cancelled || life.disposed) return { _tag: "Cancelled" as const }
    const state = randomBytes(32).toString("base64url")
    const listener = await Loopback.listen({
      parse: (callback) => SpClient.parseCallback(callback, state),
      timeout: browserTimeout,
    })
    attempt.stop = listener.cancel
    if (attempt.cancelled || life.disposed) {
      listener.cancel()
      return { _tag: "Cancelled" as const }
    }
    browser.url = instance.baseUrl
    options.changed()
    await options.open(SpClient.deviceLinkUrl(instance, listener.redirect, state))
    const outcome = await listener.outcome
    if (outcome._tag !== "Answer") return outcome
    return { ...outcome, instance }
  }

  const probe = async (url: string): Promise<Probe> => {
    const result = await Effect.runPromise(Effect.result(SpClient.discover(url)))
    if (result._tag === "Failure") return { reachable: false, reason: result.failure._tag }
    return {
      reachable: true,
      url: result.success.baseUrl,
      host: new URL(result.success.baseUrl).host,
      label: label(result.success),
      version: result.success.version,
      modes: result.success.modes,
      deviceLink: new URL(result.success.deviceLinkPath, result.success.baseUrl).href,
    }
  }

  const add = async (url: string) => {
    const instance = await Effect.runPromise(SpClient.discover(url))
    const store = read()
    const known = store.accounts.find((account) => account.url === instance.baseUrl)
    if (known) return view(known)
    const account: Stored = {
      id: randomUUID(),
      url: instance.baseUrl,
      label: label(instance),
      addedAt: Date.now(),
    }
    write({ ...store, accounts: [...store.accounts, account] })
    return view(account)
  }

  const activate = (id: string) => {
    if (cipherOf(find(id)) === undefined) throw new NotSignedIn({ id })
    write({ ...read(), active: id })
  }

  // Pins the offered key only if it is the one whose fingerprint the user compared: a key offered in between waits.
  const trust = (input: { id: string; fingerprint: string }) => {
    const key = find(input.id)?.offeredKey
    if (key === undefined || SpClient.fingerprint(key) !== input.fingerprint) throw new NothingToTrust({ id: input.id })
    write({
      ...read(),
      accounts: read().accounts.map((account) =>
        account.id === input.id
          ? { ...account, key, keyFingerprint: input.fingerprint, offeredKey: undefined }
          : account,
      ),
    })
  }

  // Records a manifest key the instance now serves (first use, or a rotation the sync engine saw). It waits for
  // `trust` before the account reads as trusted.
  const offerKey = (id: string, key: string) => {
    write({
      ...read(),
      accounts: read().accounts.map((account) =>
        account.id === id ? { ...account, offeredKey: account.key === key ? undefined : key } : account,
      ),
    })
  }

  // Records the newest manifest the sync fully applied. It is no part of what a window shows, so it is saved without
  // announcing a change.
  const applied = (id: string, version: string) => {
    const store = read()
    options.store.set({
      ...store,
      accounts: store.accounts.map((account) =>
        account.id === id ? { ...account, manifestVersion: version } : account,
      ),
    })
  }

  // Saves a change to one account's device that no window shows, without announcing it.
  const saveDevice = (id: string, device: Device | undefined, install = read().install) => {
    const store = read()
    options.store.set({
      ...store,
      install,
      accounts: store.accounts.map((account) => (account.id === id ? { ...account, device } : account)),
    })
  }

  // The device credential of the account's `userId`, enrolling this install first when it holds none for that user,
  // like the bridge's self-enrolment. For main code only (skill runtime files); never sent to a window.
  const device = async (id: string, userId: string) => {
    const account = find(id)
    const held = account?.device
    if (account === undefined || cipherOf(account) === undefined) throw new NotSignedIn({ id })
    if (held !== undefined && held.consumer === userId) {
      const credential = decrypt(options.secure, held.cipher)
      if (credential === undefined) throw new SecureStorageUnavailable()
      return { ...held, credential }
    }
    requireSecureStorage()
    const install = read().install ?? randomUUID()
    const enrolment = await withJwt(id, (token) =>
      Effect.runPromise(
        SpConsumer.enrol(account.url, token, {
          fingerprint: SpConsumer.fingerprint(install, userId),
          label: options.deviceName,
        }),
      ),
    )
    if (cipherOf(find(id)) === undefined) throw new NotSignedIn({ id })
    if (enrolment.consumer_id !== userId)
      throw new SpClient.Protocol({
        endpoint: "POST /v1/bridge/device",
        message: "the device was enrolled for another user",
      })
    // Enrolled again as the same device: its installation and receipts carry on
    const same = held?.id === enrolment.device_id && held.consumer === enrolment.consumer_id
    const next: Device = {
      id: enrolment.device_id,
      consumer: enrolment.consumer_id,
      installation: same ? held.installation : randomUUID(),
      cipher: options.secure.encryptString(enrolment.credential).toString("base64"),
      receipts: same ? held.receipts : [],
    }
    saveDevice(id, next, install)
    return { ...next, credential: enrolment.credential }
  }

  // The instance refused the device credential: the next capture enrols again.
  const forgetDevice = (id: string) => saveDevice(id, undefined)

  // Records the receipts outbox of the account's device.
  const receipts = (id: string, entries: ReadonlyArray<Receipt>) => {
    const held = find(id)?.device
    if (held !== undefined) saveDevice(id, { ...held, receipts: entries })
  }

  // What the first manifest holds, for the sign-in screen's instance list. The signature is checked against the key
  // the account pinned, else the one it was offered, so the counts only describe the catalog the instance served.
  const summary = async (id: string) => {
    const account = find(id)
    const key = account?.key ?? account?.offeredKey
    if (account === undefined || key === undefined) throw new NotSignedIn({ id })
    const result = await withJwt(id, (token) =>
      Effect.runPromise(SpClient.manifest(account.url, token, { key, fresh: true })),
    )
    if (result._tag !== "Manifest") throw new NotSignedIn({ id })
    return {
      skills: result.manifest.skills.length,
      agents: result.manifest.agents.length,
      servers: result.manifest.managed_mcp_servers.length,
      role: result.manifest.user?.roles?.[0],
    }
  }

  const dispose = () => {
    life.disposed = true
    browser.cancel?.()
    ;[...sessions.keys()].forEach(drop)
    volatile.clear()
  }

  return {
    state,
    list,
    add,
    probe,
    signInBrowser,
    signInToken,
    cancel: () => browser.cancel?.(),
    activate,
    signOut,
    remove,
    trust,
    offerKey,
    applied,
    device,
    forgetDevice,
    receipts,
    summary,
    active: () => read().active,
    // The stored entry, for main code (the sync engine reads the pinned key and the user id)
    stored: find,
    jwt,
    session,
    withJwt,
    dispose,
  }
}

export type Accounts = ReturnType<typeof make>

// The instance's display name, else its host.
function label(instance: SpClient.Instance) {
  return instance.displayName ?? new URL(instance.baseUrl).host
}

// Details shown next to the account; the sign-in does not depend on them.
function optional<A, E>(effect: Effect.Effect<A, E>) {
  return Effect.runPromise(Effect.orElseSucceed(effect, () => undefined))
}

function decrypt(secure: SecureStorage, cipher: string) {
  try {
    return secure.decryptString(Buffer.from(cipher, "base64"))
  } catch {
    return undefined
  }
}
