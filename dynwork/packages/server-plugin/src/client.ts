export * as DynWorkSyncClient from "./client"

import { Schema } from "effect"
import { DynWorkSync } from "./contract"

// Calls the plugin's `dynwork.sync` RPC on DynWork's service from main. The input carries the JWT, so a failure
// reports only the HTTP status and the RPC error type: the service's message may quote the input back.

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
  }
}

const decodeApplied = Schema.decodeUnknownOption(DynWorkSync.Applied)
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
