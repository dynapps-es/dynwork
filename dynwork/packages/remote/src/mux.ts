import { Cause, Deferred, Effect, Exit, Queue, Schema, Scope, Semaphore, Stream } from "effect"
import { empty, fromUtf8, readU32, utf8, writeU32 } from "./bytes"
import { Closed, StreamReset } from "./errors"
import { Flag, Kind, maxPayload, type Frame } from "./frame"
import type { Outgoing } from "./session"

// Logical streams over one session: HTTP request and response, fetch with a streamed (SSE) body, and WebSocket
// messages. Every stream has credit-based flow control per direction: a sender writes at most `window` bytes of data
// the receiver has not consumed yet, and the receiver grants more as its reader takes them. A slow reader therefore
// holds back exactly its own stream. Nothing here knows about any particular HTTP API.

// Bytes a sender may have unconsumed in flight on one stream, per direction.
export const window = 256 * 1024
// Streams one side may have open at once; an open past it is reset with `refused`.
export const maxStreams = 256
// The largest WebSocket message either side reassembles; a larger one resets the stream with `message-too-large`.
export const maxMessage = 16 * 1024 * 1024

export type Headers = Record<string, string>

export type Request = {
  method: string
  path: string
  headers?: Headers
  body?: Uint8Array | Stream.Stream<Uint8Array, StreamReset | Closed>
}

export type Response = {
  status: number
  headers: Headers
  body: Stream.Stream<Uint8Array, StreamReset | Closed>
  // Resets the stream: the peer stops sending and its writer fails with `StreamReset`
  cancel: Effect.Effect<void>
}

export type Message = string | Uint8Array

export type Socket = {
  protocol?: string
  send: (message: Message) => Effect.Effect<void, StreamReset | Closed>
  // Ends when the peer closes its side
  messages: Stream.Stream<Message, StreamReset | Closed>
  close: Effect.Effect<void, StreamReset | Closed>
}

export type Incoming =
  | {
      type: "http"
      method: string
      path: string
      headers: Headers
      body: Stream.Stream<Uint8Array, StreamReset | Closed>
      // Answers the request. When the request body is not finished by the end of the response, the rest is refused
      // with a `no-error` reset, so a client uploading into an early answer (a 413) stops instead of stalling.
      respond: (
        head: { status: number; headers?: Headers },
        body?: Uint8Array | Stream.Stream<Uint8Array, StreamReset | Closed>,
      ) => Effect.Effect<void, StreamReset | Closed>
    }
  | {
      type: "ws"
      path: string
      headers: Headers
      protocols: readonly string[]
      accept: (protocol?: string) => Effect.Effect<Socket, StreamReset | Closed>
      reject: (status: number) => Effect.Effect<void, StreamReset | Closed>
    }

export type Handler = (incoming: Incoming) => Effect.Effect<void, unknown>

const Open = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("http"),
    method: Schema.String,
    path: Schema.String,
    headers: Schema.Record(Schema.String, Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("ws"),
    path: Schema.String,
    headers: Schema.Record(Schema.String, Schema.String),
    protocols: Schema.Array(Schema.String),
  }),
])

const Head = Schema.Struct({
  status: Schema.Number,
  headers: Schema.Record(Schema.String, Schema.String),
  protocol: Schema.optional(Schema.String),
})

const decodeOpen = Schema.decodeUnknownOption(Schema.fromJsonString(Open))
const decodeHead = Schema.decodeUnknownOption(Schema.fromJsonString(Head))

type Chunk = { payload: Uint8Array; flags: number; cost: number }

type StreamError = StreamReset | Closed

// What a data frame costs in credit: its length, and at least 1 so empty frames cannot be sent for free. Only the
// empty final frame is free; it ends the stream.
function cost(payload: Uint8Array, flags: number) {
  if (payload.length === 0 && flags & Flag.Fin) return 0
  return Math.max(1, payload.length)
}

class Signal {
  #waiters: Deferred.Deferred<void>[] = []

  wait() {
    return Effect.suspend(() => {
      const waiter = Deferred.makeUnsafe<void>()
      this.#waiters.push(waiter)
      return Deferred.await(waiter)
    })
  }

  notify() {
    const waiters = this.#waiters.splice(0)
    waiters.forEach((waiter) => Deferred.doneUnsafe(waiter, Effect.void))
  }
}

class Channel {
  readonly id: number
  // Credit this side may still spend
  credit = window
  // Credit the peer may still spend
  allowance = window
  // Credit the reader took since the last grant
  consumed = 0
  readonly changed = new Signal()
  readonly inbound = Effect.runSync(Queue.unbounded<Chunk, StreamError | Cause.Done>())
  readonly head = Deferred.makeUnsafe<Head, StreamError>()
  // The fiber that sends a request body lives here, so it ends with the stream
  readonly scope = Scope.makeUnsafe()
  // WebSocket messages go out whole: fragments of two messages never interleave
  readonly sending = Semaphore.makeUnsafe(1)
  failure: StreamError | undefined
  sentFin = false
  receivedFin = false

  constructor(id: number) {
    this.id = id
  }
}

type Head = typeof Head.Type

export class Mux {
  readonly #write: (frame: Outgoing) => Effect.Effect<void, Closed>
  readonly #streams = new Map<number, Channel>()
  #next: number
  #handler: Handler | undefined
  #closed: Closed | undefined

  // The phone opens odd stream ids, the desktop even ones, so both can open without colliding.
  constructor(input: { write: (frame: Outgoing) => Effect.Effect<void, Closed>; initiator: boolean }) {
    this.#write = input.write
    this.#next = input.initiator ? 1 : 2
  }

  get open() {
    return this.#streams.size
  }

  serve(handler: Handler) {
    this.#handler = handler
  }

  // An interrupted caller resets the stream: nothing is left behind on either side.
  fetch(request: Request) {
    const self = this
    return Effect.gen(function* () {
      const channel = yield* self.#start(
        { type: "http", method: request.method, path: request.path, headers: request.headers ?? {} },
        request.body === undefined,
      )
      return yield* Effect.gen(function* () {
        if (request.body !== undefined)
          yield* self.#sendBody(channel, request.body).pipe(Effect.forkIn(channel.scope, { startImmediately: true }))
        const head = yield* Deferred.await(channel.head)
        return {
          status: head.status,
          headers: head.headers,
          body: self.#body(channel),
          cancel: self.#reset(channel, "cancel"),
        } satisfies Response
      }).pipe(Effect.onInterrupt(() => self.#reset(channel, "cancel")))
    })
  }

  websocket(request: { path: string; headers?: Headers; protocols?: readonly string[] }) {
    const self = this
    return Effect.gen(function* () {
      const channel = yield* self.#start(
        { type: "ws", path: request.path, headers: request.headers ?? {}, protocols: [...(request.protocols ?? [])] },
        false,
      )
      const head = yield* Deferred.await(channel.head).pipe(Effect.onInterrupt(() => self.#reset(channel, "cancel")))
      if (head.status !== 101) {
        // The desktop already finished and forgot the stream; only this side is left to clean
        self.#fail(channel, new StreamReset({ stream: channel.id, code: `rejected:${head.status}` }))
        return yield* channel.failure!
      }
      return self.#socket(channel, head.protocol)
    })
  }

  // Routes one frame of a stream (stream 0 belongs to the session).
  receive(frame: Frame) {
    const self = this
    return Effect.gen(function* () {
      if (frame.kind === Kind.Open) return yield* self.#opened(frame)
      const channel = self.#streams.get(frame.stream)
      if (channel === undefined) return
      if (frame.kind === Kind.Reset) return self.#peerReset(channel, fromUtf8(frame.payload) ?? "unknown")
      if (frame.kind === Kind.Credit) {
        const grant = frame.payload.length === 4 ? readU32(frame.payload, 0) : 0
        // A receiver only returns what it took, so credit never exceeds the window
        if (grant === 0 || channel.credit + grant > window) return yield* self.#reset(channel, "flow-control")
        channel.credit += grant
        channel.changed.notify()
        return
      }
      if (frame.kind === Kind.Headers) {
        const head = decodeHead(fromUtf8(frame.payload))
        if (head._tag === "None") return yield* self.#reset(channel, "protocol")
        Deferred.doneUnsafe(channel.head, Effect.succeed(head.value))
        return
      }
      if (frame.kind !== Kind.Data || channel.receivedFin) return
      const spent = cost(frame.payload, frame.flags)
      if (spent > channel.allowance) return yield* self.#reset(channel, "flow-control")
      channel.allowance -= spent
      if (spent > 0) Queue.offerUnsafe(channel.inbound, { payload: frame.payload, flags: frame.flags, cost: spent })
      if (frame.flags & Flag.Fin) {
        channel.receivedFin = true
        Queue.endUnsafe(channel.inbound)
        self.#settle(channel)
      }
    })
  }

  // Fails every stream: the session is gone for good.
  close(error: Closed) {
    this.#closed = error
    ;[...this.#streams.values()].forEach((channel) => this.#fail(channel, error))
  }

  // The open request is checked before anything is registered or sent.
  #start(open: typeof Open.Type, fin: boolean) {
    const self = this
    return Effect.gen(function* () {
      if (self.#closed) return yield* self.#closed
      const payload = utf8(JSON.stringify(open))
      if (payload.length > maxPayload) return yield* new StreamReset({ stream: 0, code: "headers-too-large" })
      const channel = new Channel(self.#next)
      self.#next += 2
      self.#streams.set(channel.id, channel)
      channel.sentFin = fin
      yield* self
        .#write({ kind: Kind.Open, stream: channel.id, flags: fin ? Flag.Fin : 0, payload })
        .pipe(
          Effect.onError(() =>
            Effect.sync(() => self.#fail(channel, new StreamReset({ stream: channel.id, code: "cancel" }))),
          ),
        )
      return channel
    })
  }

  #opened(frame: Frame) {
    const self = this
    return Effect.gen(function* () {
      const reject = (code: string) =>
        self.#write({ kind: Kind.Reset, stream: frame.stream, flags: 0, payload: utf8(code) })
      const ours = frame.stream % 2 === self.#next % 2
      if (ours || frame.stream === 0 || self.#streams.has(frame.stream)) return yield* reject("protocol")
      if (self.#streams.size >= maxStreams || self.#handler === undefined) return yield* reject("refused")
      const open = decodeOpen(fromUtf8(frame.payload))
      if (open._tag === "None") return yield* reject("protocol")
      const channel = new Channel(frame.stream)
      self.#streams.set(channel.id, channel)
      if (frame.flags & Flag.Fin) {
        channel.receivedFin = true
        Queue.endUnsafe(channel.inbound)
      }
      const handler = self.#handler
      const incoming = self.#incoming(channel, open.value)
      // A handler that returns without finishing its side resets the stream.
      yield* handler(incoming).pipe(
        Effect.catchCause(() => Effect.void),
        Effect.flatMap(() => (channel.sentFin ? Effect.void : self.#reset(channel, "error"))),
        Effect.forkDetach({ startImmediately: true }),
      )
    })
  }

  #incoming(channel: Channel, open: typeof Open.Type): Incoming {
    const self = this
    if (open.type === "http")
      return {
        type: "http",
        method: open.method,
        path: open.path,
        headers: open.headers,
        body: self.#body(channel),
        respond: (head, body) =>
          Effect.gen(function* () {
            yield* self.#head(channel, { status: head.status, headers: head.headers ?? {} })
            yield* self.#sendBody(channel, body ?? empty)
            yield* self.#finished(channel)
          }),
      }
    return {
      type: "ws",
      path: open.path,
      headers: open.headers,
      protocols: open.protocols,
      accept: (protocol) =>
        self.#head(channel, { status: 101, headers: {}, protocol }).pipe(Effect.as(self.#socket(channel, protocol))),
      reject: (status) =>
        Effect.gen(function* () {
          yield* self.#head(channel, { status, headers: {} })
          yield* self.#data(channel, empty, Flag.Fin)
          yield* self.#finished(channel)
        }),
    }
  }

  // The answering side is done. What the peer still sends on the stream is refused, and the stream forgotten.
  #finished(channel: Channel) {
    return Effect.suspend(() => {
      if (channel.receivedFin || channel.failure) return Effect.void
      this.#fail(channel, new StreamReset({ stream: channel.id, code: "no-error" }))
      return this.#write({ kind: Kind.Reset, stream: channel.id, flags: 0, payload: utf8("no-error") }).pipe(
        Effect.ignore,
      )
    })
  }

  #head(channel: Channel, head: Head) {
    const self = this
    return Effect.gen(function* () {
      yield* self.#guard(channel)
      const payload = utf8(JSON.stringify(head))
      if (payload.length > maxPayload) {
        yield* self.#reset(channel, "headers-too-large")
        return yield* new StreamReset({ stream: channel.id, code: "headers-too-large" })
      }
      yield* self.#write({ kind: Kind.Headers, stream: channel.id, flags: 0, payload })
    })
  }

  #socket(channel: Channel, protocol: string | undefined): Socket {
    const self = this
    return {
      protocol,
      // Each fragment spends credit like a body chunk; an empty message costs one byte.
      send: (message) =>
        channel.sending.withPermit(
          Effect.gen(function* () {
            const text = typeof message === "string"
            const bytes = text ? utf8(message) : message
            if (bytes.length > maxMessage)
              return yield* new StreamReset({ stream: channel.id, code: "message-too-large" })
            for (let at = 0; ; ) {
              const length = bytes.length === 0 ? 0 : yield* self.#take(channel, bytes.length - at)
              if (bytes.length === 0) yield* self.#take(channel, 1)
              const more = at + length < bytes.length
              yield* self.#data(
                channel,
                bytes.subarray(at, at + length),
                (text ? Flag.Text : 0) | (more ? Flag.More : 0),
              )
              at += length
              if (!more) return
            }
          }),
        ),
      messages: Stream.fromEffectRepeat(self.#message(channel)),
      close: self.#data(channel, empty, Flag.Fin),
    }
  }

  // Takes fragments up to the end of one message, refusing to hold more than `maxMessage` bytes of it.
  #message(channel: Channel) {
    const self = this
    return Effect.gen(function* () {
      const parts: Uint8Array[] = []
      const size = { bytes: 0 }
      while (true) {
        const chunk = yield* self.#pull(channel)
        size.bytes += chunk.payload.length
        if (size.bytes > maxMessage) {
          yield* self.#reset(channel, "message-too-large")
          return yield* new StreamReset({ stream: channel.id, code: "message-too-large" })
        }
        parts.push(chunk.payload)
        if (chunk.flags & Flag.More) continue
        const bytes = join(parts)
        if (!(chunk.flags & Flag.Text)) return bytes as Message
        const text = fromUtf8(bytes)
        if (text !== undefined) return text as Message
        yield* self.#reset(channel, "protocol")
        return yield* new StreamReset({ stream: channel.id, code: "protocol" })
      }
    })
  }

  // One frame from the peer; what the reader takes is credited back.
  #pull(channel: Channel) {
    return Queue.take(channel.inbound).pipe(
      Effect.flatMap((chunk) => this.#consumed(channel, chunk.cost).pipe(Effect.as(chunk))),
    )
  }

  // The stream's data one frame per pull, so what the reader has not taken is not credited back to the peer.
  #body(channel: Channel) {
    return Stream.fromEffectRepeat(this.#pull(channel)).pipe(Stream.map((chunk) => chunk.payload))
  }

  #consumed(channel: Channel, spent: number) {
    return Effect.suspend(() => {
      channel.consumed += spent
      if (channel.consumed < window / 2 || channel.receivedFin || channel.failure) return Effect.void
      const grant = channel.consumed
      channel.consumed = 0
      channel.allowance += grant
      const payload = new Uint8Array(4)
      writeU32(payload, 0, grant)
      return this.#write({ kind: Kind.Credit, stream: channel.id, flags: 0, payload }).pipe(Effect.ignore)
    })
  }

  #sendBody(channel: Channel, body: Uint8Array | Stream.Stream<Uint8Array, StreamError>) {
    const self = this
    const stream = body instanceof Uint8Array ? Stream.make(body) : body
    return stream.pipe(
      Stream.runForEach((bytes) =>
        Effect.gen(function* () {
          for (let at = 0; at < bytes.length; ) {
            const length = yield* self.#take(channel, bytes.length - at)
            yield* self.#data(channel, bytes.subarray(at, at + length), 0)
            at += length
          }
        }),
      ),
      Effect.flatMap(() => self.#data(channel, empty, Flag.Fin)),
      Effect.tapError(() => self.#reset(channel, "error")),
    )
  }

  // Waits for credit, then claims up to `wanted` bytes of it (one frame at most).
  #take(channel: Channel, wanted: number): Effect.Effect<number, StreamError> {
    return Effect.suspend(() => {
      if (channel.failure) return Effect.fail(channel.failure)
      if (channel.credit > 0) {
        const length = Math.min(wanted, channel.credit, maxPayload)
        channel.credit -= length
        return Effect.succeed(length)
      }
      return channel.changed.wait().pipe(Effect.flatMap(() => this.#take(channel, wanted)))
    })
  }

  // The stream is settled only after its final frame is written: settling closes its scope, which would interrupt a
  // body sender still writing that frame.
  #data(channel: Channel, payload: Uint8Array, flags: number) {
    return this.#guard(channel).pipe(
      Effect.flatMap(() => {
        if (flags & Flag.Fin) channel.sentFin = true
        return this.#write({ kind: Kind.Data, stream: channel.id, flags, payload })
      }),
      Effect.andThen(Effect.sync(() => (flags & Flag.Fin ? this.#settle(channel) : undefined))),
    )
  }

  #guard(channel: Channel) {
    return Effect.suspend(() => {
      if (channel.failure) return Effect.fail(channel.failure)
      if (channel.sentFin) return Effect.fail(new StreamReset({ stream: channel.id, code: "finished" }))
      return Effect.void
    })
  }

  #reset(channel: Channel, code: string) {
    return Effect.suspend(() => {
      if (channel.failure || (channel.sentFin && channel.receivedFin)) return Effect.void
      this.#fail(channel, new StreamReset({ stream: channel.id, code }))
      return this.#write({ kind: Kind.Reset, stream: channel.id, flags: 0, payload: utf8(code) }).pipe(Effect.ignore)
    })
  }

  // A reset after the peer already finished its side (`no-error` after a response) stops only this side's sending:
  // what arrived stays readable.
  #peerReset(channel: Channel, code: string) {
    if (!channel.receivedFin) return this.#fail(channel, new StreamReset({ stream: channel.id, code }))
    channel.failure ??= new StreamReset({ stream: channel.id, code })
    this.#forget(channel)
  }

  #fail(channel: Channel, error: StreamError) {
    if (channel.failure) return
    channel.failure = error
    Queue.failCauseUnsafe(channel.inbound, Cause.fail(error))
    Deferred.doneUnsafe(channel.head, Effect.fail(error))
    this.#forget(channel)
  }

  // A stream both sides finished is forgotten.
  #settle(channel: Channel) {
    if (channel.sentFin && channel.receivedFin) this.#forget(channel)
  }

  #forget(channel: Channel) {
    channel.changed.notify()
    this.#streams.delete(channel.id)
    const finalizers = Scope.closeUnsafe(channel.scope, Exit.void)
    if (finalizers) Effect.runFork(finalizers)
  }
}

function join(parts: Uint8Array[]) {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  parts.reduce((at, part) => {
    bytes.set(part, at)
    return at + part.length
  }, 0)
  return bytes
}
