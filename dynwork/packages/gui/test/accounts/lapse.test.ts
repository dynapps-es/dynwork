import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SpClient } from "@dynwork/sp-client"
import { DynWorkAccounts } from "../../src/accounts/accounts"
import { mints, setup, startFake, type Fake } from "./fixture"

let fake: Fake

beforeAll(() => {
  fake = startFake()
})

afterAll(() => fake.stop())

afterEach(() => {
  fake.state.override = undefined
})

const whoami = (token: string) => Effect.runPromise(SpClient.whoami(fake.url, token))

// Plays the system browser on the instance's consent page: the user allows, and the page answers on the redirect.
const allow = async (link: string) => {
  const redirect = new URL(new URL(link).searchParams.get("redirect") ?? "")
  redirect.searchParams.set("code", fake.issueCode())
  void fetch(redirect)
}

async function signedIn(options: Parameters<typeof setup>[1] = {}, keep?: boolean) {
  const context = setup(fake, { open: allow, ...options })
  const pat = fake.issuePat()
  await context.accounts.signInToken({ url: fake.url, token: pat, keep })
  const id = context.accounts.list()[0]?.id ?? ""
  return { ...context, id, pat }
}

// The instance forgets the account's PAT, as when the user revokes it in Governance, and the next call finds out.
async function revoke(context: Awaited<ReturnType<typeof signedIn>>) {
  fake.state.pats.clear()
  fake.state.jwts.clear()
  await context.accounts.withJwt(context.id, whoami).catch(() => undefined)
}

describe("a sign-in the instance refuses for good", () => {
  test("lapses the account: the PAT goes, the entry stays active with its user and device", async () => {
    const context = await signedIn()
    const user = context.store.value.accounts[0]?.userId ?? ""
    const device = await context.accounts.device(context.id, user)
    await revoke(context)
    expect(context.accounts.list()).toMatchObject([
      { id: context.id, status: "needsSignIn", lapse: "revoked", active: true, user: "dev@dynapps.test" },
    ])
    expect(context.store.value.accounts[0]?.patCipher).toBeUndefined()
    expect(context.store.value.accounts[0]?.device?.id).toBe(device.id)
    expect(context.accounts.state().signingIn).toBeUndefined()
    context.accounts.dispose()
  })

  test("asks nothing of the instance afterwards, however often it is called", async () => {
    const context = await signedIn()
    await revoke(context)
    const before = fake.state.requests.length
    const calls = await Promise.allSettled(
      Array.from({ length: 5 }, () => [
        context.accounts.jwt(context.id),
        context.accounts.session(context.id, true),
        context.accounts.withJwt(context.id, whoami),
      ]).flat(),
    )
    expect(calls).toHaveLength(15)
    expect(
      calls.every((call) => call.status === "rejected" && call.reason instanceof DynWorkAccounts.NotSignedIn),
    ).toBe(true)
    expect(fake.state.requests.length).toBe(before)
    expect(() => context.accounts.activate(context.id)).toThrow(DynWorkAccounts.NotSignedIn)
    context.accounts.dispose()
  })

  test("a call whose refusal does not speak for the sign-in fails without a lapse; the manifest's lapses it", async () => {
    const context = await signedIn()
    fake.state.override = {
      path: "/v1/bridge/whoami",
      status: 401,
      body: { code: "unauthorized", message: "Bridge credential rejected", error_key: "invalid_credential" },
    }
    const before = mints(fake)
    await expect(context.accounts.withJwt(context.id, whoami)).rejects.toBeInstanceOf(SpClient.Unauthorized)
    expect(mints(fake)).toBe(before + 1)
    expect(context.accounts.list()[0]?.status).toBe("signedIn")

    await expect(context.accounts.withJwt(context.id, whoami, { lapse: true })).rejects.toBeInstanceOf(
      SpClient.Unauthorized,
    )
    expect(mints(fake)).toBe(before + 2)
    expect(context.accounts.list()[0]).toMatchObject({ status: "needsSignIn", lapse: "refused", active: true })
    context.accounts.dispose()
  })

  test("an instance that does not answer is not a refusal: the account stays signed in", async () => {
    const away = startFake()
    const context = setup(away)
    await context.accounts.signInToken({ url: away.url, token: away.issuePat() })
    const id = context.accounts.list()[0]?.id ?? ""
    away.state.override = { status: 503, body: { code: "down", message: "down" } }
    await expect(context.accounts.session(id, true)).rejects.toBeInstanceOf(SpClient.Unreachable)
    away.stop()
    await expect(context.accounts.session(id, true)).rejects.toBeInstanceOf(SpClient.Unreachable)
    expect(context.accounts.list()[0]).toMatchObject({ status: "signedIn", active: true })
    expect(context.store.value.accounts[0]?.lapsed).toBeUndefined()
    context.accounts.dispose()
  })

  test("says so in main's log with the account and the reason, and no credential reaches the log or a window", async () => {
    const logs: unknown[] = []
    const context = await signedIn({ log: (message, data) => logs.push({ message, data }) })
    const token = await context.accounts.jwt(context.id)
    await revoke(context)
    expect(logs).toEqual([
      { message: "accounts: the instance refused the sign-in", data: { account: context.id, reason: "revoked" } },
    ])
    const seen = JSON.stringify([logs, context.accounts.state(), context.accounts.list()])
    expect(seen).not.toContain(context.pat)
    expect(seen).not.toContain(context.pat.slice(8))
    expect(seen).not.toContain(token)
    expect(Object.keys(context.accounts.list()[0] ?? {})).toContain("lapse")
    expect(Object.keys(context.accounts.list()[0] ?? {})).not.toContain("lapsed")
    context.accounts.dispose()
  })
})

describe("signing in again", () => {
  test("through the browser ends the lapse on the same entry, still active, with the PAT stored as before", async () => {
    const context = await signedIn()
    await revoke(context)
    expect(await context.accounts.signInBrowser(fake.url)).toBe("signed-in")
    expect(context.accounts.list()).toEqual([expect.objectContaining({ id: context.id, status: "signedIn" })])
    expect(context.accounts.list()[0]).toMatchObject({ active: true })
    expect(context.accounts.list()[0]?.lapse).toBeUndefined()
    expect(context.store.value.accounts[0]?.lapsed).toBeUndefined()
    expect(context.store.value.accounts[0]?.patCipher).toBeString()
    expect(await context.accounts.withJwt(context.id, whoami)).toMatchObject({ email: "dev@dynapps.test" })
    context.accounts.dispose()
  })

  test("an account not kept signed in signs in again the same way, and its lapse ends with the process", async () => {
    const context = await signedIn({}, false)
    await revoke(context)
    expect(context.accounts.list()[0]?.status).toBe("needsSignIn")
    expect(context.store.value.accounts[0]?.lapsed).toMatchObject({ kept: false })
    expect(await context.accounts.signInBrowser(fake.url)).toBe("signed-in")
    expect(context.accounts.list()[0]?.status).toBe("signedIn")
    expect(context.store.value.accounts[0]?.patCipher).toBeUndefined()

    // It lapses again, and the app quits: the PAT was never stored, so the next launch finds it signed out, as it
    // would have anyway.
    await revoke(context)
    context.accounts.dispose()
    const restarted = DynWorkAccounts.make({
      store: context.store,
      secure: context.secure,
      open: allow,
      deviceName: "DynWork test",
      changed: () => {},
    })
    expect(restarted.list()[0]).toMatchObject({ status: "signedOut", active: true })
    expect(context.store.value.accounts[0]?.lapsed).toBeUndefined()
    restarted.dispose()
  })

  test("a kept account still needs signing in after a restart", async () => {
    const context = await signedIn()
    await revoke(context)
    context.accounts.dispose()
    const restarted = DynWorkAccounts.make({
      store: context.store,
      secure: context.secure,
      open: allow,
      deviceName: "DynWork test",
      changed: () => {},
    })
    expect(restarted.list()).toMatchObject([{ id: context.id, status: "needsSignIn", lapse: "revoked", active: true }])
    expect(await restarted.signInBrowser(fake.url)).toBe("signed-in")
    expect(restarted.list()[0]?.status).toBe("signedIn")
    restarted.dispose()
  })

  test("signing out of a lapsed account forgets the lapse and hands the active account on", async () => {
    const context = await signedIn()
    await revoke(context)
    context.accounts.signOut(context.id)
    expect(context.accounts.list()).toMatchObject([{ id: context.id, status: "signedOut", active: false }])
    expect(context.accounts.list()[0]?.lapse).toBeUndefined()
    expect(context.store.value.accounts[0]?.lapsed).toBeUndefined()
    context.accounts.dispose()
  })
})
