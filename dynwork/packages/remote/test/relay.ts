import { Cause, Effect, Queue } from "effect"
import { toBase64Url } from "../src/bytes"
import { Closed, Remote, Session } from "../src"

// An in-memory relay with the behaviour relay-protocol.md asks of the real one: route by `to`, overwrite `from` with
// the authenticated sender, keep each (from, to) pair in order, and drop what is addressed to a peer with no socket.
// Tests reach into it the way a hostile relay could: rewrite (including `to` and `from`), drop, duplicate or reorder
// envelopes, and read every byte that crossed it.
export class Relay {
  readonly #sockets = new Map<string, Queue.Queue<Uint8Array, Closed>>()
  // Every envelope as the relay received it, in order
  readonly seen: Uint8Array[] = []
  // Rewrites what the relay forwards; returns the envelopes to deliver instead (none drops it)
  intercept: ((envelope: Uint8Array) => Uint8Array[]) | undefined

  // Delivers an envelope as if a peer had sent it again: what a relay replaying traffic does
  inject(envelope: Uint8Array) {
    const socket = this.#sockets.get(toBase64Url(envelope.subarray(1, 17)))
    if (socket) Queue.offerUnsafe(socket, envelope)
  }

  connect(id: Uint8Array): Remote.Link & { drop: () => void } {
    const key = toBase64Url(id)
    const incoming = Effect.runSync(Queue.unbounded<Uint8Array, Closed>())
    this.#sockets.set(key, incoming)
    return {
      incoming,
      send: (bytes) => {
        if (this.#sockets.get(key) !== incoming) return
        const envelope = bytes.slice()
        envelope.set(id, 17)
        this.seen.push(envelope.slice())
        const deliveries = this.intercept ? this.intercept(envelope) : [envelope]
        deliveries.forEach((delivery) => {
          const socket = this.#sockets.get(toBase64Url(delivery.subarray(1, 17)))
          if (socket) Queue.offerUnsafe(socket, delivery)
        })
      },
      drop: () => {
        if (this.#sockets.get(key) === incoming) this.#sockets.delete(key)
        Queue.failCauseUnsafe(incoming, Cause.fail(new Closed({ reason: "dropped" })))
      },
    }
  }
}

// Two ends of one channel without a relay, for the session-level tests.
export function wires() {
  const a = Effect.runSync(Queue.unbounded<Uint8Array>())
  const b = Effect.runSync(Queue.unbounded<Uint8Array>())
  const end = (inbox: Queue.Queue<Uint8Array>, outbox: Queue.Queue<Uint8Array>): Session.Wire => ({
    send: (message) => Effect.sync(() => void Queue.offerUnsafe(outbox, message)),
    receive: Queue.take(inbox),
  })
  return { phone: end(a, b), desktop: end(b, a), toPhone: a, toDesktop: b }
}

export function includes(haystack: Uint8Array, needle: Uint8Array) {
  if (needle.length === 0) return true
  for (let at = 0; at + needle.length <= haystack.length; at++)
    if (needle.every((byte, index) => haystack[at + index] === byte)) return true
  return false
}
