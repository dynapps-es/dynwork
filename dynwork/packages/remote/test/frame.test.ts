import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import fc from "fast-check"
import { Envelope, Frame } from "../src"

const kinds = Object.values(Frame.Kind)

const frame = fc
  .record({
    kind: fc.constantFrom(...kinds),
    flags: fc.subarray([Frame.Flag.Fin, Frame.Flag.Text, Frame.Flag.More, Frame.Flag.Rekey]),
    stream: fc.nat({ max: 0xffffffff }),
    seq: fc.integer({ min: 1, max: 0xffffffff }),
    ack: fc.nat({ max: 0xffffffff }),
    payload: fc.uint8Array({ maxLength: 5000 }),
  })
  .map(
    (input): Frame.Frame => ({
      ...input,
      flags: input.flags.reduce((all, flag) => all | flag, 0),
      seq: Frame.unsequenced.has(input.kind) ? 0 : input.seq,
    }),
  )

const decode = (bytes: Uint8Array) => Effect.runSync(Effect.exit(Frame.decode(bytes)))

describe("Frame", () => {
  test("round-trips every field", () => {
    fc.assert(
      fc.property(frame, (value) => {
        expect(Effect.runSync(Frame.decode(Frame.encode(value)))).toEqual(value)
      }),
      { numRuns: 300 },
    )
  })

  test("pads to the buckets only, so sizes leak no more than five classes", () => {
    const sizes = [0, 1, 236, 237, 1004, 1005, 4076, 16364, 16365, Frame.maxPayload].map(
      (length) =>
        Frame.encode({ kind: Frame.Kind.Data, flags: 0, stream: 1, seq: 1, ack: 0, payload: new Uint8Array(length) })
          .length,
    )
    expect(sizes).toEqual([256, 256, 256, 1024, 1024, 4096, 4096, 16384, Frame.maxLength, Frame.maxLength])
    expect(Frame.maxLength).toBe(65535 - 16)
  })

  // The decoder takes bytes the peer controls (after decryption). It must never throw, and whatever it accepts must be
  // the one canonical encoding of what it returns.
  test("fuzz: arbitrary bytes never throw, and only canonical encodings decode", () => {
    const bytes = fc.oneof(
      fc.uint8Array({ maxLength: 300 }),
      fc.constantFrom(...Frame.buckets).chain((size) => fc.uint8Array({ minLength: size, maxLength: size })),
    )
    fc.assert(
      fc.property(bytes, (input) => {
        const exit = decode(input)
        if (Exit.isFailure(exit)) return
        expect([...Frame.encode(exit.value)]).toEqual([...input])
      }),
      { numRuns: 500 },
    )
  })

  test("fuzz: any single-byte change of a valid frame decodes to something else or fails", () => {
    fc.assert(
      fc.property(frame, fc.nat(), fc.integer({ min: 1, max: 255 }), (value, at, delta) => {
        const bytes = Frame.encode(value)
        const index = at % bytes.length
        bytes[index] = ((bytes[index] ?? 0) + delta) & 0xff
        const exit = decode(bytes)
        if (Exit.isSuccess(exit)) expect(exit.value).not.toEqual(value)
      }),
      { numRuns: 300 },
    )
  })

  test.each([
    ["an unknown version", (bytes: Uint8Array): void => void (bytes[0] = 2), "unknown frame version 2"],
    ["an unknown kind", (bytes: Uint8Array): void => void (bytes[1] = 99), "unknown kind 99"],
    ["unknown flags", (bytes: Uint8Array): void => void (bytes[2] = 0x40), "unknown flags"],
    ["the reserved byte", (bytes: Uint8Array): void => void (bytes[3] = 1), "reserved byte is set"],
    ["a length past the frame", (bytes: Uint8Array): void => void (bytes[16] = 0xff), "payload longer than the frame"],
    ["non-zero padding", (bytes: Uint8Array): void => void (bytes[255] = 1), "padding is not zero"],
  ] as const)("refuses %s", (_, change, message) => {
    const bytes = Frame.encode({
      kind: Frame.Kind.Data,
      flags: 0,
      stream: 1,
      seq: 1,
      ack: 0,
      payload: new Uint8Array(3),
    })
    change(bytes)
    expect(Effect.runSync(Effect.flip(Frame.decode(bytes)))).toMatchObject({ _tag: "Malformed", message })
  })

  test("refuses a size that is not a bucket, and a sequence number that does not fit the kind", () => {
    expect(Effect.runSync(Effect.flip(Frame.decode(new Uint8Array(300)))).message).toBe("size is not a padding bucket")
    const ack = Frame.encode({ kind: Frame.Kind.Ack, flags: 0, stream: 0, seq: 5, ack: 0, payload: new Uint8Array(0) })
    expect(Effect.runSync(Effect.flip(Frame.decode(ack))).message).toBe("sequence number does not fit the kind")
  })
})

describe("Envelope", () => {
  const id = (byte: number) => new Uint8Array(16).fill(byte)

  test("round-trips", () => {
    fc.assert(
      fc.property(fc.nat({ max: 0xffffffff }), fc.uint8Array({ minLength: 1, maxLength: 2000 }), (seq, ciphertext) => {
        const envelope = { to: id(1), from: id(2), seq, ciphertext }
        expect(Effect.runSync(Envelope.decode(Envelope.encode(envelope)))).toEqual(envelope)
      }),
      { numRuns: 100 },
    )
  })

  test("fuzz: arbitrary bytes never throw", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), (bytes) => {
        Effect.runSync(Effect.exit(Envelope.decode(bytes)))
      }),
      { numRuns: 300 },
    )
  })

  test("refuses an unknown version, and empty or oversized ciphertext", () => {
    const bytes = Envelope.encode({ to: id(1), from: id(2), seq: 0, ciphertext: new Uint8Array(10) })
    bytes[0] = 9
    const failure = (input: Uint8Array) => Effect.runSync(Effect.flip(Envelope.decode(input))).message
    expect(failure(bytes)).toBe("unknown envelope version 9")
    expect(failure(new Uint8Array(Envelope.headerLength))).toBe("too short")
    expect(failure(new Uint8Array(Envelope.maxLength + 1))).toBe("too long")
  })
})
