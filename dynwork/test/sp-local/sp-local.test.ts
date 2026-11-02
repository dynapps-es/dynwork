import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import { generateKeyPairSync, sign } from "node:crypto"
import path from "node:path"
import {
  cardField,
  defaultPortBase,
  defaultProject,
  describeBody,
  expected,
  fixtureChanges,
  formatEnv,
  freePort,
  imageFor,
  jwtExpiry,
  leaks,
  localArch,
  localImage,
  manifestIds,
  missing,
  mobileFixtureFile,
  mobileVerdict,
  parseEnv,
  platformFor,
  publishedImage,
  redactUrl,
  scrubText,
  signatureValid,
  stackSettings,
  truncate,
  type MobileSummary,
} from "../../script/sp-local"

// The harness itself (docker, the instances) is exercised by `sp-local.ts up && seed && check`; these cover the parts
// that decide whether that check can be trusted.

describe("env file", () => {
  test("round-trips values that contain equals signs", () => {
    const values = {
      SP_DB_PASSWORD: "a1b2",
      SP_ALPHA_URL: "http://127.0.0.1:18101",
      SP_ALPHA_EXCHANGE_CODE_EXPIRES: "2026-11-01T08:46:36Z",
    }
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
    expect(redactUrl(`http://127.0.0.1:54321/cb?state=s3cr3t&code=${code}`, scope)).toBe(
      "http://127.0.0.1:<port>/cb?state=<redacted>&code=<redacted>",
    )
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
    expect(leaks(`{"pat":"sp-live-0123456789ab.secret"}`, ["sp-live-0123456789ab.secret", "", "abc"])).toEqual([
      "sp-live-0123456789ab.secret",
    ])
    expect(leaks(`{"pat":"<pat>"}`, ["sp-live-0123456789ab.secret"])).toEqual([])
  })
})

describe("stack isolation", () => {
  test("without the variables the default stack keeps its project, ports and env file", async () => {
    expect(stackSettings({})).toEqual({ project: "dynwork-sp-local", portBase: 18101, envName: ".env.local" })
    expect(stackSettings({ SP_LOCAL_PROJECT: "dynwork-sp-local", SP_LOCAL_PORT_BASE: "18101" })).toEqual(stackSettings({}))
    // compose names the project itself when `-p` is absent, so the file must agree with what the script passes
    expect((await Bun.file(path.join(import.meta.dir, "compose.yml")).text()).match(/^name: (\S+)/m)?.[1]).toBe(defaultProject)
    expect(defaultPortBase).toBe(18101)
  })

  test("another project gets its own env file and port base, and never the default's", async () => {
    const mobile = stackSettings({ SP_LOCAL_PROJECT: "dynwork-sp-mobile", SP_LOCAL_PORT_BASE: "18201" })
    expect(mobile).toEqual({ project: "dynwork-sp-mobile", portBase: 18201, envName: ".env.dynwork-sp-mobile.local" })
    expect(mobile.envName).not.toBe(stackSettings({}).envName)
    const alpha = await freePort([], mobile.portBase)
    const beta = await freePort([alpha], mobile.portBase)
    expect(alpha).toBeGreaterThanOrEqual(18201)
    expect(beta).toBeGreaterThan(alpha)
    expect([alpha, beta].filter((port) => port < 18201 || port > 18300)).toEqual([])
  })

  test("the env file of another project is gitignored like the default one", async () => {
    const ignored = (name: string) => $`git check-ignore -q ${path.join(import.meta.dir, name)}`.nothrow().quiet()
    expect((await ignored(stackSettings({ SP_LOCAL_PROJECT: "dynwork-sp-mobile" }).envName)).exitCode).toBe(0)
    expect((await ignored(stackSettings({}).envName)).exitCode).toBe(0)
  })

  test("refuses a project name or port base that compose or the host would misread", () => {
    expect(() => stackSettings({ SP_LOCAL_PROJECT: "../other" })).toThrow("not a valid compose project name")
    expect(() => stackSettings({ SP_LOCAL_PROJECT: "Has Space" })).toThrow("not a valid compose project name")
    expect(() => stackSettings({ SP_LOCAL_PORT_BASE: "80" })).toThrow("not a port")
    expect(() => stackSettings({ SP_LOCAL_PORT_BASE: "18x01" })).toThrow("not a port")
  })
})

describe("mobile sign-in verdict", () => {
  const working: MobileSummary = {
    native_registration: true,
    authorize_page: true,
    callback_state: true,
    token_with_refresh: true,
    refresh_works: true,
    bridge_accepts_jwt: true,
  }

  test("core OAuth is usable only when every step worked on every instance", () => {
    expect(mobileVerdict([working, working])).toEqual({ verdict: "core OAuth usable", reasons: [] })
    expect(mobileVerdict([working, { ...working, native_registration: false }])).toEqual({
      verdict: "extension endpoint needed",
      reasons: ["failed: a native client registers the dynwork:// redirect"],
    })
  })

  test("names each step that failed", () => {
    const broken = mobileVerdict([{ ...working, refresh_works: false, bridge_accepts_jwt: false }])
    expect(broken.verdict).toBe("extension endpoint needed")
    expect(broken.reasons).toHaveLength(2)
  })
})

describe("mobile-auth fixture", () => {
  type Registration = { redirect: string; native: { status: number }; web: { status: number } }
  type Observed = {
    verdict: string
    reasons: string[]
    instances: Record<string, { summary: MobileSummary; registration: { cases: Registration[] } }>
  }
  const fixture: Promise<Observed> = Bun.file(mobileFixtureFile).json()

  test("parses, and its verdict is the one its own observations give", async () => {
    const parsed = await fixture
    const summaries = Object.values(parsed.instances).map((instance) => instance.summary)
    expect(Object.keys(parsed.instances)).toEqual(["alpha", "beta"])
    expect(mobileVerdict(summaries)).toEqual({ verdict: parsed.verdict, reasons: parsed.reasons })
  })

  test("records the redirect the app will register, tried with and without the native application type", async () => {
    const cases = (await fixture).instances.alpha?.registration.cases ?? []
    const dynwork = cases.find((item) => item.redirect === "dynwork://auth/callback")
    expect(dynwork?.native.status).toBe(201)
    expect(dynwork?.web.status).toBe(400)
    expect(cases.find((item) => item.redirect === "javascript:alert(1)")?.native.status).toBe(400)
  })

  test("holds no PAT, JWT, registration token or authorization code", async () => {
    const text = await Bun.file(mobileFixtureFile).text()
    expect(text).not.toMatch(/sp-live-/)
    expect(text).not.toMatch(/eyJ[\w-]*\.[\w-]*\.[\w-]*/)
    expect(text).not.toMatch(/reg_[\w-]{20,}/)
    expect(text).not.toMatch(/client_[0-9a-f]{32}/)
    expect(text).not.toMatch(/[0-9a-f]{64}/)
  })
})

describe("image", () => {
  test("up runs the published release unless --image local asks for the relay image", () => {
    expect(imageFor([])).toBe(publishedImage)
    expect(imageFor(["--image", "published"])).toBe(publishedImage)
    expect(imageFor(["--image", "local"])).toBe(localImage)
    expect(localImage).not.toBe(publishedImage)
    expect(localImage.endsWith(":dynwork-relay")).toBe(true)
    expect(() => imageFor(["--image"])).toThrow()
    expect(() => imageFor(["--image", "latest"])).toThrow()
    expect(platformFor(publishedImage)).toBe("linux/amd64")
    expect(platformFor(localImage)).toBe(`linux/${localArch}`)
  })

  test("compose runs the image up chose, and the published release without one", async () => {
    const text = await Bun.file(path.join(import.meta.dir, "compose.yml")).text()
    expect(text).toContain(`image: \${SP_IMAGE:-${publishedImage}}`)
    expect(text).toContain("platform: ${SP_PLATFORM:-linux/amd64}")
    const build = await Bun.file(path.join(import.meta.dir, "relay-image.yml")).text()
    expect(build).toContain(`image: ${localImage}`)
  })
})
