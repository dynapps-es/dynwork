import { Duration, Effect, Schema } from "effect"
import { Protocol, RateLimited, Unauthorized, Unreachable } from "./errors"

// One file of a plugin bundle, as the systemprompt bridge fetches it (`gateway/fetch.rs` `fetch_plugin_file`):
// `GET /v1/bridge/plugins/{plugin}/{path}` with the user's JWT. The instance assembles the bytes from the same bundles
// it hashes into the signed manifest, so the caller checks them against the manifest's `sha256` before using them.
// Nothing is stored or logged here, and no error carries the JWT.

const endpoint = "GET /v1/bridge/plugins/{plugin}/{path}"

// The bridge's transport timeout for artefacts; the whole answer, body included.
const timeout = Duration.seconds(60)

/** Plugin bundle files are scripts, agents and themes: anything larger than this is refused. */
export const limit = 8 * 1024 * 1024

export const file = Effect.fn("SpPlugins.file")(function* (baseUrl: string, jwt: string, plugin: string, path: string) {
  // The bridge's `safe_plugin_id`, and a path of plain segments only: neither may leave the plugin's route.
  if (plugin === "" || /\.\.|[/\\]|^\./.test(plugin))
    return yield* new Protocol({ endpoint, message: "the plugin id is not a single safe segment" })
  const segments = path.split("/")
  if (path.includes("\\") || segments.some((segment) => segment === "" || segment === "." || segment === ".."))
    return yield* new Protocol({ endpoint, message: "the file path is not a plain relative path" })
  const base = yield* instanceUrl(baseUrl)
  const url = `${base}/v1/bridge/plugins/${encodeURIComponent(plugin)}/${segments.map(encodeURIComponent).join("/")}`
  const unreachable = (message: string) => new Unreachable({ endpoint, message })
  const answer = yield* Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${jwt}` },
        // A redirect is never followed: it could carry the JWT to another origin
        redirect: "manual",
        signal,
      })
      return { status: response.status, bytes: await bounded(response) }
    },
    // A fixed message: a fetch error can quote request headers, and so the JWT
    catch: () => unreachable("the request failed"),
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () => Effect.fail(unreachable(`no answer within ${Duration.format(timeout)}`)),
    }),
  )
  if (answer.bytes === undefined)
    return yield* new Protocol({ endpoint, message: "the file is larger than allowed", status: answer.status })
  if (answer.status === 200) return answer.bytes
  const message = errorMessage(answer.bytes) ?? `status ${answer.status}`
  if (answer.status === 401) return yield* new Unauthorized({ endpoint, message })
  if (answer.status === 429) return yield* new RateLimited({ endpoint, message })
  if (answer.status >= 500) return yield* new Unreachable({ endpoint, message, status: answer.status })
  return yield* new Protocol({ endpoint, message, status: answer.status })
})

// The body, or undefined once it passes `limit` bytes.
async function bounded(response: Response) {
  if (Number(response.headers.get("content-length") ?? 0) > limit) return undefined
  const chunks: Uint8Array[] = []
  const total = { bytes: 0 }
  for await (const chunk of response.body ?? []) {
    total.bytes += chunk.length
    if (total.bytes > limit) return undefined
    chunks.push(chunk)
  }
  return new Uint8Array(Buffer.concat(chunks))
}

const Envelope = Schema.Struct({ message: Schema.optional(Schema.String) })
const decodeEnvelope = Schema.decodeUnknownOption(Schema.fromJsonString(Envelope))

function errorMessage(bytes: Uint8Array) {
  const envelope = decodeEnvelope(Buffer.from(bytes).toString("utf8"))
  return envelope._tag === "Some" ? envelope.value.message : undefined
}

// The account's base URL as the client checks it: https, or http on loopback only, without credentials.
const instanceUrl = (baseUrl: string) => {
  const url = URL.canParse(baseUrl) ? new URL(baseUrl) : undefined
  const local = url !== undefined && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  if (
    url === undefined ||
    !(url.protocol === "https:" || (url.protocol === "http:" && local)) ||
    url.username !== "" ||
    url.password !== ""
  )
    return Effect.fail(
      new Protocol({ endpoint: "base URL", message: "the instance URL must use https unless it is local" }),
    )
  return Effect.succeed(`${url.origin}${url.pathname.replace(/\/+$/, "")}`)
}
