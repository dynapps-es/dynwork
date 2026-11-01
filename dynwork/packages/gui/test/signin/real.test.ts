import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { DynWorkAccounts } from "../../src/accounts/accounts"
import { AccountsIpc } from "../../src/accounts/ipc"
import { SignInFlow } from "../../src/signin/flow"
import { SignInReal } from "../../src/signin/real"
import { setup, startFake, until, type Fake } from "../accounts/fixture"

let alpha: Fake

beforeAll(() => {
  alpha = startFake()
})

afterAll(() => {
  alpha.stop()
})

// The Ipc client a window gets, over the real accounts service and the real Ipc implementation, without Electron.
function windowClient(accounts: DynWorkAccounts.Accounts): SignInReal.Accounts {
  const impl = AccountsIpc.implementation(accounts)
  const caller = { window: 1, signal: new AbortController().signal }

  return {
    probe: async (url) => impl.probe(url, caller),
    signInBrowser: async (input) => impl.signInBrowser(input, caller),
    signInToken: async (input) => impl.signInToken(input, caller),
    cancel: async () => impl.cancel(undefined, caller),
    list: async () => impl.list(undefined, caller),
    summary: async (id) => impl.summary(id, caller),
    activate: async (id) => impl.activate(id, caller),
  }
}

function screen(options?: Parameters<typeof setup>[1]) {
  const context = setup(alpha, options)
  const flow = SignInFlow.create(SignInReal.create(windowClient(context.accounts)))

  return { ...context, flow }
}

async function connect(flow: ReturnType<typeof screen>["flow"], url = alpha.url) {
  flow.input(url)
  await flow.settle()
  await until(() => flow.state.status === "valid" || flow.state.status === "invalid")
}

const counts = () => ({
  skills: (alpha.state.payload.skills as unknown[]).length,
  agents: (alpha.state.payload.agents as unknown[]).length,
  servers: (alpha.state.payload.managed_mcp_servers as unknown[]).length,
})

describe("step 1 on the real accounts", () => {
  test("a reachable instance is valid, with its host and its one-time code page", async () => {
    const { flow, accounts } = screen()

    await connect(flow)
    expect(flow.state.status).toBe("valid")
    expect(flow.state.host).toBe(new URL(alpha.url).host)
    expect(flow.state.login).toBe(`${alpha.url}/bridge-auth/device-link`)
    accounts.dispose()
  })

  test.each([
    { url: "sp.example.com", problem: "format" },
    { url: "http://127.0.0.1:1", problem: "unreachable" },
  ])("$url is invalid as $problem", async (row) => {
    const { flow, accounts } = screen()

    await connect(flow, row.url)
    expect(flow.state.status).toBe("invalid")
    expect(flow.state.problem).toBe(row.problem)
    accounts.dispose()
  })

  test("a server that answers with something that is not systemprompt reads as not supported", async () => {
    const fake = startFake()
    fake.state.override = { status: 200, body: { hello: "world" } }
    const context = setup(fake)
    const flow = SignInFlow.create(SignInReal.create(windowClient(context.accounts)))

    flow.input(fake.url)
    await flow.settle()
    await until(() => flow.state.status === "invalid")
    expect(flow.state.problem).toBe("incompatible")
    context.accounts.dispose()
    fake.stop()
  })
})

describe("signing in on the real accounts", () => {
  test("a PAT signs in, lists the instance with its first manifest's counts, and finishes active", async () => {
    const { flow, accounts, store } = screen()

    await connect(flow)
    flow.token(alpha.issuePat())
    await flow.signInToken()
    expect(flow.state.step).toBe("choose")
    expect(flow.state.instances).toEqual([
      expect.objectContaining({ name: "Dynapps", host: new URL(alpha.url).host, ...counts() }),
    ])
    expect(flow.selected()?.id).toBe(accounts.list()[0]?.id)
    await flow.finish()
    expect(flow.state.step).toBe("done")
    expect(flow.state.synced).toBe(counts().skills)
    expect(accounts.list()).toMatchObject([{ status: "signedIn", active: true }])
    expect(JSON.stringify(store.value)).not.toContain("sp-live-")
    accounts.dispose()
  })

  test("a refused token is an error under the field and stores nothing", async () => {
    const { flow, accounts } = screen()

    await connect(flow)
    flow.token("sp-live-not-a-token")
    await flow.signInToken()
    expect(flow.state.error).toEqual({ from: "token", kind: "refused" })
    expect(flow.state.step).toBe("connect")
    expect(accounts.list()).toEqual([])
    accounts.dispose()
  })

  test("a one-time code pasted into the token field signs in", async () => {
    const { flow, accounts } = screen()

    await connect(flow)
    flow.token(alpha.issueCode())
    await flow.signInToken()
    expect(flow.state.step).toBe("choose")
    accounts.dispose()
  })

  test("the browser sign-in opens the device link and lands on the instance list", async () => {
    const opened: string[] = []
    const { flow, accounts } = screen({
      open: async (link) => {
        opened.push(link)
        const redirect = new URL(new URL(link).searchParams.get("redirect") ?? "")
        redirect.searchParams.set("code", alpha.issueCode())
        void fetch(redirect)
      },
    })

    await connect(flow)
    await flow.signInBrowser()
    expect(opened).toHaveLength(1)
    expect(flow.state.step).toBe("choose")
    expect(flow.state.instances).toHaveLength(1)
    accounts.dispose()
  })

  test("declining in the browser shows it", async () => {
    const { flow, accounts } = screen({
      open: async (link) => {
        const redirect = new URL(new URL(link).searchParams.get("redirect") ?? "")
        redirect.searchParams.set("error", "denied")
        void fetch(redirect)
      },
    })

    await connect(flow)
    await flow.signInBrowser()
    expect(flow.state.error).toEqual({ from: "browser", kind: "denied" })
    expect(flow.state.step).toBe("connect")
    accounts.dispose()
  })

  test("cancel ends the wait and the browser answer never lands", async () => {
    const { flow, accounts } = screen()

    await connect(flow)
    const pending = flow.signInBrowser()
    await until(() => accounts.state().signingIn !== undefined)
    expect(flow.state.pending).toBe("browser")
    flow.cancel()
    expect(flow.state.pending).toBeUndefined()
    await pending
    await until(() => accounts.state().signingIn === undefined)
    expect(flow.state.step).toBe("connect")
    expect(flow.state.error).toBeUndefined()
    accounts.dispose()
  })

  test("no secure storage is named as such, before any request", async () => {
    const { fakeSecure } = await import("../accounts/fixture")
    const { flow, accounts } = screen({ secure: fakeSecure(false) })
    const before = alpha.state.requests.length

    await connect(flow)
    flow.token(alpha.issuePat())
    await flow.signInToken()
    expect(flow.state.error).toEqual({ from: "token", kind: "insecure" })
    expect(alpha.state.requests.slice(before).every((request) => request.path !== "/v1/auth/bridge/pat")).toBe(true)
    accounts.dispose()
  })
})

describe("keep me signed in", () => {
  test("unchecked, the PAT never reaches the store: signed in now, signed out after a restart", async () => {
    const { flow, accounts, store, secure } = screen()
    const pat = alpha.issuePat()

    await connect(flow)
    flow.keep(false)
    flow.token(pat)
    await flow.signInToken()
    await flow.finish()
    const id = accounts.list()[0]?.id ?? ""
    expect(accounts.list()).toMatchObject([{ status: "signedIn", active: true }])
    expect(await accounts.jwt(id)).toBeString()
    expect(JSON.stringify(store.disk.json)).not.toContain("patCipher")
    expect(store.disk.json).not.toContain(Buffer.from(secure.encryptString(pat)).toString("base64"))
    accounts.dispose()

    const restarted = DynWorkAccounts.make({
      store,
      secure,
      open: async () => {},
      deviceName: "DynWork test",
      changed: () => {},
    })
    expect(restarted.list()).toMatchObject([{ id, status: "signedOut" }])
    await expect(restarted.jwt(id)).rejects.toBeInstanceOf(DynWorkAccounts.NotSignedIn)
    restarted.dispose()
  })

  test("checked, the sealed PAT is stored and survives a restart", async () => {
    const { flow, accounts, store, secure } = screen()

    await connect(flow)
    flow.token(alpha.issuePat())
    await flow.signInToken()
    const id = accounts.list()[0]?.id ?? ""
    accounts.dispose()
    const restarted = DynWorkAccounts.make({
      store,
      secure,
      open: async () => {},
      deviceName: "DynWork test",
      changed: () => {},
    })
    expect(restarted.list()).toMatchObject([{ id, status: "signedIn", active: true }])
    expect(await restarted.jwt(id)).toBeString()
    restarted.dispose()
  })

  test("unchecked keeps the session renewing, and signing out forgets the in-memory PAT", async () => {
    const { flow, accounts } = screen()

    await connect(flow)
    flow.keep(false)
    flow.token(alpha.issuePat())
    await flow.signInToken()
    const id = accounts.list()[0]?.id ?? ""
    accounts.signOut(id)
    expect(accounts.list()).toMatchObject([{ status: "signedOut", active: false }])
    await expect(accounts.jwt(id)).rejects.toBeInstanceOf(DynWorkAccounts.NotSignedIn)
    accounts.dispose()
  })
})
