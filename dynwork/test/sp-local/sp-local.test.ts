import { describe, expect, test } from "bun:test"
import { generateKeyPairSync, sign } from "node:crypto"
import {
  cardField,
  describeBody,
  expected,
  fixtureChanges,
  formatEnv,
  freePort,
  jwtExpiry,
  leaks,
  manifestIds,
  missing,
  parseEnv,
  redactUrl,
  scrubText,
  signatureValid,
  truncate,
} from "../../script/sp-local"

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

describe("capture redaction", () => {
  const scope = { origins: ["http://127.0.0.1:18101", "http://localhost:18101"], port: 54321 }
  const code = "ab".repeat(32)

  test("keeps query names and drops their values, and the instance and listener port become placeholders", () => {
    expect(redactUrl(`http://127.0.0.1:54321/cb?state=s3cr3t&code=${code}`, scope)).toBe("http://127.0.0.1:<port>/cb?state=<redacted>&code=<redacted>")
    expect(redactUrl("http://localhost:18101/bridge-auth/device-link/approve", scope)).toBe("<instance>/bridge-auth/device-link/approve")
  })

  test("redacts a nested redirect as a URL, through relative locations", () => {
    const location = `/admin/login?redirect=${encodeURIComponent(`/bridge-auth/device-link?redirect=${encodeURIComponent("http://127.0.0.1:54321/cb")}`)}`
    expect(redactUrl(location, scope)).toBe("/admin/login?redirect=/bridge-auth/device-link?redirect=http://127.0.0.1:<port>/cb")
  })

  test("keeps protocol vocabulary and other hosts and ports as they are", () => {
    expect(redactUrl("http://localhost:54321/cb?error=denied", scope)).toBe("http://localhost:<port>/cb?error=denied")
    expect(redactUrl("http://127.0.0.1:1/cb?code=x", scope)).toBe("http://127.0.0.1:1/cb?code=<redacted>")
    expect(redactUrl("dynwork://auth/cb", scope)).toBe("dynwork://auth/cb")
  })

  test("never echoes a URL it cannot parse", () => {
    expect(redactUrl(`http://127.0.0.1:65536/cb?code=${code}`, scope)).toBe("<unparsable url>")
  })

  test("describes secrets by kind and keeps error envelopes", () => {
    const body = {
      token: "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln",
      pat: "sp-live-0123456789ab.secret",
      code,
      ttl: 3600,
      client_id_issued_at: 1793522903,
      headers: { "x-user-id": "u-1", "x-client-id": "sp_bridge" },
      message: "exchange code invalid",
      timestamp: "2026-11-01T08:51:38.927502386Z",
    }
    expect(describeBody(body)).toEqual({
      client_id_issued_at: "<timestamp>",
      code: "<code>",
      headers: { "x-client-id": "sp_bridge", "x-user-id": "<string>" },
      message: "exchange code invalid",
      pat: "<pat>",
      timestamp: "<timestamp>",
      token: "<jwt>",
      ttl: 3600,
    })
  })

  test("orders keys so the server's map order does not change the fixture", () => {
    expect(JSON.stringify(describeBody({ b: 1, a: 2 }))).toBe(JSON.stringify(describeBody({ a: 2, b: 1 })))
  })

  test("scrubs page text of the port and codes and rounds the seconds left", () => {
    expect(scrubText(`Helper\n 127.0.0.1:54321  ${code}  599\u00a0seconds`, scope)).toBe("Helper 127.0.0.1:<port> <code> 600 seconds")
  })
})

describe("capture fixture", () => {
  test("names the leaves that changed and ignores when it was captured", () => {
    const before = { captured_at: "a", round_trip: { callback: { query: ["code"] }, status: 200 } }
    const after = { captured_at: "b", round_trip: { callback: { query: ["code", "state"] }, status: 200 } }
    expect(fixtureChanges(before, { ...before, captured_at: "c" })).toEqual([])
    expect(fixtureChanges(before, after)).toEqual(["round_trip.callback.query"])
    expect(fixtureChanges(undefined, after)).toEqual(["(root)"])
  })

  test("finds a run's secrets in a text, ignoring empty and short values", () => {
    expect(leaks(`{"pat":"sp-live-0123456789ab.secret"}`, ["sp-live-0123456789ab.secret", "", "abc"])).toEqual(["sp-live-0123456789ab.secret"])
    expect(leaks(`{"pat":"<pat>"}`, ["sp-live-0123456789ab.secret"])).toEqual([])
  })
})
