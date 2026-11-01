import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Schema } from "effect"
import { SpClient, type Manifest } from "@dynwork/sp-client"
import { DynWorkSync } from "@dynwork/server-plugin/contract"
import { DynWorkMapping } from "@dynwork/server-plugin/mapping"
import { DynWorkSkills } from "../../../server-plugin/src/skills"
import { DynWorkRuntime } from "../../src/sync/runtime"
import { DynWorkSyncEngine } from "../../src/sync/engine"
import { setup, startFake, until, type Fake } from "../accounts/fixture"

// Skill runtime files like the systemprompt bridge's installation evidence: device enrolment, one plan per skill
// publication, the files written beside SKILL.md by the plugin's own code (here on a temporary config dir instead of
// over the RPC) and a receipt per publication, with an outbox that survives failures.

let fake: Fake

beforeAll(() => {
  fake = startFake()
})

afterAll(() => fake.stop())

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
  fake.state.override = undefined
  fake.state.requests.length = 0
  fake.state.receipts.length = 0
  setSystemTime()
})

const account = { label: "Alpha", url: "" }

// The plugin's side, as its `materialize` and `inspect` RPC methods run it: on the projection `apply` wrote.
async function plugin(manifest: Manifest) {
  const root = await mkdtemp(path.join(tmpdir(), "dynwork-runtime-"))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const projection = DynWorkMapping.map({
    instance: { key: "alpha", url: fake.url },
    manifest: Schema.decodeUnknownSync(DynWorkSync.Manifest)(manifest),
    jwt: "eyJ.test",
    expiresAt: Date.now() + 3_600_000,
  }).skillFiles
  await DynWorkSkills.write(root, projection)
  const calls: string[] = []
  return {
    root,
    calls,
    rewrite: () => DynWorkSkills.write(root, projection),
    plugin: {
      materialize: (input: { skill: string; files: ReadonlyArray<DynWorkSync.RuntimeFile> }) => {
        calls.push(`materialize ${input.skill}`)
        return DynWorkSkills.install(root, projection, input.skill, input.files)
      },
      inspect: (input: { skill: string; files: ReadonlyArray<DynWorkSync.Recorded> }) => {
        calls.push(`inspect ${input.skill}`)
        return DynWorkSkills.inspect(root, projection, input.skill, input.files)
      },
    } satisfies DynWorkRuntime.Plugin,
  }
}

async function boot() {
  const signed = setup(fake)
  cleanups.push(() => signed.accounts.dispose())
  await signed.accounts.signInToken({ url: fake.url, token: fake.issuePat() })
  const id = signed.accounts.active() ?? ""
  const stored = signed.accounts.stored(id)
  const token = await signed.accounts.jwt(id)
  const served = await Effect.runPromise(SpClient.manifest(fake.url, token, { key: stored?.offeredKey ?? "" }))
  if (served._tag !== "Manifest") throw new Error("no manifest")
  const side = await plugin(served.manifest)
  const runtime = DynWorkRuntime.make({ accounts: signed.accounts, plugin: side.plugin })
  const capture = () => runtime.capture({ id, account: { ...account, url: fake.url }, manifest: served.manifest })
  return { ...signed, ...side, id, manifest: served.manifest, runtime, capture }
}

const bundles = () => fake.state.requests.filter((request) => request.path.endsWith("/bundle"))
const posts = () => fake.state.requests.filter((request) => request.path === "/api/v1/consumer/receipts")

describe("capture", () => {
  test("enrols once, writes each publication's runtime files beside SKILL.md and posts its receipt", async () => {
    const booted = await boot()
    const outcome = await booted.capture()
    expect(outcome).toEqual({ recovered: 3, remaining: 0, undelivered: false })
    for (const dir of ["alpha-notes", "alpha-review", "who-am-i"]) {
      expect(await Bun.file(path.join(booted.root, "skills", dir, "config.yaml")).exists()).toBe(true)
      expect(await Bun.file(path.join(booted.root, "skills", dir, ".systemprompt-runtime.json")).exists()).toBe(true)
    }
    expect(fake.state.requests.filter((request) => request.path === "/v1/bridge/device")).toHaveLength(1)
    expect(fake.state.receipts).toHaveLength(3)
    const credential = posts()[0]?.headers.authorization?.replace(/^Bearer /, "") ?? ""
    expect(credential).toStartWith("sp_device_")
    // Stored like the PAT: sealed, never as plaintext
    expect(booted.accounts.stored(booted.id)?.device?.cipher).toBeDefined()
    expect(booted.store.disk.json).not.toContain(credential)
    expect(JSON.stringify(booted.accounts.list())).not.toContain("sp_device_")
    expect(booted.accounts.stored(booted.id)?.device?.receipts.map((entry) => entry.state)).toEqual([
      "acknowledged",
      "acknowledged",
      "acknowledged",
    ])
  })

  test("a later capture fetches nothing while the files hold, and writes again a skill whose files went", async () => {
    const booted = await boot()
    await booted.capture()
    fake.state.requests.length = 0
    expect(await booted.capture()).toEqual({ recovered: 0, remaining: 0, undelivered: false })
    expect(bundles()).toHaveLength(0)
    expect(fake.state.requests.filter((request) => request.path === "/v1/bridge/device")).toHaveLength(0)
    // A switch away and back clears the skill directories and `apply` writes them again without runtime files
    await DynWorkSkills.write(booted.root, undefined)
    await booted.rewrite()
    expect(await booted.capture()).toEqual({ recovered: 3, remaining: 0, undelivered: false })
    expect(bundles()).toHaveLength(3)
    expect(await Bun.file(path.join(booted.root, "skills", "who-am-i", "config.yaml")).exists()).toBe(true)
    // The same receipt again is an identical retry, not a second installation
    expect(fake.state.receipts).toHaveLength(3)
  })

  test("a receipt the instance did not take stays queued, and is delivered before the next capture", async () => {
    const booted = await boot()
    fake.state.override = { path: "/api/v1/consumer/receipts", status: 503 }
    expect(await booted.capture()).toEqual({ recovered: 3, remaining: 0, undelivered: true })
    expect(booted.accounts.stored(booted.id)?.device?.receipts.map((entry) => entry.state)).toEqual([
      "pending",
      "pending",
      "pending",
    ])
    fake.state.override = undefined
    fake.state.requests.length = 0
    // Not before its backoff
    expect((await booted.capture()).undelivered).toBe(true)
    expect(posts()).toHaveLength(0)
    setSystemTime(new Date(Date.now() + 5_000))
    expect(await booted.capture()).toEqual({ recovered: 0, remaining: 0, undelivered: false })
    expect(posts()).toHaveLength(3)
    expect(bundles()).toHaveLength(0)
    expect(fake.state.receipts).toHaveLength(3)
  })

  test("a receipt the instance refuses for good is not retried", async () => {
    const booted = await boot()
    fake.state.override = { path: "/api/v1/consumer/receipts", status: 422 }
    await booted.capture()
    expect(booted.accounts.stored(booted.id)?.device?.receipts.map((entry) => entry.state)).toEqual([
      "rejected",
      "rejected",
      "rejected",
    ])
    fake.state.override = undefined
    fake.state.requests.length = 0
    setSystemTime(new Date(Date.now() + 3_600_000))
    await booted.capture()
    expect(posts()).toHaveLength(0)
  })

  test("a refused device credential is forgotten, and the next capture enrols again", async () => {
    const booted = await boot()
    await booted.capture()
    const first = booted.accounts.stored(booted.id)?.device?.cipher
    fake.state.devices.clear()
    await DynWorkSkills.write(booted.root, undefined)
    await booted.rewrite()
    expect((await booted.capture()).remaining).toBe(3)
    expect(booted.accounts.stored(booted.id)?.device).toBeUndefined()
    expect(await booted.capture()).toEqual({ recovered: 3, remaining: 0, undelivered: false })
    expect(booted.accounts.stored(booted.id)?.device?.cipher).not.toBe(first)
  })

  test("an instance that refuses enrolment, or a skill the plugin did not write, costs a warning, never the sync", async () => {
    const booted = await boot()
    fake.state.override = { path: "/v1/bridge/device", status: 403, body: { title: "Forbidden", status: 403 } }
    expect(await booted.capture()).toEqual({ recovered: 0, remaining: 3, undelivered: false })
    expect(bundles()).toHaveLength(0)
    expect(booted.accounts.stored(booted.id)?.device).toBeUndefined()
    fake.state.override = undefined
    // Enrolment is tried again after its backoff, not on every poll
    expect((await booted.capture()).remaining).toBe(3)
    expect(fake.state.requests.filter((request) => request.path === "/v1/bridge/device")).toHaveLength(1)
    setSystemTime(new Date(Date.now() + 5_000))
    await rm(path.join(booted.root, "skills", "who-am-i"), { recursive: true })
    expect(await booted.capture()).toEqual({ recovered: 2, remaining: 1, undelivered: false })
  })

  test("signing out forgets the device credential and its receipts", async () => {
    const booted = await boot()
    await booted.capture()
    booted.accounts.signOut(booted.id)
    expect(booted.accounts.stored(booted.id)?.device).toBeUndefined()
    expect(booted.store.disk.json).not.toContain("receipts")
  })
})

describe("engine", () => {
  test("captures after an apply, not after a poll that changed nothing", async () => {
    // Just after the fixture manifest was stamped, so the engine admits it
    setSystemTime(new Date("2026-11-01T09:12:31Z"))
    const signed = setup(fake)
    cleanups.push(() => signed.accounts.dispose())
    await signed.accounts.signInToken({ url: fake.url, token: fake.issuePat() })
    const captured: string[] = []
    const engine = DynWorkSyncEngine.make({
      accounts: signed.accounts,
      plugin: {
        apply: async () => ({ skills: 3, agents: 1, mcp: 1, rules: 1 }),
        token: async () => true,
        clear: async () => {},
        listen: (_, signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve())),
      },
      runtime: {
        capture: async (input) => {
          captured.push(input.manifest.user_id)
          return { recovered: 0, remaining: 0, undelivered: false }
        },
      },
      focused: true,
      changed: () => {},
    })
    cleanups.push(() => engine.dispose())
    await until(() => captured.length === 1)
    engine.now()
    await until(() => fake.state.requests.filter((request) => request.path === "/v1/bridge/manifest").length >= 2)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(captured).toHaveLength(1)
  })
})
