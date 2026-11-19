import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DynWorkAccounts } from "../../src/accounts/accounts"
import { RoutinesBackend } from "../../src/routines/backend"
import { Capabilities, isFailure, Routine, Run, type Definition, type Failure } from "../../src/routines/contract"
import { RoutinesFarm } from "../../src/routines/farm/backend"
import { FarmClient } from "../../src/routines/farm/client"
import { FarmCloud } from "../../src/routines/farm/cloud"
import { RoutinesLocal } from "../../src/routines/local/backend"
import { RoutinesSync } from "../../src/routines/local/sync"
import { setup, startFake, type Fake } from "../accounts/fixture"
import { fakeFarm, type FakeFarm } from "./farm-server"
import { storage } from "./fixture"
import { fakeGovernance } from "./governance"
import { connect, crossing } from "./wire"

// The farm backend over the real transport and the real accounts: a signed-in account of the sp-client fake (real JWT
// mint) and the fake farm behind the fake Governance MCP proxy (`farm-server.ts`), which accepts only the JWTs the fake
// instance minted.
let sp: Fake
let farm: FakeFarm
const stops: Array<() => void> = []

beforeAll(() => {
  sp = startFake()
  farm = fakeFarm({ authorize: (bearer) => sp.state.jwts.has(bearer) })
})

afterAll(() => {
  stops.forEach((stop) => stop())
  farm.stop()
  sp.stop()
})

beforeEach(() => {
  Object.assign(farm.state, {
    subject: "ana@dynapps.es",
    admin: false,
    freePrompt: true,
    ceiling: "bypass",
    userCredential: true,
    uploaded: undefined,
    maxPerUser: 20,
    maxTenant: 500,
    catalogue: ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5", "deepseek-flash"],
    agents: [
      { slug: "code-reviewer", description: "Reviews merge requests" },
      { slug: "careful", description: "Asks first", ceiling: "ask" },
    ],
    plugins: [{ name: "developer-skills", version: "1.0.0" }],
    credentials: [
      { name: "git-readonly", type: "git_token" },
      { name: "mcp-odoo", type: "mcp_url" },
      { name: "team-git", type: "git_token", scope: "shared" },
    ],
    unauthorized: false,
    unavailable: false,
    down: false,
  })
  farm.state.schedules.clear()
  farm.state.tasks.clear()
  farm.state.tickets.clear()
  farm.reset()
})

async function cloud(options: { models?: () => Promise<readonly string[] | undefined> } = {}) {
  const context = setup(sp)
  const pat = sp.issuePat()
  await context.accounts.signInToken({ url: sp.url, token: pat })
  stops.push(context.accounts.dispose)
  const accounts = {
    active: context.accounts.active,
    session: context.accounts.session,
    stored: (key: string) => {
      const stored = context.accounts.stored(key)
      return stored && { ...stored, url: farm.url }
    },
  }
  const client = FarmClient.viaSp({ accounts })
  const access = FarmCloud.make({
    transport: client,
    accounts: {
      active: context.accounts.active,
      withPat: async (key, use) => {
        if (context.accounts.list().find((account) => account.id === key)?.status !== "signedIn")
          throw new DynWorkAccounts.NotSignedIn({ id: key })
        return use(pat)
      },
    },
  })
  const backend = RoutinesFarm.make({
    client,
    cloud: access,
    models: options.models ?? (async () => ["claude-sonnet-5-5", "claude-opus-5-5"]),
  })
  return { ...context, pat, backend, client }
}

async function ok<A>(answer: Promise<A | Failure>) {
  const value = await answer
  if (isFailure(value)) throw new Error(`${value.code}: ${value.message}`)
  return value
}

const definition = (name: string, extra: Partial<Definition> = {}): Definition => ({
  name,
  instructions: { kind: "prompt", text: `Do ${name}.` },
  schedule: { cron: "0 9 * * 1-5", timezone: "Europe/Madrid" },
  enabled: true,
  options: { repository: "https://git.example.com/acme/app.git", branch: "main", timeLimit: 15, overlap: "skip" },
  ...extra,
})

const call = (name: string) => farm.state.calls.filter((item) => item.name === name)

describe("the farm backend's capabilities", () => {
  test("ready: edits in place, replies by resuming, the user's Governance models, the caller's quota", async () => {
    const { backend } = await cloud()
    const capabilities = await backend.capabilities()
    expect(capabilities).toMatchObject({
      backend: "farm",
      kind: "remote",
      label: "Cloud",
      status: "ready",
      instructions: ["prompt", "agent"],
      model: "choose",
      actions: { edit: "in-place", reply: "resume", cancel: true },
      quota: { max: 20, used: 0, shared: false },
    })
    const keys = capabilities.fields.map((field) => field.key)
    expect(keys).not.toContain("capped")
    expect(keys).not.toContain("budget")
    expect(capabilities.fields.find((field) => field.key === "permissions")?.choices?.map((c) => c.value)).toEqual([
      "ask",
      "bypass",
    ])
    expect(capabilities.fields.find((field) => field.key === "connectors")).toMatchObject({
      kind: "multiselect",
      lookup: "credentials:mcp_url",
      max: 5,
    })
    expect(crossing(Capabilities, capabilities)).toEqual(capabilities)
    expect(await backend.options("models")).toEqual([
      { value: "claude-sonnet-5-5", label: "claude-sonnet-5-5" },
      { value: "claude-opus-5-5", label: "claude-opus-5-5" },
    ])
  })

  test("before answering, Cloud is given the account's PAT when the farm has none", async () => {
    const { backend, pat } = await cloud()
    farm.state.userCredential = false
    const capabilities = await backend.capabilities()
    expect(capabilities.status).toBe("ready")
    expect(farm.state.uploaded).toBe(pat)
    expect(farm.called().slice(0, 2)).toEqual(["farm_whoami", "farm_request_credential_upload"])
  })

  test("a PAT Cloud cannot be given: it says so, and create answers why", async () => {
    const { client } = await cloud()
    farm.state.userCredential = false
    // The upload did not reach the farm: it keeps no PAT for the user.
    const refused = RoutinesFarm.make({
      client,
      cloud: {
        ensure: async () => ({
          ok: false,
          code: "upload_unreachable",
          failure: { code: "failed", message: "Cloud did not take the Governance sign-in.", retryable: false },
        }),
        retry: async () => undefined,
      },
      models: async () => ["claude-sonnet-5-5"],
    })
    const capabilities = await refused.capabilities()
    expect(capabilities.status).toBe("disabled")
    expect(capabilities.detail).toContain("Governance")
    const answer = await refused.create(definition("No access"))
    expect(answer).toMatchObject({ code: "failed" })
    expect(isFailure(answer) ? answer.message : "").toContain("Governance")
    expect(farm.state.schedules.size).toBe(0)
  })

  test("a tenant whose ceiling is ask offers no Don't ask, a tenant without free prompts offers agents only", async () => {
    const { backend } = await cloud()
    farm.state.ceiling = "ask"
    farm.state.freePrompt = false
    farm.state.maxPerUser = null
    const capabilities = await backend.capabilities()
    expect(capabilities.fields.find((field) => field.key === "permissions")?.choices?.map((c) => c.value)).toEqual([
      "ask",
    ])
    expect(capabilities.instructions).toEqual(["agent"])
    expect(capabilities.quota).toEqual({ max: 500, used: 0, shared: true })
  })

  test("no model admitted for the user: the agent fixes it", async () => {
    const { backend } = await cloud({ models: async () => [] })
    expect((await backend.capabilities()).model).toBe("agent")
  })

  test("the models are the account's profile.models, as Governance lists them", async () => {
    const context = setup(sp)
    await context.accounts.signInToken({ url: sp.url, token: sp.issuePat() })
    stops.push(context.accounts.dispose)
    const models = RoutinesFarm.profileModels(context.accounts)
    expect(await models()).toEqual(["claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"])
    await context.accounts.signOut(context.accounts.active() ?? "")
    expect(await models()).toBeUndefined()
  })

  test("401 is signed-out, a farm that does not answer is unreachable, no farm for the account is disabled", async () => {
    const { backend } = await cloud()
    farm.state.unauthorized = true
    expect((await backend.capabilities()).status).toBe("signed-out")
    farm.state.unauthorized = false
    farm.state.down = true
    expect((await backend.capabilities()).status).toBe("unreachable")
    expect(await backend.list()).toMatchObject({ code: "unreachable", retryable: true })
    farm.state.down = false
    farm.state.unavailable = true
    const capabilities = await backend.capabilities()
    expect(capabilities.status).toBe("disabled")
    expect(crossing(Capabilities, capabilities)).toEqual(capabilities)
  })
})

describe("the farm backend's lookups and validation", () => {
  test("options serve agents, plugins, credentials of a type and the models; anything else is not-found", async () => {
    const { backend } = await cloud()
    expect(await backend.options("agents")).toEqual([
      { value: "code-reviewer", label: "code-reviewer" },
      { value: "careful", label: "careful" },
    ])
    expect(await backend.options("plugins")).toEqual([{ value: "developer-skills", label: "developer-skills" }])
    expect(await backend.options("credentials:git_token")).toEqual([{ value: "git-readonly", label: "git-readonly" }])
    expect(await backend.options("credentials:mcp_url")).toEqual([{ value: "mcp-odoo", label: "mcp-odoo" }])
    expect(await backend.options("skills")).toMatchObject({ code: "not-found" })
  })

  test("validate adds the farm's rules: the user's models, the agent's ceiling, agents that exist", async () => {
    const { backend } = await cloud()
    expect(await backend.validate(definition("Fine", { model: "claude-sonnet-5-5" }))).toBeUndefined()
    expect((await backend.validate(definition("Bad model", { model: "deepseek-flash" })))?.fields).toHaveProperty(
      "model",
    )
    const careful = definition("Careful", {
      instructions: { kind: "agent", agent: "careful", input: "Go." },
      options: { permissions: "bypass" },
    })
    expect((await backend.validate(careful))?.fields).toHaveProperty("permissions")
    const unknown = definition("Unknown", { instructions: { kind: "agent", agent: "nobody", input: "Go." } })
    expect((await backend.validate(unknown))?.fields).toHaveProperty("instructions")
    expect((await backend.validate(definition("")))?.fields).toHaveProperty("name")
  })
})

describe("the farm backend's routines", () => {
  test("create, list and get: a schedule with name and metadata, run as the user, the definition as it was", async () => {
    const { backend } = await cloud()
    const made = definition("Digest", {
      model: "claude-sonnet-5-5",
      template: { id: "t1", revision: 3 },
      options: {
        repository: "https://git.example.com/acme/app.git",
        branch: "main",
        access: "git-readonly",
        permissions: "ask",
        connectors: ["mcp-odoo"],
        timeLimit: 15,
        overlap: "allow",
        future: { kept: [1, 2] },
      },
    })
    const created = await ok(backend.create(made))
    expect(created.ref.backend).toBe("farm")
    expect(created.definition).toEqual(made)
    expect(created.state).toBe("active")
    expect(created.next).toBeNumber()
    expect(crossing(Routine, created)).toEqual(created)

    const sent = call("farm_create_schedule")[0]?.args ?? {}
    expect(sent).toMatchObject({
      name: "Digest",
      overlap: "allow",
      recurrence: { cron: "0 9 * * 1-5", timezone: "Europe/Madrid" },
      task: {
        prompt: "Do Digest.",
        model: "claude-sonnet-5-5",
        permission_mode: "ask",
        gateway_identity: "user",
        workspace: { repo: "https://git.example.com/acme/app.git", ref: "main", credentials_ref: "git-readonly" },
        mcp_servers: [{ name: "mcp-odoo", credential: "mcp-odoo" }],
        limits: { timeout_s: 900 },
      },
    })
    expect((sent.metadata as Record<string, unknown>).template).toEqual({ id: "t1", revision: 3 })
    expect(sent).not.toHaveProperty("owner_device")

    expect((await ok(backend.list())).map((routine) => routine.ref.id)).toEqual([created.ref.id])
    expect(call("farm_list_schedules")[0]?.args).toEqual({ owner: "me" })
    expect(await ok(backend.get(created.ref.id))).toEqual(created)
    expect(await backend.get("nope")).toMatchObject({ code: "not-found" })
  })

  test("a manual routine has no recurrence and runs only when started; start fires it", async () => {
    const { backend } = await cloud()
    const created = await ok(backend.create(definition("Manual", { schedule: undefined })))
    expect(created.definition.schedule).toBeUndefined()
    expect(created.next).toBeUndefined()
    expect(call("farm_create_schedule")[0]?.args).not.toHaveProperty("recurrence")

    const run = await ok(backend.start(created.ref.id))
    expect(run).toMatchObject({
      routine: created.ref,
      state: "queued",
      trigger: "manual",
      title: "Manual",
      conversation: { kind: "transcript" },
    })
    expect(crossing(Run, run)).toEqual(run)
    expect(call("farm_fire_schedule")[0]?.args).toEqual({ schedule_id: created.ref.id })
  })

  test("an edit is in place: same id, a PATCH, and what Dynwork does not know of the schedule is kept", async () => {
    const { backend } = await cloud()
    const created = await ok(backend.create(definition("Before", { template: { id: "t1", revision: 1 } })))
    const stored = farm.state.schedules.get(created.ref.id)
    if (stored === undefined) throw new Error("not stored")
    stored.metadata = { ...stored.metadata, console: { colour: "blue" } }
    stored.task = { ...stored.task, scope: "acme", limits: { timeout_s: 900, memory: "2Gi" } }

    const next = definition("After", { schedule: undefined, template: { id: "t1", revision: 2 } })
    const updated = await ok(backend.update(created.ref.id, next))
    expect(updated.ref).toEqual(created.ref)
    expect(updated.definition).toEqual(next)
    expect(farm.state.schedules.size).toBe(1)
    expect(call("farm_create_schedule")).toHaveLength(1)
    const changes = call("farm_update_schedule")[0]?.args.changes as Record<string, unknown>
    expect(changes.recurrence).toBeNull()
    expect(stored.metadata.console).toEqual({ colour: "blue" })
    expect(stored.metadata.template).toEqual({ id: "t1", revision: 2 })
    expect(stored.task).toMatchObject({ scope: "acme", limits: { timeout_s: 900, memory: "2Gi" } })
    expect(stored.name).toBe("After")
  })

  test("enabled false is a paused schedule; pause, resume and remove go to the farm", async () => {
    const { backend } = await cloud()
    const off = await ok(backend.create(definition("Off", { enabled: false })))
    expect(off.state).toBe("paused")
    expect(off.definition.enabled).toBe(false)
    expect(off.next).toBeUndefined()

    expect(await backend.resume(off.ref.id)).toBeUndefined()
    expect((await ok(backend.get(off.ref.id))).state).toBe("active")
    expect(await backend.pause(off.ref.id)).toBeUndefined()
    expect((await ok(backend.get(off.ref.id))).definition.enabled).toBe(false)
    expect(await backend.start(off.ref.id)).toMatchObject({ code: "conflict" })
    const on = await ok(backend.update(off.ref.id, { ...off.definition, enabled: true }))
    expect(on.state).toBe("active")

    expect(await backend.remove(off.ref.id)).toBeUndefined()
    expect(await backend.get(off.ref.id)).toMatchObject({ code: "not-found" })
    expect(await backend.remove(off.ref.id)).toMatchObject({ code: "not-found" })
    expect(await backend.pause(off.ref.id)).toMatchObject({ code: "not-found" })
  })

  test("a full quota is a quota failure; a refused model is invalid on its field", async () => {
    const { backend } = await cloud()
    farm.state.maxPerUser = 1
    await ok(backend.create(definition("One")))
    expect(await backend.create(definition("Two"))).toMatchObject({ code: "quota", retryable: false })
    farm.state.maxPerUser = 20
    farm.state.catalogue = []
    const refused = await backend.create(definition("Model", { model: "claude-sonnet-5-5" }))
    expect(refused).toMatchObject({ code: "invalid" })
    expect(isFailure(refused) ? refused.fields : undefined).toHaveProperty("model")
  })

  test("a farm without the user's PAT gets it again and the routine is created once", async () => {
    const { backend, pat } = await cloud()
    farm.state.userCredential = false
    const created = await ok(backend.create(definition("Again")))
    expect(farm.state.uploaded).toBe(pat)
    expect(farm.state.schedules.size).toBe(1)
    expect(created.definition.name).toBe("Again")
  })

  test("nothing rejects: a farm that is down answers unreachable to every method", async () => {
    const { backend } = await cloud()
    farm.state.down = true
    const answers = await Promise.all([
      backend.options("agents"),
      backend.validate(definition("Down")),
      backend.list(),
      backend.get("x"),
      backend.create(definition("Down")),
      backend.update("x", definition("Down")),
      backend.remove("x"),
      backend.pause("x"),
      backend.resume("x"),
      backend.start("x"),
    ])
    answers.forEach((answer) => expect(answer).toMatchObject({ code: "unreachable" }))
  })
})

describe("one list", () => {
  test("Cloud routines sit in the same list as the local ones and never reach the local routines' sync", async () => {
    const { backend } = await cloud()
    const governance = fakeGovernance()
    stops.push(governance.stop)
    const store = storage(RoutinesLocal.Saved, RoutinesLocal.initial)
    const device = { id: "a".repeat(32), name: "Mac A" }
    const account = () => ({ id: "account", url: governance.url, token: async () => governance.token })
    const shared: { sync?: RoutinesSync.Sync } = {}
    const local = RoutinesLocal.make({
      label: "Mac A",
      store,
      client: () => undefined,
      server: "sidecar",
      home: await mkdtemp(path.join(tmpdir(), "farm-one-list-")),
      now: Date.now,
      device: () => device,
      account: () => "account",
      synced: () => shared.sync?.synced(),
      queued: () => {},
    })
    const sync = RoutinesSync.make({
      store,
      local,
      account,
      device: () => device,
      now: Date.now,
      timers: { set: () => () => {} },
    })
    shared.sync = sync
    stops.push(local.dispose, sync.dispose)
    const registry = RoutinesBackend.make()
    registry.register(local)
    registry.register(backend)
    const window = connect(registry).client

    const mine = await ok(local.create({ ...definition("Here"), options: { permissions: "ask" } }))
    const remote = await ok(window.create({ backend: "farm", definition: definition("There") }))
    await window.refresh()
    const listed = window.state().routines.map((routine) => `${routine.ref.backend}:${routine.definition.name}`)
    expect(listed.toSorted()).toEqual(["farm:There", "local:Here"])

    await sync.sync()
    const synced = [...governance.state.routines.values()].map((row) => (row.definition as Definition).name)
    expect(synced).toEqual(["Here"])
    expect(governance.state.routines.has(remote.ref.id)).toBe(false)
    expect(mine.ref.backend).toBe("local")
  })
})

describe("the fake farm", () => {
  test("serves the run tools the backend reads next: runs, viewed, transcript, answers, cancel", async () => {
    const { backend, client: transport } = await cloud()
    const message = { seq: 1, role: "assistant" as const, text: "Working.", tool_uses: [], at: null, truncated: false }
    const created = await ok(backend.create(definition("Runs", { schedule: undefined })))
    const run = await ok(backend.start(created.ref.id))
    farm.advance(run.ref.id, {
      state: "running",
      question: {
        seq: 4,
        text: "Go on?",
        asked_at: "2026-11-19T00:00:00Z",
        kind: "permission",
        options: ["Allow", "Deny"],
      },
      transcript: [message],
    })
    const runs = await transport.callTool("farm_list_schedule_runs", { schedule_id: created.ref.id })
    expect(runs.ok && (runs.value.items as { waiting_input: boolean }[])[0]?.waiting_input).toBe(true)
    expect((await transport.callTool("farm_answer_task", { task_id: run.ref.id, answer: "Allow", seq: 4 })).ok).toBe(
      true,
    )
    const transcript = await transport.callTool("farm_get_task_transcript", { task_id: run.ref.id })
    expect(transcript.ok && transcript.value.messages).toEqual([message])
    expect((await transport.callTool("farm_mark_task_viewed", { task_id: run.ref.id })).ok).toBe(true)
    expect(farm.state.tasks.get(run.ref.id)?.viewed).toBe(true)
    expect((await transport.callTool("farm_cancel_task", { task_id: run.ref.id })).ok).toBe(true)
    const again = await transport.callTool("farm_cancel_task", { task_id: run.ref.id })
    expect(again.ok ? undefined : again.failure.code).toBe("conflict")
    const tasks = await transport.callTool("farm_list_tasks", { owner: "me" })
    expect(tasks.ok && (tasks.value.items as unknown[]).length).toBe(1)
  })
})
