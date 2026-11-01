import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fc from "fast-check"
import { fromBase64Url, toBase64Url, utf8 } from "../src/bytes"
import { Keys } from "../src"

const now = 1_800_000_000_000

const pairing = (instance = "https://ai.dynapps.es") =>
  Keys.createPairing({ instance, desktopKey: Keys.generate().publicKey, now, ttlMs: 120_000 })

const parse = (text: string, at = now) => Effect.runSync(Effect.exit(Keys.parsePairing(text, at)))
const failure = (text: string, at = now) => Effect.runSync(Effect.flip(Keys.parsePairing(text, at)))

const qr = (payload: Record<string, unknown>) => Keys.scheme + toBase64Url(utf8(JSON.stringify(payload)))

describe("base64url", () => {
  test("round-trips and has exactly one text form per value", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 100 }), (bytes) => {
        const text = toBase64Url(bytes)
        expect(text).toMatch(/^[A-Za-z0-9_-]*$/)
        expect([...(fromBase64Url(text) ?? [])]).toEqual([...bytes])
      }),
      { numRuns: 300 },
    )
    // "AB" and "AA" both decode to 0x00 if the unused low bits are ignored
    expect(fromBase64Url("AB")).toBeUndefined()
    expect(fromBase64Url("A")).toBeUndefined()
    expect(fromBase64Url("AA==")).toBeUndefined()
    expect(fromBase64Url("+/")).toBeUndefined()
  })
})

describe("Keys", () => {
  test("fingerprints and peer ids are stable and distinct per key", () => {
    const key = Keys.generate()
    const again = Keys.fromSecretKey(key.secretKey)
    expect([...again.publicKey]).toEqual([...key.publicKey])
    expect(Keys.fingerprint(key.publicKey)).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){4}$/)
    expect(Keys.fingerprint(again.publicKey)).toBe(Keys.fingerprint(key.publicKey))
    expect(Keys.fingerprint(Keys.generate().publicKey)).not.toBe(Keys.fingerprint(key.publicKey))
    expect(Keys.peerId(key.publicKey).length).toBe(16)
  })

  test("a pairing survives the QR text", () => {
    const value = pairing()
    const text = Keys.encodePairing(value)
    expect(text.startsWith("dynwork://pair#")).toBe(true)
    const parsed: Keys.Pairing = Effect.runSync(Keys.parsePairing(text, now))
    expect(parsed).toEqual(value)
  })

  test("two pairings never share a token", () => {
    expect([...pairing().token]).not.toEqual([...pairing().token])
  })

  test("refuses an expired pairing", () => {
    const value = pairing()
    expect(failure(Keys.encodePairing(value), value.expires)).toMatchObject({
      _tag: "PairingRejected",
      reason: "expired",
    })
  })

  test("refuses an unknown version as incompatible", () => {
    const value = pairing()
    const text = qr({
      v: 2,
      instance: value.instance,
      desktopKey: toBase64Url(value.desktopKey),
      token: toBase64Url(value.token),
      expires: value.expires,
    })
    expect(failure(text)).toMatchObject({ _tag: "Incompatible", supported: "1", found: "2" })
  })

  test.each([
    ["https://ai.dynapps.es", true],
    ["https://ai.dynapps.es:8443/base", true],
    ["http://127.0.0.1:18201", true],
    ["http://localhost:18201", true],
    ["http://[::1]:18201", true],
    ["http://10.0.2.2:18201", false],
    ["http://ai.dynapps.es", false],
    ["http://127.0.0.1@evil.example", false],
    ["ftp://ai.dynapps.es", false],
    ["https://", false],
  ] as const)("instance %s allowed: %s", (instance, allowed) => {
    const exit = parse(Keys.encodePairing(pairing(instance)))
    expect(exit._tag).toBe(allowed ? "Success" : "Failure")
  })

  test("refuses codes that are not pairings, or carry keys of the wrong size", () => {
    const value = pairing()
    const fields = { v: 1, instance: value.instance, token: toBase64Url(value.token), expires: value.expires }
    expect(failure("https://example.com").message).toBe("not a DynWork pairing code")
    expect(failure(Keys.scheme + "***").message).toBe("not base64url")
    expect(failure(qr({ hello: 1 })).message).toBe("unexpected payload")
    expect(failure(qr({ ...fields, desktopKey: toBase64Url(new Uint8Array(31)) })).message).toBe(
      "desktop key is not 32 bytes",
    )
    expect(
      failure(qr({ ...fields, desktopKey: toBase64Url(value.desktopKey), token: toBase64Url(new Uint8Array(8)) }))
        .message,
    ).toBe("token is not 32 bytes")
  })
})
