import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, setSystemTime, test } from "bun:test"
import { Effect } from "effect"
import { SpDrive, SpPerson } from "@dynwork/sp-client"
import { AccountsIpc } from "../../src/accounts/ipc"
import { DynWorkPerson } from "../../src/accounts/person"
import { startPerson } from "../../../sp-client/test/fake"
import { personOf, personStore, setup, startFake, until, type Fake } from "./fixture"

let fake: Fake

beforeAll(() => {
  fake = startFake()
})

afterAll(() => fake.stop())

beforeEach(() => {
  fake.state.person = startPerson()
  fake.state.requests.length = 0
})

afterEach(() => {
  fake.state.override = undefined
  jest.useRealTimers()
  setSystemTime()
})

const caller = { window: 1, signal: new AbortController().signal }
const idle = { status: () => ({ status: "idle" as const }), now: () => {} }
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

// A signed-in account, its person's session, and the system browser: each page opened is recorded and answered by
// `browser`, which by default plays the person signing in and allowing.
async function stand(
  browser: (link: string) => Promise<unknown> = (link) => fake.personBrowser(link),
  options: { store?: ReturnType<typeof personStore> } = {},
) {
  const context = setup(fake)
  await context.accounts.signInToken({ url: fake.url, token: fake.issuePat() })
  const id = context.accounts.list()[0]?.id ?? ""
  const opened: string[] = []
  const answer = { browser }
  const person = personOf(context, {
    store: options.store,
    open: async (link) => {
      opened.push(link)
      await answer.browser(link)
    },
  })
  const ipc = AccountsIpc.implementation(context.accounts, idle, person.person)
  const dispose = () => {
    person.person.dispose()
    context.accounts.dispose()
  }
  return { ...context, ...person, id, opened, answer, ipc, dispose }
}

const refreshes = () =>
  fake.state.requests.filter((request) => request.path === "/api/v1/core/oauth/token" && request.body.includes("refresh_token"))
    .length

// Every token the fake's OAuth server issued: none may show outside main's memory and the instance.
const issued = () => [...fake.state.person.access.keys(), ...fake.state.person.refresh.keys(), ...fake.state.person.spent.keys()]

describe("signing the person in", () => {
  test("opens the authorize page with PKCE S256 and a fresh state, and takes only the answer with that state", async () => {
    const forged: number[] = []
    const context = await stand(async (link) => {
      const redirect = new URL(link).searchParams.get("redirect_uri") ?? ""
      // A page that is not the instance's sends a code with another state: refused, and the listener keeps waiting
      forged.push((await fetch(`${redirect}?code=stolen&state=${"z".repeat(43)}`)).status)
      return fake.personBrowser(link)
    })

    expect(await context.ipc.personSignIn(context.id, caller)).toBe("signed-in")
    const link = new URL(context.opened[0] ?? "")
    expect(link.pathname).toBe("/api/v1/core/oauth/authorize")
    expect(link.searchParams.get("client_id")).toBe("dynwork-desktop")
    expect(link.searchParams.get("code_challenge_method")).toBe("S256")
    expect(link.searchParams.get("state")).toHaveLength(43)
    expect(link.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/)
    expect(forged).toEqual([400])
    // The fake grants the code only for the verifier of that challenge
    expect(context.person.status(context.id)).toMatchObject({ status: "on" })

    expect(await context.ipc.personSignIn(context.id, caller)).toBe("signed-in")
    expect(new URL(context.opened[1] ?? "").searchParams.get("state")).not.toBe(link.searchParams.get("state"))
    expect(new URL(context.opened[1] ?? "").searchParams.get("code_challenge")).not.toBe(
      link.searchParams.get("code_challenge"),
    )
    context.dispose()
  })

  test("its tokens never leave main: not in the Ipc's answers, the store, the log or a window's state", async () => {
    const context = await stand()
    const outcome = await context.ipc.personSignIn(context.id, caller)
    await context.person.withPerson(context.id, (token) => run(SpDrive.list(fake.url, token)))
    await context.person.signOut(context.id)
    await context.ipc.personSignIn(context.id, caller)

    const seen = JSON.stringify([
      outcome,
      context.ipc.state(1),
      await context.ipc.list(undefined, caller),
      context.store.disk.json,
      context.events.log,
    ])
    expect(issued().length).toBeGreaterThan(3)
    issued().forEach((token) => expect(seen).not.toContain(token))
    expect(seen).not.toContain("eyJ")
    expect(context.ipc.state(1).accounts[0]?.person).toMatchObject({ status: "on" })
    expect(Object.keys(context.ipc.state(1).accounts[0]?.person ?? {}).toSorted()).toEqual(["status", "until"])
    context.dispose()
  })

  test("someone else signed in in the browser: refused, and their session ended at the instance", async () => {
    const context = await stand((link) => fake.personBrowser(link, { user: "someone-else" }))

    expect(await context.ipc.personSignIn(context.id, caller)).toBe("mismatch")
    expect(context.store.value.sessions).toEqual({})
    expect(context.person.status(context.id).status).toBe("off")
    await until(() => fake.state.person.families.size === 0)
    context.dispose()
  })

  test("declined in the browser, or cancelled, ends without a session", async () => {
    const declined = await stand((link) => fake.personBrowser(link, { deny: true }))
    expect(await declined.ipc.personSignIn(declined.id, caller)).toBe("denied")
    expect(declined.store.value.sessions).toEqual({})
    declined.dispose()

    const cancelled = await stand(async () => {})
    const pending = cancelled.ipc.personSignIn(cancelled.id, caller)
    await until(() => cancelled.person.status(cancelled.id).status === "signingIn")
    await cancelled.ipc.personCancel(undefined, caller)
    expect(await pending).toBe("cancelled")
    expect(cancelled.person.status(cancelled.id).status).toBe("off")
    cancelled.dispose()
  })
})

describe("renewal in the background", () => {
  test("refreshes before the 300 s run out, and again on a use that finds it about to", async () => {
    jest.useFakeTimers()
    const start = Date.now()
    setSystemTime(new Date(start))
    const context = await stand()
    await context.ipc.personSignIn(context.id, caller)
    expect(refreshes()).toBe(0)
    const first = context.store.value.sessions[context.id]?.cipher

    jest.advanceTimersByTime(240_000)
    // The new refresh token is kept as soon as it arrives
    await until(() => context.store.value.sessions[context.id]?.cipher !== first)
    expect(refreshes()).toBe(1)

    // Close to the access token's end without the timer firing: the use refreshes first
    setSystemTime(new Date(Date.now() + 290_000))
    const tokens: string[] = []
    await context.person.withPerson(context.id, (token) => {
      tokens.push(token)
      return run(SpDrive.list(fake.url, token))
    })
    expect(refreshes()).toBe(2)
    expect(fake.state.person.access.get(tokens[0] ?? "")?.expiresAt).toBeGreaterThan(Date.now())
    context.dispose()
  })

  test("concurrent uses share one refresh: a refresh token is never spent twice", async () => {
    jest.useFakeTimers()
    const start = Date.now()
    setSystemTime(new Date(start))
    const context = await stand()
    await context.ipc.personSignIn(context.id, caller)
    setSystemTime(new Date(start + 299_000))
    await Promise.all(
      Array.from({ length: 5 }, () => context.person.withPerson(context.id, (token) => run(SpDrive.list(fake.url, token)))),
    )
    expect(refreshes()).toBe(1)
    expect(fake.state.person.families.size).toBe(1)
    context.dispose()
  })

  test("ends at 12 hours from the sign-in: no request more, no browser, and it says so", async () => {
    jest.useFakeTimers()
    const start = Date.now()
    setSystemTime(new Date(start))
    const context = await stand()
    await context.ipc.personSignIn(context.id, caller)
    expect(context.person.status(context.id).until).toBe(
      (context.store.value.sessions[context.id]?.signedInAt ?? 0) + SpPerson.lifetime,
    )

    setSystemTime(new Date(start + SpPerson.lifetime + 1000))
    jest.advanceTimersByTime(240_000)
    await until(() => context.person.status(context.id).status === "off")
    expect(context.person.status(context.id)).toEqual({ status: "off", ended: true })
    expect(refreshes()).toBe(0)
    expect(context.opened).toHaveLength(1)
    expect(context.store.value.sessions).toEqual({})
    expect(
      await context.person.withPerson(context.id, async () => "ran").catch((error) => error),
    ).toBeInstanceOf(DynWorkPerson.SignedOut)

    jest.advanceTimersByTime(3600_000)
    expect(fake.state.requests.filter((request) => request.path.startsWith("/api/v1/core/oauth/token"))).toHaveLength(1)
    context.dispose()
  })

  test("a session the instance refuses ends once, and nothing tries again", async () => {
    jest.useFakeTimers()
    const start = Date.now()
    setSystemTime(new Date(start))
    const context = await stand()
    await context.ipc.personSignIn(context.id, caller)
    fake.state.person.families.clear()

    jest.advanceTimersByTime(240_000)
    await until(() => context.person.status(context.id).status === "off")
    expect(context.person.status(context.id)).toEqual({ status: "off" })
    expect(refreshes()).toBe(1)
    jest.advanceTimersByTime(3600_000)
    setSystemTime(new Date(start + 3 * 3600_000))
    await Promise.resolve()
    expect(refreshes()).toBe(1)
    expect(context.opened).toHaveLength(1)
    context.dispose()
  })

  test("no answer keeps the session and tries again; it shows as renewing once the token ran out", async () => {
    jest.useFakeTimers()
    const start = Date.now()
    setSystemTime(new Date(start))
    const context = await stand()
    await context.ipc.personSignIn(context.id, caller)
    fake.state.override = { path: "/api/v1/core/oauth/token", status: 503 }
    const changes = context.events.changed

    jest.advanceTimersByTime(240_000)
    await until(() => context.events.changed > changes)
    expect(refreshes()).toBe(1)
    expect(context.events.log).toEqual([])
    expect(context.person.status(context.id).status).toBe("on")
    // The access token runs out before the next try
    setSystemTime(new Date(start + 301_000))
    expect(context.person.status(context.id).status).toBe("renewing")
    expect(context.store.value.sessions[context.id]).toBeDefined()

    fake.state.override = undefined
    jest.advanceTimersByTime(DynWorkPerson.retryAfter)
    await until(() => context.person.status(context.id).status === "on")
    context.dispose()
  })

  test("a stored session carries on after a restart, renewed in the background", async () => {
    const first = await stand()
    await first.ipc.personSignIn(first.id, caller)
    first.person.dispose()

    const again = personOf(first, { store: first.store })
    expect(again.person.status(first.id).status).toBe("renewing")
    again.person.reconcile()
    await until(() => again.person.status(first.id).status === "on")
    expect(refreshes()).toBe(1)
    again.person.dispose()
    first.accounts.dispose()
  })
})

describe("an action that wants a recent sign-in", () => {
  // A document of the person's and someone to share it with, then a sign-in older than the step-up window
  async function stale(browser?: (link: string) => Promise<unknown>) {
    jest.useFakeTimers()
    const start = Date.now()
    setSystemTime(new Date(start))
    const context = await stand()
    await context.ipc.personSignIn(context.id, caller)
    fake.state.drive.people.set("peer", { user_id: "peer", name: "Peer", email: "peer@dynapps.test" })
    const made = await context.person.withPerson(context.id, (token) =>
      run(SpDrive.importFile(fake.url, token, { name: "Mine.md", bytes: new TextEncoder().encode("# Mine"), mime: "text/markdown" })),
    )
    setSystemTime(new Date(start + 610_000))
    if (browser) context.answer.browser = browser
    const calls = { count: 0 }
    const share = () =>
      context.person.withPerson(context.id, (token) => {
        calls.count++
        return run(SpDrive.share(fake.url, token, made.document.id, { kind: "user", value: "peer", level: "view" }))
      })
    return { context, calls, share, document: made.document.id }
  }

  test("sends the person through the browser again with max_age and retries once on return", async () => {
    const { context, calls, share, document } = await stale()

    expect(await share()).toBeString()
    expect(calls.count).toBe(2)
    expect(context.opened).toHaveLength(2)
    expect(new URL(context.opened[1] ?? "").searchParams.get("max_age")).toBe("600")
    expect(fake.state.drive.grants.get(document)).toHaveLength(1)
    expect(context.person.status(context.id).status).toBe("on")
    context.dispose()
  })

  test("cancelled or declined: the action fails with the reason, done once and not half done", async () => {
    const declined = await stale((link) => fake.personBrowser(link, { deny: true }))
    const refused = await declined.share().catch((error) => error)
    expect(refused).toBeInstanceOf(DynWorkPerson.SignInFailed)
    expect(refused).toMatchObject({ outcome: "denied" })
    expect(declined.calls.count).toBe(1)
    expect(fake.state.drive.grants.get(declined.document) ?? []).toEqual([])
    // The session itself goes on: only the action wanted more
    expect(declined.context.person.status(declined.context.id).status).toBe("on")
    declined.context.dispose()

    const cancelled = await stale(async () => {})
    const pending = cancelled.share().catch((error) => error)
    await until(() => cancelled.context.person.status(cancelled.context.id).status === "signingIn")
    cancelled.context.person.cancel()
    expect(await pending).toMatchObject({ outcome: "cancelled" })
    expect(cancelled.calls.count).toBe(1)
    expect(fake.state.drive.grants.get(cancelled.document) ?? []).toEqual([])
    cancelled.context.dispose()
  })
})

describe("signing out", () => {
  test("of the person's session: gone here and at the instance", async () => {
    const context = await stand()
    await context.ipc.personSignIn(context.id, caller)
    const refresh = [...fake.state.person.refresh.keys()][0] ?? ""

    await context.ipc.personSignOut(context.id, caller)
    expect(context.store.value.sessions).toEqual({})
    expect(context.person.status(context.id)).toEqual({ status: "off" })
    expect(fake.state.person.families.size).toBe(0)
    expect(await run(Effect.flip(SpPerson.refresh(fake.url, refresh)))).toMatchObject({ _tag: "Unauthorized" })
    context.dispose()
  })

  test("of the account, or removing it, clears the person's session too, revoked while the account still could", async () => {
    const signedOut = await stand()
    await signedOut.ipc.personSignIn(signedOut.id, caller)
    await signedOut.ipc.signOut(signedOut.id, caller)
    expect(signedOut.store.value.sessions).toEqual({})
    expect(fake.state.person.families.size).toBe(0)
    expect(
      await signedOut.person.withPerson(signedOut.id, async () => "ran").catch((error) => error),
    ).toBeInstanceOf(DynWorkPerson.SignedOut)
    signedOut.dispose()

    fake.state.person = startPerson()
    const removed = await stand()
    await removed.ipc.personSignIn(removed.id, caller)
    await removed.ipc.remove(removed.id, caller)
    expect(removed.store.value.sessions).toEqual({})
    expect(fake.state.person.families.size).toBe(0)
    removed.dispose()
  })

  test("an account signed out elsewhere loses its person's session at the next change", async () => {
    const context = await stand()
    await context.ipc.personSignIn(context.id, caller)
    context.accounts.signOut(context.id)
    context.person.reconcile()
    expect(context.store.value.sessions).toEqual({})
    expect(context.events.log.map((entry) => entry.data)).toContainEqual({ account: context.id, reason: "signed-out" })
    context.dispose()
  })
})

describe("an instance without DynWork's client", () => {
  test("stays as today: unavailable, nothing opened, no error and no session", async () => {
    fake.state.person.client = "none"
    const context = await stand()
    context.person.reconcile()
    await until(() => context.events.changed > 0)

    expect(context.person.status(context.id)).toEqual({ status: "unavailable" })
    expect(context.ipc.state(1).accounts[0]?.person).toEqual({ status: "unavailable" })
    expect(await context.ipc.personSignIn(context.id, caller)).toBe("unavailable")
    expect(context.opened).toEqual([])
    expect(context.events.log).toEqual([])
    expect(
      await context.person.withPerson(context.id, async () => "ran").catch((error) => error),
    ).toBeInstanceOf(DynWorkPerson.SignedOut)
    context.dispose()
  })

  test("a client that gives no UI session is not used, and reads as unavailable", async () => {
    fake.state.person.client = "plain"
    const context = await stand()

    expect(await context.ipc.personSignIn(context.id, caller)).toBe("unavailable")
    expect(context.store.value.sessions).toEqual({})
    expect(context.person.status(context.id)).toEqual({ status: "unavailable" })
    context.dispose()
  })

  test("with the client, an account shows off until the person signs in", async () => {
    const context = await stand()
    context.person.reconcile()
    await until(() => context.person.status(context.id).status === "off")
    expect(context.opened).toEqual([])
    context.dispose()
  })
})
