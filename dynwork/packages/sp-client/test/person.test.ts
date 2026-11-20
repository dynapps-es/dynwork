import { afterAll, afterEach, beforeEach, describe, expect, jest, setSystemTime, test } from "bun:test"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { Effect } from "effect"
import { SpClient, SpDrive, SpPerson } from "../src"
import { startFake, startPerson } from "./fake"
import alpha from "./fixtures/alpha.json"

const fake = startFake()

afterAll(() => fake.stop())

beforeEach(() => {
  fake.state.person = startPerson()
  fake.state.requests.length = 0
})

afterEach(() => {
  jest.useRealTimers()
  setSystemTime()
})

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const fail = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(effect))

// A loopback listener standing in for DynWork's: it hands over the first callback the browser sends to it.
async function listener() {
  const server = createServer()
  const callback = Promise.withResolvers<URL>()
  server.on("request", (request, response) => {
    callback.resolve(new URL(request.url ?? "", "http://127.0.0.1"))
    response.end("ok")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const redirect = `http://127.0.0.1:${(server.address() as AddressInfo).port}${SpPerson.callbackPath}`
  return { redirect, callback: callback.promise, close: () => server.close() }
}

// One whole sign-in: the authorize page in the browser, the callback, and the code for the tokens.
async function signIn(options: Parameters<typeof fake.personBrowser>[1] = {}) {
  const grant = SpPerson.begin()
  const loop = await listener()
  const link = SpPerson.authorizeUrl(fake.url, { redirect: loop.redirect, state: grant.state, challenge: grant.challenge })
  await fake.personBrowser(link, options)
  const answer = SpPerson.parseCallback(await loop.callback, grant.state)
  loop.close()
  if (answer?._tag !== "Code") throw new Error("no code")
  return { grant, loop, code: answer.code }
}

describe("the authorize page and its way back", () => {
  test("asks for a code with PKCE S256, the declared client, the loopback redirect and a 43-character state", () => {
    const grant = SpPerson.begin()
    const link = new URL(
      SpPerson.authorizeUrl("https://gov.example", {
        redirect: "http://127.0.0.1:5123/oauth/callback",
        state: grant.state,
        challenge: grant.challenge,
      }),
    )
    expect(link.origin + link.pathname).toBe("https://gov.example/api/v1/core/oauth/authorize")
    expect(Object.fromEntries(link.searchParams)).toEqual({
      response_type: "code",
      client_id: "dynwork-desktop",
      redirect_uri: "http://127.0.0.1:5123/oauth/callback",
      scope: "user",
      state: grant.state,
      code_challenge: grant.challenge,
      code_challenge_method: "S256",
    })
    expect(grant.state).toHaveLength(43)
    expect(grant.verifier).toHaveLength(43)
    expect(grant.challenge).toBe(createHash("sha256").update(grant.verifier).digest("base64url"))
    expect(SpPerson.begin().state).not.toBe(grant.state)
  })

  test("asks for a recent sign-in with max_age when told", () => {
    const link = SpPerson.authorizeUrl("https://gov.example", {
      redirect: "http://127.0.0.1:5123/oauth/callback",
      state: "s".repeat(43),
      challenge: "c",
      maxAge: 600,
    })
    expect(new URL(link).searchParams.get("max_age")).toBe("600")
  })

  test("a callback with another state, or none, is no answer; the person's refusal is", () => {
    const state = "a".repeat(43)
    const at = (query: string) => new URL(`http://127.0.0.1:1/oauth/callback?${query}`)
    expect(SpPerson.parseCallback(at(`code=abc&state=${"b".repeat(43)}`), state)).toBeUndefined()
    expect(SpPerson.parseCallback(at("code=abc"), state)).toBeUndefined()
    expect(SpPerson.parseCallback(at(`code=abc&state=${state}`), "")).toBeUndefined()
    expect(SpPerson.parseCallback(at(`state=${state}`), state)).toBeUndefined()
    expect(SpPerson.parseCallback(at(`error=access_denied&state=${state}`), state)).toEqual({ _tag: "Denied" })
    expect(SpPerson.parseCallback(at(`code=abc&state=${state}`), state)).toEqual({ _tag: "Code", code: "abc" })
  })
})

describe("whether the instance declares DynWork's client", () => {
  test("a 0.84 instance with the client answers its sign-in page", async () => {
    expect(await run(SpPerson.available(fake.url))).toBe(true)
  })

  test("an instance without it refuses the client: not available, and no error", async () => {
    fake.state.person.client = "none"
    expect(await run(SpPerson.available(fake.url))).toBe(false)
  })

  test("no answer is an error, not a no", async () => {
    expect((await fail(SpPerson.available("http://127.0.0.1:1")))._tag).toBe("Unreachable")
  })
})

describe("the code for the person's UI session", () => {
  test("gives a 300-second UI session that begins at the sign-in and names the person", async () => {
    const before = Date.now()
    const flow = await signIn()
    const tokens = await run(
      SpPerson.exchange(fake.url, { code: flow.code, redirect: flow.loop.redirect, verifier: flow.grant.verifier }),
    )
    expect(tokens.ttl).toBe(300)
    expect(tokens.expiresAt - Date.now()).toBeGreaterThan(290_000)
    expect(tokens.signedInAt).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000)
    expect(tokens.user).toBe(alpha.whoami.body.user_id)
    expect(tokens.refresh.startsWith("rt_")).toBe(true)
  })

  test("refuses a verifier that is not the challenge's, and the code is spent", async () => {
    const flow = await signIn()
    const wrong = await fail(
      SpPerson.exchange(fake.url, { code: flow.code, redirect: flow.loop.redirect, verifier: SpPerson.begin().verifier }),
    )
    expect(wrong).toBeInstanceOf(SpClient.Unauthorized)
    const again = await fail(
      SpPerson.exchange(fake.url, { code: flow.code, redirect: flow.loop.redirect, verifier: flow.grant.verifier }),
    )
    expect(again).toBeInstanceOf(SpClient.Unauthorized)
  })

  test("refuses another redirect than the one the code was asked for", async () => {
    const flow = await signIn()
    const wrong = await fail(
      SpPerson.exchange(fake.url, {
        code: flow.code,
        redirect: "http://127.0.0.1:1/oauth/callback",
        verifier: flow.grant.verifier,
      }),
    )
    expect(wrong).toBeInstanceOf(SpClient.Unauthorized)
  })

  test("a client that is not a person_ui one gives no UI session: incompatible, and no error carries a token", async () => {
    fake.state.person.client = "plain"
    const flow = await signIn()
    const error = await fail(
      SpPerson.exchange(fake.url, { code: flow.code, redirect: flow.loop.redirect, verifier: flow.grant.verifier }),
    )
    expect(error).toBeInstanceOf(SpClient.Incompatible)
    expect(JSON.stringify(error)).not.toContain("eyJ")
    expect(JSON.stringify(error)).not.toContain("rt_")
  })
})

describe("refreshing", () => {
  const session = async () => {
    const flow = await signIn()
    return run(SpPerson.exchange(fake.url, { code: flow.code, redirect: flow.loop.redirect, verifier: flow.grant.verifier }))
  }

  test("rotates the refresh token and keeps the sign-in time", async () => {
    const first = await session()
    const next = await run(SpPerson.refresh(fake.url, first.refresh))
    expect(next.refresh).not.toBe(first.refresh)
    expect(next.access).not.toBe(first.access)
    expect(next.signedInAt).toBe(first.signedInAt)
    expect((await fail(SpPerson.refresh(fake.url, first.refresh)))._tag).toBe("Unauthorized")
  })

  test("a refresh token spent twice ends the whole session", async () => {
    const first = await session()
    const next = await run(SpPerson.refresh(fake.url, first.refresh))
    await fail(SpPerson.refresh(fake.url, first.refresh))
    expect(await fail(SpPerson.refresh(fake.url, next.refresh))).toBeInstanceOf(SpClient.Unauthorized)
  })

  test("ends 12 hours after the sign-in, refreshes or not", async () => {
    jest.useFakeTimers()
    const start = Date.now()
    setSystemTime(new Date(start))
    const first = await session()
    setSystemTime(new Date(start + 11 * 3600_000))
    const late = await run(SpPerson.refresh(fake.url, first.refresh))
    setSystemTime(new Date(start + 12 * 3600_000 + 1000))
    expect(await fail(SpPerson.refresh(fake.url, late.refresh))).toBeInstanceOf(SpClient.Unauthorized)
  })

  test("revoking with DynWork's JWT ends it; the UI token cannot revoke", async () => {
    const first = await session()
    const jwt = (await run(SpClient.mintJwt(fake.url, fake.issuePat()))).token
    expect(await fail(SpPerson.revoke(fake.url, { refreshToken: first.refresh, bearer: first.access }))).toBeInstanceOf(
      SpClient.Unauthorized,
    )
    await run(SpPerson.revoke(fake.url, { refreshToken: first.refresh, bearer: jwt }))
    expect(await fail(SpPerson.refresh(fake.url, first.refresh))).toBeInstanceOf(SpClient.Unauthorized)
  })
})

describe("the Drive with the person's UI token", () => {
  test("acts as the person, and asks for a recent sign-in past 600 s with RecentSignIn and its max_age", async () => {
    jest.useFakeTimers()
    const start = Date.now()
    setSystemTime(new Date(start))
    const flow = await signIn()
    const tokens = await run(
      SpPerson.exchange(fake.url, { code: flow.code, redirect: flow.loop.redirect, verifier: flow.grant.verifier }),
    )
    const folder = await run(SpDrive.createFolder(fake.url, tokens.access, { name: "Mine" }))
    setSystemTime(new Date(start + 280_000))
    const later = await run(SpPerson.refresh(fake.url, tokens.refresh))
    setSystemTime(new Date(start + 560_000))
    const latest = await run(SpPerson.refresh(fake.url, later.refresh))
    setSystemTime(new Date(start + 610_000))
    const refused = await fail(SpDrive.revoke(fake.url, latest.access, folder.id, "grant"))
    expect(refused).toBeInstanceOf(SpClient.RecentSignIn)
    expect(refused).toMatchObject({ maxAge: 600 })
    expect(JSON.stringify(refused)).not.toContain(latest.access)
    // Reading needs no recent sign-in
    expect(await run(SpDrive.list(fake.url, latest.access))).toBeDefined()
    expect(fake.state.person.acted).toEqual(["POST /api/v1/document-folders", "GET /api/v1/documents"])
  })
})
