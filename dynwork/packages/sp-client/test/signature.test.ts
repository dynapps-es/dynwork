import { describe, expect, test } from "bun:test"
import { SpClient } from "../src"
import { Jcs } from "../src/jcs"
import { keyPair } from "./fake"

describe("manifest signature", () => {
  const key = keyPair()
  const payload = Jcs.canonicalize({ skills: [{ id: "alpha_notes", sha256: "00" }], min_schema_version: 1 })

  test("verifies ed25519 over the exact payload bytes", () => {
    expect(SpClient.verifySignature(payload, key.sign(payload), key.public)).toBe(true)
  })

  test("fails on a tampered payload, even one that parses to the same value", () => {
    const signature = key.sign(payload)
    expect(SpClient.verifySignature(payload.replace("alpha", "alphb"), signature, key.public)).toBe(false)
    expect(SpClient.verifySignature(` ${payload}`, signature, key.public)).toBe(false)
  })

  test("fails against another key", () => {
    expect(SpClient.verifySignature(payload, key.sign(payload), keyPair().public)).toBe(false)
  })

  test("fails on a malformed signature or key instead of throwing", () => {
    expect(SpClient.verifySignature(payload, "not base64 at all", key.public)).toBe(false)
    expect(SpClient.verifySignature(payload, key.sign(payload), Buffer.alloc(31).toString("base64"))).toBe(false)
  })

  test("fingerprints the raw key bytes with SHA-256", () => {
    // SHA-256 of 32 zero bytes
    expect(SpClient.fingerprint(Buffer.alloc(32).toString("base64"))).toBe(
      "sha256:66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925",
    )
    expect(SpClient.fingerprint(key.public)).not.toBe(SpClient.fingerprint(keyPair().public))
  })
})
