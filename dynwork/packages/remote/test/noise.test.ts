import { describe, expect, test } from "bun:test"
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js"
import { Effect } from "effect"
import { Noise } from "../src"
import fixture from "./fixtures/noise-vectors.json"

// The published vectors of the three public suites (cacophony, snow, noise-c; script/vectors.ts pins each file):
// every XX and IK vector for 25519/ChaChaPoly/SHA256. Both sides run the real state machine with the vector's fixed
// keys; every handshake and transport message must match byte for byte. Messages alternate between the initiator
// (even index) and the responder, the handshake first and then the transport.
describe("Noise test vectors", () => {
  test("cover XX and IK from every source", () => {
    expect(fixture.vectors.length).toBe(6)
    expect(new Set(fixture.vectors.map((vector) => `${vector.source} ${vector.protocol}`)).size).toBe(6)
  })

  test.each(fixture.vectors.map((vector) => [`${vector.source} ${vector.protocol}`, vector] as const))(
    "%s",
    (_, vector) => {
      const run = Effect.gen(function* () {
        const pattern = vector.protocol.split("_")[1] as Noise.Pattern
        const key = (hex: string) => Noise.keyPairFromSecret(hexToBytes(hex))
        const initiator = yield* Noise.HandshakeState.make({
          pattern,
          initiator: true,
          prologue: hexToBytes(vector.init_prologue),
          staticKey: key(vector.init_static),
          ephemeral: key(vector.init_ephemeral),
          remoteStatic: vector.init_remote_static === undefined ? undefined : hexToBytes(vector.init_remote_static),
        })
        const responder = yield* Noise.HandshakeState.make({
          pattern,
          initiator: false,
          prologue: hexToBytes(vector.resp_prologue),
          staticKey: key(vector.resp_static),
          ephemeral: key(vector.resp_ephemeral),
        })
        const first = { handshake: initiator, transport: undefined as Noise.Transport | undefined }
        const second = { handshake: responder, transport: undefined as Noise.Transport | undefined }
        const sides = [first, second]
        for (const [index, message] of vector.messages.entries()) {
          const sender = index % 2 === 0 ? first : second
          const receiver = index % 2 === 0 ? second : first
          const payload = hexToBytes(message.payload)
          const ciphertext = sender.transport
            ? yield* sender.transport.send.encrypt(new Uint8Array(0), payload)
            : yield* sender.handshake.write(payload)
          expect(bytesToHex(ciphertext)).toBe(message.ciphertext)
          const opened = receiver.transport
            ? yield* receiver.transport.receive.decrypt(new Uint8Array(0), ciphertext, "transport")
            : yield* receiver.handshake.read(ciphertext)
          expect(bytesToHex(opened)).toBe(message.payload)
          for (const side of sides)
            if (!side.transport && side.handshake.finished) side.transport = yield* side.handshake.split()
        }
        expect(sides.every((side) => side.transport !== undefined)).toBe(true)
        if (vector.handshake_hash !== undefined) expect(bytesToHex(initiator.hash)).toBe(vector.handshake_hash)
        expect(bytesToHex(initiator.hash)).toBe(bytesToHex(responder.hash))
        expect(bytesToHex(responder.remoteStatic!)).toBe(bytesToHex(key(vector.init_static).publicKey))
      })
      Effect.runSync(run)
    },
  )
})

describe("Noise", () => {
  const handshake = (pattern: Noise.Pattern, responderKey = Noise.generateKeyPair()) =>
    Effect.gen(function* () {
      const initiatorKey = Noise.generateKeyPair()
      const initiator = yield* Noise.HandshakeState.make({
        pattern,
        initiator: true,
        prologue: new Uint8Array(0),
        staticKey: initiatorKey,
        remoteStatic: pattern === "IK" ? responderKey.publicKey : undefined,
      })
      const responder = yield* Noise.HandshakeState.make({
        pattern,
        initiator: false,
        prologue: new Uint8Array(0),
        staticKey: responderKey,
      })
      return { initiator, responder, initiatorKey, responderKey }
    })

  test("a tampered handshake message fails to decrypt", () => {
    const result = Effect.gen(function* () {
      const sides = yield* handshake("XX")
      yield* sides.responder.read(yield* sides.initiator.write(new Uint8Array(0)))
      const second = yield* sides.responder.write(new Uint8Array([1, 2, 3]))
      second[40] = (second[40] ?? 0) ^ 1
      return yield* sides.initiator.read(second)
    }).pipe(Effect.flip, Effect.runSync)
    expect(result._tag).toBe("Decrypt")
  })

  test("IK against the wrong responder key fails on the responder", () => {
    const result = Effect.gen(function* () {
      const sides = yield* handshake("IK")
      const other = yield* Noise.HandshakeState.make({
        pattern: "IK",
        initiator: false,
        prologue: new Uint8Array(0),
        staticKey: Noise.generateKeyPair(),
      })
      return yield* other.read(yield* sides.initiator.write(new Uint8Array(0)))
    }).pipe(Effect.flip, Effect.runSync)
    expect(result._tag).toBe("Decrypt")
  })

  test("transport rejects replayed and reordered messages, and keeps working after a forgery", () => {
    Effect.gen(function* () {
      const sides = yield* handshake("IK")
      yield* sides.responder.read(yield* sides.initiator.write(new Uint8Array(0)))
      yield* sides.initiator.read(yield* sides.responder.write(new Uint8Array(0)))
      const a = yield* sides.initiator.split()
      const b = yield* sides.responder.split()
      const first = yield* a.send.encrypt(new Uint8Array(0), new Uint8Array([1]))
      const second = yield* a.send.encrypt(new Uint8Array(0), new Uint8Array([2]))
      expect((yield* Effect.flip(b.receive.decrypt(new Uint8Array(0), second, "transport")))._tag).toBe("Decrypt")
      expect([...(yield* b.receive.decrypt(new Uint8Array(0), first, "transport"))]).toEqual([1])
      expect((yield* Effect.flip(b.receive.decrypt(new Uint8Array(0), first, "transport")))._tag).toBe("Decrypt")
      expect([...(yield* b.receive.decrypt(new Uint8Array(0), second, "transport"))]).toEqual([2])
    }).pipe(Effect.runSync)
  })

  test("rekey on both ends keeps the channel; on one end only breaks it", () => {
    Effect.gen(function* () {
      const sides = yield* handshake("XX")
      yield* sides.responder.read(yield* sides.initiator.write(new Uint8Array(0)))
      yield* sides.initiator.read(yield* sides.responder.write(new Uint8Array(0)))
      yield* sides.responder.read(yield* sides.initiator.write(new Uint8Array(0)))
      const a = yield* sides.initiator.split()
      const b = yield* sides.responder.split()
      a.send.rekey()
      b.receive.rekey()
      const sealed = yield* a.send.encrypt(new Uint8Array(0), new Uint8Array([7]))
      expect([...(yield* b.receive.decrypt(new Uint8Array(0), sealed, "transport"))]).toEqual([7])
      a.send.rekey()
      const unsynced = yield* a.send.encrypt(new Uint8Array(0), new Uint8Array([8]))
      expect((yield* Effect.flip(b.receive.decrypt(new Uint8Array(0), unsynced, "transport")))._tag).toBe("Decrypt")
    }).pipe(Effect.runSync)
  })

  test("a low-order remote ephemeral key aborts the handshake", () => {
    const result = Effect.gen(function* () {
      const sides = yield* handshake("XX")
      yield* sides.responder.read(new Uint8Array(32))
      return yield* sides.responder.write(new Uint8Array(0))
    }).pipe(Effect.flip, Effect.runSync)
    expect(result).toMatchObject({ _tag: "Handshake", message: "invalid public key" })
  })

  test("messages out of turn are refused", () => {
    const result = Effect.gen(function* () {
      const sides = yield* handshake("XX")
      return yield* sides.responder.write(new Uint8Array(0))
    }).pipe(Effect.flip, Effect.runSync)
    expect(result._tag).toBe("Handshake")
  })
})
