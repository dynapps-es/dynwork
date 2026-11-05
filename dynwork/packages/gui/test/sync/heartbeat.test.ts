import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { SpConsumer } from "@dynwork/sp-client"
import type { DynWorkSync } from "@dynwork/server-plugin/contract"
import { DynWorkHeartbeat } from "../../src/sync/heartbeat"
import { setup, startFake, type Fake } from "../accounts/fixture"

// The heartbeat on the real accounts against the fake instance, which answers `/v1/bridge/heartbeat` as 0.76 does:
// the session must be the JWT's. The service's totals come from a stand-in for the plugin's `usage`.

let fake: Fake

beforeAll(() => {
  fake = startFake()
})

afterAll(() => fake.stop())

const cleanups: Array<() => void> = []

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  fake.state.override = undefined
  fake.state.heartbeats.length = 0
})

async function boot(usage: () => Promise<DynWorkSync.Usage>) {
  const signed = setup(fake)
  const logged: Array<{ level: string; message: string }> = []
  const heartbeat = DynWorkHeartbeat.make({
    accounts: signed.accounts,
    plugin: { usage },
    version: "2.2.5",
    hostname: " studio.local ",
    platform: "darwin",
    log: (level, message) => logged.push({ level, message }),
  })
  cleanups.push(() => {
    heartbeat.dispose()
    signed.accounts.dispose()
  })
  return { ...signed, heartbeat, logged }
}

const signIn = async (accounts: Awaited<ReturnType<typeof boot>>["accounts"]) => {
  await accounts.signInToken({ url: fake.url, token: fake.issuePat() })
  return accounts.active() ?? ""
}

test("reports the service's totals with the JWT's session, as the bridge does", async () => {
  const at = Date.parse("2026-11-02T09:30:00.000Z")
  const booted = await boot(async () => ({ forwarded: 4, tokens_in: 1200, tokens_out: 300, last_activity: at }))
  const id = await signIn(booted.accounts)
  await booted.heartbeat.tick()
  const session = await booted.accounts.session(id)
  expect(fake.state.heartbeats).toEqual([
    {
      session_id: session.sessionId,
      bridge_version: SpConsumer.bridgeVersion,
      os: "macos",
      hostname: "studio.local",
      last_activity_at: "2026-11-02T09:30:00.000Z",
      forwarded_total: 4,
      tokens_in_total: 1200,
      tokens_out_total: 300,
      release_version: "2.2.5",
      state: "active",
    },
  ])
  expect(booted.logged).toEqual([])
})

test("nothing is sent while no account is signed in, and the pause is logged once", async () => {
  const booted = await boot(async () => ({ forwarded: 0, tokens_in: 0, tokens_out: 0 }))
  await booted.heartbeat.tick()
  await booted.heartbeat.tick()
  expect(fake.state.heartbeats).toEqual([])
  expect(booted.logged).toEqual([
    { level: "info", message: "systemprompt heartbeat paused until an account is signed in" },
  ])
  const id = await signIn(booted.accounts)
  booted.accounts.signOut(id)
  await booted.heartbeat.tick()
  expect(fake.state.heartbeats).toEqual([])
})

test("a service that does not answer reports what it counted last, and before that zeros", async () => {
  const answers: Array<DynWorkSync.Usage | undefined> = [
    undefined,
    { forwarded: 2, tokens_in: 10, tokens_out: 5 },
    undefined,
  ]
  const booted = await boot(async () => {
    const next = answers.shift()
    if (next === undefined) throw new Error("the service is restarting")
    return next
  })
  await signIn(booted.accounts)
  await booted.heartbeat.tick()
  await booted.heartbeat.tick()
  await booted.heartbeat.tick()
  expect(fake.state.heartbeats.map((entry) => [entry.forwarded_total, entry.last_activity_at])).toEqual([
    [0, null],
    [2, null],
    [2, null],
  ])
})

test("a refusal is minted around once, a failure is warned about once, and the recovery is logged", async () => {
  const booted = await boot(async () => ({ forwarded: 0, tokens_in: 0, tokens_out: 0 }))
  await signIn(booted.accounts)
  const mints = () => fake.state.requests.filter((request) => request.path === "/v1/auth/bridge/pat").length
  const before = mints()
  fake.state.override = { path: "/v1/bridge/heartbeat", status: 401, body: { message: "refused" } }
  await booted.heartbeat.tick()
  expect(mints()).toBe(before + 1)
  await booted.heartbeat.tick()
  fake.state.override = undefined
  await booted.heartbeat.tick()
  expect(fake.state.heartbeats).toHaveLength(1)
  expect(booted.logged.map((entry) => `${entry.level} ${entry.message}`)).toEqual([
    "warn systemprompt heartbeat failed",
    "info systemprompt heartbeat recovered",
  ])
})

test("an instance that reports this version as unsupported is warned about once while it says so", async () => {
  const booted = await boot(async () => ({ forwarded: 0, tokens_in: 0, tokens_out: 0 }))
  await signIn(booted.accounts)
  fake.state.override = {
    path: "/v1/bridge/heartbeat",
    status: 200,
    body: { min_bridge_version: "9.0.0", compatible: false, window_status: "below" },
  }
  await booted.heartbeat.tick()
  await booted.heartbeat.tick()
  expect(booted.logged.map((entry) => entry.message)).toEqual([
    "systemprompt reports this DynWork as outside the versions it supports",
  ])
})
