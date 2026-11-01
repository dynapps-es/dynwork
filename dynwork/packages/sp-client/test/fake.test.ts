import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SpClient } from "../src"
import deviceLink from "../../../test/sp-local/fixtures/device-link.json"
import alpha from "./fixtures/alpha.json"
import { keyPair, startFake } from "./fake"

const fake = startFake()
const original = structuredClone(fake.state.payload)

afterAll(() => fake.stop())

beforeEach(() => {
  fake.state.discovery = deviceLink.instance.discovery.body
  fake.state.payload = structuredClone(original)
  fake.state.tamper = false
  fake.state.signer = undefined
  fake.state.override = undefined
  fake.state.requests.length = 0
})

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const fail = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(effect))

const session = () => run(SpClient.mintJwt(fake.url, fake.issuePat()))

describe("discover", () => {
  test("an unreadable health answer only leaves the version unknown", async () => {
    fake.state.override = { path: "/api/v1/health", status: 200, body: "<html>proxy</html>" }
    const instance = await run(SpClient.discover(fake.url))
    expect(instance.discovered).toBe(true)
    expect(instance.version).toBeUndefined()
  })

  test("an instance without the capabilities route reports no sign-in modes", async () => {
    fake.state.override = { path: "/v1/auth/bridge/capabilities", status: 404, body: { message: "not found" } }
    const instance = await run(SpClient.discover(fake.url))
    expect(instance.modes).toEqual([])
  })

  test("an address that answers 404 to the discovery document and the capabilities route is not an instance", async () => {
    fake.state.discovery = undefined
    fake.state.override = { path: "/v1/auth/bridge/capabilities", status: 404, body: { message: "not found" } }
    const error = await fail(SpClient.discover(fake.url))
    expect(error).toBeInstanceOf(SpClient.Incompatible)
  })

  test("reads the discovery document, the sign-in modes and the version", async () => {
    const instance = await run(SpClient.discover(`${fake.url}/`))
    expect(instance).toEqual({
      baseUrl: fake.url,
      discovered: true,
      deviceLinkPath: "/bridge-auth/device-link",
      identityPath: "/api/public/bridge/whoami",
      displayName: "Dynapps",
      enabledHosts: ["claude-code", "claude-desktop", "opencode", "opencode-cli"],
      modes: alpha.capabilities.body.modes,
      version: "0.76.0",
    })
  })

  test("falls back to the Dynapps paths on an instance without discovery", async () => {
    fake.state.discovery = undefined
    const instance = await run(SpClient.discover(fake.url))
    expect(instance.discovered).toBe(false)
    expect(instance.deviceLinkPath).toBe(SpClient.fallback.deviceLinkPath)
    expect(instance.identityPath).toBe(SpClient.fallback.identityPath)
  })

  test.each(["//evil.example/device-link", "https://evil.example/device-link", "device-link", "/\\evil.example"])(
    "refuses a device-link path that leaves the origin: %s",
    async (path) => {
      fake.state.discovery = { ...deviceLink.instance.discovery.body, device_link_path: path }
      const error = await fail(SpClient.discover(fake.url))
      expect(error).toBeInstanceOf(SpClient.Protocol)
      expect(error._tag === "Protocol" && error.path).toBe("device_link_path")
    },
  )

  test("a failing health check only drops the version; a failing discovery fails discover", async () => {
    fake.state.override = { path: "/api/v1/health", status: 500 }
    expect((await run(SpClient.discover(fake.url))).version).toBeUndefined()
    fake.state.override = { path: "/.well-known/systemprompt-bridge", status: 502, body: { message: "bad gateway" } }
    expect(await fail(SpClient.discover(fake.url))).toBeInstanceOf(SpClient.Unreachable)
  })

  test("reports an unknown discovery contract as incompatible", async () => {
    fake.state.discovery = { ...deviceLink.instance.discovery.body, contract: "2" }
    const error = await fail(SpClient.discover(fake.url))
    expect(error).toBeInstanceOf(SpClient.Incompatible)
    expect(error._tag === "Incompatible" && [error.supported, error.found]).toEqual(["1", "2"])
  })

  test("refuses a base URL that is not plain http or https, without a request", async () => {
    // A fake of its own: interrupted requests of earlier tests may still land on the shared one
    const own = startFake()
    for (const url of ["ftp://127.0.0.1", "not a url", "http://user:secret@127.0.0.1", `${own.url}/?token=x`]) {
      const error = await fail(SpClient.discover(url))
      expect(error).toBeInstanceOf(SpClient.Protocol)
      expect(JSON.stringify(error)).not.toContain("secret")
    }
    own.stop()
    expect(own.state.requests).toEqual([])
  })
})

describe("device link", () => {
  const instance = { baseUrl: fake.url, deviceLinkPath: "/bridge-auth/device-link" }

  test("puts the state inside the redirect, the only parameter the page reads", () => {
    const page = new URL(SpClient.deviceLinkUrl(instance, "http://127.0.0.1:43123/cb", "s1"))
    expect(`${page.origin}${page.pathname}`).toBe(`${fake.url}/bridge-auth/device-link`)
    expect([...page.searchParams.keys()]).toEqual(["redirect"])
    expect(page.searchParams.get("redirect")).toBe("http://127.0.0.1:43123/cb?state=s1")
  })

  // The redirect table observed on the consent page: the client refuses up front what the page refuses.
  test.each(deviceLink.experiments.redirects.map((entry) => [entry.redirect, entry.page] as const))(
    "redirect %s is accepted as the page does (%d)",
    (redirect, status) => {
      const build = () => SpClient.deviceLinkUrl(instance, redirect.replace("<port>", "43123"), "s1")
      // :0 and :1 are accepted by the page, but a listener never binds them, so they only need to not throw here
      if (status === 200) expect(build).not.toThrow()
      if (status !== 200) expect(build).toThrow(TypeError)
    },
  )

  test("accepts only a callback that carries the state back with a well-formed code", () => {
    const code = "ab".repeat(32)
    expect(SpClient.parseCallback(`http://127.0.0.1:1/cb?state=s1&code=${code}`, "s1")).toEqual({ _tag: "Code", code })
    expect(SpClient.parseCallback("http://127.0.0.1:1/cb?state=s1&error=denied", "s1")).toEqual({ _tag: "Denied" })
    expect(SpClient.parseCallback(`http://127.0.0.1:1/cb?state=s2&code=${code}`, "s1")).toBeUndefined()
    expect(SpClient.parseCallback(`http://127.0.0.1:1/cb?code=${code}`, "s1")).toBeUndefined()
    expect(SpClient.parseCallback("http://127.0.0.1:1/cb?state=s1&code=not-hex", "s1")).toBeUndefined()
    expect(SpClient.parseCallback("http://127.0.0.1:1/favicon.ico", "s1")).toBeUndefined()
    expect(SpClient.parseCallback(`http://127.0.0.1:1/cb?state=&code=${code}`, "")).toBeUndefined()
  })
})

describe("sign-in exchanges", () => {
  test("trades a code for a PAT once; the second use is unauthorized", async () => {
    const code = fake.issueCode()
    const pat = await run(SpClient.exchangeCode(fake.url, ` ${code}\n`, "DynWork on test"))
    expect(fake.state.pats.has(pat)).toBe(true)
    expect(
      JSON.parse(fake.state.requests.find((request) => request.path === "/v1/auth/bridge/session-pat")?.body ?? "{}"),
    ).toEqual({ code, device_name: "DynWork on test" })
    const error = await fail(SpClient.exchangeCode(fake.url, code))
    expect(error).toBeInstanceOf(SpClient.Unauthorized)
    expect(error.message).toBe(deviceLink.round_trip.second_use.body.message)
  })

  test("an empty code is a protocol error, not a sign-out", async () => {
    const error = await fail(SpClient.exchangeCode(fake.url, "  "))
    expect(error).toBeInstanceOf(SpClient.Protocol)
    expect(error._tag === "Protocol" && error.status).toBe(400)
  })

  test("mints a JWT with its expiry and session, declaring the client kind and no attestation", async () => {
    const before = Date.now()
    const minted = await session()
    expect(fake.state.jwts.has(minted.token)).toBe(true)
    expect(minted.ttl).toBe(3600)
    expect(minted.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000)
    expect(minted.expiresAt).toBeLessThanOrEqual(Date.now() + 3_600_000)
    expect(minted.sessionId).toStartWith("sess_")
    const headers = fake.state.requests.findLast((request) => request.path === "/v1/auth/bridge/pat")?.headers ?? {}
    expect(headers["x-systemprompt-client"]).toBe("opencode")
    expect(Object.keys(headers).filter((name) => name.includes("attestation"))).toEqual([])
  })

  test("replays the session id when asked, so the instance keeps the session", async () => {
    const pat = fake.issuePat()
    const minted = await run(SpClient.mintJwt(fake.url, pat, { sessionId: "sess_kept" }))
    expect(minted.sessionId).toBe("sess_kept")
  })

  test("a refused PAT is unauthorized and the error never carries it", async () => {
    const pat = `sp-live-${"f".repeat(40)}`
    const error = await fail(SpClient.mintJwt(fake.url, pat))
    expect(error).toBeInstanceOf(SpClient.Unauthorized)
    expect(error.message).toBe("Invalid PAT")
    expect(`${JSON.stringify(error)} ${String(error)} ${error.stack}`).not.toContain(pat)
  })

  test("withJwt mints once more after a refused JWT and hands back the new session", async () => {
    const pat = fake.issuePat()
    const stale = { token: fake.staleJwt(), ttl: 3600, expiresAt: Date.now() + 3_600_000, sessionId: "sess_old" }
    const result = await run(SpClient.withJwt(fake.url, pat, stale, (token) => SpClient.whoami(fake.url, token)))
    expect(result.value.email).toBe("dev@dynapps.test")
    expect(result.session.token).not.toBe(stale.token)
    expect(result.session.sessionId).toBe("sess_old")
    expect(fake.state.requests.filter((request) => request.path === "/v1/auth/bridge/pat")).toHaveLength(1)
    expect(fake.state.requests.filter((request) => request.path === "/v1/bridge/whoami")).toHaveLength(2)
  })

  test("withJwt mints straight away when the session has expired", async () => {
    const pat = fake.issuePat()
    const expired = { token: fake.staleJwt(), ttl: 3600, expiresAt: Date.now() - 1 }
    const result = await run(SpClient.withJwt(fake.url, pat, expired, (token) => SpClient.whoami(fake.url, token)))
    expect(result.session.token).not.toBe(expired.token)
    expect(fake.state.requests.map((request) => request.path)).toEqual(["/v1/auth/bridge/pat", "/v1/bridge/whoami"])
  })

  test("withJwt reports the refusal when the PAT itself is gone", async () => {
    const stale = { token: fake.staleJwt(), ttl: 3600, expiresAt: Date.now() + 3_600_000 }
    const error = await fail(
      SpClient.withJwt(fake.url, "sp-live-revoked", stale, (token) => SpClient.whoami(fake.url, token)),
    )
    expect(error).toBeInstanceOf(SpClient.Unauthorized)
    expect(error.endpoint).toBe("POST /v1/auth/bridge/pat")
  })
})

describe("manifest", () => {
  test("verifies the signature, decodes the payload and keeps the signed bytes and the ETag", async () => {
    const minted = await session()
    const result = await run(SpClient.manifest(fake.url, minted.token, { key: fake.state.key.public, fresh: true }))
    if (result._tag !== "Manifest") throw new Error("expected a manifest")
    expect(result.etag).toMatch(/^"[0-9a-f]{64}"$/)
    expect(result.manifest.skills.map((skill) => skill.id)).toContain("alpha_notes")
    expect(result.manifest.managed_mcp_servers.map((server) => server.id)).toEqual(["alpha-docs"])
    expect(JSON.parse(result.payload)).toEqual(original)
    expect(
      fake.state.requests.findLast((request) => request.path === "/v1/bridge/manifest")?.headers["cache-control"],
    ).toBe("no-cache")
  })

  test("keeps the per-host model protocols for the plugin's model filter", async () => {
    const minted = await session()
    const result = await run(SpClient.manifest(fake.url, minted.token, { key: fake.state.key.public }))
    if (result._tag !== "Manifest") throw new Error("expected a manifest")
    expect(result.manifest.host_model_protocols).toEqual(JSON.parse(result.payload).host_model_protocols)
    expect(result.manifest.host_model_protocols).toBeDefined()
  })

  test("answers NotModified to a matching strong or weak ETag", async () => {
    const minted = await session()
    const first = await run(SpClient.manifest(fake.url, minted.token, { key: fake.state.key.public }))
    for (const etag of [first.etag, `W/${first.etag}`]) {
      const again = await run(SpClient.manifest(fake.url, minted.token, { key: fake.state.key.public, etag }))
      expect(again._tag).toBe("NotModified")
    }
  })

  test("a tampered payload fails the signature while the key is unchanged", async () => {
    const minted = await session()
    fake.state.tamper = true
    const error = await fail(SpClient.manifest(fake.url, minted.token, { key: fake.state.key.public }))
    expect(error).toBeInstanceOf(SpClient.SignatureInvalid)
  })

  test("a rotated instance key is reported as a key change with both fingerprints", async () => {
    const minted = await session()
    const pinned = fake.state.key.public
    fake.state.key = keyPair()
    const error = await fail(SpClient.manifest(fake.url, minted.token, { key: pinned }))
    expect(error).toBeInstanceOf(SpClient.KeyChanged)
    if (error._tag !== "KeyChanged") throw new Error("expected KeyChanged")
    expect(error.pinned).toBe(SpClient.fingerprint(pinned))
    expect(error.served).toBe(SpClient.fingerprint(fake.state.key.public))
  })

  test("a newer schema floor is incompatible, before any field is decoded", async () => {
    const minted = await session()
    fake.state.payload = { min_schema_version: 2 }
    const error = await fail(SpClient.manifest(fake.url, minted.token, { key: fake.state.key.public }))
    expect(error).toBeInstanceOf(SpClient.Incompatible)
  })

  test("a payload that does not decode names the field", async () => {
    const minted = await session()
    const skills = (original.skills as Record<string, unknown>[]).map((skill, index) =>
      index === 1 ? { ...skill, id: 7 } : skill,
    )
    fake.state.payload = { ...original, skills }
    const error = await fail(SpClient.manifest(fake.url, minted.token, { key: fake.state.key.public }))
    expect(error).toBeInstanceOf(SpClient.Protocol)
    expect(error._tag === "Protocol" && error.path).toBe("skills.1.id")
  })

  test("a manifest without an ETag is a protocol error", async () => {
    const minted = await session()
    fake.state.override = { path: "/v1/bridge/manifest", status: 200, body: { payload: "{}", signature: "" } }
    const error = await fail(SpClient.manifest(fake.url, minted.token, { key: fake.state.key.public }))
    expect(error).toBeInstanceOf(SpClient.Protocol)
    expect(error.message).toContain("ETag")
  })

  test("a served key that is not 32 bytes is refused", async () => {
    fake.state.override = {
      path: "/v1/bridge/pubkey",
      status: 200,
      body: { pubkey: Buffer.alloc(16).toString("base64") },
    }
    const error = await fail(SpClient.publicKey(fake.url))
    expect(error._tag === "Protocol" && error.path).toBe("pubkey")
  })

  test("publicKey returns the key and its SHA-256 fingerprint", async () => {
    const key = await run(SpClient.publicKey(fake.url))
    expect(key.key).toBe(fake.state.key.public)
    expect(key.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})

describe("profile and models", () => {
  test("decode the observed bodies", async () => {
    const minted = await session()
    const profile = await run(SpClient.profile(fake.url, minted.token))
    expect(profile.models).toEqual(alpha.profile.body.models)
    expect(profile.default_model).toBe(alpha.profile.body.default_model)
    const models = await run(SpClient.models(fake.url, minted.token))
    expect(models.map((model) => model.id)).toEqual(alpha.models.body.data.map((model) => model.id))
  })
})

describe("transport errors", () => {
  test("429 is rate limited with Retry-After in seconds or as a date", async () => {
    fake.state.override = {
      status: 429,
      body: { code: "rate_limited", message: "slow down" },
      headers: { "retry-after": "7" },
    }
    const seconds = await fail(SpClient.publicKey(fake.url))
    expect(seconds).toBeInstanceOf(SpClient.RateLimited)
    expect(seconds._tag === "RateLimited" && seconds.retryAfterMs).toBe(7000)
    fake.state.override.headers = { "retry-after": new Date(Date.now() + 60_000).toUTCString() }
    const date = await fail(SpClient.publicKey(fake.url))
    expect(date._tag === "RateLimited" && date.retryAfterMs).toBeGreaterThan(50_000)
  })

  test("an unreadable Retry-After is unknown, not zero", async () => {
    fake.state.override = { status: 429, body: { message: "slow down" }, headers: { "retry-after": "1.5" } }
    const error = await fail(SpClient.publicKey(fake.url))
    expect(error._tag === "RateLimited" && error.retryAfterMs).toBeUndefined()
  })

  test("plain http is refused for a remote instance, so credentials never travel in clear text", async () => {
    const error = await fail(SpClient.mintJwt("http://sp.example.com", "sp-live-secret"))
    expect(error).toBeInstanceOf(SpClient.Protocol)
    expect(error.endpoint).toBe("base URL")
  })

  test("a 5xx is unreachable with its status", async () => {
    fake.state.override = { status: 503, body: { code: "unavailable", message: "starting" } }
    const error = await fail(SpClient.publicKey(fake.url))
    expect(error).toBeInstanceOf(SpClient.Unreachable)
    expect(error._tag === "Unreachable" && error.status).toBe(503)
  })

  test("a closed port is unreachable", async () => {
    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
    const url = `http://127.0.0.1:${closed.port}`
    await closed.stop(true)
    const error = await fail(SpClient.discover(url))
    expect(error).toBeInstanceOf(SpClient.Unreachable)
  })

  test("a redirect is not followed, so the bearer never reaches another origin", async () => {
    const elsewhere: string[] = []
    const other = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        elsewhere.push(request.headers.get("authorization") ?? "")
        return Response.json({ user_id: "x" })
      },
    })
    fake.state.override = { status: 302, headers: { location: `http://127.0.0.1:${other.port}/v1/bridge/whoami` } }
    const error = await fail(SpClient.whoami(fake.url, "eyJsecret"))
    await other.stop(true)
    expect(error).toBeInstanceOf(SpClient.Protocol)
    expect(error._tag === "Protocol" && error.status).toBe(302)
    expect(elsewhere).toEqual([])
  })
})
