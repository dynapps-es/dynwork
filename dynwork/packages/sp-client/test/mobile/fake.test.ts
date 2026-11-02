import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { SpMobile } from "../../src"

// The mobile module against a small in-process stand-in for the relay's mobile routes, plus its pure helpers.
// The live round trip against a real instance is in live.test.ts.

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const fail = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(effect))

const code = `dwa1_${"c".repeat(43)}`
const credential = `dwm1_${"m".repeat(43)}`
const peerId = "ab".repeat(16)
const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
const account = { id: "user-1", email: "dev@dynapps.test", name: "dev" }
const seen: { path: string; authorization: string | null; body: string }[] = []
const state = { discovery: true, revoked: false }

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const route = `${request.method} ${new URL(request.url).pathname}`
    const body = await request.text()
    seen.push({ path: route, authorization: request.headers.get("authorization"), body })
    const session = { token: "eyJfake", token_type: "Bearer", expires_in: 3600, device_id: "device-1", account }
    if (route === "GET /api/dynwork/mobile/v1/discovery" && state.discovery)
      return Response.json({
        version: 1,
        display_name: "Dynapps",
        redirect_uri: "dynwork://auth/callback",
        authorize_path: "/api/dynwork/mobile/v1/authorize",
      })
    if (route === "POST /api/dynwork/mobile/v1/token") {
      const sent = JSON.parse(body) as { code: string; code_verifier: string; peer_id: string }
      if (sent.code !== code || sent.code_verifier !== verifier)
        return Response.json({ error: "invalid_grant", message: "the code is unknown" }, { status: 400 })
      return Response.json({ ...session, credential, peer_id: sent.peer_id })
    }
    const bearer = request.headers.get("authorization") === `Bearer ${credential}` && !state.revoked
    if (route === "POST /api/dynwork/mobile/v1/refresh" && bearer) return Response.json(session)
    if (route === "POST /api/dynwork/mobile/v1/revoke" && bearer) {
      state.revoked = true
      return new Response(null, { status: 204 })
    }
    if (route.endsWith("/refresh") || route.endsWith("/revoke"))
      return Response.json({ error: "unauthorized", message: "unknown or revoked device credential" }, { status: 401 })
    return Response.json({ error: "not_found", message: "not found" }, { status: 404 })
  },
})
const base = `http://127.0.0.1:${server.port}`

afterAll(() => server.stop(true))

describe("pure helpers", () => {
  test("S256 matches the RFC 7636 appendix B vector", () => {
    expect(SpMobile.challengeOf(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
  })

  test("base64url is unpadded RFC 4648 section 5", () => {
    expect(SpMobile.base64url(new Uint8Array([]))).toBe("")
    expect(SpMobile.base64url(new Uint8Array([0xfb]))).toBe("-w")
    expect(SpMobile.base64url(new Uint8Array([0xfb, 0xff]))).toBe("-_8")
    expect(SpMobile.base64url(new TextEncoder().encode("foobar"))).toBe("Zm9vYmFy")
  })

  test("a fresh PKCE pair is 43 unreserved characters with its own challenge, and never repeats", () => {
    const pkce = SpMobile.createPkce()
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(pkce.challenge).toBe(SpMobile.challengeOf(pkce.verifier))
    expect(SpMobile.createPkce().verifier).not.toBe(pkce.verifier)
    expect(SpMobile.randomSecret(() => new Uint8Array(32))).toBe("A".repeat(43))
  })

  test("authorizeUrl names the constant redirect, S256, the state and the encoded device name", () => {
    const url = SpMobile.authorizeUrl(`${base}/`, { challenge: "ch", state: "st", deviceName: "Pixel 9 & co" })
    expect(url).toBe(
      `${base}/api/dynwork/mobile/v1/authorize?redirect_uri=dynwork%3A%2F%2Fauth%2Fcallback&code_challenge=ch&code_challenge_method=S256&state=st&device_name=Pixel%209%20%26%20co`,
    )
  })

  test("only https or this machine over http is an instance URL", () => {
    expect(SpMobile.instanceUrl("https://dynapps.example/")).toBe("https://dynapps.example")
    expect(SpMobile.instanceUrl("http://localhost:8080")).toBe("http://localhost:8080")
    for (const bad of ["http://10.0.2.2:18201", "https://user:pw@x.example", "https://x.example/?a=1", "ftp://x", "x"])
      expect(SpMobile.instanceUrl(bad)).toBeUndefined()
    expect(() =>
      SpMobile.authorizeUrl("http://evil.example", { challenge: "c", state: "s", deviceName: "d" }),
    ).toThrow()
  })

  test("parseCallback takes a code or a denial only with the expected state", () => {
    const st = "s".repeat(43)
    expect(SpMobile.parseCallback(`dynwork://auth/callback?code=${code}&state=${st}`, st)).toEqual({
      _tag: "Code",
      code,
    })
    expect(SpMobile.parseCallback(`dynwork://auth/callback?error=access_denied&state=${st}`, st)).toEqual({
      _tag: "Denied",
    })
    for (const url of [
      `dynwork://auth/callback?code=${code}&state=${"t".repeat(43)}`,
      `dynwork://auth/callback?code=${code}`,
      `dynwork://auth/callback?code=not-a-code&state=${st}`,
      `dynwork://evil/callback?code=${code}&state=${st}`,
      `https://evil.example/?code=${code}&state=${st}`,
    ])
      expect(SpMobile.parseCallback(url, st)).toBeUndefined()
    expect(SpMobile.parseCallback(`dynwork://auth/callback?code=${code}&state=`, "")).toBeUndefined()
  })

  test("the module uses nothing Hermes lacks", async () => {
    // Comments may name what the module avoids; only code counts
    const source = (await Bun.file(path.join(import.meta.dir, "../../src/mobile.ts")).text()).replace(
      /^\s*\/\/.*$/gm,
      "",
    )
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1])
    expect(imports).toEqual(["@noble/hashes/sha2.js", "effect", "./errors"])
    for (const forbidden of [
      /\bBun\./,
      /\bBuffer\b/,
      /\bprocess\./,
      /\bWebAssembly\b/,
      /new URL\(/,
      /URLSearchParams/,
      /require\(/,
    ])
      expect(source).not.toMatch(forbidden)
    const errors = await Bun.file(path.join(import.meta.dir, "../../src/errors.ts")).text()
    expect([...errors.matchAll(/from "([^"]+)"/g)].map((match) => match[1])).toEqual(["effect"])
  })
})

describe("against the stand-in", () => {
  test("discover reads the path 1 routes, and an instance without them is Incompatible", async () => {
    expect(await run(SpMobile.discover(base))).toEqual({
      baseUrl: base,
      displayName: "Dynapps",
      authorizePath: "/api/dynwork/mobile/v1/authorize",
    })
    state.discovery = false
    const error = await fail(SpMobile.discover(base))
    state.discovery = true
    expect(error._tag).toBe("Incompatible")
  })

  test("exchange sends the code, verifier and peer id and returns the credential and a dated JWT", async () => {
    const before = Date.now()
    const signedIn = await run(SpMobile.exchange(base, { code, verifier, peerId }))
    expect(signedIn.credential).toBe(credential)
    expect(signedIn.peerId).toBe(peerId)
    expect(signedIn.account).toEqual(account)
    expect(signedIn.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000)
    expect(JSON.parse(seen.at(-1)?.body ?? "{}")).toEqual({ code, code_verifier: verifier, peer_id: peerId })
  })

  test("a refused code is a Protocol error with the relay's key and no secret", async () => {
    const error = await fail(SpMobile.exchange(base, { code, verifier: "x".repeat(43), peerId }))
    expect(error).toMatchObject({ _tag: "Protocol", status: 400, errorKey: "invalid_grant" })
    expect(JSON.stringify(error)).not.toContain(code)
    expect((await fail(SpMobile.exchange(base, { code, verifier, peerId: "XYZ" })))._tag).toBe("Protocol")
  })

  test("refresh presents the credential as a bearer; after signOut it is Unauthorized", async () => {
    state.revoked = false
    const session = await run(SpMobile.refresh(base, credential))
    expect(session.token).toBe("eyJfake")
    expect(seen.at(-1)?.authorization).toBe(`Bearer ${credential}`)
    await run(SpMobile.signOut(base, credential))
    const error = await fail(SpMobile.refresh(base, credential))
    expect(error).toMatchObject({ _tag: "Unauthorized", errorKey: "unauthorized" })
    expect(JSON.stringify(error)).not.toContain(credential)
  })

  test("a refused base URL never reaches the network", async () => {
    const count = seen.length
    expect((await fail(SpMobile.refresh("http://evil.example", credential)))._tag).toBe("Protocol")
    expect(seen.length).toBe(count)
  })
})
