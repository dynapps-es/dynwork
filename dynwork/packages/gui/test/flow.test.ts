import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import { SignInAccounts } from "../src/signin/accounts"
import { SignInFlag } from "../src/signin/flag"
import { SignInFlow } from "../src/signin/flow"

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
  test.each([
    { keep: true, kept: localStorage, dropped: sessionStorage },
    { keep: false, kept: sessionStorage, dropped: localStorage },
  ])("syncs the selected instance, then stores the flag (keep $keep)", async (row) => {
    const flow = await connected()

    flow.keep(row.keep)
    void flow.signInBrowser()
    await elapse(2025)
    flow.select("demo")
    expect(SignInFlag.signedIn()).toBe(false)
    void flow.finish()
    expect(flow.state.step).toBe("finalizing")
    await elapse(750)
    expect(flow.state.synced).toBe(3)
    expect(SignInFlag.signedIn()).toBe(false)
    await elapse(775)
    expect(flow.state.synced).toBe(6)
    expect(flow.state.step).toBe("done")
    expect(SignInFlag.signedIn()).toBe(true)
    expect(row.dropped.getItem("dynwork-signin")).toBeNull()
    expect(JSON.parse(row.kept.getItem("dynwork-signin") ?? "")).toEqual({
      url: "https://sp.example.com",
      instance: { id: "demo", name: "Demo", host: "demo.sp.dynapps.es" },
    })
  })
})
