export * as DynWorkAccounts from "./accounts"

import { randomBytes, randomUUID } from "node:crypto"
import { Effect, Schema } from "effect"
import { SpClient } from "@dynwork/sp-client"
import type { Account, Probe, SignIn, State } from "./contract"
import { Loopback } from "./loopback"

// Where secrets live: the PAT only as `safeStorage` ciphertext in the plugin's main storage, decrypted for the moment
// a JWT is minted; JWTs only in this module's memory. Neither ever reaches a window, a log or the OpenCode database.

export const Stored = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  label: Schema.String,
  user: Schema.optional(Schema.String),
  org: Schema.optional(Schema.String),
  // base64 of `safeStorage.encryptString(pat)`; absent while signed out
  patCipher: Schema.optional(Schema.String),
  // The manifest key the user trusted (base64 ed25519) and its fingerprint
  key: Schema.optional(Schema.String),
  keyFingerprint: Schema.optional(Schema.String),
  // A served key that differs from the trusted one, waiting for `trust`; kept across restarts
  offeredKey: Schema.optional(Schema.String),
  addedAt: Schema.Number,
})
export type Stored = typeof Stored.Type

export const Store = Schema.Struct({
  accounts: Schema.Array(Stored),
  active: Schema.optional(Schema.String),
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

  const view = (account: Stored): Account => {
    const pending = account.offeredKey
    return {
      id: account.id,
      label: account.label,
      url: account.url,
      user: account.user,
      org: account.org,
      status: account.patCipher === undefined ? "signedOut" : "signedIn",
      active: read().active === account.id,
      fingerprint: pending === undefined ? account.keyFingerprint : SpClient.fingerprint(pending),
      trusted: pending === undefined && account.keyFingerprint !== undefined,
    }
  }

  const list = () => read().accounts.map(view)
  const state = (): State => ({ accounts: list(), signingIn: browser.url })

  const drop = (id: string) => {
    clearTimeout(sessions.get(id)?.timer)
    sessions.delete(id)
    minting.delete(id)
  }

  // The next active account when `id` leaves: the first other signed-in one, else none.
  const successor = (store: Store, id: string) =>
    store.active !== id
      ? store.active
      : store.accounts.find((account) => account.id !== id && account.patCipher !== undefined)?.id

  const signOut = (id: string) => {
    drop(id)
    const store = read()
    write({
      active: successor(store, id),
      accounts: store.accounts.map((account) => (account.id === id ? { ...account, patCipher: undefined } : account)),
    })
  }

  const remove = (id: string) => {
    drop(id)
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
    const cipher = account?.patCipher
    if (account === undefined || cipher === undefined) throw new NotSignedIn({ id })
    const pat = decrypt(options.secure, cipher)
    // The OS may open it later (a locked keyring, a denied prompt): keep the ciphertext, only the instance can sign out
    if (pat === undefined) throw new SecureStorageUnavailable()
    const session = await Effect.runPromise(
      SpClient.mintJwt(account.url, pat, { sessionId: sessions.get(id)?.sessionId }),
    ).catch((error) => {
      if (error instanceof SpClient.Unauthorized && find(id)?.patCipher === cipher) signOut(id)
      throw error
    })
    // Signed out, removed or signed in again while the request ran: this JWT belongs to nobody.
    if (find(id)?.patCipher !== cipher) throw new NotSignedIn({ id })
    clearTimeout(sessions.get(id)?.timer)
    const live = { ...session, cipher }
    schedule(id, live)
    return live
  }

  // A JWT for the account, minted on demand. For main code only (gateway, sync); never sent to a window.
  const jwt = async (id: string) => {
    const session = sessions.get(id)
    if (session !== undefined && session.cipher === find(id)?.patCipher && session.expiresAt - 60_000 > Date.now())
      return session.token
    return (await mint(id)).token
  }

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
  const complete = async (instance: SpClient.Instance, pat: string) => {
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
      org: details[1]?.organization_uuid ?? known?.org,
      patCipher: cipher,
      ...(details[2] === undefined ? {} : { offeredKey: details[2].key === known?.key ? undefined : details[2].key }),
    }
    drop(id)
    schedule(id, { ...session, cipher })
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

  const signInToken = async (input: { url: string; token: string }) => {
    requireSecureStorage()
    const instance = await Effect.runPromise(SpClient.discover(input.url))
    const token = input.token.trim()
    if (!SpClient.isCode(token)) return complete(instance, token)
    return complete(
      instance,
      await Effect.runPromise(SpClient.exchangeCode(instance.baseUrl, token, options.deviceName)),
    )
  }

  // `signal` is the calling window's: closing it, or a second sign-in, or `cancel`, ends this one at any step.
  const signInBrowser = async (url: string, signal?: AbortSignal): Promise<SignIn> => {
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
    if (find(id)?.patCipher === undefined) throw new NotSignedIn({ id })
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

  const dispose = () => {
    life.disposed = true
    browser.cancel?.()
    ;[...sessions.keys()].forEach(drop)
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
    active: () => read().active,
    jwt,
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
