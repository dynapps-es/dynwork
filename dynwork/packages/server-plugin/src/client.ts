export * as DynWorkSyncClient from "./client"

import { Schema } from "effect"
import { DynWorkSync } from "./contract"

// Calls the plugin's `dynwork.sync` RPC on DynWork's service from main, and follows its events. The input carries the
// JWT, so a failure reports only the HTTP status and the RPC error type: the service's message may quote the input back.

export interface Endpoint {
  readonly url: string
  /** Headers the service needs, with its `authorization`. */
  readonly headers: Readonly<Record<string, string>>
}

export class Failed extends Error {
  constructor(
    readonly method: string,
    /** 0 when the service is not running or did not answer. */
    readonly status: number,
    /** The RPC error type, such as `rpc.invalid_input` or `rpc.unavailable` (the plugin is not loaded). */
    readonly type?: string,
  ) {
    super(`dynwork.sync.${method} failed${status ? ` (${status}${type ? ` ${type}` : ""})` : ": service unavailable"}`)
  }
}

/** How long one call may take: `apply` waits until every Location has rebuilt its content. */
export const timeout = 30_000

export function make(endpoint: () => Endpoint | undefined) {
  const call = async (method: string, input: unknown) => {
    const server = endpoint()
    if (!server) throw new Failed(method, 0)
    const response = await fetch(`${server.url.replace(/\/+$/, "")}/api/rpc/${DynWorkSync.id}/${method}`, {
      method: "POST",
      headers: { ...server.headers, "content-type": "application/json" },
      body: JSON.stringify({ input }),
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
    }).catch(() => undefined)
    if (!response) throw new Failed(method, 0)
    const body: unknown = await response.json().catch(() => undefined)
    if (!response.ok) throw new Failed(method, response.status, errorType(body))
    return outputOf(body)
  }
  return {
    apply: (input: DynWorkSync.Apply) =>
      call("apply", input).then((output) => {
        const applied = decodeApplied(output)
        if (applied._tag === "None") throw new Failed("apply", 200, "invalid_output")
        return applied.value
      }),
    clear: () => call("clear", {}).then(() => undefined),
    /** Pushes a renewed JWT; false when the plugin holds another instance (a switch or sign-out came first). */
    token: (input: DynWorkSync.Token) =>
      call("token", input).then((output) => {
        const accepted = decodeAccepted(output)
        if (accepted._tag === "None") throw new Failed("token", 200, "invalid_output")
        return accepted.value.accepted
      }),
    /** Writes a skill's runtime files beside its SKILL.md and reads them back. */
    materialize: (input: DynWorkSync.Materialize) =>
      call("materialize", input).then((output) => {
        const written = decodeMaterialized(output)
        if (written._tag === "None") throw new Failed("materialize", 200, "invalid_output")
        return written.value
      }),
    /** Whether the runtime files a receipt recorded are still on disk as written. */
    inspect: (input: DynWorkSync.Inspect) =>
      call("inspect", input).then((output) => {
        const inspected = decodeInspected(output)
        if (inspected._tag === "None") throw new Failed("inspect", 200, "invalid_output")
        return inspected.value.intact
      }),
    /**
     * Follows the plugin's `refresh` and `rejected` events until `signal` aborts or the service closes the stream
     * (it stopped or restarted), when the promise settles and the caller subscribes again. Events published while
     * nobody listens are lost: a call waiting for a JWT then gives up after a while.
     */
    listen: async (handlers: Handlers, signal: AbortSignal) => {
      const server = endpoint()
      if (!server) throw new Failed("events", 0)
      const types = (["refresh", "rejected"] as const).map((name) => `types=rpc.${DynWorkSync.id}.${name}`).join("&")
      const response = await fetch(`${server.url.replace(/\/+$/, "")}/api/event?${types}`, {
        headers: { ...server.headers, accept: "text/event-stream" },
        redirect: "error",
        signal,
      }).catch(() => undefined)
      if (signal.aborted) return
      if (!response?.ok || !response.body) throw new Failed("events", response?.status ?? 0)
      // An abort or a stream the service broke off ends the subscription the same way as a closed one.
      await follow(response.body, handlers).catch(() => undefined)
    },
  }
}

export interface Handlers {
  readonly refresh?: (event: DynWorkSync.Refresh) => void
  readonly rejected?: (event: DynWorkSync.Rejected) => void
}

const decodeEvent = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ type: Schema.String, data: Schema.Unknown })),
)
const decodeRefresh = Schema.decodeUnknownOption(DynWorkSync.Refresh)
const decodeRejected = Schema.decodeUnknownOption(DynWorkSync.Rejected)

async function follow(body: ReadableStream<Uint8Array>, handlers: Handlers) {
  const decoder = new TextDecoder()
  const buffer = { text: "" }
  for await (const chunk of body) {
    buffer.text += decoder.decode(chunk, { stream: true })
    const frames = buffer.text.split(/\r?\n\r?\n/)
    buffer.text = frames.pop() ?? ""
    for (const frame of frames) dispatch(frame, handlers)
  }
}

// One server-sent event: its `data` lines joined. Anything that is not one of the two events is skipped.
function dispatch(frame: string, handlers: Handlers) {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(line.startsWith("data: ") ? 6 : 5))
    .join("\n")
  const event = decodeEvent(data)
  if (event._tag === "None") return
  if (event.value.type === `rpc.${DynWorkSync.id}.refresh`) {
    const refresh = decodeRefresh(event.value.data)
    if (refresh._tag === "Some") handlers.refresh?.(refresh.value)
  }
  if (event.value.type === `rpc.${DynWorkSync.id}.rejected`) {
    const rejected = decodeRejected(event.value.data)
    if (rejected._tag === "Some") handlers.rejected?.(rejected.value)
  }
}

const decodeApplied = Schema.decodeUnknownOption(DynWorkSync.Applied)
const decodeAccepted = Schema.decodeUnknownOption(DynWorkSync.TokenAccepted)
const decodeMaterialized = Schema.decodeUnknownOption(DynWorkSync.Materialized)
const decodeInspected = Schema.decodeUnknownOption(DynWorkSync.Inspected)
const decodeError = Schema.decodeUnknownOption(Schema.Struct({ type: Schema.String }))
const decodeOutput = Schema.decodeUnknownOption(Schema.Struct({ output: Schema.optional(Schema.Unknown) }))

function errorType(body: unknown) {
  const error = decodeError(body)
  return error._tag === "Some" ? error.value.type : undefined
}

function outputOf(body: unknown) {
  const output = decodeOutput(body)
  return output._tag === "Some" ? output.value.output : undefined
}
