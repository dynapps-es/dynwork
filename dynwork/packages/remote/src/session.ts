import { equalBytes } from "@noble/ciphers/utils.js"
import { randomBytes } from "@noble/hashes/utils.js"
import { Clock, Effect, Option, Schema } from "effect"
import { empty, fromBase64Url, fromUtf8, toBase64Url, utf8 } from "./bytes"
import { Closed, Incompatible, KeyMismatch, Malformed, PairingRejected, Replay, ResumeFailed } from "./errors"
import { decode, encode, Flag, Kind, maxPayload, unsequenced, type Frame } from "./frame"
import { fingerprint, version, type Pairing } from "./keys"
import { HandshakeState, type KeyPair, type Transport } from "./noise"
import type { Handshake } from "./errors"

// The session outlives any one connection. It numbers every sequenced frame, keeps the ones the peer has not acked in
// a bounded replay window, and after a reconnect resends exactly what the peer reports missing. Within a connection
// Noise itself refuses tampered, replayed and reordered messages; across connections the sequence numbers drop what
// the peer already has and refuse gaps.

export type Options = {
  // Rekey the sending cipher after this many messages
  rekeyMessages: number
  // ...or after this long on one key
  rekeyMs: number
  // The replay window: unacked frames kept for resume. Writers wait while it is full.
  windowFrames: number
  windowBytes: number
  // Acknowledge at least every this many received frames
  ackEvery: number
}

export const defaults: Options = {
  rekeyMessages: 10_000,
  rekeyMs: 10 * 60_000,
  windowFrames: 4096,
  windowBytes: 16 * 1024 * 1024,
  ackEvery: 32,
}

// Bound to every handshake. A different prologue fails decryption; the version travels in the payloads instead, so a
// version mismatch is reported as such.
export const prologue = utf8("dynwork-remote")

// The first byte of a channel's first message, outside Noise, tells the responder which pattern follows.
export const PatternByte = { XX: 1, IK: 2 } as const

export type Outgoing = Pick<Frame, "kind" | "stream" | "flags" | "payload">

type Connection = { transport: Transport; sent: number; keyedAt: number }

export class Session {
  readonly id: string
  readonly remoteStatic: Uint8Array
  readonly options: Options
  #nextSeq = 1
  #received = 0
  #unacked = 0
  #pending: { seq: number; frame: Outgoing }[] = []
  #pendingBytes = 0
  #connection: Connection | undefined

  constructor(input: { id: string; remoteStatic: Uint8Array; options?: Partial<Options> }) {
    this.id = input.id
    this.remoteStatic = input.remoteStatic
    this.options = { ...defaults, ...input.options }
  }

  // The highest sequence number received in order
  get received() {
    return this.#received
  }

  get attached() {
    return this.#connection !== undefined
  }

  get hasSpace() {
    return this.#pending.length < this.options.windowFrames && this.#pendingBytes < this.options.windowBytes
  }

  // Frames waiting for the peer's ack, oldest first
  get pending() {
    return this.#pending.length
  }

  get ackDue() {
    return this.#unacked > 0
  }

  get ackOverdue() {
    return this.#unacked >= this.options.ackEvery
  }

  // Sequences the frame (unless its kind is unsequenced) and seals it on the current connection. Returns undefined
  // while detached: the frame waits in the window for the next connection, or, unsequenced, is dropped.
  send(frame: Outgoing, now: number) {
    const self = this
    return Effect.gen(function* () {
      if (frame.payload.length > maxPayload) return yield* new Malformed({ what: "frame", message: "too long" })
      if (unsequenced.has(frame.kind)) return yield* self.#seal(0, frame, now)
      const seq = self.#nextSeq++
      self.#pending.push({ seq, frame })
      self.#pendingBytes += frame.payload.length
      return yield* self.#seal(seq, frame, now)
    })
  }

  // Opens one transport message. Returns the frame to deliver, or undefined for a duplicate the peer resent on resume.
  receive(ciphertext: Uint8Array) {
    const self = this
    return Effect.gen(function* () {
      const connection = self.#connection
      if (connection === undefined) return yield* new Closed({ reason: "detached" })
      const frame = yield* decode(yield* connection.transport.receive.decrypt(empty, ciphertext, "transport"))
      if (frame.flags & Flag.Rekey) connection.transport.receive.rekey()
      if (frame.ack >= self.#nextSeq) return yield* new Malformed({ what: "frame", message: "ack past what was sent" })
      self.#release(frame.ack)
      if (frame.seq === 0) return frame
      if (frame.seq <= self.#received) return undefined
      if (frame.seq !== self.#received + 1) return yield* new Replay({ expected: self.#received + 1, found: frame.seq })
      self.#received = frame.seq
      self.#unacked++
      return frame
    })
  }

  // Attaches the connection a handshake just produced. `peerReceived` is the peer's own `received`: what it already
  // has is released, the rest is resealed in order and returned for sending. With `confirm`, an ack goes first: the
  // reconnecting phone's proof that it is live, since an IK first message can be replayed.
  attach(transport: Transport, peerReceived: number, now: number, options?: { confirm?: boolean }) {
    const self = this
    return Effect.gen(function* () {
      if (peerReceived >= self.#nextSeq)
        return yield* new ResumeFailed({ message: "the peer reports frames this side never sent" })
      const oldest = self.#pending[0]?.seq ?? self.#nextSeq
      if (peerReceived < oldest - 1)
        return yield* new ResumeFailed({ message: "the replay window no longer holds what the peer is missing" })
      self.#connection = { transport, sent: 0, keyedAt: now }
      self.#release(peerReceived)
      const resend: Uint8Array[] = []
      if (options?.confirm) {
        const ack = yield* self.#seal(0, { kind: Kind.Ack, stream: 0, flags: 0, payload: empty }, now)
        if (ack) resend.push(ack)
      }
      for (const entry of self.#pending) {
        const sealed = yield* self.#seal(entry.seq, entry.frame, now)
        if (sealed) resend.push(sealed)
      }
      return resend
    })
  }

  detach() {
    this.#connection = undefined
  }

  #release(ack: number) {
    const count = this.#pending.findIndex((entry) => entry.seq > ack)
    const released = this.#pending.splice(0, count === -1 ? this.#pending.length : count)
    this.#pendingBytes -= released.reduce((sum, entry) => sum + entry.frame.payload.length, 0)
  }

  // Every frame carries the current ack. The sender rekeys after the frame that announces it.
  #seal(seq: number, frame: Outgoing, now: number) {
    return Effect.suspend(() => {
      const connection = this.#connection
      if (connection === undefined) return Effect.succeed(undefined)
      const rekey =
        connection.sent + 1 >= this.options.rekeyMessages || now - connection.keyedAt >= this.options.rekeyMs
      const plaintext = encode({
        ...frame,
        flags: frame.flags | (rekey ? Flag.Rekey : 0),
        seq,
        ack: this.#received,
      })
      this.#unacked = 0
      return connection.transport.send.encrypt(empty, plaintext).pipe(
        Effect.map((sealed) => {
          connection.sent++
          if (rekey) {
            connection.transport.send.rekey()
            connection.sent = 0
            connection.keyedAt = now
          }
          return sealed
        }),
      )
    })
  }
}

// Handshake payloads. They are JSON; `versions` and `version` are the protocol's major versions.

const ResumeRequest = Schema.Struct({ session: Schema.String, received: Schema.Number })

const Hello = Schema.Struct({
  versions: Schema.Array(Schema.Number),
  resume: Schema.optional(ResumeRequest),
})

const Welcome = Schema.Union([
  Schema.Struct({ version: Schema.Number, session: Schema.String, received: Schema.Number }),
  Schema.Struct({ refused: Schema.Literals(["version", "device"]), versions: Schema.Array(Schema.Number) }),
])

const Proof = Schema.Struct({ token: Schema.String })

const supported = [version]

function json<A>(parse: (input: unknown) => Option.Option<A>, what: string) {
  return (bytes: Uint8Array) => {
    const value = parse(fromUtf8(bytes))
    if (Option.isNone(value)) return Effect.fail(new Malformed({ what, message: "unexpected handshake payload" }))
    return Effect.succeed(value.value)
  }
}

const decodeHello = json(Schema.decodeUnknownOption(Schema.fromJsonString(Hello)), "hello")
const decodeWelcome = json(Schema.decodeUnknownOption(Schema.fromJsonString(Welcome)), "welcome")
const decodeProof = json(Schema.decodeUnknownOption(Schema.fromJsonString(Proof)), "proof")

// The channel's messages, already unwrapped from their envelopes: the handshake, then transport messages.
export type Wire<E = never> = {
  send: (message: Uint8Array) => Effect.Effect<void, Closed>
  receive: Effect.Effect<Uint8Array, Closed | Malformed | Replay | E>
  // Hands back the last message received, which did not authenticate on this channel. Only the desktop's new channel
  // has it: it runs beside the live one, whose envelopes it may see first.
  reject?: () => void
}

// What a handshake produced. `attach` attaches the session to the new connection and returns the frames to resend
// on it; the caller runs it where no other fiber can seal a frame in between.
export type Established = {
  session: Session
  attach: (now: number) => Effect.Effect<Uint8Array[], ResumeFailed | Handshake>
}

// Phone, first pairing: Noise XX. Refuses a desktop whose static key is not the one in the QR, proves the token inside
// the encrypted third message, then waits for the desktop's verdict: an ack, or a close naming why it refused.
export function pair(input: {
  wire: Wire
  staticKey: KeyPair
  pairing: Pairing
  now: number
  options?: Partial<Options>
  versions?: number[]
}) {
  return Effect.gen(function* () {
    const handshake = yield* HandshakeState.make({
      pattern: "XX",
      initiator: true,
      prologue,
      staticKey: input.staticKey,
    })
    const hello = yield* handshake.write(utf8(JSON.stringify({ versions: input.versions ?? supported })))
    yield* input.wire.send(withPattern(PatternByte.XX, hello))
    const welcome = yield* decodeWelcome(yield* handshake.read(yield* input.wire.receive))
    const desktop = handshake.remoteStatic as Uint8Array
    if (!equalBytes(desktop, input.pairing.desktopKey))
      return yield* new KeyMismatch({
        expected: fingerprint(input.pairing.desktopKey),
        found: fingerprint(desktop),
      })
    const accepted = yield* welcomed(welcome)
    yield* input.wire.send(yield* handshake.write(utf8(JSON.stringify({ token: toBase64Url(input.pairing.token) }))))
    const session = new Session({ id: accepted.session, remoteStatic: desktop, options: input.options })
    yield* session.attach(yield* handshake.split(), 0, input.now)
    const verdict = yield* session.receive(yield* input.wire.receive)
    if (verdict?.kind === Kind.Close) return yield* closed(verdict.payload)
    if (verdict?.kind !== Kind.Ack)
      return yield* new Malformed({ what: "handshake", message: "no pairing verdict from the desktop" })
    return { session, attach: () => Effect.succeed([]) } satisfies Established
  })
}

// Phone, reconnect: Noise IK to the desktop key already pinned. With `resume`, asks to continue that session.
export function reconnect(input: {
  wire: Wire
  staticKey: KeyPair
  desktopKey: Uint8Array
  resume?: Session
  now: number
  options?: Partial<Options>
  versions?: number[]
}) {
  return Effect.gen(function* () {
    const handshake = yield* HandshakeState.make({
      pattern: "IK",
      initiator: true,
      prologue,
      staticKey: input.staticKey,
      remoteStatic: input.desktopKey,
    })
    const resume = input.resume ? { session: input.resume.id, received: input.resume.received } : undefined
    const hello = yield* handshake.write(utf8(JSON.stringify({ versions: input.versions ?? supported, resume })))
    yield* input.wire.send(withPattern(PatternByte.IK, hello))
    const accepted = yield* welcomed(yield* decodeWelcome(yield* handshake.read(yield* input.wire.receive)))
    const transport = yield* handshake.split()
    if (input.resume && accepted.session !== input.resume.id)
      return yield* new ResumeFailed({ message: "the desktop no longer holds the session" })
    const session =
      input.resume ?? new Session({ id: accepted.session, remoteStatic: input.desktopKey, options: input.options })
    const peerReceived = input.resume ? accepted.received : 0
    return {
      session,
      attach: (now) => session.attach(transport, peerReceived, now, { confirm: true }),
    } satisfies Established
  })
}

export type Accepted = Established & {
  // The phone's static key when this channel paired a new device: the caller stores it and drops the pairing
  paired?: Uint8Array
  resumed: boolean
}

// Desktop: answers a channel's first message, XX for a pairing or IK for a known device. A pairing it refuses is
// still told to the phone, over the new channel, before failing. It completes only once the phone is authenticated
// and live: after the XX third message, or after the phone's first frame on a new IK channel.
export function accept<E>(input: {
  wire: Wire<E>
  first: Uint8Array
  staticKey: KeyPair
  // The pairing the desktop shows now, if any. Read again when the proof arrives: it may have been cancelled,
  // replaced or let expire since the first message.
  pairing: () => Pick<Pairing, "token" | "expires"> | undefined
  // Whether a token already paired a phone
  used?: (token: Uint8Array) => boolean
  // Marks a token used once its proof verifies; false when another channel claimed it first. Runs before the verdict
  // is sent, so two phones racing with the same QR cannot both pair.
  claim?: (token: Uint8Array) => boolean
  // Whether a static key belongs to a paired device
  device: (remoteStatic: Uint8Array) => boolean
  // The live session with this id, if it belongs to this device
  session: (id: string, remoteStatic: Uint8Array) => Session | undefined
  options?: Partial<Options>
}) {
  return Effect.gen(function* () {
    const pattern = input.first[0] === PatternByte.XX ? "XX" : input.first[0] === PatternByte.IK ? "IK" : undefined
    if (pattern === undefined) return yield* new Malformed({ what: "handshake", message: "unknown pattern" })
    const handshake = yield* HandshakeState.make({ pattern, initiator: false, prologue, staticKey: input.staticKey })
    const hello = yield* decodeHello(yield* handshake.read(input.first.subarray(1)))
    const refuse = (refused: "version" | "device") =>
      handshake
        .write(utf8(JSON.stringify({ refused, versions: supported })))
        .pipe(Effect.flatMap((message) => input.wire.send(message)))
    const chosen = Math.max(...hello.versions.filter((v) => supported.includes(v)))
    if (!Number.isFinite(chosen)) {
      yield* refuse("version")
      return yield* new Incompatible({ supported: supported.join(","), found: hello.versions.join(",") })
    }
    const phone = handshake.remoteStatic
    if (pattern === "IK" && (phone === undefined || !input.device(phone))) {
      yield* refuse("device")
      return yield* new KeyMismatch({ found: phone ? fingerprint(phone) : "none" })
    }
    const existing = pattern === "IK" && hello.resume ? input.session(hello.resume.session, phone!) : undefined
    const id = existing?.id ?? newId()
    yield* input.wire.send(
      yield* handshake.write(utf8(JSON.stringify({ version: chosen, session: id, received: existing?.received ?? 0 }))),
    )
    if (pattern === "IK") {
      const transport = yield* handshake.split()
      yield* authenticated(input.wire, (message) => confirmed(transport, message))
      const session = existing ?? new Session({ id, remoteStatic: phone!, options: input.options })
      const peerReceived = existing ? hello.resume!.received : 0
      return {
        session,
        attach: (now) => session.attach(transport, peerReceived, now),
        resumed: existing !== undefined,
      } satisfies Accepted
    }
    const proof = yield* decodeProof(yield* authenticated(input.wire, (message) => handshake.read(message)))
    const transport = yield* handshake.split()
    const session = new Session({ id, remoteStatic: transport.remoteStatic, options: input.options })
    const now = yield* Clock.currentTimeMillis
    yield* session.attach(transport, 0, now)
    const rejected = verify({ ...input, proof: proof.token, now })
    if (rejected) {
      const close = yield* session.send(
        { kind: Kind.Close, stream: 0, flags: 0, payload: utf8(`pairing:${rejected}`) },
        now,
      )
      yield* input.wire.send(close!)
      return yield* new PairingRejected({ reason: rejected })
    }
    const ack = yield* session.send({ kind: Kind.Ack, stream: 0, flags: 0, payload: empty }, now)
    yield* input.wire.send(ack!)
    return {
      session,
      attach: () => Effect.succeed([]),
      paired: transport.remoteStatic,
      resumed: false,
    } satisfies Accepted
  })
}

// The token is checked against the pairing shown now; claiming it is the last step, so only a proof that passed
// everything else uses it up.
function verify(input: {
  proof: string
  now: number
  pairing: () => Pick<Pairing, "token" | "expires"> | undefined
  used?: (token: Uint8Array) => boolean
  claim?: (token: Uint8Array) => boolean
}) {
  const token = fromBase64Url(input.proof)
  if (token?.length !== 32) return "token" as const
  if (input.used?.(token)) return "used" as const
  const pairing = input.pairing()
  if (pairing === undefined) return "cancelled" as const
  if (!equalBytes(token, pairing.token)) return "token" as const
  if (input.now >= pairing.expires) return "expired" as const
  if (input.claim?.(token) === false) return "used" as const
  return undefined
}

// Reads the next message `open` authenticates. On the desktop's new channel a message that fails to decrypt is the
// live channel's, so it is handed back and the next one tried; anywhere else it is fatal.
function authenticated<A, E, F>(wire: Wire<E>, open: (message: Uint8Array) => Effect.Effect<A, F>) {
  return Effect.gen(function* () {
    while (true) {
      const message = yield* wire.receive
      const opened = yield* Effect.result(open(message))
      if (opened._tag === "Success") return opened.success
      const failure = opened.failure as F & { _tag?: string }
      if (wire.reject && failure._tag === "Decrypt") {
        wire.reject()
        continue
      }
      return yield* Effect.fail(failure)
    }
  })
}

// The reconnecting phone's first transport frame, an ack: it holds the new keys, so it is live, not a replay.
function confirmed(transport: Transport, message: Uint8Array) {
  return Effect.gen(function* () {
    const frame = yield* decode(yield* transport.receive.decrypt(empty, message, "transport"))
    if (frame.flags & Flag.Rekey) transport.receive.rekey()
    if (frame.kind !== Kind.Ack) return yield* new Malformed({ what: "handshake", message: "no confirmation" })
  })
}

// A close frame's payload is its reason code; `pairing:<reason>` is the desktop refusing a pairing.
export function closed(payload: Uint8Array) {
  const reason = fromUtf8(payload) ?? "unknown"
  const pairing = /^pairing:(expired|token|instance|used|cancelled)$/.exec(reason)
  if (pairing) return new PairingRejected({ reason: pairing[1] as PairingRejected["reason"] })
  return new Closed({ reason })
}

function welcomed(welcome: typeof Welcome.Type) {
  if ("refused" in welcome) {
    if (welcome.refused === "device") return Effect.fail(new KeyMismatch({ found: "this device" }))
    return Effect.fail(new Incompatible({ supported: supported.join(","), found: welcome.versions.join(",") }))
  }
  if (!supported.includes(welcome.version))
    return Effect.fail(new Incompatible({ supported: supported.join(","), found: String(welcome.version) }))
  return Effect.succeed(welcome)
}

function withPattern(pattern: number, message: Uint8Array) {
  const bytes = new Uint8Array(message.length + 1)
  bytes[0] = pattern
  bytes.set(message, 1)
  return bytes
}

function newId() {
  return toBase64Url(randomBytes(16))
}
