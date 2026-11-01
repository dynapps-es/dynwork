import { equalBytes } from "@noble/ciphers/utils.js"
import { Cause, Clock, Deferred, Duration, Effect, Fiber, Queue, Semaphore } from "effect"
import { empty, fromUtf8, toBase64Url, utf8 } from "./bytes"
import { decode as decodeEnvelope, encode as encodeEnvelope, type Envelope } from "./envelope"
import { Closed, Handshake, Replay, type RemoteError } from "./errors"
import { Kind, unsequenced, type Frame } from "./frame"
import { peerId, type Pairing } from "./keys"
import { Mux } from "./mux"
import type { KeyPair } from "./noise"
import {
  accept,
  pair,
  reconnect,
  type Accepted,
  type Established,
  type Options,
  type Outgoing,
  type Session,
  type Wire,
} from "./session"

// One side of the channel over a relay connection. `Link` is the transport binding (a WebSocket to the relay in the
// apps, the in-memory relay in tests): envelopes out, envelopes in, and a failure when the socket drops.

export type Link = {
  send: (envelope: Uint8Array) => void
  // Fails with `Closed` when the socket drops
  incoming: Queue.Dequeue<Uint8Array, Closed>
}

// Why the current connection ended. The session stays usable for resume unless the peer closed it.
export type Ended = { error: RemoteError }

// Frames that keep the channel moving. They never wait for room in the replay window: the reader sends them, and a
// reader that waited on the window, which only its own acks can drain, would deadlock both sides.
const control = new Set<number>([...unsequenced, Kind.Credit, Kind.Reset, Kind.Close])

// A channel's envelopes as Noise messages, with what the reader loop needs to know. A channel is unsettled until a
// message authenticates on it: envelopes of the channel it replaces can still be in flight.
type ChannelWire<E> = Wire<E> & { settle: () => void; settled: () => boolean; idle: () => boolean }

// A session and its streams, attached to at most one connection at a time.
export class Peer {
  readonly session: Session
  readonly mux: Mux
  #wire: Wire<unknown> | undefined
  // Counts connections, so a reader of an older one can neither detach nor feed the current one
  #generation = 0
  #ended = Deferred.makeUnsafe<Ended>()
  #space: Deferred.Deferred<void> = Deferred.makeUnsafe<void>()
  #closed: Closed | undefined
  readonly #onClosed: (() => void) | undefined
  // Sealing and sending are one step: two fibers interleaving between them would put ciphertexts on the wire out of
  // nonce order (and split a rekey from the frame that announces it).
  readonly #lock = Semaphore.makeUnsafe(1)

  constructor(session: Session, initiator: boolean, onClosed?: () => void) {
    this.session = session
    this.mux = new Mux({ write: (frame) => this.write(frame), initiator })
    this.#onClosed = onClosed
  }

  get connected() {
    return this.#wire !== undefined
  }

  get closed() {
    return this.#closed !== undefined
  }

  get generation() {
    return this.#generation
  }

  // Completes when the current connection ends, with the reason.
  get ended() {
    return Deferred.await(this.#ended)
  }

  // Sends one frame. A sequenced data frame waits while the replay window is full; while detached it is kept for the
  // next connection.
  write(frame: Outgoing): Effect.Effect<void, Closed> {
    const self = this
    return Effect.gen(function* () {
      while (true) {
        if (self.#closed) return yield* self.#closed
        if (control.has(frame.kind) || self.session.hasSpace) break
        yield* Deferred.await(self.#space)
      }
      yield* self.#lock.withPermit(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          // Only an oversized payload fails here, and the mux bounds every payload it writes (heads included)
          const sealed = yield* self.session.send(frame, now).pipe(Effect.orDie)
          const wire = self.#wire
          if (sealed && wire) yield* wire.send(sealed)
        }),
      )
    })
  }

  // Closes the session for good, telling the peer why.
  close(reason: string) {
    const self = this
    return Effect.gen(function* () {
      if (self.#closed) return
      yield* self.write({ kind: Kind.Close, stream: 0, flags: 0, payload: utf8(reason.slice(0, 200)) })
      self.#shut(new Closed({ reason }))
    })
  }

  // Takes the connection a handshake produced and returns its generation. What the peer is missing goes out before any
  // new frame; whoever waited on the previous connection learns it was replaced.
  attach(wire: Wire<unknown>, established: Established) {
    const self = this
    return self.#lock.withPermit(
      Effect.gen(function* () {
        if (self.#closed) return yield* self.#closed
        const resend = yield* established.attach(yield* Clock.currentTimeMillis)
        Deferred.doneUnsafe(self.#ended, Effect.succeed({ error: new Closed({ reason: "replaced" }) }))
        self.#generation++
        self.#wire = wire
        self.#ended = Deferred.makeUnsafe<Ended>()
        for (const sealed of resend) yield* wire.send(sealed)
        self.#freed()
        return self.#generation
      }),
    )
  }

  // Detaches the connection of `generation` (the current one by default); an older one is already gone.
  detach(error: RemoteError, generation = this.#generation) {
    if (generation !== this.#generation || this.#wire === undefined) return
    this.#wire = undefined
    this.session.detach()
    Deferred.doneUnsafe(this.#ended, Effect.succeed({ error }))
  }

  // Reads the connection of `generation` until it fails or is replaced, then detaches it. Until the first message
  // authenticates, one that fails to decrypt is a straggler of the replaced channel and is skipped (a failed decryption
  // leaves the cipher as it was); after it, the channel is strict. Acks go out whenever the reader catches up, so a
  // sender is never left waiting on a quiet channel.
  pump<E>(wire: ChannelWire<E>, generation: number) {
    const self = this
    return Effect.gen(function* () {
      while (true) {
        const message = yield* wire.receive
        if (generation !== self.#generation) return
        const delivered = yield* Effect.result(self.deliver(message))
        if (delivered._tag === "Failure") {
          if (!wire.settled() && wire.reject && delivered.failure._tag === "Decrypt") {
            wire.reject()
            continue
          }
          return yield* Effect.fail(delivered.failure)
        }
        wire.settle()
        if (wire.idle() && self.session.ackDue) yield* self.#ack
      }
    }).pipe(Effect.catch((error) => Effect.sync(() => self.detach(error as RemoteError, generation))))
  }

  deliver(ciphertext: Uint8Array) {
    const self = this
    return Effect.gen(function* () {
      const frame = yield* self.session.receive(ciphertext)
      self.#freed()
      if (frame) yield* self.#dispatch(frame)
      if (self.session.ackOverdue) yield* self.#ack
    })
  }

  get #ack() {
    return this.write({ kind: Kind.Ack, stream: 0, flags: 0, payload: empty })
  }

  #dispatch(frame: Frame) {
    if (frame.kind === Kind.Ping) return this.write({ kind: Kind.Pong, stream: 0, flags: 0, payload: frame.payload })
    if (frame.kind === Kind.Close)
      return Effect.sync(() => this.#shut(new Closed({ reason: fromUtf8(frame.payload) ?? "unknown" })))
    if (frame.stream === 0) return Effect.void
    return this.mux.receive(frame)
  }

  #freed() {
    if (!this.session.hasSpace) return
    Deferred.doneUnsafe(this.#space, Effect.void)
    this.#space = Deferred.makeUnsafe<void>()
  }

  #shut(error: Closed) {
    this.#closed = error
    this.mux.close(error)
    this.detach(error)
    Deferred.doneUnsafe(this.#space, Effect.void)
    this.#onClosed?.()
  }
}

// The envelopes of one channel between two peer ids. `seq` counts each direction from 0; once a message has
// authenticated on the channel, a gap is a `Replay`.
//
// Until then the channel is unsettled: envelopes of the channel it replaces may still arrive. Whatever it cannot use
// (another seq, or, via `reject`, a message that fails to authenticate) goes to `forward`: on the desktop the live
// channel this one runs beside, on the phone nowhere. A settled phone channel also skips a desktop's stray first
// answer (seq 0) to a handshake the relay replayed.
function channel<E = never>(input: {
  link: Link
  self: Uint8Array
  remote: Uint8Array
  queue?: Queue.Queue<Envelope, Closed>
  forward?: (envelope: Envelope) => void
}): ChannelWire<E> {
  const state = {
    sent: 0,
    received: 0,
    settled: false,
    last: undefined as Envelope | undefined,
    rejected: undefined as number | undefined,
  }
  const queue = input.queue
  const forward = input.forward
  const next: Effect.Effect<Envelope | undefined, Closed | E> = queue
    ? Queue.take(queue)
    : Queue.take(input.link.incoming).pipe(
        Effect.flatMap((bytes) => decodeEnvelope(bytes)),
        Effect.catchTag("Malformed", () => Effect.succeed(undefined)),
      )
  return {
    send: (ciphertext) =>
      Effect.sync(() =>
        input.link.send(encodeEnvelope({ to: input.remote, from: input.self, seq: state.sent++, ciphertext })),
      ),
    receive: Effect.gen(function* () {
      while (true) {
        const envelope = yield* next
        if (envelope === undefined || !equalBytes(envelope.from, input.remote)) continue
        // On the phone, the message after one that failed to authenticate proves the failed one was this channel's own:
        // it was tampered with, and waiting would hang the channel
        if (!state.settled && !forward && state.rejected !== undefined && envelope.seq === state.rejected + 1)
          return yield* new Replay({ expected: state.rejected, found: envelope.seq })
        if (envelope.seq === state.received) {
          state.received++
          state.last = envelope
          return envelope.ciphertext
        }
        if (!state.settled) {
          forward?.(envelope)
          continue
        }
        if (envelope.seq === 0 && queue === undefined) continue
        return yield* new Replay({ expected: state.received, found: envelope.seq })
      }
    }),
    reject: () => {
      if (state.settled || state.last === undefined) return
      state.received--
      state.rejected = state.received
      forward?.(state.last)
      state.last = undefined
    },
    settle: () => {
      state.settled = true
    },
    settled: () => state.settled,
    idle: () => (queue ? Queue.sizeUnsafe(queue) : Queue.sizeUnsafe(input.link.incoming)) === 0,
  }
}

// Phone: pairs with the desktop in the QR over a fresh relay link.
export function pairPhone(input: { link: Link; staticKey: KeyPair; pairing: Pairing; options?: Partial<Options> }) {
  return Effect.gen(function* () {
    const wire = channel({
      link: input.link,
      self: peerId(input.staticKey.publicKey),
      remote: peerId(input.pairing.desktopKey),
    })
    const now = yield* Clock.currentTimeMillis
    const established = yield* pair({
      wire,
      staticKey: input.staticKey,
      pairing: input.pairing,
      now,
      options: input.options,
    })
    // The desktop's verdict authenticated on this channel
    wire.settle()
    return yield* start(new Peer(established.session, true), wire, established)
  })
}

// Phone: reconnects to a paired desktop. With `peer`, resumes its session (its open streams carry on); otherwise starts
// a new one. Fails with `ResumeFailed` when the desktop no longer holds the session.
export function reconnectPhone(input: {
  link: Link
  staticKey: KeyPair
  desktopKey: Uint8Array
  peer?: Peer
  options?: Partial<Options>
  versions?: number[]
}) {
  return Effect.gen(function* () {
    const wire = channel({
      link: input.link,
      self: peerId(input.staticKey.publicKey),
      remote: peerId(input.desktopKey),
    })
    const now = yield* Clock.currentTimeMillis
    const established = yield* reconnect({
      wire,
      staticKey: input.staticKey,
      desktopKey: input.desktopKey,
      resume: input.peer?.session,
      now,
      options: input.options,
      versions: input.versions,
    })
    return yield* start(input.peer ?? new Peer(established.session, true), wire, established)
  })
}

function start(peer: Peer, wire: ChannelWire<never>, established: Established) {
  return Effect.gen(function* () {
    const generation = yield* peer.attach(wire, established)
    yield* peer.pump(wire, generation).pipe(Effect.forkDetach({ startImmediately: true }))
    return peer
  })
}

export type DesktopEvents = {
  // A phone completed a pairing: store its key and drop the pairing
  paired?: (phoneKey: Uint8Array, peer: Peer) => void
  // A phone connected or resumed; serve its streams here
  connected?: (peer: Peer, resumed: boolean) => void
  // A channel failed before it could attach (a refused pairing, an unknown device, a version mismatch, a timeout)
  refused?: (error: unknown) => void
}

export type DesktopOptions = {
  staticKey: KeyPair
  // The pairing the desktop is showing, if any. Read when a proof arrives, so cancelling or replacing it takes effect
  // even for a handshake already under way.
  pairing: () => Pick<Pairing, "token" | "expires"> | undefined
  device: (phoneKey: Uint8Array) => boolean
  events?: DesktopEvents
  options?: Partial<Options>
  // A handshake not authenticated after this long is dropped
  handshakeMs?: number
  // Handshakes under way at once; first messages past it are dropped
  maxHandshakes?: number
  // A detached session waits this long for its phone to resume, then is closed
  resumeMs?: number
  // Envelopes queued for one phone channel; past it the channel is dropped and the phone resumes
  queueLength?: number
}

type Line = Queue.Queue<Envelope, Closed>
type Pending = { line: Line; fiber?: Fiber.Fiber<void, unknown>; done?: boolean }
// A phone's live channel and the new channels under way, oldest first. The newest receives the phone's envelopes and
// passes what it cannot authenticate to the one before it, down to the live channel; so a replayed first message
// neither cuts off the live channel nor a genuine reconnect still under way.
type Phone = { live?: Line; pending: Pending[] }

// New channels under way at once for one phone
const maxPendingPerPhone = 4

// Desktop: the sessions of every paired phone. It outlives any one relay connection: `listen` serves one link, and a
// new link after a relay reconnect finds the same sessions (so phones resume) and the same used pairing tokens.
export class Desktop {
  readonly #input: DesktopOptions
  readonly #id: Uint8Array
  readonly #peers = new Map<string, Peer>()
  readonly #claimed = new Set<string>()
  #handshakes = 0

  constructor(input: DesktopOptions) {
    this.#input = input
    this.#id = peerId(input.staticKey.publicKey)
  }

  // Sessions held, connected or waiting for their phone to resume
  get sessions() {
    return this.#peers.size
  }

  get handshakes() {
    return this.#handshakes
  }

  // Answers every phone on one relay link until the link fails, and returns why. Envelopes are demultiplexed by
  // sender. A phone's seq 0 starts a new channel beside its live one, which carries on until the new one
  // authenticates; a replayed first message therefore cannot cut a phone off.
  listen(link: Link) {
    const self = this
    const phones = new Map<string, Phone>()
    const limit = self.#input.maxHandshakes ?? 16
    return Effect.gen(function* () {
      while (true) {
        const envelope = yield* Queue.take(link.incoming).pipe(
          Effect.flatMap((bytes) => decodeEnvelope(bytes)),
          Effect.catchTag("Malformed", () => Effect.succeed(undefined)),
        )
        if (envelope === undefined || !equalBytes(envelope.to, self.#id)) continue
        const key = toBase64Url(envelope.from)
        const phone = phones.get(key)
        if (envelope.seq === 0) {
          const state = phone ?? { pending: [] }
          if (self.#handshakes >= limit || state.pending.length >= maxPendingPerPhone) continue
          phones.set(key, state)
          const line = yield* Queue.bounded<Envelope, Closed>(self.#input.queueLength ?? 8192)
          Queue.offerUnsafe(line, envelope)
          const pending: Pending = { line }
          state.pending.push(pending)
          pending.fiber = yield* self
            .#handshake(link, envelope.from, state, pending)
            .pipe(Effect.forkDetach({ startImmediately: true }))
          continue
        }
        const target = phone?.pending.at(-1)?.line ?? phone?.live
        if (target && !Queue.offerUnsafe(target, envelope)) {
          // Dropped at once, unread: the phone resumes on a new channel
          while (Queue.takeUnsafe(target)?._tag === "Success") continue
          Queue.failCauseUnsafe(target, Cause.fail(new Closed({ reason: "overflow" })))
        }
      }
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          phones.forEach((phone) =>
            [phone.live, ...phone.pending.map((pending) => pending.line)].forEach(
              (line) => line && Queue.failCauseUnsafe(line, Cause.fail(error)),
            ),
          )
          return error
        }),
      ),
    )
  }

  // Runs one new channel's handshake beside the phone's live channel, then switches to it.
  #handshake(link: Link, remote: Uint8Array, phone: Phone, pending: Pending) {
    const self = this
    // The channel below this one in the phone's chain: an older handshake under way, or the live channel
    const below = (envelope: Envelope) => {
      const index = phone.pending.indexOf(pending)
      const line = index > 0 ? phone.pending[index - 1]!.line : phone.live
      if (line) Queue.offerUnsafe(line, envelope)
    }
    const wire = channel<never>({ link, self: self.#id, remote, queue: pending.line, forward: below })
    const run = Effect.gen(function* () {
      const first = yield* wire.receive
      const outcome = yield* self.#accept(wire, first).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(self.#input.handshakeMs ?? 30_000),
          orElse: () => Effect.fail(new Handshake({ message: "timed out" })),
        }),
        Effect.result,
      )
      if (outcome._tag === "Failure") {
        self.#input.events?.refused?.(outcome.failure)
        return
      }
      const accepted = outcome.success
      const peer = self.#adopt(accepted)
      if (accepted.paired) self.#input.events?.paired?.(accepted.paired, peer)
      // Authenticated: this channel replaces the live one, and older handshakes are moot
      const replaced = phone.live
      const index = phone.pending.indexOf(pending)
      phone.pending.splice(0, index + 1).forEach((older) => {
        older.done = true
        if (older !== pending) older.fiber?.interruptUnsafe()
      })
      phone.live = pending.line
      wire.settle()
      const attached = yield* Effect.result(peer.attach(wire, accepted))
      if (replaced) Queue.failCauseUnsafe(replaced, Cause.fail(new Closed({ reason: "replaced" })))
      if (attached._tag === "Failure") {
        self.#input.events?.refused?.(attached.failure)
        return
      }
      self.#input.events?.connected?.(peer, accepted.resumed)
      yield* peer.pump(wire, attached.success).pipe(Effect.forkDetach({ startImmediately: true }))
      yield* self.#expire(peer, attached.success).pipe(Effect.forkDetach({ startImmediately: true }))
    })
    return Effect.suspend(() => {
      self.#handshakes++
      return run
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          self.#handshakes--
          if (pending.done) return
          // Not authenticated (refused or timed out): what queued up meanwhile belongs to the channel below
          for (
            let next = Queue.takeUnsafe(pending.line);
            next?._tag === "Success";
            next = Queue.takeUnsafe(pending.line)
          )
            below(next.value)
          phone.pending.splice(phone.pending.indexOf(pending), 1)
        }),
      ),
    )
  }

  #accept(wire: ChannelWire<never>, first: Uint8Array) {
    const self = this
    return accept({
      wire,
      first,
      staticKey: self.#input.staticKey,
      pairing: self.#input.pairing,
      used: (token) => self.#claimed.has(toBase64Url(token)),
      claim: (token) => {
        const key = toBase64Url(token)
        if (self.#claimed.has(key)) return false
        self.#claimed.add(key)
        return true
      },
      device: self.#input.device,
      session: (id, phoneKey) => {
        const peer = self.#peers.get(id)
        return peer && !peer.closed && equalBytes(peer.session.remoteStatic, phoneKey) ? peer.session : undefined
      },
      options: self.#input.options,
    })
  }

  // The peer of a resumed session, or a new one. A new session for a phone replaces the phone's older ones: they can
  // no longer be resumed.
  #adopt(accepted: Accepted) {
    const existing = accepted.resumed ? this.#peers.get(accepted.session.id) : undefined
    if (existing) return existing
    const id = accepted.session.id
    ;[...this.#peers.values()]
      .filter((peer) => equalBytes(peer.session.remoteStatic, accepted.session.remoteStatic))
      .forEach((peer) => Effect.runFork(peer.close("replaced")))
    const peer = new Peer(accepted.session, false, () => {
      if (this.#peers.get(id) === peer) this.#peers.delete(id)
    })
    this.#peers.set(id, peer)
    return peer
  }

  // Closes a peer whose phone has not resumed within `resumeMs` of losing connection `generation`. A resume replaces
  // the connection, and the new one gets its own watch.
  #expire(peer: Peer, generation: number) {
    const resumeMs = this.#input.resumeMs ?? 10 * 60_000
    return Effect.gen(function* () {
      yield* peer.ended
      if (peer.closed || peer.generation !== generation) return
      yield* Effect.sleep(Duration.millis(resumeMs))
      if (!peer.closed && peer.generation === generation) yield* peer.close("expired")
    })
  }
}
