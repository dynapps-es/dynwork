export * as DynWorkPerson from "./person"

import { Effect, Schema } from "effect"
import { SpClient, SpPerson } from "@dynwork/sp-client"
import { DynWorkAccounts } from "./accounts"
import type { Person, PersonSignIn } from "./contract"
import { Loopback } from "./loopback"

// DynWork acting as the person in the Drive: the person's own UI session (0.84), one per account, kept by main. The
// refresh token lives only as `safeStorage` ciphertext in this module's store, decrypted for the moment it is spent; the
// access token only in this module's memory. Neither reaches a window, the plugin, the harness or a log, and only main
// calls the instance with them (`withPerson`).

export const Saved = Schema.Struct({
  // By account id
  sessions: Schema.Record(
    Schema.String,
    Schema.Struct({
      // base64 of `safeStorage.encryptString(refreshToken)`, replaced at every refresh
      cipher: Schema.String,
      // The person the session acts as (the token's `sub`), which must stay the account's user
      user: Schema.String,
      // The sign-in, epoch ms: the session ends `SpPerson.lifetime` after it
      signedInAt: Schema.Number,
    }),
  ),
})
export type Saved = typeof Saved.Type

export const initial: Saved = { sessions: {} }

export type Options = {
  accounts: Pick<DynWorkAccounts.Accounts, "list" | "stored" | "withJwt">
  store: { readonly value: Saved; set(value: Saved): void }
  secure: DynWorkAccounts.SecureStorage
  // Opens the instance's sign-in page in the system browser
  open: (url: string) => Promise<void>
  // Called after every change of what `status` answers
  changed: () => void
  // Main's log. It only ever gets the account id and what happened, never a credential.
  log?: (message: string, data: { account: string; reason: string }) => void
}

// The account has no live person session: never signed in, signed out, or past its 12 hours.
export class SignedOut extends Schema.TaggedError<SignedOut>("DynWorkPerson.SignedOut")("SignedOut", {
  id: Schema.String,
}) {}

// The action wanted a recent sign-in and the person's browser sign-in did not end signed in: nothing was done.
export class SignInFailed extends Schema.TaggedError<SignInFailed>("DynWorkPerson.SignInFailed")("SignInFailed", {
  id: Schema.String,
  outcome: Schema.String,
}) {}

// The access token is refreshed once this share of its lifetime has passed.
export const renewAt = 0.8
// A refresh that found no answer is tried again after this long, while the session lasts.
export const retryAfter = 30_000
// The held access token is spent only while it lasts this long more.
export const margin = 30_000
// The browser sign-in gives up after this long.
export const browserTimeout = 600_000

type Live = { token?: string; expiresAt?: number; timer?: ReturnType<typeof setTimeout> }

export function make(options: Options) {
  const live = new Map<string, Live>()
  const renewing = new Map<string, Promise<string>>()
  // Whether each account's instance declares DynWork's client, once asked
  const declared = new Map<string, boolean>()
  const probing = new Map<string, Promise<boolean | undefined>>()
  // Accounts whose session ran its 12 hours, until the next sign-in or sign-out
  const ended = new Set<string>()
  const browser: { id?: string; cancel?: () => void } = {}
  const life = { disposed: false }

  const saved = (id: string) => options.store.value.sessions[id]
  const save = (id: string, session: Saved["sessions"][string] | undefined) => {
    const sessions = { ...options.store.value.sessions }
    if (session === undefined) delete sessions[id]
    else sessions[id] = session
    options.store.set({ sessions })
  }
  const account = (id: string) => options.accounts.list().find((entry) => entry.id === id)
  const until = (id: string) => {
    const session = saved(id)
    return session === undefined ? undefined : session.signedInAt + SpPerson.lifetime
  }

  const status = (id: string): Person => {
    if (browser.id === id) return { status: "signingIn" }
    const end = until(id)
    if (end !== undefined) {
      const held = live.get(id)
      const on = held?.token !== undefined && (held.expiresAt ?? 0) > Date.now()
      return { status: on ? "on" : "renewing", until: end }
    }
    if (declared.get(id) !== true) return { status: "unavailable" }
    return ended.has(id) ? { status: "off", ended: true } : { status: "off" }
  }

  const drop = (id: string) => {
    clearTimeout(live.get(id)?.timer)
    live.delete(id)
    renewing.delete(id)
  }

  // The session is over here: its refresh token and access token go, and nothing renews it.
  const end = (id: string, reason: "ended" | "refused" | "signed-out" | "other-user") => {
    if (saved(id) === undefined && !live.has(id)) return
    drop(id)
    save(id, undefined)
    if (reason === "ended") ended.add(id)
    else ended.delete(id)
    options.changed()
    options.log?.("person: the session ended", { account: id, reason })
  }

  // Keeps a fresh pair: the new refresh token goes to the store before anything else, since the old one is spent.
  const hold = (id: string, tokens: SpPerson.Tokens) => {
    save(id, {
      cipher: options.secure.encryptString(tokens.refresh).toString("base64"),
      user: tokens.user,
      signedInAt: tokens.signedInAt,
    })
    clearTimeout(live.get(id)?.timer)
    live.set(id, { token: tokens.access, expiresAt: tokens.expiresAt })
    schedule(id, Math.min(tokens.ttl * 1000 * renewAt, tokens.signedInAt + SpPerson.lifetime - Date.now()))
    ended.delete(id)
    options.changed()
  }

  const schedule = (id: string, after: number) => {
    if (life.disposed) return
    const held = live.get(id) ?? {}
    clearTimeout(held.timer)
    live.set(id, { ...held, timer: setTimeout(() => void background(id), Math.max(0, after)) })
  }

  // Renewal in the background: a session the instance ends stays ended, no answer tries again while the session lasts.
  const background = (id: string) =>
    renew(id).catch((error) => {
      if (error instanceof SignedOut || saved(id) === undefined) return
      if (error instanceof SpClient.Unauthorized) return
      schedule(id, Math.min(retryAfter, (until(id) ?? 0) - Date.now()))
      options.changed()
    })

  // A new access token from the stored refresh token. Concurrent callers share one request: the instance ends the whole
  // session when a refresh token is spent twice. Past its 12 hours, or refused, the session ends with no request more.
  const renew = (id: string) => {
    const running = renewing.get(id)
    if (running) return running
    const next = renewOnce(id).finally(() => {
      if (renewing.get(id) === next) renewing.delete(id)
    })
    renewing.set(id, next)
    return next
  }

  const renewOnce = async (id: string) => {
    const session = saved(id)
    const entry = account(id)
    if (session === undefined || entry === undefined) throw new SignedOut({ id })
    if (Date.now() >= session.signedInAt + SpPerson.lifetime) {
      end(id, "ended")
      throw new SignedOut({ id })
    }
    const refresh = decrypt(options.secure, session.cipher)
    if (refresh === undefined) throw new DynWorkAccounts.SecureStorageUnavailable()
    const tokens = await Effect.runPromise(SpPerson.refresh(entry.url, refresh)).catch((error) => {
      if (error instanceof SpClient.Unauthorized && saved(id)?.cipher === session.cipher)
        end(id, Date.now() >= session.signedInAt + SpPerson.lifetime - margin ? "ended" : "refused")
      throw error
    })
    // Signed out while the request ran: this pair belongs to nobody
    if (saved(id)?.cipher !== session.cipher) throw new SignedOut({ id })
    hold(id, tokens)
    return tokens.access
  }

  // The access token, refreshed when it is about to run out: on every use, besides the background renewal.
  const access = async (id: string) => {
    const held = live.get(id)
    if (saved(id) !== undefined && held?.token !== undefined && (held.expiresAt ?? 0) - margin > Date.now())
      return held.token
    return renew(id)
  }

  /**
   * Runs `use` as the person, for main code only. A refused token is refreshed once and `use` retried once. An action
   * that wants a more recent sign-in (`SpClient.RecentSignIn`) sends the person through the browser again and retries
   * once on return; if that sign-in does not end signed in, it fails with `SignInFailed` and nothing was done.
   * Without a session it fails with `SignedOut` at once, with no request.
   */
  const withPerson = async <A>(id: string, use: (token: string) => Promise<A>) => {
    const token = await access(id)
    return use(token).catch(async (error) => {
      if (error instanceof SpClient.RecentSignIn) {
        const outcome = await signIn(id, { maxAge: error.maxAge ?? SpPerson.recent })
        if (outcome !== "signed-in") throw new SignInFailed({ id, outcome })
        return use(await access(id))
      }
      if (!(error instanceof SpClient.Unauthorized)) throw error
      const held = live.get(id)
      if (held?.token === token) live.set(id, { timer: held.timer })
      return use(await access(id))
    })
  }

  /**
   * Signs the person in through the system browser (code + PKCE, `state` checked) for the account's instance. A second
   * call, `cancel` or `signal` ends the one under way.
   */
  const signIn = async (id: string, request: { maxAge?: number; signal?: AbortSignal } = {}): Promise<PersonSignIn> => {
    const entry = account(id)
    if (entry === undefined || entry.status !== "signedIn" || life.disposed) return "unavailable"
    if (!options.secure.isEncryptionAvailable()) return "insecure"
    // An instance without DynWork's client gets no browser: its page would only refuse the client
    const found = declared.get(id) ?? (await probe(entry))
    if (found === false) return "unavailable"
    if (found === undefined) return "unreachable"
    browser.cancel?.()
    const attempt = { cancelled: false, stop: () => {} }
    const cancel = () => {
      attempt.cancelled = true
      attempt.stop()
    }
    browser.cancel = cancel
    request.signal?.addEventListener("abort", cancel, { once: true })
    const grant = SpPerson.begin()
    const answer = await browserAnswer(id, entry.url, grant, attempt, request.maxAge)
      .catch(() => ({ _tag: "Failed" as const }))
      .finally(() => {
        attempt.stop()
        request.signal?.removeEventListener("abort", cancel)
        if (browser.cancel !== cancel) return
        browser.id = undefined
        browser.cancel = undefined
        options.changed()
      })
    if (answer._tag === "Failed") return "failed"
    if (answer._tag === "Cancelled") return "cancelled"
    if (answer._tag === "Expired") return "expired"
    if (answer.answer._tag === "Denied") return "denied"
    const result = await Effect.runPromise(
      Effect.result(
        SpPerson.exchange(entry.url, { code: answer.answer.code, redirect: answer.redirect, verifier: grant.verifier }),
      ),
    )
    if (result._tag === "Failure") return failed(id, result.failure)
    const tokens = result.success
    // The browser may hold another person's session: DynWork never acts as anyone but the account's user
    const user = options.accounts.stored(id)?.userId
    if (user !== undefined && tokens.user !== user) {
      void revokeAt(id, entry.url, tokens.refresh)
      return "mismatch"
    }
    if (account(id)?.status !== "signedIn") return "unavailable"
    declared.set(id, true)
    hold(id, tokens)
    return "signed-in"
  }

  const browserAnswer = async (
    id: string,
    url: string,
    grant: ReturnType<typeof SpPerson.begin>,
    attempt: { cancelled: boolean; stop: () => void },
    maxAge: number | undefined,
  ) => {
    const listener = await Loopback.listen({
      parse: (callback) => SpPerson.parseCallback(callback, grant.state),
      timeout: browserTimeout,
      path: SpPerson.callbackPath,
    })
    attempt.stop = listener.cancel
    if (attempt.cancelled || life.disposed) {
      listener.cancel()
      return { _tag: "Cancelled" as const }
    }
    browser.id = id
    options.changed()
    await options.open(
      SpPerson.authorizeUrl(url, { redirect: listener.redirect, state: grant.state, challenge: grant.challenge, maxAge }),
    )
    const outcome = await listener.outcome
    if (outcome._tag !== "Answer") return outcome
    return { ...outcome, redirect: listener.redirect }
  }

  const failed = (id: string, error: SpClient.SpError): PersonSignIn => {
    if (error instanceof SpClient.Incompatible) {
      declared.set(id, false)
      options.changed()
      return "unavailable"
    }
    if (error instanceof SpClient.Unreachable) return "unreachable"
    if (error instanceof SpClient.Unauthorized) return "refused"
    return "failed"
  }

  // Ends the session at the instance with the account's own JWT: the revoke route does not take the UI token. Best
  // effort: the session ends here whatever the instance answers, and on its own 12 hours after the sign-in.
  const revokeAt = (id: string, url: string, refreshToken: string) =>
    options.accounts
      .withJwt(id, (bearer) => Effect.runPromise(SpPerson.revoke(url, { refreshToken, bearer })))
      .catch(() => undefined)

  /** Ends the account's person session, at the instance too while the account can still say so. */
  const signOut = async (id: string) => {
    if (browser.id === id) browser.cancel?.()
    const session = saved(id)
    const entry = account(id)
    end(id, "signed-out")
    const refresh = session === undefined ? undefined : decrypt(options.secure, session.cipher)
    if (entry !== undefined && refresh !== undefined) await revokeAt(id, entry.url, refresh)
  }

  /**
   * Follows the accounts, on every change: a session whose account is gone, signed out or now another user's ends; a
   * signed-in account's instance is asked once whether it declares DynWork's client; a stored session with nothing in
   * memory (the app just started) is renewed in the background.
   */
  const reconcile = () => {
    if (life.disposed) return
    const accounts = options.accounts.list()
    Object.entries(options.store.value.sessions).forEach(([id, session]) => {
      const entry = accounts.find((candidate) => candidate.id === id)
      const user = options.accounts.stored(id)?.userId
      if (entry === undefined || entry.status === "signedOut") return end(id, "signed-out")
      if (user !== undefined && user !== session.user) return end(id, "other-user")
      if (entry.status === "signedIn" && !live.has(id)) schedule(id, 0)
    })
    accounts
      .filter((entry) => entry.status === "signedIn" && !declared.has(entry.id))
      .forEach((entry) => void probe(entry))
  }

  // Asks the account's instance once whether it declares DynWork's client. Concurrent callers share the request; no
  // answer leaves it unknown (undefined), to ask again on the next change of the accounts or the next sign-in.
  const probe = (entry: { id: string; url: string }) => {
    const running = probing.get(entry.id)
    if (running) return running
    const next = Effect.runPromise(SpPerson.available(entry.url))
      .then((found) => {
        declared.set(entry.id, found)
        options.changed()
        return found
      })
      .catch(() => undefined)
      .finally(() => probing.delete(entry.id))
    probing.set(entry.id, next)
    return next
  }

  const dispose = () => {
    life.disposed = true
    browser.cancel?.()
    ;[...live.keys()].forEach(drop)
  }

  return {
    status,
    signIn,
    signOut,
    cancel: () => browser.cancel?.(),
    withPerson,
    reconcile,
    dispose,
  }
}

export type Service = ReturnType<typeof make>

function decrypt(secure: DynWorkAccounts.SecureStorage, cipher: string) {
  try {
    return secure.decryptString(Buffer.from(cipher, "base64"))
  } catch {
    return undefined
  }
}
