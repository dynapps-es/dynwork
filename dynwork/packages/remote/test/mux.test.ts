import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Stream } from "effect"
import { empty, fromUtf8, utf8, writeU32 } from "../src/bytes"
import { Frame, Mux, type Session } from "../src"

// One mux on its own, as the desktop side: the test plays the phone by feeding frames and reads what the mux writes.
const harness = (handler: Mux.Handler) => {
  const written: Session.Outgoing[] = []
  const mux = new Mux.Mux({ write: (frame) => Effect.sync(() => void written.push(frame)), initiator: false })
  mux.serve(handler)
  const receive = (frame: Partial<Frame.Frame>) =>
    mux.receive({ kind: Frame.Kind.Data, flags: 0, stream: 1, seq: 1, ack: 0, payload: empty, ...frame })
  const open = (value: object) => receive({ kind: Frame.Kind.Open, payload: utf8(JSON.stringify(value)) })
  const resets = () =>
    written.filter((frame) => frame.kind === Frame.Kind.Reset).map((frame) => fromUtf8(frame.payload) ?? "")
  const sent = () =>
    written.filter((frame) => frame.kind === Frame.Kind.Data).reduce((sum, frame) => sum + frame.payload.length, 0)
  return { mux, written, receive, open, resets, sent }
}

const ws = { type: "ws", path: "/ws", headers: {}, protocols: [] }
const http = { type: "http", method: "GET", path: "/", headers: {} }

const credit = (bytes: number) => {
  const payload = new Uint8Array(4)
  writeU32(payload, 0, bytes)
  return { kind: Frame.Kind.Credit, payload }
}

const settle = Effect.gen(function* () {
  for (let tick = 0; tick < 20; tick++) yield* Effect.yieldNow
})

describe("Mux", () => {
  test("a WebSocket message spends credit: the sender stops at the window until the peer grants more", async () => {
    await Effect.gen(function* () {
      const done = Deferred.makeUnsafe<void>()
      const h = harness((incoming) =>
        incoming.type === "ws"
          ? incoming.accept().pipe(
              Effect.flatMap((socket) => socket.send(new Uint8Array(300 * 1024))),
              Effect.andThen(Deferred.succeed(done, undefined)),
            )
          : Effect.void,
      )
      yield* h.open(ws)
      yield* settle
      expect(h.sent()).toBe(Mux.window)
      expect(yield* Deferred.isDone(done)).toBe(false)
      yield* h.receive(credit(Mux.window / 2))
      yield* Deferred.await(done)
      expect(h.sent()).toBe(300 * 1024)
      const fragments = h.written.filter((frame) => frame.kind === Frame.Kind.Data)
      expect(fragments.slice(0, -1).every((frame) => (frame.flags & Frame.Flag.More) !== 0)).toBe(true)
      expect(fragments.at(-1)!.flags & Frame.Flag.More).toBe(0)
    }).pipe(Effect.runPromise)
  })

  test("refuses a reassembled WebSocket message larger than the limit", async () => {
    await Effect.gen(function* () {
      const failure = Deferred.makeUnsafe<unknown>()
      const h = harness((incoming) =>
        incoming.type === "ws"
          ? incoming.accept().pipe(
              Effect.flatMap((socket) => Stream.runDrain(socket.messages)),
              Effect.catch((error) => Deferred.succeed(failure, error)),
            )
          : Effect.void,
      )
      yield* h.open(ws)
      const fragment = new Uint8Array(Frame.maxPayload)
      for (let sent = 0; sent <= Mux.maxMessage && h.resets().length === 0; sent += fragment.length) {
        yield* h.receive({ flags: Frame.Flag.More, payload: fragment })
        yield* settle
      }
      expect(h.resets()).toEqual(["message-too-large"])
      expect(yield* Deferred.await(failure)).toMatchObject({ _tag: "StreamReset", code: "message-too-large" })
    }).pipe(Effect.runPromise)
  })

  test("empty data frames spend credit, so a peer cannot queue them for free", async () => {
    await Effect.gen(function* () {
      const h = harness((incoming) =>
        incoming.type === "ws" ? incoming.accept().pipe(Effect.andThen(Effect.never)) : Effect.void,
      )
      yield* h.open(ws)
      yield* settle
      const full = new Uint8Array(Frame.maxPayload)
      for (let index = 0; index < 4; index++) yield* h.receive({ payload: full })
      for (let index = 0; index < Mux.window - 4 * Frame.maxPayload; index++) yield* h.receive({ payload: empty })
      expect(h.resets()).toEqual([])
      yield* h.receive({ payload: empty })
      expect(h.resets()).toEqual(["flow-control"])
    }).pipe(Effect.runPromise)
  })

  test("refuses a credit grant past the window", async () => {
    await Effect.gen(function* () {
      const h = harness(() => Effect.never)
      yield* h.open(http)
      yield* h.receive(credit(1))
      expect(h.resets()).toEqual(["flow-control"])
    }).pipe(Effect.runPromise)
  })

  test("an open request too large for a frame fails typed and leaves nothing behind", async () => {
    await Effect.gen(function* () {
      const written: Session.Outgoing[] = []
      const mux = new Mux.Mux({ write: (frame) => Effect.sync(() => void written.push(frame)), initiator: true })
      const exit = yield* Effect.exit(
        mux.fetch({ method: "GET", path: "/", headers: { cookie: "x".repeat(Frame.maxPayload) } }),
      )
      expect(Exit.isFailure(exit) && Exit.hasFails(exit)).toBe(true)
      expect(yield* Effect.flip(mux.fetch({ method: "GET", path: "/" + "y".repeat(Frame.maxPayload) }))).toMatchObject({
        _tag: "StreamReset",
        code: "headers-too-large",
      })
      expect(mux.open).toBe(0)
      expect(written).toEqual([])
    }).pipe(Effect.runPromise)
  })

  test("a response head too large for a frame resets the stream with headers-too-large", async () => {
    await Effect.gen(function* () {
      const failure = Deferred.makeUnsafe<unknown>()
      const h = harness((incoming) =>
        incoming.type === "http"
          ? incoming
              .respond({ status: 200, headers: { big: "z".repeat(Frame.maxPayload) } })
              .pipe(Effect.catch((error) => Deferred.succeed(failure, error)))
          : Effect.void,
      )
      yield* h.receive({ kind: Frame.Kind.Open, flags: Frame.Flag.Fin, payload: utf8(JSON.stringify(http)) })
      expect(yield* Deferred.await(failure)).toMatchObject({ _tag: "StreamReset", code: "headers-too-large" })
      expect(h.resets()).toEqual(["headers-too-large"])
      expect(h.mux.open).toBe(0)
    }).pipe(Effect.runPromise)
  })

  test("an interrupted fetch resets its stream and stops its body sender", async () => {
    await Effect.gen(function* () {
      const written: Session.Outgoing[] = []
      const mux = new Mux.Mux({ write: (frame) => Effect.sync(() => void written.push(frame)), initiator: true })
      const pulls = { count: 0 }
      const body = Stream.fromEffectRepeat(Effect.sync(() => (pulls.count++, new Uint8Array(1024))))
      const fiber = yield* mux
        .fetch({ method: "POST", path: "/", body })
        .pipe(Effect.forkChild({ startImmediately: true }))
      yield* settle
      expect(mux.open).toBe(1)
      yield* Fiber.interrupt(fiber)
      expect(mux.open).toBe(0)
      expect(written.at(-1)).toMatchObject({ kind: Frame.Kind.Reset, payload: utf8("cancel") })
      const stopped = pulls.count
      yield* settle
      expect(pulls.count).toBe(stopped)
    }).pipe(Effect.runPromise)
  })

  test("an interrupted WebSocket upgrade resets its stream", async () => {
    await Effect.gen(function* () {
      const written: Session.Outgoing[] = []
      const mux = new Mux.Mux({ write: (frame) => Effect.sync(() => void written.push(frame)), initiator: true })
      const fiber = yield* mux.websocket({ path: "/ws" }).pipe(Effect.forkChild({ startImmediately: true }))
      expect(mux.open).toBe(1)
      yield* Fiber.interrupt(fiber)
      expect(mux.open).toBe(0)
      expect(written.at(-1)).toMatchObject({ kind: Frame.Kind.Reset, payload: utf8("cancel") })
    }).pipe(Effect.runPromise)
  })
})
