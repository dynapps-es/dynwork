import { afterAll, afterEach, beforeAll, describe, expect, jest, setSystemTime, test } from "bun:test"
import { Effect } from "effect"
import { SpClient } from "@dynwork/sp-client"
import { DynWorkAccounts } from "../../src/accounts/accounts"
import { mints, setup, startFake, until, type Fake } from "./fixture"

let fake: Fake

beforeAll(() => {
  fake = startFake()
})

afterAll(() => fake.stop())

afterEach(() => {
  fake.state.override = undefined
  jest.useRealTimers()
  setSystemTime()
})

const start = Date.parse("2030-01-01T00:00:00Z")
// The fake's JWTs live 3600 s, as the instance's do.
const ttl = 3_600_000

// Moves the fake clock to `to` after the start: the timers that fall due run, and Date.now follows.
function elapse(to: number) {
  jest.advanceTimersByTime(start + to - Date.now())
  expect(Date.now()).toBe(start + to)
}

async function signedIn() {
  const context = setup(fake)
  await context.accounts.signInToken({ url: fake.url, token: fake.issuePat() })
  const id = context.accounts.list()[0]?.id ?? ""
  return { ...context, id }
}

const whoami = (token: string) => Effect.runPromise(SpClient.whoami(fake.url, token))

describe("account sessions", () => {
  test("renews the JWT at 80 % of its lifetime, not before", async () => {
    jest.useFakeTimers()
    setSystemTime(new Date(start))
    const context = await signedIn()
    const first = await context.accounts.jwt(context.id)
    const before = mints(fake)

    elapse(ttl * 0.79)
    expect(await context.accounts.jwt(context.id)).toBe(first)
    expect(mints(fake)).toBe(before)

    elapse(ttl * 0.8)
    // The renewed JWT replaces the old one without another request.
    await until(async () => (await context.accounts.jwt(context.id)) !== first)
    expect(mints(fake)).toBe(before + 1)
    // The renewal replays the instance's session id.
    const requests = fake.state.requests.filter((request) => request.path === "/v1/auth/bridge/pat")
    expect(requests.at(-1)?.headers["x-session-id"]).toStartWith("sess_")
    context.accounts.dispose()
  })

  test("a failed renewal is tried again 30 s later while the JWT holds", async () => {
    jest.useFakeTimers()
    setSystemTime(new Date(start))
    const context = await signedIn()
    const before = mints(fake)
    fake.state.override = { path: "/v1/auth/bridge/pat", status: 503 }

    elapse(ttl * 0.8)
    await until(() => mints(fake) === before + 1)
    // The fake applied the 503 when it recorded the request, so the next mint succeeds.
    fake.state.override = undefined
    // The 503 lands in real time, so the clock moves in 100 ms steps until the retry goes out.
    await until(() => {
      if (mints(fake) === before + 2) return true
      jest.advanceTimersByTime(100)
      return false
    })
    const waited = Date.now() - (start + ttl * 0.8)
    expect(waited).toBeGreaterThanOrEqual(DynWorkAccounts.retryAfter)
    expect(waited).toBeLessThan(DynWorkAccounts.retryAfter + 5_000)
    expect(context.accounts.list()[0]?.status).toBe("signedIn")
    context.accounts.dispose()
  })

  test("a refused JWT is minted again once and the call retried", async () => {
    const context = await signedIn()
    const before = mints(fake)
    // The instance forgets every JWT it issued, as after a restart.
    fake.state.jwts.clear()
    const tokens: string[] = []
    const who = await context.accounts.withJwt(context.id, (token) => {
      tokens.push(token)
      return whoami(token)
    })
    expect(who.email).toBe("dev@dynapps.test")
    expect(tokens).toHaveLength(2)
    expect(tokens[0]).not.toBe(tokens[1])
    expect(mints(fake)).toBe(before + 1)
    expect(context.accounts.list()[0]?.status).toBe("signedIn")
    context.accounts.dispose()
  })

  test("a PAT the instance refuses signs the account out", async () => {
    const context = await signedIn()
    fake.state.jwts.clear()
    fake.state.pats.clear()
    await expect(context.accounts.withJwt(context.id, whoami)).rejects.toBeInstanceOf(SpClient.Unauthorized)
    expect(context.accounts.list()).toMatchObject([{ id: context.id, status: "signedOut", active: false }])
    expect(context.store.value.accounts[0]?.patCipher).toBeUndefined()
    expect(context.store.value.active).toBeUndefined()
    await expect(context.accounts.jwt(context.id)).rejects.toBeInstanceOf(DynWorkAccounts.NotSignedIn)
  })

  test("a renewal refused for its PAT signs the account out", async () => {
    jest.useFakeTimers()
    setSystemTime(new Date(start))
    const context = await signedIn()
    fake.state.pats.clear()
    elapse(ttl * 0.8)
    await until(() => context.accounts.list()[0]?.status === "signedOut")
    await expect(context.accounts.jwt(context.id)).rejects.toBeInstanceOf(DynWorkAccounts.NotSignedIn)
    expect(context.events.changed).toBeGreaterThan(1)
  })

  test("concurrent callers share one mint", async () => {
    const context = await signedIn()
    const held = await context.accounts.jwt(context.id)
    fake.state.jwts.delete(held)
    const before = mints(fake)
    const tokens = await Promise.all(
      Array.from({ length: 3 }, () => context.accounts.withJwt(context.id, (token) => whoami(token).then(() => token))),
    )
    expect(new Set(tokens).size).toBe(1)
    expect(mints(fake)).toBe(before + 1)
    context.accounts.dispose()
  })

  test("a JWT never outlives its account", async () => {
    const context = await signedIn()
    const token = await context.accounts.jwt(context.id)
    context.accounts.signOut(context.id)
    await expect(context.accounts.jwt(context.id)).rejects.toBeInstanceOf(DynWorkAccounts.NotSignedIn)
    expect(JSON.stringify(context.store.value)).not.toContain(token)
  })
})
