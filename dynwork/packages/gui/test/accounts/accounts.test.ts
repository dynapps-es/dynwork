import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { SpClient } from "@dynwork/sp-client"
import { DynWorkAccounts } from "../../src/accounts/accounts"
import { setup, startFake, until, type Fake } from "./fixture"

let alpha: Fake
let beta: Fake

beforeAll(() => {
  alpha = startFake()
  beta = startFake()
})

afterAll(() => {
  alpha.stop()
  beta.stop()
})

// Plays the system browser and the instance's consent page: follows the device link and answers on its redirect.
function browser(fake: Fake, answer: "allow" | "deny" | "ignore") {
  const opened: string[] = []
  const open = async (link: string) => {
    opened.push(link)
    if (answer === "ignore") return
    const redirect = new URL(new URL(link).searchParams.get("redirect") ?? "")
    if (answer === "allow") redirect.searchParams.set("code", fake.issueCode())
    if (answer === "deny") redirect.searchParams.set("error", "denied")
    void fetch(redirect)
  }
  return { opened, open }
}

async function signIn(context: ReturnType<typeof setup>, fake: Fake) {
  await context.accounts.signInToken({ url: fake.url, token: fake.issuePat() })
  return context.accounts.list().find((account) => account.url === fake.url)?.id ?? ""
}

describe("browser sign-in", () => {
  test("opens the device link with a loopback redirect and signs in with the code", async () => {
    const page = browser(alpha, "allow")
    const context = setup(alpha, page)
    expect(await context.accounts.signInBrowser(alpha.url)).toBe("signed-in")
    const link = new URL(page.opened[0] ?? "")
    expect(`${link.origin}${link.pathname}`).toBe(`${alpha.url}/bridge-auth/device-link`)
    const redirect = new URL(link.searchParams.get("redirect") ?? "")
    expect(redirect.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(redirect.searchParams.get("state")?.length).toBeGreaterThanOrEqual(32)
    expect(context.accounts.list()).toMatchObject([{ url: alpha.url, status: "signedIn", active: true }])
    expect(context.accounts.state().signingIn).toBeUndefined()
    context.accounts.dispose()
  })

  test("a declined consent ends as denied and stores nothing", async () => {
    const context = setup(alpha, browser(alpha, "deny"))
    expect(await context.accounts.signInBrowser(alpha.url)).toBe("denied")
    expect(context.store.value.accounts).toEqual([])
  })

  test("cancel ends the pending sign-in, and a second sign-in cancels the first", async () => {
    const context = setup(alpha, browser(alpha, "ignore"))
    const first = context.accounts.signInBrowser(alpha.url)
    await until(() => context.accounts.state().signingIn === alpha.url)
    const second = context.accounts.signInBrowser(alpha.url)
    expect(await first).toBe("cancelled")
    await until(() => context.accounts.state().signingIn === alpha.url)
    context.accounts.cancel()
    expect(await second).toBe("cancelled")
    expect(context.accounts.state().signingIn).toBeUndefined()
    expect(context.store.value.accounts).toEqual([])
  })

  test("cancel during discovery stops the sign-in before any browser or listener", async () => {
    const page = browser(alpha, "allow")
    const context = setup(alpha, page)
    const pending = context.accounts.signInBrowser(alpha.url)
    context.accounts.cancel()
    expect(await pending).toBe("cancelled")
    expect(page.opened).toEqual([])
    expect(context.store.value.accounts).toEqual([])
  })

  test("the calling window going away cancels its sign-in", async () => {
    const context = setup(alpha, browser(alpha, "ignore"))
    const window = new AbortController()
    const pending = context.accounts.signInBrowser(alpha.url, window.signal)
    await until(() => context.accounts.state().signingIn === alpha.url)
    window.abort()
    expect(await pending).toBe("cancelled")
    expect(context.accounts.state().signingIn).toBeUndefined()
  })
})

describe("accounts", () => {
  test("probe reports discovery without storing anything", async () => {
    const context = setup(alpha)
    expect(await context.accounts.probe(`${alpha.url}/`)).toMatchObject({
      reachable: true,
      url: alpha.url,
      host: new URL(alpha.url).host,
      label: "Dynapps",
      modes: expect.arrayContaining(["pat"]),
    })
    expect(await context.accounts.probe("http://127.0.0.1:1")).toEqual({ reachable: false, reason: "Unreachable" })
    expect(context.store.value.accounts).toEqual([])
  })

  test("add keeps one entry per instance, signed out", async () => {
    const context = setup(alpha)
    const added = await context.accounts.add(alpha.url)
    expect(await context.accounts.add(`${alpha.url}/`)).toEqual(added)
    expect(added).toMatchObject({ status: "signedOut", active: false, trusted: false })
    expect(() => context.accounts.activate(added.id)).toThrow(DynWorkAccounts.NotSignedIn)
    // Signing in to a known instance fills that entry rather than adding one.
    expect(await signIn(context, alpha)).toBe(added.id)
    expect(context.accounts.list()).toHaveLength(1)
    context.accounts.dispose()
  })

  test("the first sign-in becomes active, later ones wait for activate", async () => {
    const context = setup(alpha)
    const a = await signIn(context, alpha)
    const b = await signIn(context, beta)
    expect(context.accounts.active()).toBe(a)
    const before = context.events.changed
    context.accounts.activate(b)
    expect(context.accounts.active()).toBe(b)
    expect(context.events.changed).toBe(before + 1)
    expect(context.accounts.list().map((account) => account.active)).toEqual([false, true])
    context.accounts.dispose()
  })

  test("signing out the active account hands over to another signed-in one, and keeps the entry", async () => {
    const context = setup(alpha)
    const a = await signIn(context, alpha)
    const b = await signIn(context, beta)
    context.accounts.signOut(a)
    expect(context.accounts.active()).toBe(b)
    expect(context.accounts.list()).toMatchObject([
      { id: a, status: "signedOut", active: false },
      { id: b, status: "signedIn", active: true },
    ])
    context.accounts.signOut(b)
    expect(context.accounts.active()).toBeUndefined()
    expect(context.store.value.accounts.every((account) => account.patCipher === undefined)).toBe(true)
  })

  test("remove forgets the account and moves the active one on", async () => {
    const context = setup(alpha)
    const a = await signIn(context, alpha)
    const b = await signIn(context, beta)
    context.accounts.remove(a)
    expect(context.accounts.list().map((account) => account.id)).toEqual([b])
    expect(context.accounts.active()).toBe(b)
    await expect(context.accounts.jwt(a)).rejects.toBeInstanceOf(DynWorkAccounts.NotSignedIn)
    context.accounts.dispose()
  })

  test("trust pins the served manifest key; a rotated key waits for trust again", async () => {
    const context = setup(alpha)
    const id = await signIn(context, alpha)
    const served = SpClient.fingerprint(alpha.state.key.public)
    expect(context.accounts.list()[0]).toMatchObject({ fingerprint: served, trusted: false })
    // A fingerprint the user did not compare pins nothing.
    expect(() => context.accounts.trust({ id, fingerprint: "sha256:other" })).toThrow(DynWorkAccounts.NothingToTrust)
    context.accounts.trust({ id, fingerprint: served })
    expect(context.accounts.list()[0]).toMatchObject({ fingerprint: served, trusted: true })
    expect(context.store.value.accounts[0]).toMatchObject({ key: alpha.state.key.public, keyFingerprint: served })
    expect(() => context.accounts.trust({ id, fingerprint: served })).toThrow(DynWorkAccounts.NothingToTrust)

    // Signing in again to the same key keeps it trusted.
    await signIn(context, alpha)
    expect(context.accounts.list()[0]?.trusted).toBe(true)

    const rotated = beta.state.key.public
    context.accounts.offerKey(id, rotated)
    expect(context.accounts.list()[0]).toMatchObject({ fingerprint: SpClient.fingerprint(rotated), trusted: false })
    context.accounts.trust({ id, fingerprint: SpClient.fingerprint(rotated) })
    expect(context.store.value.accounts[0]?.key).toBe(rotated)
    context.accounts.dispose()
  })
})
