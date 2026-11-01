import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Queue } from "effect"
import { empty, toBase64Url, utf8 } from "../src/bytes"
import { Frame, Keys, Noise, Session } from "../src"
import { wires } from "./relay"

const now = 1_800_000_000_000

const data = (text: string) => ({ kind: Frame.Kind.Data, stream: 1, flags: 0, payload: utf8(text) })

// A fresh pair of Noise transports, as a reconnect would produce.
const transports = Effect.gen(function* () {
  const responderKey = Noise.generateKeyPair()
  const initiator = yield* Noise.HandshakeState.make({
    pattern: "IK",
    initiator: true,
    prologue: Session.prologue,
    staticKey: Noise.generateKeyPair(),
    remoteStatic: responderKey.publicKey,
  })
  const responder = yield* Noise.HandshakeState.make({
    pattern: "IK",
    initiator: false,
    prologue: Session.prologue,
    staticKey: responderKey,
  })
  yield* responder.read(yield* initiator.write(empty))
  yield* initiator.read(yield* responder.write(empty))
  return { a: yield* initiator.split(), b: yield* responder.split() }
})

const sessions = (options?: Partial<Session.Options>) => {
  const key = Noise.generateKeyPair().publicKey
  return {
    a: new Session.Session({ id: "s", remoteStatic: key, options }),
    b: new Session.Session({ id: "s", remoteStatic: key, options }),
  }
}

// Pairs a phone with a desktop over the in-memory wires and returns both outcomes.
// `shown` is what the desktop shows when the proof arrives; `midway` changes it while the handshake is under way,
// as the third message arrives.
type Shown = { value: Keys.Pairing | undefined }

const pairing = (input: {
  qrKey?: Uint8Array
  token?: Uint8Array
  shown?: (issued: Keys.Pairing) => Keys.Pairing | undefined
  midway?: (shown: Shown, issued: Keys.Pairing) => void
  versions?: number[]
}) =>
  Effect.gen(function* () {
    const desktopKey = Keys.generate()
    const phoneKey = Keys.generate()
    const issued = Keys.createPairing({
      instance: "https://ai.dynapps.es",
      desktopKey: desktopKey.publicKey,
      now,
      ttlMs: 60_000,
    })
    const w = wires()
    const shown: Shown = { value: input.shown ? input.shown(issued) : issued }
    const wire = {
      ...w.desktop,
      receive: w.desktop.receive.pipe(Effect.tap(() => Effect.sync(() => input.midway?.(shown, issued)))),
    }
    const desktop = yield* Effect.gen(function* () {
      return yield* Session.accept({
        wire,
        first: yield* Queue.take(w.toDesktop),
        staticKey: desktopKey,
        pairing: () => shown.value,
        device: () => false,
        session: () => undefined,
      })
    }).pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
    const phone = yield* Session.pair({
      wire: w.phone,
      staticKey: phoneKey,
      pairing: { ...issued, desktopKey: input.qrKey ?? issued.desktopKey, token: input.token ?? issued.token },
      now,
      versions: input.versions,
    }).pipe(Effect.exit)
    const desktopExit = input.qrKey ? undefined : yield* Fiber.join(desktop)
    return { phone, desktop: desktopExit, phoneKey, desktopKey }
  })

const failure = <A, E>(exit: { _tag: string } | undefined) =>
  exit && exit._tag === "Failure"
    ? (exit as unknown as { cause: { reasons: { error: E }[] } }).cause.reasons[0]?.error
    : undefined

describe("Session handshakes", () => {
  test("pairing over XX gives both sides the same session and each other's key", async () => {
    const outcome = await Effect.runPromise(pairing({}))
    if (outcome.phone._tag !== "Success" || outcome.desktop?._tag !== "Success") throw new Error("pairing failed")
    expect(outcome.phone.value.session.id).toBe(outcome.desktop.value.session.id)
    expect(toBase64Url(outcome.desktop.value.paired!)).toBe(toBase64Url(outcome.phoneKey.publicKey))
    expect(toBase64Url(outcome.phone.value.session.remoteStatic)).toBe(toBase64Url(outcome.desktopKey.publicKey))
    expect(outcome.desktop.value.resumed).toBe(false)
  })

  test("the phone refuses a desktop whose key is not the one in the QR", async () => {
    const other = Keys.generate().publicKey
    const outcome = await Effect.runPromise(pairing({ qrKey: other }))
    expect(failure(outcome.phone)).toMatchObject({ _tag: "KeyMismatch", expected: Keys.fingerprint(other) })
  })

  test.each([
    ["a wrong token", { token: new Uint8Array(32).fill(7) }, "token"],
    ["an expired pairing", { shown: (issued: Keys.Pairing) => ({ ...issued, expires: Date.now() - 1 }) }, "expired"],
    ["a pairing no longer shown", { shown: () => undefined }, "cancelled"],
    // Read again when the proof arrives, not at the first message
    ["a pairing cancelled during the handshake", { midway: (shown: Shown) => (shown.value = undefined) }, "cancelled"],
    [
      "a pairing that expires during the handshake",
      { midway: (shown: Shown, issued: Keys.Pairing) => (shown.value = { ...issued, expires: Date.now() - 1 }) },
      "expired",
    ],
    [
      "a pairing replaced by a new QR during the handshake",
      {
        midway: (shown: Shown, issued: Keys.Pairing) =>
          (shown.value = Keys.createPairing({
            instance: issued.instance,
            desktopKey: issued.desktopKey,
            now: Date.now(),
            ttlMs: 60_000,
          })),
      },
      "token",
    ],
  ])("%s is refused on both sides", async (_, input, reason) => {
    const outcome = await Effect.runPromise(pairing(input))
    expect(failure(outcome.desktop)).toMatchObject({ _tag: "PairingRejected", reason })
    expect(failure(outcome.phone)).toMatchObject({ _tag: "PairingRejected", reason })
  })

  test("an unknown major version closes with Incompatible on both sides", async () => {
    const outcome = await Effect.runPromise(pairing({ versions: [2, 3] }))
    expect(failure(outcome.desktop)).toMatchObject({ _tag: "Incompatible", supported: "1", found: "2,3" })
    expect(failure(outcome.phone)).toMatchObject({ _tag: "Incompatible", found: "1" })
  })

  test("a reconnect from a device the desktop never paired is refused on both sides", async () => {
    const outcome = await Effect.gen(function* () {
      const desktopKey = Keys.generate()
      const w = wires()
      const desktop = yield* Effect.gen(function* () {
        return yield* Session.accept({
          wire: w.desktop,
          first: yield* Queue.take(w.toDesktop),
          staticKey: desktopKey,
          device: () => false,
          session: () => undefined,
          pairing: () => undefined,
        })
      }).pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
      const phone = yield* Effect.exit(
        Session.reconnect({ wire: w.phone, staticKey: Keys.generate(), desktopKey: desktopKey.publicKey, now }),
      )
      return { phone, desktop: yield* Fiber.join(desktop) }
    }).pipe(Effect.runPromise)
    expect(failure(outcome.desktop)).toMatchObject({ _tag: "KeyMismatch" })
    expect(failure(outcome.phone)).toMatchObject({ _tag: "KeyMismatch", found: "this device" })
  })
})

describe("Session", () => {
  test("delivers in order, drops what the peer resends after a reconnect, and refuses a gap", () => {
    Effect.gen(function* () {
      const s = sessions()
      const first = yield* transports
      yield* s.a.attach(first.a, 0, now)
      yield* s.b.attach(first.b, 0, now)
      for (const text of ["one", "two", "three"]) {
        const frame = yield* s.b.receive((yield* s.a.send(data(text), now))!)
        expect(new TextDecoder().decode(frame!.payload)).toBe(text)
      }
      expect(s.b.received).toBe(3)
      // The sender believes only the first arrived: it resends two and three, which the receiver drops
      const second = yield* transports
      const resend = yield* s.a.attach(second.a, 1, now)
      yield* s.b.attach(second.b, 0, now)
      expect(resend.length).toBe(2)
      for (const sealed of resend) expect(yield* s.b.receive(sealed)).toBeUndefined()
      const four = yield* s.b.receive((yield* s.a.send(data("four"), now))!)
      expect(four?.seq).toBe(4)
      // A sender that skips ahead after a reconnect leaves a gap
      const third = yield* transports
      yield* s.a.attach(third.a, 4, now)
      yield* s.b.attach(third.b, 0, now)
      const sealed = yield* s.a.send(data("five"), now)
      yield* s.a.send(data("six"), now)
      const fourth = yield* transports
      const skipped = yield* s.a.attach(fourth.a, 5, now)
      yield* s.b.attach(fourth.b, 0, now)
      expect(sealed).toBeDefined()
      expect(yield* Effect.flip(s.b.receive(skipped[0]!))).toMatchObject({ _tag: "Replay", expected: 5, found: 6 })
    }).pipe(Effect.runSync)
  })

  test("keeps frames sent while detached and sends them on the next connection", () => {
    Effect.gen(function* () {
      const s = sessions()
      expect(yield* s.a.send(data("queued"), now)).toBeUndefined()
      expect(yield* s.a.send({ kind: Frame.Kind.Ping, stream: 0, flags: 0, payload: empty }, now)).toBeUndefined()
      const t = yield* transports
      const resend = yield* s.a.attach(t.a, 0, now)
      yield* s.b.attach(t.b, 0, now)
      expect(resend.length).toBe(1)
      expect(new TextDecoder().decode((yield* s.b.receive(resend[0]!))!.payload)).toBe("queued")
    }).pipe(Effect.runSync)
  })

  test("acks release the bounded replay window", () => {
    Effect.gen(function* () {
      const s = sessions({ windowFrames: 4 })
      const t = yield* transports
      yield* s.a.attach(t.a, 0, now)
      yield* s.b.attach(t.b, 0, now)
      const sealed = []
      for (const text of ["1", "2", "3", "4"]) sealed.push((yield* s.a.send(data(text), now))!)
      expect(s.a.hasSpace).toBe(false)
      for (const message of sealed) yield* s.b.receive(message)
      expect(s.b.ackDue).toBe(true)
      const ack = yield* s.b.send({ kind: Frame.Kind.Ack, stream: 0, flags: 0, payload: empty }, now)
      expect(s.b.ackDue).toBe(false)
      expect(yield* s.a.receive(ack!)).toMatchObject({ kind: Frame.Kind.Ack, ack: 4 })
      expect(s.a.pending).toBe(0)
      expect(s.a.hasSpace).toBe(true)
    }).pipe(Effect.runSync)
  })

  test("refuses to resume from a point the window no longer holds, or past what was sent", () => {
    Effect.gen(function* () {
      const s = sessions()
      const t = yield* transports
      yield* s.a.attach(t.a, 0, now)
      yield* s.b.attach(t.b, 0, now)
      for (const text of ["1", "2", "3"]) yield* s.b.receive((yield* s.a.send(data(text), now))!)
      yield* s.a.receive((yield* s.b.send({ kind: Frame.Kind.Ack, stream: 0, flags: 0, payload: empty }, now))!)
      const again = yield* transports
      expect((yield* Effect.flip(s.a.attach(again.a, 1, now)))._tag).toBe("ResumeFailed")
      expect((yield* Effect.flip(s.a.attach(again.a, 9, now)))._tag).toBe("ResumeFailed")
    }).pipe(Effect.runSync)
  })

  test("rekeys in step on both ends, by message count and by time", () => {
    Effect.gen(function* () {
      for (const options of [{ rekeyMessages: 3 }, { rekeyMs: 1_000 }]) {
        const s = sessions(options)
        const t = yield* transports
        yield* s.a.attach(t.a, 0, now)
        yield* s.b.attach(t.b, 0, now)
        const flags: number[] = []
        for (let index = 0; index < 20; index++) {
          const at = now + index * 600
          const there = yield* s.b.receive((yield* s.a.send(data(`a${index}`), at))!)
          const back = yield* s.a.receive((yield* s.b.send(data(`b${index}`), at))!)
          expect(new TextDecoder().decode(there!.payload)).toBe(`a${index}`)
          expect(new TextDecoder().decode(back!.payload)).toBe(`b${index}`)
          flags.push(there!.flags & Frame.Flag.Rekey)
        }
        expect(flags.filter((flag) => flag !== 0).length).toBeGreaterThanOrEqual(5)
      }
    }).pipe(Effect.runSync)
  })
})
