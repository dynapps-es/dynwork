import { afterAll, afterEach, beforeAll, describe, expect, jest, setSystemTime, test } from "bun:test"
import { SpClient } from "@dynwork/sp-client"
import { keyPair } from "../../../sp-client/test/fake"
import { DynWorkSyncClient } from "@dynwork/server-plugin/client"
import type { DynWorkSync } from "@dynwork/server-plugin/contract"
import { DynWorkAccounts } from "../../src/accounts/accounts"
import type { SyncStatus } from "../../src/accounts/contract"
import { DynWorkSyncMain } from "../../src/accounts/sync"
import { DynWorkSyncEngine } from "../../src/sync/engine"
import { fakeSecure, memoryStore, mints, startFake, until, type Fake } from "../accounts/fixture"

let alpha: Fake
let beta: Fake
const original: { alpha?: Record<string, unknown>; key?: ReturnType<typeof keyPair> } = {}

beforeAll(() => {
  alpha = startFake()
  beta = startFake()
  original.alpha = structuredClone(alpha.state.payload)
  original.key = alpha.state.key
})

afterAll(() => {
  alpha.stop()
  beta.stop()
})

const cleanups: Array<() => void> = []

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  alpha.state.override = undefined
  alpha.state.payload = structuredClone(original.alpha ?? {})
  if (original.key) alpha.state.key = original.key
  alpha.state.requests.length = 0
  beta.state.requests.length = 0
  jest.useRealTimers()
  setSystemTime()
})

// Just after the fixture manifest was stamped: its `not_before` is a minute old
const start = Date.parse("2026-11-01T09:12:31Z")
const version = (stamp: string) => `${stamp}-000001a19661c117`

// What the instance does on every response: a newer `manifest_version` and a `not_before` a minute ago, so a changed
// catalog is accepted however far the fake clock has moved. The fake instance itself stamps nothing.
const stamps = { count: 0 }
function serve(patch: Record<string, unknown> = {}) {
  stamps.count++
  alpha.state.payload = {
    ...alpha.state.payload,
    ...patch,
    manifest_version: version(new Date(Date.now() + stamps.count * 1000).toISOString()),
    not_before: new Date(Date.now() - 60_000).toISOString(),
  }
}
const counts = { skills: 3, agents: 1, mcp: 1, rules: 1 }

// Stands in for the plugin RPC: records every call, answers `apply` with counts, and holds the event stream open
// until the test closes it or the engine aborts it.
function fakePlugin() {
  const calls: Array<
    | { method: "apply"; input: Parameters<DynWorkSyncEngine.Plugin["apply"]>[0] }
    | { method: "token"; input: Parameters<DynWorkSyncEngine.Plugin["token"]>[0] }
    | { method: "clear" }
  > = []
  const stream: { handlers?: DynWorkSyncClient.Handlers; close: () => void; opened: number } = {
    close: () => {},
    opened: 0,
  }
  const answers = { apply: (): Promise<DynWorkSync.Applied> => Promise.resolve(counts), token: true }
  const plugin: DynWorkSyncEngine.Plugin = {
    apply: (input) => {
      calls.push({ method: "apply", input })
      return answers.apply()
    },
    token: async (input) => {
      calls.push({ method: "token", input })
      return answers.token
    },
    clear: async () => {
      calls.push({ method: "clear" })
    },
    listen: (handlers, signal) => {
      stream.handlers = handlers
      stream.opened++
      return new Promise<void>((resolve) => {
        stream.close = resolve
        signal.addEventListener("abort", () => resolve(), { once: true })
      })
    },
  }
  return { plugin, calls, stream, answers, applies: () => calls.filter((call) => call.method === "apply") }
}

// Main's wiring, as `accounts/main.ts` does it: the accounts tell the engine about each change and each new JWT.
async function boot(options: { focused?: boolean; instances?: Fake[]; store?: ReturnType<typeof memoryStore> } = {}) {
  jest.useFakeTimers()
  setSystemTime(new Date(start))
  const fake = fakePlugin()
  const statuses: SyncStatus[] = []
  const holder: { engine?: DynWorkSyncEngine.Engine } = {}
  const jwts = new Set<string>()
  const accounts = DynWorkAccounts.make({
    store: options.store ?? memoryStore(),
    secure: fakeSecure(),
    open: async () => {},
    deviceName: "DynWork test",
    changed: () => holder.engine?.update(),
    renewed: (id, session) => {
      jwts.add(session.token)
      holder.engine?.renewed(id, session)
    },
  })
  for (const instance of options.instances ?? [alpha])
    await accounts.signInToken({ url: instance.url, token: instance.issuePat() })
  const engine = DynWorkSyncEngine.make({
    accounts,
    plugin: fake.plugin,
    focused: options.focused ?? true,
    changed: (status) => statuses.push(status),
  })
  holder.engine = engine
  cleanups.push(() => {
    engine.dispose()
    accounts.dispose()
  })
  const id = accounts.active() ?? ""
  // This test's manifest requests: a poll a previous test left in flight carries another JWT.
  const polls = (instance: Fake) =>
    instance.state.requests.filter(
      (request) =>
        request.path === "/v1/bridge/manifest" &&
        jwts.has(request.headers.authorization?.replace(/^Bearer /, "") ?? ""),
    )
  return { ...fake, accounts, engine, statuses, id, polls }
}

// Runs the next due timer and returns how long after `from` it fell due.
function next(from = Date.now()) {
  jest.advanceTimersToNextTimer()
  return Date.now() - from
}

// Waits for the poll that a timer started to finish: the engine's status settles after the manifest answers.
async function settled(context: Awaited<ReturnType<typeof boot>>, count: number) {
  await until(() => context.statuses.filter((status) => status.status !== "syncing").length >= count)
  return context.statuses.at(-1)
}

// Nothing in flight: a few real event-loop turns with no new request.
async function drain() {
  for (const _ of Array.from({ length: 20 })) await new Promise((resolve) => setImmediate(resolve))
}

describe("cadence", () => {
  test("the first poll runs at once and the next within 30 s ± 20 % while focused", async () => {
    const context = await boot()
    expect(await settled(context, 1)).toEqual({ status: "synced", account: context.id, at: start, counts })
    expect(context.statuses[0]).toEqual({ status: "syncing", account: context.id })
    expect(context.polls(alpha)).toHaveLength(1)

    jest.advanceTimersByTime(23_999)
    await drain()
    expect(context.polls(alpha)).toHaveLength(1)
    jest.advanceTimersByTime(36_000 - 23_999)
    await until(() => context.polls(alpha).length === 2)
  })

  test("jitter keeps every gap within 24 to 36 s, and the gaps differ", async () => {
    const context = await boot()
    await settled(context, 1)
    const gaps = []
    for (const index of Array.from({ length: 8 }, (_, value) => value)) {
      gaps.push(next())
      await settled(context, index + 2)
    }
    expect(gaps.every((gap) => gap >= 24_000 && gap <= 36_000)).toBe(true)
    expect(new Set(gaps).size).toBeGreaterThan(1)
  })

  test("every 5 min while no window has focus, and at once when one gains it", async () => {
    const context = await boot({ focused: false })
    await settled(context, 1)
    expect(next()).toBe(300_000)
    await settled(context, 2)
    expect(context.polls(alpha)).toHaveLength(2)

    context.engine.focus(true)
    await settled(context, 3)
    expect(context.polls(alpha)).toHaveLength(3)
    expect(Date.now()).toBe(start + 300_000)
    const gap = next()
    expect(gap).toBeGreaterThanOrEqual(24_000)
    expect(gap).toBeLessThanOrEqual(36_000)
  })

  test("sync now polls at once and a focus event while polling runs one more poll, not two at once", async () => {
    const context = await boot()
    await settled(context, 1)
    context.engine.now()
    context.engine.now()
    await until(() => context.polls(alpha).length === 3)
    await settled(context, 3)
    await drain()
    expect(context.polls(alpha)).toHaveLength(3)
  })
})

describe("changes", () => {
  test("a 304 pushes nothing; a change pushes once; a re-signed copy of the same content pushes nothing", async () => {
    const context = await boot()
    await settled(context, 1)
    expect(context.applies()).toHaveLength(1)

    next()
    await settled(context, 2)
    expect(context.polls(alpha)[1]?.headers["if-none-match"]).toStartWith('"')
    expect(context.applies()).toHaveLength(1)

    serve({
      skills: [
        ...(alpha.state.payload.skills as unknown[]),
        { id: "fresh", name: "fresh", instructions: "New on the instance" },
      ],
    })
    next()
    await settled(context, 3)
    expect(context.applies()).toHaveLength(2)
    expect(context.applies()[1]?.input.manifest.skills.map((skill) => skill.id)).toContain("fresh")

    next()
    await settled(context, 4)
    expect(context.applies()).toHaveLength(2)

    // A new stamp changes the ETag but not the content the plugin gets
    serve({ issued_at: "2030-01-02T00:00:00Z" })
    next()
    await settled(context, 5)
    expect(context.applies()).toHaveLength(2)
    expect(context.statuses.at(-1)?.status).toBe("synced")
  })

  test("the first apply carries the JWT and the gateway models from the profile", async () => {
    const context = await boot()
    await settled(context, 1)
    const apply = context.applies()[0]?.input
    expect(apply?.account).toEqual({ label: "Dynapps", url: alpha.url })
    expect(apply?.jwt).toBe(await context.accounts.jwt(context.id))
    expect(apply?.expiresAt).toBe(start + 3_600_000)
    expect(apply?.profile?.models.length).toBeGreaterThan(0)
    expect(apply?.catalog?.length).toBeGreaterThan(0)
  })

  test("a manifest for another user, or not newer than the last applied, is refused and nothing is pushed", async () => {
    const context = await boot()
    await settled(context, 1)
    // The user the instance named at sign-in
    expect(context.accounts.stored(context.id)?.userId).toBe(String(original.alpha?.user_id))
    alpha.state.payload = { ...alpha.state.payload, user_id: "someone-else", skills: [] }
    next()
    expect(await settled(context, 2)).toEqual({ status: "error", account: context.id, kind: "invalid", at: Date.now() })

    alpha.state.payload = {
      ...structuredClone(original.alpha),
      manifest_version: version("2026-11-01T09:00:00Z"),
      skills: [],
    }
    next()
    expect(await settled(context, 3)).toMatchObject({ status: "error", kind: "invalid" })
    expect(context.applies()).toHaveLength(1)

    alpha.state.payload = structuredClone(original.alpha ?? {})
    next()
    expect(await settled(context, 4)).toMatchObject({ status: "synced" })
    expect(context.applies()).toHaveLength(1)
  })
})

describe("acceptance like the bridge", () => {
  const fixture = () => String(original.alpha?.manifest_version)

  test("the applied manifest_version is persisted and a manifest that is not newer is refused after a restart", async () => {
    const store = memoryStore()
    const first = await boot({ store })
    await settled(first, 1)
    expect(store.value.accounts[0]?.manifestVersion).toBe(fixture())
    cleanups.pop()?.()

    // The same version again (200, no ETag after a restart) is a replay
    const second = await boot({ store })
    expect(await settled(second, 1)).toMatchObject({ status: "error", kind: "invalid" })
    expect(second.applies()).toHaveLength(0)

    // A lower one too
    alpha.state.payload = { ...structuredClone(original.alpha), manifest_version: version("2026-11-01T09:00:00Z") }
    next()
    expect(await settled(second, 2)).toMatchObject({ status: "error", kind: "invalid" })
    expect(second.applies()).toHaveLength(0)

    // A newer one applies and moves the stored version
    alpha.state.payload = { ...structuredClone(original.alpha), manifest_version: version("2026-11-01T09:13:00Z") }
    next()
    expect(await settled(second, 3)).toMatchObject({ status: "synced" })
    expect(second.applies()).toHaveLength(1)
    expect(store.value.accounts[0]?.manifestVersion).toBe(version("2026-11-01T09:13:00Z"))
  })

  test("versions order by timestamp, then by the hex suffix", async () => {
    const store = memoryStore()
    const context = await boot({ store })
    await settled(context, 1)

    // Same second, a smaller suffix: not newer
    alpha.state.payload = {
      ...structuredClone(original.alpha),
      manifest_version: "2026-11-01T09:12:31Z-000001a19661c116",
    }
    next()
    expect(await settled(context, 2)).toMatchObject({ status: "error", kind: "invalid" })

    // Same second, a larger suffix: newer
    alpha.state.payload = {
      ...structuredClone(original.alpha),
      manifest_version: "2026-11-01T09:12:31Z-000001a19661c118",
    }
    next()
    expect(await settled(context, 3)).toMatchObject({ status: "synced" })
    expect(store.value.accounts[0]?.manifestVersion).toBe("2026-11-01T09:12:31Z-000001a19661c118")

    // A malformed version is refused too
    alpha.state.payload = { ...structuredClone(original.alpha), manifest_version: "yesterday-abc" }
    next()
    expect(await settled(context, 4)).toMatchObject({ status: "error", kind: "invalid" })
  })

  test("a not_before more than five minutes from now is refused, either way; four minutes passes", async () => {
    const store = memoryStore()
    const context = await boot({ store })
    await settled(context, 1)
    // Each is newer than the last applied one, so only the clock can refuse it
    const skewed = (minutes: number) => {
      serve()
      alpha.state.payload = {
        ...alpha.state.payload,
        not_before: new Date(Date.now() + minutes * 60_000).toISOString(),
      }
    }

    skewed(-6)
    next()
    expect(await settled(context, 2)).toMatchObject({ status: "error", kind: "invalid" })
    skewed(6)
    next()
    expect(await settled(context, 3)).toMatchObject({ status: "error", kind: "invalid" })
    expect(store.value.accounts[0]?.manifestVersion).toBe(fixture())
    expect(context.applies()).toHaveLength(1)

    skewed(-4)
    next()
    expect(await settled(context, 4)).toMatchObject({ status: "synced" })
    expect(store.value.accounts[0]?.manifestVersion).not.toBe(fixture())
  })

  test("a 304 skips both checks: its stored manifest is as old as its first acceptance", async () => {
    const context = await boot()
    await settled(context, 1)
    setSystemTime(new Date(start + 30 * 60_000))
    next()
    expect(await settled(context, 2)).toMatchObject({ status: "synced" })
    expect(context.polls(alpha)[1]?.headers["if-none-match"]).toStartWith('"')
    expect(context.applies()).toHaveLength(1)
  })

  test("only Sync now asks for a fresh build; polls and focus use the instance's memo", async () => {
    const context = await boot({ focused: false })
    await settled(context, 1)
    expect(context.polls(alpha)[0]?.headers["cache-control"]).toBeUndefined()

    next()
    await settled(context, 2)
    expect(context.polls(alpha)[1]?.headers["cache-control"]).toBeUndefined()

    context.engine.focus(true)
    await settled(context, 3)
    expect(context.polls(alpha)[2]?.headers["cache-control"]).toBeUndefined()

    context.engine.now()
    await settled(context, 4)
    expect(context.polls(alpha)[3]?.headers["cache-control"]).toBe("no-cache")

    // The freshness was for that one poll
    next()
    await settled(context, 5)
    expect(context.polls(alpha)[4]?.headers["cache-control"]).toBeUndefined()
  })
})

describe("failures", () => {
  test("an unreachable instance backs off 30 s, 1, 2, 4 min, capped at 5, and recovers", async () => {
    const context = await boot()
    await settled(context, 1)
    alpha.state.override = { path: "/v1/bridge/manifest", status: 503, body: { code: "down", message: "down" } }
    next()
    expect(await settled(context, 2)).toMatchObject({ status: "error", kind: "unreachable" })
    const gaps = []
    for (const index of [3, 4, 5, 6, 7]) {
      gaps.push(next())
      expect(await settled(context, index)).toMatchObject({ status: "error", kind: "unreachable" })
    }
    expect(gaps).toEqual([30_000, 60_000, 120_000, 240_000, 300_000])

    alpha.state.override = undefined
    next()
    expect(await settled(context, 8)).toMatchObject({ status: "synced" })
    const gap = next()
    expect(gap).toBeGreaterThanOrEqual(24_000)
    expect(gap).toBeLessThanOrEqual(36_000)
    // Nothing changed meanwhile: the recovery pushed nothing either
    expect(context.applies()).toHaveLength(1)
  })

  test("a rate-limited poll waits as long as the instance asks, within the cap", async () => {
    const context = await boot()
    await settled(context, 1)
    alpha.state.override = {
      path: "/v1/bridge/manifest",
      status: 429,
      body: { code: "rate_limited", message: "slow down" },
      headers: { "retry-after": "120" },
    }
    next()
    expect(await settled(context, 2)).toMatchObject({ status: "error", kind: "rate-limited" })
    expect(next()).toBe(120_000)
  })

  test("a service that does not take the apply is retried soon, then synced", async () => {
    const context = await boot()
    context.answers.apply = () => Promise.reject(new DynWorkSyncClient.Failed("apply", 0))
    expect(await settled(context, 1)).toMatchObject({ status: "error", kind: "service" })
    expect(next()).toBe(2_000)
    expect(await settled(context, 2)).toMatchObject({ status: "error", kind: "service" })
    context.answers.apply = () => Promise.resolve(counts)
    expect(next()).toBe(4_000)
    expect(await settled(context, 3)).toMatchObject({ status: "synced", counts })
  })

  test("a rotated manifest key stops the sync until the user trusts it", async () => {
    const context = await boot()
    await settled(context, 1)
    const rotated = keyPair()
    alpha.state.key = rotated
    serve({ skills: [] })
    next()
    expect(await settled(context, 2)).toMatchObject({ status: "error", kind: "key-changed" })
    const account = context.accounts.list()[0]
    expect(account).toMatchObject({ trusted: false })
    expect(account?.fingerprint).toBe(SpClient.fingerprint(rotated.public))

    jest.advanceTimersByTime(3_600_000)
    await drain()
    expect(context.polls(alpha)).toHaveLength(2)
    expect(context.calls.filter((call) => call.method === "clear")).toHaveLength(0)
    expect(context.applies()).toHaveLength(1)

    // An hour later the instance stamps a new response
    serve()
    context.accounts.trust({ id: context.id, fingerprint: account?.fingerprint ?? "" })
    expect(await settled(context, 3)).toMatchObject({ status: "synced" })
    expect(context.applies().at(-1)?.input.manifest.skills).toEqual([])
  })
})

describe("switching and signing out", () => {
  test("activating another instance stops the previous loop, clears it and syncs the new one at once", async () => {
    const context = await boot({ instances: [alpha, beta] })
    await settled(context, 1)
    const other = context.accounts.list().find((account) => account.url === beta.url)?.id ?? ""
    context.accounts.activate(other)
    expect(await settled(context, 2)).toMatchObject({ status: "synced", account: other })
    expect(context.calls.map((call) => call.method)).toEqual(["apply", "clear", "apply"])
    expect(context.applies()[1]?.input.account.url).toBe(beta.url)

    const before = context.polls(alpha).length
    jest.advanceTimersByTime(600_000)
    await until(() => context.polls(beta).length >= 2)
    await drain()
    expect(context.polls(alpha)).toHaveLength(before)
  })

  test("signing out clears the plugin and stops polling", async () => {
    const context = await boot()
    await settled(context, 1)
    context.accounts.signOut(context.id)
    expect(context.statuses.at(-1)).toEqual({ status: "idle" })
    await until(() => context.calls.some((call) => call.method === "clear"))
    jest.advanceTimersByTime(600_000)
    await drain()
    expect(context.polls(alpha)).toHaveLength(1)
  })
})

describe("the gateway's JWT", () => {
  test("every renewal reaches the plugin once", async () => {
    const context = await boot()
    await settled(context, 1)
    const first = context.applies()[0]?.input.jwt
    jest.advanceTimersByTime(3_600_000 * DynWorkAccounts.renewAt)
    await until(() => context.calls.some((call) => call.method === "token"))
    const pushed = context.calls.flatMap((call) => (call.method === "token" ? [call.input] : []))
    expect(pushed).toHaveLength(1)
    expect(pushed[0]?.jwt).not.toBe(first)
    expect(pushed[0]?.jwt).toBe(await context.accounts.jwt(context.id))
    expect(pushed[0]?.account.url).toBe(alpha.url)
  })

  test("a refused JWT is answered with a new mint, not the cached one; a second refusal signs out", async () => {
    const context = await boot()
    await settled(context, 1)
    const before = mints(alpha)
    const held = await context.accounts.jwt(context.id)
    context.stream.handlers?.refresh?.({ instance: "someone-else", reason: "rejected" })
    context.stream.handlers?.refresh?.({ instance: DynWorkSyncMain.key("Dynapps"), reason: "rejected" })
    await until(() => context.calls.some((call) => call.method === "token"))
    expect(mints(alpha)).toBe(before + 1)
    const pushed = context.calls.find((call) => call.method === "token")
    expect(pushed?.method === "token" && pushed.input.jwt).not.toBe(held)

    context.stream.handlers?.rejected?.({ instance: DynWorkSyncMain.key("Dynapps") })
    await until(() => context.accounts.list()[0]?.status === "signedOut")
    await until(() => context.calls.some((call) => call.method === "clear"))
    expect(context.statuses.at(-1)).toEqual({ status: "idle" })
  })

  test("a token the plugin refuses means it lost the instance: it is applied again", async () => {
    const context = await boot()
    await settled(context, 1)
    context.answers.token = false
    context.stream.handlers?.refresh?.({ instance: DynWorkSyncMain.key("Dynapps"), reason: "rejected" })
    await until(() => context.applies().length === 2)
  })

  test("when the event stream ends, the engine follows it again and applies the instance again", async () => {
    const context = await boot()
    await settled(context, 1)
    expect(context.stream.opened).toBe(1)
    context.stream.close()
    await until(() => context.applies().length === 2)
    jest.advanceTimersByTime(DynWorkSyncEngine.resubscribeAfter)
    await until(() => context.stream.opened === 2)
  })
})

describe("bundle files", () => {
  test("an apply carries the bundle files main fetched, and a plugin whose files change is applied again", async () => {
    cleanups.push(() => (alpha.state.files = {}))
    const plugin = (text: string) => ({
      id: "kit",
      files: [{ path: "agents/helper.md", sha256: new Bun.CryptoHasher("sha256").update(text).digest("hex") }],
    })
    const context = await boot()
    await settled(context, 1)
    alpha.state.files["kit/agents/helper.md"] = "# Helper"
    serve({ plugins: [plugin("# Helper")] })
    next()
    await settled(context, 2)
    expect(context.applies()).toHaveLength(2)
    expect(context.applies()[1]?.input.files).toEqual([
      { plugin: "kit", path: "agents/helper.md", content: Buffer.from("# Helper").toString("base64") },
    ])

    alpha.state.files["kit/agents/helper.md"] = "# Helper v2"
    serve({ plugins: [plugin("# Helper v2")] })
    next()
    await settled(context, 3)
    expect(context.applies()).toHaveLength(3)
    expect(context.applies()[2]?.input.files).toEqual([
      { plugin: "kit", path: "agents/helper.md", content: Buffer.from("# Helper v2").toString("base64") },
    ])
  })
})
