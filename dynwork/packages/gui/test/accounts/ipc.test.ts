import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { SpClient } from "@dynwork/sp-client"
import { DynWorkAccounts } from "../../src/accounts/accounts"
import { AccountsIpc } from "../../src/accounts/ipc"
import { setup, startFake, fakeSecure, type Fake } from "./fixture"

let alpha: Fake

beforeAll(() => {
  alpha = startFake()
})

afterAll(() => {
  alpha.stop()
})

const caller = { window: 1, signal: new AbortController().signal }

const request = { endpoint: "POST /x", message: "no" }

// An engine with no active instance, for the tests that do not sync.
const idle = { status: () => ({ status: "idle" as const }), now: () => {} }

describe("sign-in failures over the Ipc", () => {
  test.each([
    { error: new SpClient.Unreachable(request), kind: "unreachable" },
    { error: new SpClient.Unauthorized(request), kind: "refused" },
    { error: new SpClient.RateLimited(request), kind: "rate-limited" },
    { error: new SpClient.Incompatible({ ...request, supported: "1", found: "2" }), kind: "incompatible" },
    { error: new SpClient.Protocol(request), kind: "incompatible" },
    { error: new DynWorkAccounts.SecureStorageUnavailable(), kind: "insecure" },
    { error: new SpClient.SignatureInvalid(request), kind: "failed" },
    { error: new Error("boom"), kind: "failed" },
    { error: "not even an error", kind: "failed" },
  ])("$kind", (row) => {
    expect(AccountsIpc.failure(row.error)).toBe(row.kind)
  })

  test("a refused PAT and a dead instance answer instead of rejecting, with nothing stored", async () => {
    const context = setup(alpha)
    const impl = AccountsIpc.implementation(context.accounts, idle)

    expect(await impl.signInToken({ url: alpha.url, token: "sp-live-nope" }, caller)).toBe("refused")
    expect(await impl.signInToken({ url: "http://127.0.0.1:1", token: "sp-live-nope" }, caller)).toBe("unreachable")
    expect(context.accounts.list()).toEqual([])
    context.accounts.dispose()
  })

  test("without OS encryption the browser sign-in answers insecure and opens nothing", async () => {
    const opened: string[] = []
    const context = setup(alpha, { secure: fakeSecure(false), open: async (link) => void opened.push(link) })
    const impl = AccountsIpc.implementation(context.accounts, idle)

    expect(await impl.signInBrowser({ url: alpha.url }, caller)).toBe("insecure")
    expect(opened).toEqual([])
    context.accounts.dispose()
  })
})

describe("summary", () => {
  test("counts the first manifest, verified against the key the account was offered", async () => {
    const context = setup(alpha)
    const impl = AccountsIpc.implementation(context.accounts, idle)

    await impl.signInToken({ url: alpha.url, token: alpha.issuePat() }, caller)
    const id = context.accounts.list()[0]?.id ?? ""
    expect(await impl.summary(id, caller)).toMatchObject({
      skills: (alpha.state.payload.skills as unknown[]).length,
      agents: (alpha.state.payload.agents as unknown[]).length,
      servers: (alpha.state.payload.managed_mcp_servers as unknown[]).length,
    })
    context.accounts.dispose()
  })

  test("a manifest signed by another key is not counted", async () => {
    const fake = startFake()
    const context = setup(fake)
    const impl = AccountsIpc.implementation(context.accounts, idle)

    await impl.signInToken({ url: fake.url, token: fake.issuePat() }, caller)
    const id = context.accounts.list()[0]?.id ?? ""
    fake.state.signer = (await import("../../../sp-client/test/fake")).keyPair()
    await expect(impl.summary(id, caller)).rejects.toBeInstanceOf(SpClient.SignatureInvalid)
    context.accounts.dispose()
    fake.stop()
  })

  test("an account that is not signed in has none", async () => {
    const context = setup(alpha)
    const impl = AccountsIpc.implementation(context.accounts, idle)

    await expect(impl.summary("missing", caller)).rejects.toBeInstanceOf(DynWorkAccounts.NotSignedIn)
    context.accounts.dispose()
  })
})

describe("sync over the Ipc", () => {
  test("the state carries the engine's status, and syncNow polls", async () => {
    const context = setup(alpha)
    const engine = {
      polls: 0,
      status: () => ({
        status: "synced" as const,
        account: "a",
        at: 1,
        counts: { skills: 1, agents: 0, mcp: 0, rules: 0 },
      }),
      now: () => {
        engine.polls++
      },
    }
    const impl = AccountsIpc.implementation(context.accounts, engine)

    expect(impl.state(1)).toEqual({ accounts: [], signingIn: undefined, sync: engine.status() })
    await impl.syncNow(undefined, caller)
    expect(engine.polls).toBe(1)
    context.accounts.dispose()
  })
})
