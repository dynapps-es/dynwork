export * as FarmClient from "./client"

import { Option, Schema } from "effect"
import { SpClient } from "@dynwork/sp-client"
import { DynWorkAccounts } from "../../accounts/accounts"
import { fail } from "../backend"
import type { Failure } from "../contract"

/**
 * How main talks to the Agent Farm. Everything goes through a `FarmTransport`, chosen once by the connection mode
 * (`mode`). `via-sp` is the farm's MCP server behind the Governance MCP proxy, authenticated with the JWT the account
 * already mints from its PAT: nothing to set up. `direct` (a farm reached with its own credentials, no Governance) has
 * its place here but is not available yet: choosing it answers that, and never falls back to `via-sp`.
 *
 * Credentials: the JWT is read from `accounts` at the moment of each request and goes only in the `Authorization`
 * header. It is never in a URL, an argument, a `Failure`, a log line or anything else a window can read. Governance
 * stores the arguments and the result of every tool call, so no argument may carry a credential: `callTool` refuses
 * one before any request.
 */

/** The environment variable that chooses the connection mode. Absent or empty: `sp`. */
export const connection = "DYNWORK_ROUTINES_FARM_CONNECTION"

export const modes = ["sp", "direct"] as const
export type Mode = (typeof modes)[number]

/** The one place the connection mode is read. An unknown value is `undefined`: `select` refuses it, it never guesses. */
export function mode(env: Readonly<Record<string, string | undefined>>): Mode | undefined {
  const value = env[connection]
  if (value === undefined || value === "") return "sp"
  return modes.find((known) => known === value)
}

/** The farm's MCP server as Governance names it. */
export const server = "dynapps-farm"
/** The MCP protocol version sent with every request. */
export const protocol = "2025-06-18"
/** A call gives up after this long. The farm's longest tool waits 30 s. */
export const timeout = 40_000
/** Tries per call, counting the first, for a rate limit or a farm error marked `retryable`. */
export const attempts = 3
/** The longest `retry-after` worth waiting for; a longer one answers `unreachable` at once. */
export const wait = 10_000

/** The keys no argument may have at any depth, whatever their case: Governance keeps every argument it forwards. */
export const forbidden = ["value", "token", "pat"] as const

/** Tool arguments. The secret-shaped keys are refused by type at the top level and at run time at any depth. */
export type Arguments = { readonly [key: string]: unknown } & {
  readonly [key in (typeof forbidden)[number]]?: never
}

/**
 * What a call answers. `code` is the farm's own error code, or one of the transport's: `unavailable` (Governance does
 * not give this account the farm), `unauthorized`, `too_large`, `rate_limited`, `timeout`, `network`, `http_<status>`,
 * `protocol`, `signed_out`, `secure_storage`, `secret_argument`, `direct_not_available`, `mode_unknown`.
 */
export type Answer = { ok: true; value: Readonly<Record<string, unknown>> } | Refusal
export type Refusal = { ok: false; code: string; failure: Failure }

export interface FarmTransport {
  readonly mode: Mode | "unknown"
  callTool(name: string, args?: Arguments, options?: { timeout?: number }): Promise<Answer>
}

/** What the transport needs from the accounts: the active one, its instance URL and its JWT. */
export type Accounts = Pick<DynWorkAccounts.Accounts, "active" | "stored" | "session">

export interface ViaSpOptions {
  accounts: Accounts
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  /** Receives one line per call that did not succeed at once; no line carries a credential or an argument. */
  log?: (line: string) => void
  timeout?: number
  attempts?: number
  wait?: number
}

export function select(chosen: Mode | undefined, sp: ViaSpOptions): FarmTransport {
  if (chosen === "sp") return viaSp(sp)
  if (chosen === "direct") return direct()
  return refusing("unknown", "mode_unknown", "This way of connecting to Cloud is not known.")
}

/** The `direct` slot: chosen on purpose, it says so on every call and reaches nothing. */
export function direct(): FarmTransport {
  return refusing("direct", "direct_not_available", "Connecting to Cloud without Governance is not available yet.")
}

function refusing(chosen: FarmTransport["mode"], code: string, message: string): FarmTransport {
  return { mode: chosen, callTool: async () => ({ ok: false, code, failure: fail("unsupported", message) }) }
}

const Content = Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })
const Envelope = Schema.Struct({
  id: Schema.optional(Schema.Unknown),
  result: Schema.optional(
    Schema.Struct({
      structuredContent: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
      content: Schema.optional(Schema.Array(Content)),
      isError: Schema.optional(Schema.Boolean),
    }),
  ),
  error: Schema.optional(Schema.Struct({ code: Schema.Number, message: Schema.String })),
})
const FarmError = Schema.Struct({
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
    retryable: Schema.optional(Schema.Boolean),
    details: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
  }),
})
const decodeEnvelope = Schema.decodeUnknownOption(Schema.fromJsonString(Envelope))
const decodeFarmError = Schema.decodeUnknownOption(FarmError)
const decodeObject = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))

// The farm's codes for "the thing is not in a state that allows it" (HTTP 409 on the farm's REST side).
const conflicts = new Set([
  "task_not_cancellable",
  "task_not_terminal",
  "schedule_finished",
  "schedule_not_active",
  "schedule_overlap",
  "agent_in_use_by_schedule",
  "agent_slug_taken",
  "no_open_question",
])

type Step = { tries: number; reminted: boolean; fresh: boolean }

export function viaSp(options: ViaSpOptions): FarmTransport {
  const request = options.fetch ?? fetch
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const log = options.log ?? (() => {})
  const most = options.attempts ?? attempts
  const longest = options.wait ?? wait
  const counter = { id: 0 }

  const callTool: FarmTransport["callTool"] = async (name, args = {}, call) => {
    if (carriesSecret(args)) {
      log(`farm ${name}: refused, an argument has a credential-shaped key`)
      return failed("secret_argument", fail("invalid", "A Cloud request cannot carry a credential."))
    }
    const id = options.accounts.active()
    const account = id === undefined ? undefined : options.accounts.stored(id)
    if (id === undefined || account === undefined)
      return failed("signed_out", fail("signed-out", "Sign in to Governance to use Cloud."))
    const url = new URL(`api/v1/mcp/${server}/mcp`, account.url.endsWith("/") ? account.url : `${account.url}/`)
    const limit = call?.timeout ?? options.timeout ?? timeout

    const attempt = async (step: Step): Promise<Answer> => {
      const session = await options.accounts.session(id, step.fresh).then(
        (held) => ({ token: held.token }),
        (error: unknown) => ({ answer: sessionFailure(error) }),
      )
      if ("answer" in session) {
        log(`farm ${name}: no JWT (${session.answer.code})`)
        return session.answer
      }
      const token = session.token
      const rpc = ++counter.id
      const reply = await request(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": protocol,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: rpc, method: "tools/call", params: { name, arguments: args } }),
        signal: AbortSignal.timeout(limit),
      }).then(
        async (response) => ({ response, text: await response.text() }),
        (error: unknown) => ({ error }),
      )
      const finish = (answer: Answer, status?: number) => {
        const clean = scrub(answer, token)
        if (!clean.ok)
          log(`farm ${name}: ${scrubText(clean.code, token)}${status === undefined ? "" : ` (HTTP ${status})`}`)
        return clean
      }
      const again = (delay: number, next: Partial<Step>) =>
        sleep(delay).then(() => attempt({ ...step, fresh: false, tries: step.tries + 1, ...next }))

      if ("error" in reply) {
        const late = reply.error instanceof Error && reply.error.name === "TimeoutError"
        return finish(
          late
            ? failed("timeout", fail("unreachable", "Cloud did not answer in time."))
            : failed("network", fail("unreachable", "Cloud cannot be reached right now.")),
        )
      }
      const status = reply.response.status
      if (status === 401) {
        if (step.reminted)
          return finish(
            failed("unauthorized", fail("signed-out", "Governance did not accept this account. Sign in again.")),
            status,
          )
        log(`farm ${name}: unauthorized, minting a new JWT`)
        return attempt({ ...step, reminted: true, fresh: true })
      }
      if (status === 429) {
        const delay = retryAfter(reply.response.headers.get("retry-after"))
        if (step.tries < most && delay <= longest) {
          log(`farm ${name}: rate limited, retrying in ${delay} ms`)
          return again(delay, {})
        }
        return finish(
          failed("rate_limited", fail("unreachable", "Too many Cloud requests right now. Try again shortly.")),
          status,
        )
      }
      if (status === 503 && reply.text.includes("service_not_running"))
        return finish(failed("unavailable", fail("failed", "Cloud is not available for this account.")), status)
      if (status === 413) return finish(failed("too_large", fail("failed", "The Cloud request was too large.")), status)
      if (status < 200 || status >= 300)
        return finish(
          failed(
            `http_${status}`,
            status >= 500
              ? fail("unreachable", "Cloud cannot be reached right now.")
              : fail("failed", "Cloud refused the request."),
          ),
          status,
        )

      const envelope = parse(reply.text, reply.response.headers.get("content-type") ?? "", rpc)
      if (envelope === undefined || (envelope.result === undefined && envelope.error === undefined))
        return finish(
          failed("protocol", fail("failed", "Cloud answered in a way Dynwork does not understand.")),
          status,
        )
      if (envelope.error !== undefined || envelope.result === undefined)
        return finish(failed("protocol", fail("failed", "Cloud did not accept the request.")), status)
      const body = envelope.result.structuredContent ?? textObject(envelope.result.content)
      if (envelope.result.isError !== true) return finish({ ok: true, value: body ?? {} })
      const error = Option.getOrUndefined(decodeFarmError(body))?.error
      if (error === undefined)
        return finish(
          failed("protocol", fail("failed", "Cloud answered in a way Dynwork does not understand.")),
          status,
        )
      if (error.retryable === true && step.tries < most) {
        log(`farm ${name}: ${scrubText(error.code, token)}, retrying`)
        return again(500 * step.tries, {})
      }
      return finish(failed(error.code, farmFailure(error)), status)
    }

    return attempt({ tries: 1, reminted: false, fresh: false })
  }

  return { mode: "sp", callTool }
}

function failed(code: string, failure: Failure): Refusal {
  return { ok: false, code, failure }
}

// A JWT that cannot be had. The errors' own text is never used: only their kind.
function sessionFailure(error: unknown): Refusal {
  if (error instanceof DynWorkAccounts.NotSignedIn || error instanceof SpClient.Unauthorized)
    return failed("signed_out", fail("signed-out", "Sign in to Governance to use Cloud."))
  if (error instanceof DynWorkAccounts.SecureStorageUnavailable)
    return failed("secure_storage", fail("signed-out", "The system keychain did not open the Governance sign-in."))
  if (error instanceof SpClient.Unreachable || error instanceof SpClient.RateLimited)
    return failed("network", fail("unreachable", "Governance cannot be reached right now."))
  return failed("signed_out", fail("failed", "Governance did not give a session for Cloud."))
}

// The farm's `{ error: { code, message, retryable, details } }` as a `Failure`. The code itself stays in `Answer.code`
// for callers that need finer handling.
function farmFailure(error: (typeof FarmError.Type)["error"]): Failure {
  const message = error.message.slice(0, 500)
  const field = error.details?.field
  if (error.code === "token_expired" || error.code === "token_invalid") return fail("signed-out", message)
  if (error.code === "not_found" || error.code.endsWith("_not_found")) return fail("not-found", message)
  if (error.code === "quota_exceeded") return fail("quota", message)
  if (conflicts.has(error.code) || error.code.endsWith("_conflict")) return fail("conflict", message)
  if (error.retryable === true) return fail("unreachable", message)
  if (typeof field === "string") return fail("invalid", message, { [field]: message })
  if (
    /_(invalid|required|unknown|too_large|too_short)$/.test(error.code) ||
    error.code === "limits_exceed_tenant_policy"
  )
    return fail("invalid", message)
  return fail("failed", message)
}

// The JSON-RPC answer to request `id`: a JSON body, or the matching `data:` event of an event stream.
function parse(text: string, type: string, id: number) {
  if (!type.includes("text/event-stream")) return Option.getOrUndefined(decodeEnvelope(text))
  return text
    .split(/\r?\n\r?\n/)
    .map((block) =>
      block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n"),
    )
    .filter((data) => data !== "")
    .map((data) => Option.getOrUndefined(decodeEnvelope(data)))
    .find((envelope) => envelope?.id === id && (envelope.result !== undefined || envelope.error !== undefined))
}

function textObject(content: ReadonlyArray<typeof Content.Type> | undefined) {
  const text = content?.find((item) => item.type === "text")?.text
  return text === undefined ? undefined : Option.getOrUndefined(decodeObject(text))
}

function carriesSecret(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(carriesSecret)
  if (typeof value !== "object" || value === null) return false
  return Object.entries(value).some(
    ([key, inner]) => forbidden.some((name) => name === key.toLowerCase()) || carriesSecret(inner),
  )
}

// Whatever reached us from the network goes out without the JWT, even if a server echoed it.
function scrubText(text: string, token: string) {
  return token === "" ? text : text.replaceAll(token, "[redacted]")
}

function scrub(answer: Answer, token: string): Answer {
  if (answer.ok) return answer
  return {
    ok: false,
    code: scrubText(answer.code, token),
    failure: {
      ...answer.failure,
      message: scrubText(answer.failure.message, token),
      ...(answer.failure.fields
        ? {
            fields: Object.fromEntries(
              Object.entries(answer.failure.fields).map(([key, text]) => [
                scrubText(key, token),
                scrubText(text, token),
              ]),
            ),
          }
        : {}),
    },
  }
}

// `retry-after` in seconds or as a date; absent or unreadable is one second.
function retryAfter(header: string | null) {
  if (header === null) return 1_000
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(header)
  return Number.isNaN(date) ? 1_000 : Math.max(0, date - Date.now())
}
