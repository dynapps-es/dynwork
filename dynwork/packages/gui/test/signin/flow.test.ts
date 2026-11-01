import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import { SignInAccounts } from "../../src/signin/accounts"
import { SignInFlow } from "../../src/signin/flow"

beforeEach(() => {
  jest.useFakeTimers()
  localStorage.clear()
  sessionStorage.clear()
})

afterEach(() => {
  jest.useRealTimers()
})

// The mock chains timers through promises, so time moves in small steps with the microtasks drained in between.
async function elapse(ms: number) {
  for (const _ of Array.from({ length: Math.ceil(ms / 25) })) {
    jest.advanceTimersByTime(25)
    for (const _ of Array.from({ length: 10 })) await Promise.resolve()
  }
}

async function connected() {
  const flow = SignInFlow.create(SignInAccounts.mock())

  flow.input("https://sp.example.com")
  await elapse(500 + 600)

  return flow
}

describe("instance URL", () => {
  test.each([
    { value: "https://sp.example.com", host: "sp.example.com" },
    { value: "  http://localhost:4096/  ", host: "localhost:4096" },
    { value: "sp.example.com", host: undefined },
    { value: "ftp://sp.example.com", host: undefined },
    { value: "https://", host: undefined },
    { value: "", host: undefined },
  ])("$value parses to host $host", (row) => {
    expect(SignInAccounts.parseURL(row.value)?.host).toBe(row.host)
  })

  test("settles after idle typing, checks, then reports the host", async () => {
    const flow = SignInFlow.create(SignInAccounts.mock())

    expect(flow.state.status).toBe("empty")
    flow.input("https://sp.example.com")
    expect(flow.state.status).toBe("typing")
    await elapse(475)
    expect(flow.state.status).toBe("typing")
    await elapse(50)
    expect(flow.state.status).toBe("checking")
    await elapse(600)
    expect(flow.state.status).toBe("valid")
    expect(flow.state.host).toBe("sp.example.com")
  })

  test("blur settles at once and a non-http URL is invalid", async () => {
    const flow = SignInFlow.create(SignInAccounts.mock())

    flow.input("sp.example.com")
    void flow.settle()
    expect(flow.state.status).toBe("checking")
    await elapse(600)
    expect(flow.state.status).toBe("invalid")
  })

  test("an edit during the check discards its answer", async () => {
    const flow = SignInFlow.create(SignInAccounts.mock())

    flow.input("https://sp.example.com")
    void flow.settle()
    await elapse(300)
    flow.input("sp.example")
    await elapse(300)
    expect(flow.state.status).toBe("typing")
    await elapse(200 + 600)
    expect(flow.state.status).toBe("invalid")
  })

  test("clearing the field shows the empty status", async () => {
    const flow = await connected()

    flow.input("  ")
    expect(flow.state.status).toBe("empty")
    await elapse(1200)
    expect(flow.state.status).toBe("empty")
  })
})

describe("sign in", () => {
  test("the browser sign-in waits for a reachable URL", async () => {
    const flow = SignInFlow.create(SignInAccounts.mock())

    flow.input("sp.example.com")
    await elapse(1100)
    void flow.signInBrowser()
    expect(flow.state.pending).toBeUndefined()
    await elapse(2000)
    expect(flow.state.step).toBe("connect")
  })

  test("the browser sign-in moves to the instance list with the first one selected", async () => {
    const flow = await connected()

    void flow.signInBrowser()
    expect(flow.state.pending).toBe("browser")
    await elapse(1975)
    expect(flow.state.step).toBe("connect")
    await elapse(50)
    expect(flow.state.step).toBe("choose")
    expect(flow.state.pending).toBeUndefined()
    expect(flow.state.instances).toEqual(SignInAccounts.instances)
    expect(flow.selected()).toEqual(SignInAccounts.instances[0])
  })

  test("cancel returns to idle and the browser answer never lands", async () => {
    const flow = await connected()

    void flow.signInBrowser()
    await elapse(1000)
    flow.cancel()
    expect(flow.state.pending).toBeUndefined()
    await elapse(3000)
    expect(flow.state.step).toBe("connect")
    expect(flow.state.status).toBe("valid")
  })

  test("an empty token is an error and starts nothing", async () => {
    const flow = await connected()

    flow.token("   ")
    void flow.signInToken()
    expect(flow.state.tokenError).toBe(true)
    expect(flow.state.pending).toBeUndefined()
    flow.token("sp-live-123")
    expect(flow.state.tokenError).toBe(false)
  })

  test("a token connects in about a second", async () => {
    const flow = await connected()

    flow.token("sp-live-123")
    void flow.signInToken()
    expect(flow.state.pending).toBe("token")
    await elapse(1025)
    expect(flow.state.step).toBe("choose")
  })

  test("back returns to the connect step", async () => {
    const flow = await connected()

    void flow.signInBrowser()
    await elapse(2025)
    flow.select("demo")
    flow.back()
    expect(flow.state.step).toBe("connect")
    expect(flow.state.pending).toBeUndefined()
    expect(flow.state.status).toBe("valid")
  })
})

describe("finish", () => {
  test("syncs the selected instance and finishes", async () => {
    const flow = await connected()

    void flow.signInBrowser()
    await elapse(2025)
    flow.select("demo")
    void flow.finish()
    expect(flow.state.step).toBe("finalizing")
    await elapse(750)
    expect(flow.state.synced).toBe(3)
    expect(flow.state.step).toBe("finalizing")
    await elapse(775)
    expect(flow.state.synced).toBe(6)
    expect(flow.state.step).toBe("done")
  })

  test("leaves nothing in the renderer's storage", async () => {
    const flow = await connected()

    void flow.signInBrowser()
    await elapse(2025)
    void flow.finish()
    await elapse(1600)
    expect(flow.state.step).toBe("done")
    expect(localStorage.length + sessionStorage.length).toBe(0)
  })
})

// A mock whose sign-in answers are chosen by the test, and that records what the flow asked.
function scripted(answer: SignInAccounts.SignIn) {
  const calls: unknown[][] = []
  const accounts: SignInAccounts.Interface = {
    ...SignInAccounts.mock(),
    probe: async () => ({ reachable: true, host: "sp.example.com", login: "https://sp.example.com/device" }),
    signInBrowser: async (...args) => (calls.push(["browser", ...args]), answer),
    signInToken: async (...args) => (calls.push(["token", ...args]), answer),
  }

  return { accounts, calls }
}

async function settled(accounts: SignInAccounts.Interface) {
  const flow = SignInFlow.create(accounts)

  flow.input("https://sp.example.com")
  await flow.settle()
  await elapse(500)

  return flow
}

describe("keep me signed in", () => {
  test.each([true, false])("passes keep=%p to both sign-ins", async (keep) => {
    const browser = scripted("cancelled")
    const flow = await settled(browser.accounts)

    flow.keep(keep)
    await flow.signInBrowser()
    flow.token(" sp-live-1 ")
    await flow.signInToken()
    expect(browser.calls).toEqual([
      ["browser", "https://sp.example.com", keep],
      ["token", "https://sp.example.com", "sp-live-1", keep],
    ])
  })
})

describe("failed sign-ins", () => {
  test.each([
    "denied",
    "expired",
    "unreachable",
    "refused",
    "rate-limited",
    "incompatible",
    "insecure",
    "failed",
  ] as const)("the browser sign-in answering %s shows it and stays on step 1", async (kind) => {
    const flow = await settled(scripted(kind).accounts)

    await flow.signInBrowser()
    expect(flow.state.error).toEqual({ from: "browser", kind })
    expect(flow.state.pending).toBeUndefined()
    expect(flow.state.step).toBe("connect")
  })

  test("a refused token shows under the token field, and typing clears it", async () => {
    const flow = await settled(scripted("refused").accounts)

    flow.token("sp-live-bad")
    await flow.signInToken()
    expect(flow.state.error).toEqual({ from: "token", kind: "refused" })
    expect(flow.state.pending).toBeUndefined()
    flow.token("sp-live-bad2")
    expect(flow.state.error).toBeUndefined()
  })

  test("a new attempt clears the previous failure", async () => {
    const answers = ["denied", "cancelled"] as const
    const calls = { count: 0 }
    const flow = await settled({
      ...scripted("failed").accounts,
      signInBrowser: async () => answers[calls.count++] ?? "cancelled",
    })

    await flow.signInBrowser()
    expect(flow.state.error?.kind).toBe("denied")
    void flow.signInBrowser()
    expect(flow.state.error).toBeUndefined()
  })

  test("the instance's login page and the problem come from the probe", async () => {
    const flow = await settled(scripted("failed").accounts)

    expect(flow.state.login).toBe("https://sp.example.com/device")
    const down = await settled({
      ...scripted("failed").accounts,
      probe: async () => ({ reachable: false, reason: "unreachable" }),
    })
    expect(down.state.status).toBe("invalid")
    expect(down.state.problem).toBe("unreachable")
    expect(down.state.login).toBeUndefined()
  })
})
