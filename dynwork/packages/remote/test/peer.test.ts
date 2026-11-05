import { describe, expect, test } from "bun:test"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { Effect, Fiber, Stream } from "effect"
import { fromUtf8, toBase64Url, utf8 } from "../src/bytes"
import { Envelope, Frame, Keys, Mux, Remote, Session as SessionModule, type Session } from "../src"
import { includes, Relay } from "./relay"

// A desktop and a phone talking through the in-memory relay, as the apps will through the real one.

type State = { cancelled: boolean }

const big = 10 * 1024 * 1024
const bigChunk = 64 * 1024
// One SSE event of exactly 1 KiB: "data: ", six digits, a space, padding, then the blank line
const event = (index: number) => utf8(`data: ${String(index).padStart(6, "0")} ${"x".repeat(1024 - 15)}\n\n`)

// Splits an SSE body into event numbers, whatever the frame boundaries (a body is a byte stream).
const sse = () => {
  const state = { buffer: "" }
  return (chunk: Uint8Array) => {
    const parts = (state.buffer + fromUtf8(chunk)).split("\n\n")
    state.buffer = parts.pop() ?? ""
    return parts.map((part) => part.slice(6, 12))
  }
}

const numbers = (count: number) => Array.from({ length: count }, (_, index) => String(index + 1).padStart(6, "0"))

const bigChunks = () =>
  Stream.range(0, big / bigChunk - 1, 1).pipe(Stream.map((index) => new Uint8Array(bigChunk).fill(index & 0xff)))

function handler(state: State): Mux.Handler {
  return (incoming) => {
    if (incoming.type === "ws" && incoming.path === "/reject") return incoming.reject(403)
    if (incoming.type === "ws")
      return Effect.gen(function* () {
        const socket = yield* incoming.accept(incoming.protocols[0])
        yield* socket.messages.pipe(Stream.runForEach((message) => socket.send(message)))
        yield* socket.close
      })
    const [path, query] = incoming.path.split("?")
    if (path === "/hello")
      return incoming.respond(
        { status: 200, headers: { "content-type": "text/plain" } },
        utf8(`hello ${incoming.method}`),
      )
    if (path === "/echo") return incoming.respond({ status: 200 }, incoming.body)
    // Answers at once without reading the upload
    if (path === "/too-large") return incoming.respond({ status: 413 }, utf8("too large"))
    if (path === "/big") return incoming.respond({ status: 200 }, bigChunks())
    if (path === "/events")
      return incoming.respond(
        { status: 200, headers: { "content-type": "text/event-stream" } },
        Stream.range(1, Number(query?.split("=")[1] ?? 10), 1).pipe(Stream.map(event)),
      )
    if (path === "/forever")
      return incoming
        .respond({ status: 200 }, Stream.iterate(0, (index) => index + 1).pipe(Stream.map(event)))
        .pipe(Effect.onExit(() => Effect.sync(() => (state.cancelled = true))))
    return incoming.respond({ status: 404 })
  }
}

const seqOf = (envelope: Uint8Array) => new DataView(envelope.buffer, envelope.byteOffset).getUint32(33)
const senderOf = (envelope: Uint8Array) => toBase64Url(envelope.subarray(17, 33))

const eventually = (check: () => boolean) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 20_000
    while (!check()) {
      if (Date.now() > deadline) return yield* Effect.die(new Error("condition not reached within 20s"))
      yield* Effect.sleep("1 millis")
    }
  })

const text = (stream: Stream.Stream<Uint8Array, unknown>) =>
  stream.pipe(
    Stream.runCollect,
    Effect.map((chunks) => chunks.map((chunk) => fromUtf8(chunk)).join("")),
  )

// Pairs a fresh phone with a fresh desktop through a relay. `keepPairing` leaves the QR shown after it is used.
const world = (
  config: {
    options?: Partial<Session.Options>
    desktop?: Partial<Remote.DesktopOptions>
    keepPairing?: boolean
  } = {},
) =>
  Effect.gen(function* () {
    const options = config.options
    const relay = new Relay()
    const desktopKey = Keys.generate()
    const phoneKey = Keys.generate()
    const state: State = { cancelled: false }
    const devices = new Set<string>()
    const desktops: Remote.Peer[] = []
    const refused: unknown[] = []
    const issued = Keys.createPairing({
      instance: "https://ai.dynapps.es",
      desktopKey: desktopKey.publicKey,
      now: Date.now(),
      ttlMs: 60_000,
    })
    const shown = { pairing: issued as typeof issued | undefined }
    const desktop = new Remote.Desktop({
      staticKey: desktopKey,
      pairing: () => shown.pairing,
      device: (key) => devices.has(toBase64Url(key)),
      events: {
        paired: (key) => {
          devices.add(toBase64Url(key))
          if (!config.keepPairing) shown.pairing = undefined
        },
        connected: (peer) => {
          peer.mux.serve(handler(state))
          if (!desktops.includes(peer)) desktops.push(peer)
        },
        refused: (error) => refused.push(error),
      },
      options,
      ...config.desktop,
    })
    const desktopLink = { current: relay.connect(Keys.peerId(desktopKey.publicKey)) }
    // Connects the desktop to the relay (again, after a relay reconnect)
    const listen = () =>
      Effect.gen(function* () {
        desktopLink.current = relay.connect(Keys.peerId(desktopKey.publicKey))
        yield* desktop.listen(desktopLink.current).pipe(Effect.forkDetach({ startImmediately: true }))
      })
    yield* desktop.listen(desktopLink.current).pipe(Effect.forkDetach({ startImmediately: true }))
    const phoneId = Keys.peerId(phoneKey.publicKey)
    const link = { current: relay.connect(phoneId) }
    const phone = yield* Remote.pairPhone({ link: link.current, staticKey: phoneKey, pairing: issued, options })
    const reconnect = () =>
      Effect.gen(function* () {
        link.current = relay.connect(phoneId)
        return yield* Remote.reconnectPhone({
          link: link.current,
          staticKey: phoneKey,
          desktopKey: desktopKey.publicKey,
          peer: phone,
          options,
        })
      })
    const fromDesktop = (envelope: Uint8Array) =>
      toBase64Url(envelope.subarray(17, 33)) === toBase64Url(Keys.peerId(desktopKey.publicKey))
    const show = (pairing: typeof issued) => {
      shown.pairing = pairing
    }
    return {
      relay,
      desktop,
      desktopLink,
      listen,
      desktopKey,
      phoneKey,
      issued,
      phone,
      link,
      reconnect,
      show,
      state,
      desktops,
      refused,
      fromDesktop,
    }
  })

describe("Remote", () => {
  test("HTTP request and response, with a body larger than the flow-control window", async () => {
    await Effect.gen(function* () {
      const w = yield* world()
      const hello = yield* w.phone.mux.fetch({ method: "GET", path: "/hello" })
      expect(hello.status).toBe(200)
      expect(hello.headers["content-type"]).toBe("text/plain")
      expect(yield* text(hello.body)).toBe("hello GET")
      const body = new Uint8Array(3 * Mux.window + 17).map((_, index) => index % 251)
      const echo = yield* w.phone.mux.fetch({ method: "POST", path: "/echo", body })
      const chunks = yield* Stream.runCollect(echo.body)
      expect(bytesToHex(sha256(new Uint8Array(chunks.flatMap((chunk) => [...chunk]))))).toBe(bytesToHex(sha256(body)))
      expect((yield* w.phone.mux.fetch({ method: "GET", path: "/missing" })).status).toBe(404)
    }).pipe(Effect.runPromise)
  })

  test("many streams at once stay separate", async () => {
    await Effect.gen(function* () {
      const w = yield* world()
      const bodies = Array.from({ length: 20 }, (_, index) => utf8(`body ${index} `.repeat(500 * (index + 1))))
      const echoed = yield* Effect.forEach(
        bodies,
        (body) =>
          w.phone.mux
            .fetch({ method: "POST", path: "/echo", body })
            .pipe(Effect.flatMap((response) => text(response.body))),
        { concurrency: "unbounded" },
      )
      expect(echoed).toEqual(bodies.map((body) => fromUtf8(body) ?? ""))
      yield* eventually(() => w.phone.mux.open === 0 && w.desktops[0]!.mux.open === 0)
    }).pipe(Effect.runPromise)
  })

  test("WebSocket echo: text, binary and a message larger than a frame", async () => {
    await Effect.gen(function* () {
      const w = yield* world()
      const socket = yield* w.phone.mux.websocket({ path: "/ws", protocols: ["dynwork.v1"] })
      expect(socket.protocol).toBe("dynwork.v1")
      const large = "é".repeat(100_000)
      const replies = yield* socket.messages.pipe(Stream.take(3), Stream.runCollect, Effect.forkChild)
      yield* socket.send("hello")
      yield* socket.send(new Uint8Array([1, 2, 3]))
      yield* socket.send(large)
      const messages = yield* Fiber.join(replies)
      expect(messages[0]).toBe("hello")
      expect([...(messages[1] as Uint8Array)]).toEqual([1, 2, 3])
      expect(messages[2]).toBe(large)
      yield* socket.close
      yield* eventually(() => w.phone.mux.open === 0)
    }).pipe(Effect.runPromise)
  })

  // The relay counts the desktop's data frames: while the reader holds back, the desktop stops at the window.
  test("SSE backpressure: a slow reader holds the sender at the window, then gets every event in order", async () => {
    await Effect.gen(function* () {
      const w = yield* world()
      const count = 2000
      const sizeOf = Frame.bucket(Frame.headerLength + event(0).length) + 16
      const frames = () =>
        w.relay.seen.filter((envelope) => w.fromDesktop(envelope) && envelope.length === Envelope.headerLength + sizeOf)
          .length
      const response = yield* w.phone.mux.fetch({ method: "GET", path: `/events?count=${count}` })
      const received: string[] = []
      const held = { done: false }
      const parse = sse()
      yield* response.body.pipe(
        Stream.runForEach((chunk) =>
          Effect.gen(function* () {
            received.push(...parse(chunk))
            if (received.length !== 100) return
            const limit = Mux.window / event(0).length
            yield* eventually(() => frames() >= limit)
            for (let tick = 0; tick < 50; tick++) yield* Effect.sleep("1 millis")
            expect(frames()).toBe(limit)
            held.done = true
          }),
        ),
      )
      expect(held.done).toBe(true)
      expect(received).toEqual(numbers(count))
    }).pipe(Effect.runPromise)
  })

  test("cancelling a stream stops the desktop's writer", async () => {
    await Effect.gen(function* () {
      const w = yield* world()
      const response = yield* w.phone.mux.fetch({ method: "GET", path: "/forever" })
      expect((yield* response.body.pipe(Stream.take(3), Stream.runCollect)).length).toBe(3)
      yield* response.cancel
      yield* eventually(() => w.state.cancelled)
      yield* eventually(() => w.phone.mux.open === 0 && w.desktops[0]!.mux.open === 0)
      const failure = yield* Effect.flip(Stream.runDrain(response.body))
      expect(failure).toMatchObject({ _tag: "StreamReset", code: "cancel" })
    }).pipe(Effect.runPromise)
  })

  test("resume after a dropped socket: the stream carries on without losing or repeating an event", async () => {
    await Effect.gen(function* () {
      const w = yield* world()
      const count = 600
      const response = yield* w.phone.mux.fetch({ method: "GET", path: `/events?count=${count}` })
      const received: string[] = []
      const parse = sse()
      const dropped = { done: false }
      yield* response.body.pipe(
        Stream.runForEach((chunk) =>
          Effect.gen(function* () {
            received.push(...parse(chunk))
            if (dropped.done || received.length < 50) return
            dropped.done = true
            w.link.current.drop()
            expect((yield* w.phone.ended).error).toMatchObject({ _tag: "Closed", reason: "dropped" })
            expect(w.phone.connected).toBe(false)
            const resumed = yield* w.reconnect()
            expect(resumed).toBe(w.phone)
          }),
        ),
      )
      expect(dropped.done).toBe(true)
      expect(received).toEqual(numbers(count))
      expect(w.phone.connected).toBe(true)
    }).pipe(Effect.runPromise)
  })

  test("a 10 MB response arrives intact across rekeys", async () => {
    await Effect.gen(function* () {
      const w = yield* world({ options: { rekeyMessages: 50 } })
      const response = yield* w.phone.mux.fetch({ method: "GET", path: "/big" })
      const hash = sha256.create()
      const total = yield* response.body.pipe(
        Stream.runFold(
          () => 0,
          (sum, chunk) => {
            hash.update(chunk)
            return sum + chunk.length
          },
        ),
      )
      const expected = sha256.create()
      Array.from({ length: big / bigChunk }, (_, index) => expected.update(new Uint8Array(bigChunk).fill(index & 0xff)))
      expect(total).toBe(big)
      expect(bytesToHex(hash.digest())).toBe(bytesToHex(expected.digest()))
    }).pipe(Effect.runPromise)
  }, 120_000)

  test("the relay carries only ciphertext in padded sizes", async () => {
    await Effect.gen(function* () {
      const w = yield* world()
      const secret = utf8("a secret only the two ends may read")
      const echo = yield* w.phone.mux.fetch({ method: "POST", path: "/echo?topic=private", body: secret })
      expect(yield* text(echo.body)).toBe(fromUtf8(secret) ?? "")
      const needles = [
        secret,
        utf8("/echo?topic=private"),
        w.issued.token,
        w.phoneKey.publicKey,
        w.desktopKey.publicKey,
      ]
      for (const envelope of w.relay.seen) for (const needle of needles) expect(includes(envelope, needle)).toBe(false)
      const transport = w.relay.seen.filter((envelope) => envelope.length - Envelope.headerLength > 200)
      const sizes = new Set(transport.map((envelope) => envelope.length - Envelope.headerLength - 16))
      for (const size of sizes) expect(Frame.buckets as readonly number[]).toContain(size)
    }).pipe(Effect.runPromise)
  })

  test("a tampered envelope fails decryption; the phone resumes and the request completes", async () => {
    await Effect.gen(function* () {
      const w = yield* world()
      const once = { done: false }
      w.relay.intercept = (envelope) => {
        if (once.done || !w.fromDesktop(envelope)) return [envelope]
        once.done = true
        const tampered = envelope.slice()
        tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1
        return [tampered]
      }
      const request = yield* w.phone.mux.fetch({ method: "GET", path: "/hello" }).pipe(Effect.forkChild)
      expect((yield* w.phone.ended).error).toMatchObject({ _tag: "Decrypt", stage: "transport" })
      w.relay.intercept = undefined
      yield* w.reconnect()
      const response = yield* Fiber.join(request)
      expect(yield* text(response.body)).toBe("hello GET")
    }).pipe(Effect.runPromise)
  })

  test.each([
    ["a replayed envelope", (held: Uint8Array[], envelope: Uint8Array) => [envelope, envelope], "Replay"],
    [
      "a replayed envelope with a fresh sequence number",
      (held: Uint8Array[], envelope: Uint8Array) => {
        const again = envelope.slice()
        again[36] = (again[36] ?? 0) + 1
        return [envelope, again]
      },
      "Decrypt",
    ],
    [
      "reordered envelopes",
      (held: Uint8Array[], envelope: Uint8Array) => {
        if (held.length === 0) {
          held.push(envelope)
          return []
        }
        return [envelope, ...held.splice(0)]
      },
      "Replay",
    ],
  ] as const)("%s is refused", async (_, rewrite, tag) => {
    await Effect.gen(function* () {
      const w = yield* world()
      const held: Uint8Array[] = []
      const count = { left: 2 }
      w.relay.intercept = (envelope) => {
        if (!w.fromDesktop(envelope) || count.left === 0) return [envelope]
        count.left--
        return rewrite(held, envelope)
      }
      yield* w.phone.mux.fetch({ method: "GET", path: "/events?count=5" }).pipe(Effect.forkChild)
      expect((yield* w.phone.ended).error._tag).toBe(tag)
    }).pipe(Effect.runPromise)
  })

  test("a relay that routes the phone to another desktop is caught by the key in the QR", async () => {
    await Effect.gen(function* () {
      const w = yield* world()
      const impostor = Keys.generate()
      const phoneKey = Keys.generate()
      const pairing = { ...w.issued, desktopKey: impostor.publicKey }
      const desktopId = Keys.peerId(w.desktopKey.publicKey)
      const impostorId = toBase64Url(Keys.peerId(impostor.publicKey))
      // Sends what the phone addresses to the impostor to the real desktop, and disguises the answers
      w.relay.intercept = (envelope) => {
        const rewritten = envelope.slice()
        if (toBase64Url(envelope.subarray(1, 17)) === impostorId) rewritten.set(desktopId, 1)
        if (w.fromDesktop(envelope)) rewritten.set(Keys.peerId(impostor.publicKey), 17)
        return [rewritten]
      }
      const link = w.relay.connect(Keys.peerId(phoneKey.publicKey))
      const failure = yield* Effect.flip(Remote.pairPhone({ link, staticKey: phoneKey, pairing }))
      expect(failure).toMatchObject({
        _tag: "KeyMismatch",
        expected: Keys.fingerprint(impostor.publicKey),
        found: Keys.fingerprint(w.desktopKey.publicKey),
      })
    }).pipe(Effect.runPromise)
  })

  test("a phone the desktop never paired is refused, and a used pairing cannot pair again", async () => {
    await Effect.gen(function* () {
      const w = yield* world()
      const stranger = Keys.generate()
      const reconnect = Remote.reconnectPhone({
        link: w.relay.connect(Keys.peerId(stranger.publicKey)),
        staticKey: stranger,
        desktopKey: w.desktopKey.publicKey,
      })
      expect(yield* Effect.flip(reconnect)).toMatchObject({ _tag: "KeyMismatch" })
      const second = Keys.generate()
      const pairAgain = Remote.pairPhone({
        link: w.relay.connect(Keys.peerId(second.publicKey)),
        staticKey: second,
        pairing: w.issued,
      })
      expect(yield* Effect.flip(pairAgain)).toMatchObject({ _tag: "PairingRejected", reason: "used" })
      expect(w.refused.map((error) => (error as { _tag: string })._tag)).toEqual(["KeyMismatch", "PairingRejected"])
    }).pipe(Effect.runPromise)
  })

  test("two phones racing with the same QR: exactly one pairs", async () => {
    await Effect.gen(function* () {
      const w = yield* world()
      // world() paired its phone already; a fresh pairing is shown to two new phones at once
      const fresh = Keys.createPairing({
        instance: w.issued.instance,
        desktopKey: w.desktopKey.publicKey,
        now: Date.now(),
        ttlMs: 60_000,
      })
      w.show(fresh)
      const phones = [Keys.generate(), Keys.generate()]
      const outcomes = yield* Effect.forEach(
        phones,
        (key) =>
          Remote.pairPhone({ link: w.relay.connect(Keys.peerId(key.publicKey)), staticKey: key, pairing: fresh }).pipe(
            Effect.exit,
          ),
        { concurrency: "unbounded" },
      )
      expect(outcomes.map((exit) => exit._tag).sort()).toEqual(["Failure", "Success"])
    }).pipe(Effect.runPromise)
  })

  test("WebSocket messages respect flow control: one of 300 KB, and several adding up past the window", async () => {
    await Effect.gen(function* () {
      const w = yield* world()
      const socket = yield* w.phone.mux.websocket({ path: "/ws" })
      const messages = [
        new Uint8Array(300 * 1024).fill(1),
        ...Array.from({ length: 6 }, (_, index) => new Uint8Array(100 * 1024).fill(index + 2)),
      ]
      const replies = yield* socket.messages.pipe(Stream.take(messages.length), Stream.runCollect, Effect.forkChild)
      for (const message of messages) yield* socket.send(message)
      const echoed = yield* Fiber.join(replies)
      expect(echoed.map((message) => bytesToHex(sha256(message as Uint8Array)))).toEqual(
        messages.map((message) => bytesToHex(sha256(message))),
      )
    }).pipe(Effect.runPromise)
  })

  test("rejected WebSocket upgrades leave no stream behind on either side", async () => {
    await Effect.gen(function* () {
      const w = yield* world()
      for (let index = 0; index < 300; index++)
        expect(yield* Effect.flip(w.phone.mux.websocket({ path: "/reject" }))).toMatchObject({ code: "rejected:403" })
      yield* eventually(() => w.phone.mux.open === 0 && w.desktops[0]!.mux.open === 0)
      expect((yield* w.phone.mux.fetch({ method: "GET", path: "/hello" })).status).toBe(200)
    }).pipe(Effect.runPromise)
  })

  test("a 1 MB upload answered with 413 at once stops the upload and frees both sides", async () => {
    await Effect.gen(function* () {
      const w = yield* world()
      const response = yield* w.phone.mux.fetch({
        method: "POST",
        path: "/too-large",
        body: new Uint8Array(1024 * 1024),
      })
      expect(response.status).toBe(413)
      expect(yield* text(response.body)).toBe("too large")
      yield* eventually(() => w.phone.mux.open === 0 && w.desktops[0]!.mux.open === 0)
      expect((yield* w.phone.mux.fetch({ method: "GET", path: "/hello" })).status).toBe(200)
    }).pipe(Effect.runPromise)
  })

  test("a full replay window holds data frames but never control frames", async () => {
    await Effect.gen(function* () {
      const session = new SessionModule.Session({
        id: "s",
        remoteStatic: Keys.generate().publicKey,
        options: { windowFrames: 2 },
      })
      const peer = new Remote.Peer(session, true)
      const frame = (kind: Frame.Kind) => ({ kind, stream: 1, flags: 0, payload: new Uint8Array(4) })
      yield* peer.write(frame(Frame.Kind.Data))
      yield* peer.write(frame(Frame.Kind.Data))
      expect(session.hasSpace).toBe(false)
      const blocked = yield* peer.write(frame(Frame.Kind.Data)).pipe(Effect.forkChild({ startImmediately: true }))
      // What the reader writes (resets, credit, acks, pongs, close) goes out regardless
      for (const kind of [Frame.Kind.Reset, Frame.Kind.Credit, Frame.Kind.Ack, Frame.Kind.Pong])
        yield* peer.write(frame(kind)).pipe(Effect.timeout("1 second"))
      yield* Effect.yieldNow
      expect(blocked.pollUnsafe()).toBeUndefined()
      yield* Fiber.interrupt(blocked)
    }).pipe(Effect.runPromise)
  })

  test("a reader of a replaced connection cannot detach the new one", async () => {
    await Effect.gen(function* () {
      const w = yield* world()
      const old = w.link.current
      const ended = w.phone.ended
      yield* w.reconnect()
      expect((yield* ended).error).toMatchObject({ _tag: "Closed", reason: "replaced" })
      old.drop()
      yield* Effect.sleep("5 millis")
      expect(w.phone.connected).toBe(true)
      expect(yield* text((yield* w.phone.mux.fetch({ method: "GET", path: "/hello" })).body)).toBe("hello GET")
    }).pipe(Effect.runPromise)
  })

  test("closed and expired sessions are forgotten and cannot be resumed; a new session replaces the old one", async () => {
    await Effect.gen(function* () {
      const revoked = yield* world()
      yield* revoked.desktops[0]!.close("revoked")
      expect(revoked.desktop.sessions).toBe(0)
      revoked.link.current.drop()
      expect((yield* Effect.flip(revoked.reconnect()))._tag).toBe("ResumeFailed")

      // The desktop learns a connection ended when its own link drops (the relay tells it nothing of the phone's)
      const expiring = yield* world({ desktop: { resumeMs: 20 } })
      expiring.desktopLink.current.drop()
      yield* eventually(() => expiring.desktop.sessions === 0)
      yield* expiring.listen()
      expiring.link.current.drop()
      expect((yield* Effect.flip(expiring.reconnect()))._tag).toBe("ResumeFailed")

      const replaced = yield* world()
      const fresh = yield* Remote.reconnectPhone({
        link: replaced.relay.connect(Keys.peerId(replaced.phoneKey.publicKey)),
        staticKey: replaced.phoneKey,
        desktopKey: replaced.desktopKey.publicKey,
      })
      expect(fresh).not.toBe(replaced.phone)
      yield* eventually(() => replaced.desktop.sessions === 1 && replaced.desktops[0]!.closed)
    }).pipe(Effect.runPromise)
  })

  test("sessions and used tokens survive the desktop's relay reconnect", async () => {
    await Effect.gen(function* () {
      const w = yield* world({ keepPairing: true })
      w.desktopLink.current.drop()
      yield* w.listen()
      w.link.current.drop()
      yield* w.phone.ended
      yield* w.reconnect()
      expect(yield* text((yield* w.phone.mux.fetch({ method: "GET", path: "/hello" })).body)).toBe("hello GET")
      expect(w.desktop.sessions).toBe(1)
      const other = Keys.generate()
      const again = Remote.pairPhone({
        link: w.relay.connect(Keys.peerId(other.publicKey)),
        staticKey: other,
        pairing: w.issued,
      })
      expect(yield* Effect.flip(again)).toMatchObject({ _tag: "PairingRejected", reason: "used" })
    }).pipe(Effect.runPromise)
  })

  test.each([
    ["the pairing's first message", "pairing"],
    ["a reconnect's first message", "reconnect"],
    ["a reconnect's first message while that reconnect is still under way", "racing"],
  ] as const)("a relay replaying %s cannot cut the phone off", async (_, when) => {
    await Effect.gen(function* () {
      const w = yield* world({ desktop: { handshakeMs: 100 } })
      if (when !== "pairing") yield* w.reconnect()
      // "racing": the phone is done, the desktop still waits for its confirmation
      if (when === "racing") expect(w.desktop.handshakes).toBe(1)
      if (when !== "racing") yield* eventually(() => w.desktop.handshakes === 0 && w.desktops[0]!.connected)
      const phoneId = toBase64Url(Keys.peerId(w.phoneKey.publicKey))
      const replay = w.relay.seen.filter((envelope) => senderOf(envelope) === phoneId && seqOf(envelope) === 0).at(-1)!
      w.relay.inject(replay)
      yield* eventually(() => w.desktop.handshakes >= 1)
      expect(yield* text((yield* w.phone.mux.fetch({ method: "GET", path: "/hello" })).body)).toBe("hello GET")
      yield* eventually(() => w.desktop.handshakes === 0)
      expect(w.refused.map(String).some((error) => error.includes("timed out"))).toBe(true)
      expect(w.phone.connected && w.desktops[0]!.connected).toBe(true)
      expect(yield* text((yield* w.phone.mux.fetch({ method: "GET", path: "/hello" })).body)).toBe("hello GET")
    }).pipe(Effect.runPromise)
  })

  test("stalled handshakes time out, and no more than the limit run at once", async () => {
    await Effect.gen(function* () {
      const w = yield* world({ desktop: { handshakeMs: 100, maxHandshakes: 2 } })
      const desktopId = toBase64Url(Keys.peerId(w.desktopKey.publicKey))
      const answers = () =>
        w.relay.seen.filter((envelope) => senderOf(envelope) === desktopId && seqOf(envelope) === 0).length
      const before = answers()
      // Three phones whose links let only the pairing's first message out: the desktop never sees a third
      for (let index = 0; index < 3; index++) {
        const key = Keys.generate()
        const link = w.relay.connect(Keys.peerId(key.publicKey))
        const sent = { first: false }
        const stalled = {
          incoming: link.incoming,
          send: (envelope: Uint8Array) => {
            if (sent.first) return
            sent.first = true
            link.send(envelope)
          },
        }
        yield* Remote.pairPhone({ link: stalled, staticKey: key, pairing: w.issued }).pipe(Effect.forkChild)
      }
      yield* eventually(() => w.desktop.handshakes === 2)
      yield* eventually(() => w.desktop.handshakes === 0)
      expect(answers() - before).toBe(2)
      expect(w.refused.map(String).filter((error) => error.includes("timed out")).length).toBe(2)
    }).pipe(Effect.runPromise)
  })

  test("a phone that floods its queue is dropped, and resumes", async () => {
    await Effect.gen(function* () {
      const w = yield* world({ desktop: { queueLength: 8 } })
      const phoneId = toBase64Url(Keys.peerId(w.phoneKey.publicKey))
      const once = { done: false }
      w.relay.intercept = (envelope) => {
        if (once.done || toBase64Url(envelope.subarray(17, 33)) !== phoneId) return [envelope]
        once.done = true
        return Array.from({ length: 20 }, () => envelope)
      }
      const desktop = w.desktops[0]!
      const ended = desktop.ended
      yield* w.phone.mux.fetch({ method: "GET", path: "/hello" }).pipe(Effect.forkChild)
      expect((yield* ended).error).toMatchObject({ _tag: "Closed", reason: "overflow" })
      w.relay.intercept = undefined
      w.link.current.drop()
      yield* w.reconnect()
      expect(yield* text((yield* w.phone.mux.fetch({ method: "GET", path: "/hello" })).body)).toBe("hello GET")
    }).pipe(Effect.runPromise)
  })

  test("closing the session on the desktop fails the phone's streams with the reason", async () => {
    await Effect.gen(function* () {
      const w = yield* world()
      const response = yield* w.phone.mux.fetch({ method: "GET", path: "/forever" })
      yield* response.body.pipe(Stream.take(1), Stream.runDrain)
      yield* w.desktops[0]!.close("revoked")
      expect((yield* w.phone.ended).error).toMatchObject({ _tag: "Closed", reason: "revoked" })
      expect(yield* Effect.flip(Stream.runDrain(response.body))).toMatchObject({ _tag: "Closed", reason: "revoked" })
      expect(yield* Effect.flip(w.phone.mux.fetch({ method: "GET", path: "/hello" }))).toMatchObject({ _tag: "Closed" })
    }).pipe(Effect.runPromise)
  })
})
