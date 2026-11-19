export * as FarmCloud from "./cloud"

import { createHmac, randomBytes } from "node:crypto"
import { Option, Schema } from "effect"
import { DynWorkAccounts } from "../../accounts/accounts"
import { fail } from "../backend"
import type { FarmTransport, Refusal } from "./client"

/**
 * Cloud runs a user's tasks as that user, with the PAT their Dynwork account already signs in with: the farm keeps it as
 * the user's `gateway_pat` credential (`sp-gateway`). `ensure` puts it there with nothing for the user to do.
 *
 * The PAT never travels through the farm's MCP server: Governance stores every tool call. One tool call asks for a
 * one-time upload link, and the PAT goes in one `PUT` straight to that link, with no `Authorization`, over HTTPS, never
 * following a redirect. It is decrypted in main only for that request and never reaches a log, an answer, a window or
 * the store. This module keeps, in memory only, a keyed hash of the last PAT it uploaded per account, to tell a new PAT
 * from the one the farm already holds.
 */

/** The credential the farm runs the user's tasks with. */
export const credential = { type: "gateway_pat", name: "sp-gateway" } as const

/**
 * The farm's reasons for a task or a launch that mean it holds no PAT that works: the gateway refused the stored one when
 * the task started, or there is none. Either one is worth an upload; `retry(reason)` checks.
 */
export const stale = ["farm_access_revoked", "user_gateway_credential_missing"] as const

/** The longest the `PUT` may take. */
export const timeout = 30_000

/**
 * Why `ensure` runs:
 * - `capabilities`: Cloud is about to be shown. Uploads only when the farm says it holds no PAT for the user.
 * - `refused`: a task failed with one of the `stale` reasons. Uploads again, whatever the farm says it holds.
 * - `account`: the account minted a session, which follows every sign-in. Uploads when this PAT is not the one last
 *   uploaded from this process, so once per launch and again after each new sign-in.
 */
export type Cause = "capabilities" | "refused" | "account"

/**
 * What `ensure` ends with. `present`: the farm already holds a PAT; `uploaded`: it holds this one now; `unchanged`: this
 * PAT was already uploaded. A refusal keeps the transport's code: `unavailable` is Cloud not given to this account
 * (nothing was asked, nothing is wrong), `signed_out` and `secure_storage` come from the account, `upload_refused` and
 * `upload_<status>` from the upload link.
 */
export type Outcome = { ok: true; state: "present" | "uploaded" | "unchanged" } | Refusal

/** What `ensure` needs from the accounts: the active one and its PAT, lent for one call. */
export interface Accounts {
  active(): string | undefined
  withPat<A>(id: string, use: (pat: string) => Promise<A>): Promise<A>
}

export interface Options {
  /** The farm, as `FarmClient` reaches it for the active account. */
  transport: FarmTransport
  accounts: Accounts
  fetch?: typeof fetch
  /** One line per upload or failure; no line carries the PAT, the link or anything the farm answered. */
  log?: (line: string) => void
  timeout?: number
}

const Whoami = Schema.Struct({
  gateway_identity: Schema.optional(Schema.Struct({ user_credential: Schema.optional(Schema.Boolean) })),
})
const Ticket = Schema.Struct({ upload_url: Schema.String, method: Schema.optional(Schema.String) })
const decodeWhoami = Schema.decodeUnknownOption(Whoami)
const decodeTicket = Schema.decodeUnknownOption(Ticket)

// A link may use plain http only on this machine (a farm run locally); anywhere else it is https.
const loopback = new Set(["localhost", "127.0.0.1", "[::1]"])

export function make(options: Options) {
  const request = options.fetch ?? fetch
  const log = options.log ?? (() => {})
  const key = randomBytes(32)
  const mark = (pat: string) => createHmac("sha256", key).update(pat).digest("base64")
  const uploaded = new Map<string, string>()
  const running = new Map<string, { forced: boolean; done: Promise<Outcome> }>()

  const run = async (id: string, cause: Cause): Promise<Outcome> => {
    if (cause === "capabilities") {
      const whoami = await options.transport.callTool("farm_whoami")
      if (!whoami.ok) return whoami
      if (Option.getOrUndefined(decodeWhoami(whoami.value))?.gateway_identity?.user_credential === true)
        return { ok: true, state: "present" }
    }
    if (cause === "account" && uploaded.get(id) === (await options.accounts.withPat(id, async (pat) => mark(pat))))
      return { ok: true, state: "unchanged" }

    const ticket = await options.transport.callTool("farm_request_credential_upload", { ...credential })
    if (!ticket.ok) {
      log(`farm cloud: no upload link (${ticket.code})`)
      return ticket
    }
    const link = target(Option.getOrUndefined(decodeTicket(ticket.value)))
    if (link === undefined) {
      log("farm cloud: refused the upload link the farm gave")
      return refusal("upload_refused")
    }
    return options.accounts.withPat(id, async (pat) => {
      const response = await request(link, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: pat }),
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeout ?? timeout),
      }).catch(() => undefined)
      if (response === undefined) {
        log("farm cloud: the upload did not reach Cloud")
        return refusal("upload_unreachable")
      }
      await response.body?.cancel()
      if (response.status < 200 || response.status >= 300) {
        log(`farm cloud: upload refused (HTTP ${response.status})`)
        return refusal(`upload_${response.status}`)
      }
      uploaded.set(id, mark(pat))
      log("farm cloud: key uploaded")
      return { ok: true, state: "uploaded" } as const
    })
  }

  /**
   * Makes the farm hold the active account's PAT, as `cause` says. Never rejects. Calls for the same account share one
   * run; one that must upload and finds a run that may not waits for it and then runs.
   */
  const ensure = (cause: Cause = "capabilities"): Promise<Outcome> => {
    const id = options.accounts.active()
    if (id === undefined) return Promise.resolve(signedOut)
    const forced = cause !== "capabilities"
    const held = running.get(id)
    if (held !== undefined && (held.forced || !forced)) return held.done
    const done: Promise<Outcome> = (held === undefined ? Promise.resolve() : held.done.then(() => {}))
      .then(() => run(id, cause))
      .catch(accountFailure)
      .finally(() => {
        if (running.get(id)?.done === done) running.delete(id)
      })
    running.set(id, { forced, done })
    return done
  }

  /** After a task or a launch failed with `reason`: uploads again when the reason says the farm has no working PAT. */
  const retry = (reason: string | undefined) =>
    stale.some((known) => known === reason) ? ensure("refused") : Promise.resolve(undefined)

  return { ensure, retry }
}

export type Cloud = ReturnType<typeof make>

const signedOut: Refusal = {
  ok: false,
  code: "signed_out",
  failure: fail("signed-out", "Sign in to Governance to use Cloud."),
}

function refusal(code: string): Refusal {
  return { ok: false, code, failure: fail("failed", "Cloud did not take the Governance sign-in. Try again later.") }
}

// The PAT could not be lent. The error's own text is never used: only its kind.
function accountFailure(error: unknown): Outcome {
  if (error instanceof DynWorkAccounts.NotSignedIn) return signedOut
  if (error instanceof DynWorkAccounts.SecureStorageUnavailable)
    return {
      ok: false,
      code: "secure_storage",
      failure: fail("signed-out", "The system keychain did not open the Governance sign-in."),
    }
  return refusal("upload_failed")
}

// The farm's link, only if it is one: https (http only on this machine), no user info, no query, the upload path.
function target(ticket: typeof Ticket.Type | undefined) {
  if (ticket === undefined || (ticket.method !== undefined && ticket.method !== "PUT")) return undefined
  const url = URL.parse(ticket.upload_url)
  if (url === null || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "")
    return undefined
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback.has(url.hostname))) return undefined
  if (!/\/credential-uploads\/[^/]+$/.test(url.pathname)) return undefined
  return url
}
