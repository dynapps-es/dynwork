import { describe, expect, test } from "bun:test"
import { generateKeyPairSync, sign } from "node:crypto"
import { cardField, expected, formatEnv, freePort, jwtExpiry, manifestIds, missing, parseEnv, signatureValid, truncate } from "../../script/sp-local"

// The harness itself (docker, the instances) is exercised by `sp-local.ts up && seed && check`; these cover the parts
// that decide whether that check can be trusted.

describe("env file", () => {
  test("round-trips values that contain equals signs", () => {
    const values = { SP_DB_PASSWORD: "a1b2", SP_ALPHA_URL: "http://127.0.0.1:18101", SP_ALPHA_EXCHANGE_CODE_EXPIRES: "2026-11-01T08:46:36Z" }
    expect(parseEnv(formatEnv({ ...values, KEY: "a=b=c" }))).toEqual({ ...values, KEY: "a=b=c" })
  })

  test("ignores comments and blank lines", () => {
    expect(parseEnv("# generated\n\nA=1\n")).toEqual({ A: "1" })
  })
})

describe("CLI cards", () => {
  const card = JSON.stringify({
    sections: [
      { heading: "user_id", content: "u-1" },
      { heading: "code", content: "c0de" },
      { heading: "scopes", content: [] },
    ],
  })

  test("reads a field by heading", () => {
    expect(cardField(card, "code")).toBe("c0de")
  })

  test("refuses a missing or non-text field", () => {
    expect(() => cardField(card, "secret")).toThrow('no "secret"')
    expect(() => cardField(card, "scopes")).toThrow('no "scopes"')
  })
})

describe("tokens", () => {
  test("reads the expiry from the JWT claims", () => {
    const claims = Buffer.from(JSON.stringify({ exp: 1793520000 })).toString("base64url")
    expect(jwtExpiry(`header.${claims}.signature`).toISOString()).toBe("2026-11-01T08:00:00.000Z")
  })

  test("truncation never reveals more than the prefix", () => {
    const pat = `sp-live-${"x".repeat(40)}`
    expect(truncate(pat)).toBe("sp-live-xxxx…")
    expect(truncate(pat)).not.toContain("xxxxx")
  })
})

describe("manifest content", () => {
  const full = {
    skills: [{ id: "alpha_notes" }, { id: "alpha_review" }, { id: "who_am_i" }],
    agents: [{ id: "alpha_helper" }],
    managed_mcp_servers: [{ id: "alpha-docs" }],
    rules: [{ id: "alpha_conventions" }],
  }

  test("an instance with everything seeded misses nothing", () => {
    expect(missing("alpha", full)).toEqual([])
  })

  test("names what is missing, and an instance never satisfies the other one", () => {
    expect(missing("alpha", { ...full, agents: [], rules: undefined })).toEqual(["agents/alpha_helper", "rules/alpha_conventions"])
    expect(missing("beta", full)).toHaveLength(Object.values(expected.beta).flat().length)
  })

  test("falls back to the name when an entry has no id", () => {
    expect(manifestIds({ ...full, agents: [{ name: "alpha_helper" }] }).agents).toEqual(["alpha_helper"])
  })
})

describe("manifest signature", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64")
  const payload = JSON.stringify({ skills: [] })
  const signature = sign(null, Buffer.from(payload), privateKey).toString("base64")

  test("accepts the signature over the exact payload bytes", () => {
    expect(signatureValid({ payload, signature }, raw)).toBe(true)
  })

  test("rejects a payload that changed by one byte", () => {
    expect(signatureValid({ payload: `${payload} `, signature }, raw)).toBe(false)
  })

  test("rejects another key", () => {
    const other = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64")
    expect(signatureValid({ payload, signature }, other)).toBe(false)
  })
})

describe("ports", () => {
  test("skips taken and reserved ports and ports something is listening on", async () => {
    const busy = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
    const port = await freePort([busy.port + 1], busy.port)
    busy.stop(true)
    expect(port).not.toBe(busy.port)
    expect(port).not.toBe(busy.port + 1)
  })

  test("never hands out DynWork's service port", async () => {
    expect(await freePort([], 17495)).not.toBe(17495)
  })
})
