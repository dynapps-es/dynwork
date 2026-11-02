import { Cause, Deferred, Effect, Queue } from "effect"
import { Closed } from "./errors"
import type { Link } from "./peer"

// The relay link over a WebSocket: one binary message per envelope (or relay presence message), both ways. Written
// against the WHATWG WebSocket shape that Bun, Electron's main process (Node's WebSocket) and React Native share; the
// caller constructs the socket, with the `Authorization` header its runtime lets it set.

export const basePath = "/api/dynwork/relay/v1"

// The relay socket of an instance: `desktop` for DynWork, `device` for a phone. Plain `ws:` follows plain `http:`, which
// the callers allow on loopback only.
export function url(instance: string, end: "desktop" | "device") {
  return `${instance.replace(/\/+$/, "").replace(/^http/, "ws")}${basePath}/${end}`
}

// The runtime's own WebSocket (Bun, Node's in Electron main, React Native's).
export type WebSocketLike = WebSocket

export type Ending = { code: number; reason: string }

export type SocketLink = Link & {
  // Closes the socket; `incoming` then fails with `Closed`
  close: (code?: number, reason?: string) => void
  // Completes when the socket has closed, with the relay's close code
  ended: Effect.Effect<Ending>
}

const open = 1

// The relay closes a socket that sends more than 500 envelopes a second (burst 1000) or 8 MiB a second (burst 16 MiB)
// with 1008. A burst of small frames, such as an SSE stream of short events, would pass that at once, so the link
// paces what it sends below those limits, in order. The replay window bounds how much can wait here.
export const pace = { rate: 400, burst: 800, bytesPerSecond: 6 * 1024 * 1024, byteBurst: 12 * 1024 * 1024 }

export type Pace = typeof pace

// Waits for the socket to open and returns the link. Fails with `Closed` (reason `refused`) when the socket closes
// first: the relay answers a refused credential with plain HTTP before the upgrade, which a WebSocket only reports
// as a close.
export function link(socket: WebSocketLike, limits: Pace = pace): Effect.Effect<SocketLink, Closed> {
  return Effect.gen(function* () {
    socket.binaryType = "arraybuffer"
    const incoming = yield* Queue.unbounded<Uint8Array, Closed>()
    const opened = Deferred.makeUnsafe<void, Closed>()
    const ended = Deferred.makeUnsafe<Ending>()
    socket.onopen = () => Deferred.doneUnsafe(opened, Effect.void)
    socket.onmessage = (event) => {
      const data = event.data
      if (data instanceof ArrayBuffer) Queue.offerUnsafe(incoming, new Uint8Array(data))
      else if (ArrayBuffer.isView(data))
        Queue.offerUnsafe(incoming, new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
    }
    socket.onerror = () => {}
    socket.onclose = (event) => {
      const ending = { code: event.code, reason: event.reason }
      Deferred.doneUnsafe(opened, Effect.fail(new Closed({ reason: "refused" })))
      Queue.failCauseUnsafe(incoming, Cause.fail(new Closed({ reason: `relay:${event.code}` })))
      Deferred.doneUnsafe(ended, Effect.succeed(ending))
    }
    const sender = paced(socket, limits)
    const result: SocketLink = {
      incoming,
      send: sender,
      close: (code, reason) => socket.close(code ?? 1000, reason),
      ended: Deferred.await(ended),
    }
    yield* Deferred.await(opened).pipe(Effect.onInterrupt(() => Effect.sync(() => socket.close(1000))))
    return result
  })
}

// Sends in order, at most `limits` allow: two token buckets, envelopes and bytes, refilled by elapsed time.
function paced(socket: WebSocketLike, limits: Pace) {
  const state = {
    envelopes: limits.burst,
    bytes: limits.byteBurst,
    at: Date.now(),
    waiting: [] as Uint8Array[],
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
  }
  const drain = () => {
    const now = Date.now()
    const elapsed = (now - state.at) / 1000
    state.at = now
    state.envelopes = Math.min(limits.burst, state.envelopes + elapsed * limits.rate)
    state.bytes = Math.min(limits.byteBurst, state.bytes + elapsed * limits.bytesPerSecond)
    while (state.waiting.length > 0) {
      if (socket.readyState !== open) {
        state.waiting.length = 0
        return
      }
      const next = state.waiting[0]!
      if (state.envelopes < 1 || state.bytes < next.length) break
      state.envelopes -= 1
      state.bytes -= next.length
      state.waiting.shift()
      socket.send(new Uint8Array(next))
    }
    if (state.waiting.length === 0 || state.timer !== undefined) return
    const next = state.waiting[0]!
    const wait = Math.max((1 - state.envelopes) / limits.rate, (next.length - state.bytes) / limits.bytesPerSecond)
    state.timer = setTimeout(
      () => {
        state.timer = undefined
        drain()
      },
      Math.max(1, Math.ceil(wait * 1000)),
    )
  }
  return (bytes: Uint8Array) => {
    if (socket.readyState !== open) return
    state.waiting.push(bytes)
    drain()
  }
}
