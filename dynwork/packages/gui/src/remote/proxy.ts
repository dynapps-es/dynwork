export * as RemoteProxy from "./proxy"

import { Effect, Stream } from "effect"
import type { Mux } from "@dynwork/remote"
import type { ServerEndpoint } from "@opencode/plugin/gui/main"
import { RemoteAllowlist } from "./allowlist"

// What answers a paired phone's streams: DynWork's OpenCode service through the allowlist, nothing else. Requests go
// to the endpoint main knows (`ServerEndpoints`), with a session token this proxy mints from the service's own
// pairing (`POST /api/pair`, then `/auth/connect/:code`); the service password never leaves main. The phone may read
// that token at `tokenPath`, inside the encrypted channel only (decision A5).

/** Answered here, never forwarded: `{ token }`, the OpenCode session token the phone's requests run under. */
export const tokenPath = "/dynwork/remote/v1/session"

/** The largest request body forwarded; a bigger one answers 413. */
export const maxBody = 16 * 1024 * 1024

export type Log = (level: "info" | "warn", message: string, data?: Record<string, unknown>) => void

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export function make(input: { endpoint: () => ServerEndpoint | undefined; fetch?: Fetch; log: Log }) {
  const send = input.fetch ?? fetch
  const held: { token?: Promise<string | undefined> } = {}

  // Mints once and keeps it in memory; a refused token is minted again on the next request.
  const token = (endpoint: ServerEndpoint) => {
    held.token ??= mint(endpoint, send).catch((error: Error) => {
      input.log("warn", "remote: minting the session token failed", { error: error.message })
      held.token = undefined
      return undefined
    })
    return held.token
  }

  const handler: Mux.Handler = (incoming) => {
    if (incoming.type === "ws") return incoming.reject(403)
    return Effect.gen(function* () {
      const endpoint = input.endpoint()
      if (!endpoint) return yield* incoming.respond({ status: 503 })
      if (incoming.method === "GET" && incoming.path === tokenPath) {
        const minted = yield* Effect.promise(() => token(endpoint))
        if (!minted) return yield* incoming.respond({ status: 503 })
        return yield* incoming.respond(
          { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } },
          new TextEncoder().encode(JSON.stringify({ token: minted })),
        )
      }
      if (!RemoteAllowlist.match(incoming.method, incoming.path)) return yield* incoming.respond({ status: 403 })
      const body = incoming.method === "GET" || incoming.method === "HEAD" ? undefined : yield* collect(incoming.body)
      if (body === "too-large") return yield* incoming.respond({ status: 413 })
      const minted = yield* Effect.promise(() => token(endpoint))
      const headers = forwarded(incoming.headers, endpoint, minted)
      const reached = yield* Effect.tryPromise((signal) =>
        send(`${endpoint.url.replace(/\/+$/, "")}${incoming.path}`, {
          method: incoming.method,
          headers,
          body: body === undefined ? undefined : new Uint8Array(body),
          signal,
          redirect: "manual",
        }),
      ).pipe(Effect.option)
      if (reached._tag === "None") return yield* incoming.respond({ status: 502 })
      const answer = reached.value
      if (answer.status === 401 && minted) held.token = undefined
      const responseHeaders = Object.fromEntries(
        RemoteAllowlist.responseHeaders.flatMap((name) => {
          const value = answer.headers.get(name)
          return value === null ? [] : [[name, value]]
        }),
      )
      if (!answer.body) return yield* incoming.respond({ status: answer.status, headers: responseHeaders })
      const stream = answer.body
      yield* incoming.respond(
        { status: answer.status, headers: responseHeaders },
        // Bursts of small chunks (an SSE stream's events) travel as one frame each 10 ms at most
        Stream.fromReadableStream({ evaluate: () => stream, onError: (error) => error }).pipe(
          Stream.groupedWithin(256, "10 millis"),
          Stream.map(join),
          Stream.orDie,
        ),
      )
    }).pipe(Effect.catchCause(() => Effect.void))
  }

  return { handler, forget: () => (held.token = undefined) }
}

export type Proxy = ReturnType<typeof make>

// The phone's headers that the allowlist passes, then the service's credentials: the session token as the password,
// or the endpoint's own headers when no token could be minted (a service without a password needs none).
function forwarded(headers: Mux.Headers, endpoint: ServerEndpoint, token: string | undefined) {
  const passed = Object.fromEntries(
    Object.entries(headers).filter((entry) => RemoteAllowlist.requestHeaders.includes(entry[0].toLowerCase())),
  )
  if (!token) return { ...passed, ...endpoint.headers }
  const own = Object.fromEntries(
    Object.entries(endpoint.headers).filter((entry) => entry[0].toLowerCase() !== "authorization"),
  )
  return { ...passed, ...own, authorization: `Basic ${Buffer.from(`opencode:${token}`).toString("base64")}` }
}

async function mint(endpoint: ServerEndpoint, send: Fetch) {
  const base = endpoint.url.replace(/\/+$/, "")
  const code = await send(`${base}/api/pair`, { method: "POST", headers: endpoint.headers })
  if (!code.ok) throw new Error(`POST /api/pair answered ${code.status}`)
  const pairing = (await code.json()) as { code: string }
  const session = await send(`${base}/auth/connect/${encodeURIComponent(pairing.code)}`, {
    headers: { accept: "application/json" },
    redirect: "manual",
  })
  if (!session.ok) throw new Error(`redeeming the pairing code answered ${session.status}`)
  return ((await session.json()) as { token: string }).token
}

function collect(body: Stream.Stream<Uint8Array, unknown>) {
  return Effect.gen(function* () {
    const chunks: Uint8Array[] = []
    const size = { bytes: 0 }
    yield* body.pipe(
      Stream.runForEachWhile((chunk) =>
        Effect.sync(() => {
          size.bytes += chunk.length
          chunks.push(chunk)
          return size.bytes <= maxBody
        }),
      ),
    )
    return size.bytes > maxBody ? ("too-large" as const) : join(chunks)
  })
}

function join(chunks: readonly Uint8Array[]) {
  if (chunks.length === 1) return chunks[0]!
  const joined = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  chunks.reduce((at, chunk) => {
    joined.set(chunk, at)
    return at + chunk.length
  }, 0)
  return joined
}
