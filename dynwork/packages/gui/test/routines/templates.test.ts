import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { MainContext } from "@opencode/plugin/gui/main"
import { isFailure, type Definition, type Personal, type Template } from "../../src/routines/contract"
import { RoutinesMain } from "../../src/routines/main"
import { RoutinesTemplates } from "../../src/routines/templates"
import { RoutinesLocal } from "../../src/routines/local/backend"
import { enqueue, type Op } from "../../src/routines/local/store"
import { RoutinesSync } from "../../src/routines/local/sync"
import { RoutinesTemplatesReader } from "../../src/routines/local/templates"
import { storage } from "./fixture"
import { fakeGovernance, type FakeGovernance } from "./governance"

const home = await mkdtemp(path.join(tmpdir(), "routines-templates-"))
const stops: Array<() => void> = []
afterAll(() => stops.forEach((stop) => stop()))

const governance = () => {
  const made = fakeGovernance()
  stops.push(made.stop)
  return made
}

const ZONE = "Europe/Madrid"

const template = (id: string, extra: Partial<Template> = {}): Template => ({
  id,
  revision: 1,
  name: `Template ${id}`,
  description: "A task the whole team runs.",
  mandatory: false,
  where: "local",
  definition: {
    instructions: { kind: "prompt", text: "Review the project." },
    schedule: { cron: "0 9 * * 1-5" },
    options: { permissions: "ask", connectors: ["dynapps-odoo"] },
  },
  locks: { model: false, schedule: "time", timeLimitMax: null },
  personal: { folder: "required", hint: "The project it reviews." },
  ...extra,
})

const account = (gov: FakeGovernance, id = "account") => ({ id, url: gov.url, token: async () => gov.token })

// One computer reading templates: its local backend, its reader and its sync over its own store, with timers the test
// never fires.
function computer(
  gov: FakeGovernance,
  name: string,
  input: {
    account?: () => RoutinesSync.Account | undefined
    zone?: string
    /** Another computer's store: this one is that computer started again. */
    store?: ReturnType<typeof storage<typeof RoutinesLocal.Saved>>
  } = {},
) {
  const active = input.account ?? (() => account(gov))
  const store = input.store ?? storage(RoutinesLocal.Saved, RoutinesLocal.initial)
  const device = { id: (name === "Mac A" ? "a" : "b").repeat(32), name }
  const shared: { sync?: RoutinesSync.Sync; changed: number } = { changed: 0 }
  const reader = RoutinesTemplatesReader.make({
    account: active,
    device: () => device,
    changed: () => void shared.changed++,
  })
  const local = RoutinesLocal.make({
    label: name,
    store,
    client: () => undefined,
    server: "sidecar",
    home,
    now: Date.now,
    device: () => device,
    account: () => active()?.id,
    synced: () => shared.sync?.synced(),
    queued: () => void shared.sync?.sync(),
    templates: reader.current,
  })
  const sync = RoutinesSync.make({
    store,
    local,
    account: active,
    device: () => device,
    now: Date.now,
    timers: { set: () => () => {} },
    templates: reader,
    zone: () => input.zone ?? ZONE,
  })
  shared.sync = sync
  stops.push(local.dispose, sync.dispose)
  return { store, local, reader, sync, shared, device }
}

// Waits for an answer that comes through main's own timers and requests.
async function eventually(condition: () => Promise<boolean>) {
  const deadline = Date.now() + 3_000
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the condition")
    await Bun.sleep(2)
  }
}

async function offered(local: RoutinesLocal.Local) {
  const answer = await local.templates?.()
  if (!answer || isFailure(answer)) throw new Error(answer?.message ?? "No templates")
  return answer
}

describe("reading the templates", () => {
  test("an answer is kept with its ETag, and a 304 keeps it", async () => {
    const gov = governance()
    gov.state.templates = [template("review")]
    const reader = RoutinesTemplatesReader.make({
      account: () => account(gov),
      device: () => ({ id: "a".repeat(32), name: "Mac A" }),
      changed: () => void changed.count++,
    })
    const changed = { count: 0 }
    await reader.read()
    expect(reader.current()?.templates.map((item) => item.id)).toEqual(["review"])
    await reader.read()
    expect(gov.state.served.map((answer) => answer.status)).toEqual([200, 304])
    expect(gov.state.served[1]?.etag).toBeString()
    expect(reader.current()?.templates.map((item) => item.id)).toEqual(["review"])
    expect(changed.count).toBe(1)
    gov.state.templates = [template("review"), template("timesheet")]
    await reader.read()
    expect(reader.current()?.templates.map((item) => item.id)).toEqual(["review", "timesheet"])
    expect(changed.count).toBe(2)
  })

  test("Governance down keeps what was read", async () => {
    const gov = governance()
    gov.state.templates = [template("review")]
    const reader = RoutinesTemplatesReader.make({
      account: () => account(gov),
      device: () => ({ id: "a".repeat(32), name: "Mac A" }),
      changed: () => {},
    })
    await reader.read()
    gov.state.down = true
    await reader.read()
    expect(reader.current()?.templates.map((item) => item.id)).toEqual(["review"])
  })

  test("each account keeps its own answer, and another account's is never shown", async () => {
    const first = governance()
    const second = governance()
    first.state.templates = [template("first")]
    second.state.templates = [template("second")]
    const active = { value: account(first, "first") }
    const reader = RoutinesTemplatesReader.make({
      account: () => active.value,
      device: () => ({ id: "a".repeat(32), name: "Mac A" }),
      changed: () => {},
    })
    await reader.read()
    active.value = account(second, "second")
    expect(reader.current()).toBeUndefined()
    await reader.read()
    expect(reader.current()?.templates.map((item) => item.id)).toEqual(["second"])
    active.value = account(first, "first")
    expect(reader.current()?.templates.map((item) => item.id)).toEqual(["first"])
    expect(first.state.served).toHaveLength(1)
  })

  test("every pass of the sync reads them first, before the feed", async () => {
    const gov = governance()
    gov.state.templates = [template("review")]
    const a = computer(gov, "Mac A")
    await a.sync.sync()
    expect(gov.state.requests.slice(0, 2)).toEqual(["GET /templates -", "GET /changes -"])
    expect((await offered(a.local)).templates.map((item) => item.id)).toEqual(["review"])
    expect(a.shared.changed).toBe(1)
  })

  test("a hint reads them at once: main's templates", async () => {
    const gov = governance()
    const stored = new Map<string, unknown>()
    const cleanups: Array<() => void> = []
    const ctx = {
      provide: () => ({ changed: () => {}, emit: () => {} }),
      onCleanup: (cleanup: () => void) => void cleanups.push(cleanup),
      storage: {
        store: (key: string, options: { schema: never; initial: unknown }) => {
          if (!stored.has(key)) stored.set(key, storage(options.schema, options.initial as never))
          return stored.get(key)
        },
      },
      serverEndpoints: { get: () => undefined },
      windows: { focused: () => undefined, list: () => [] },
    }
    // SAFETY: the routines' setup reads only `provide`, `onCleanup`, `storage`, `serverEndpoints` and `windows`.
    const main = RoutinesMain.setup(ctx as unknown as MainContext, {
      label: "Mac A",
      sync: { account: () => account(gov), device: () => ({ id: "a".repeat(32), name: "Mac A" }) },
    })
    stops.push(() => cleanups.forEach((cleanup) => cleanup()))
    const local = main.registry.get("local") as RoutinesLocal.Local
    await eventually(async () => {
      const answer = await local.templates?.()
      return !!answer && !isFailure(answer)
    })
    expect((await offered(local)).templates).toEqual([])
    gov.state.templates = [template("review")]
    main.templates()
    await eventually(async () => (await offered(local)).templates.length === 1)
    expect((await offered(local)).templates.map((item) => item.id)).toEqual(["review"])
  })
})

describe("the local backend's templates", () => {
  test("it says why there are none: no templates here, signed out, or not read yet", async () => {
    const gov = governance()
    const plain = RoutinesLocal.make({
      label: "Mac A",
      store: storage(RoutinesLocal.Saved, RoutinesLocal.initial),
      client: () => undefined,
      server: "sidecar",
      home,
      now: Date.now,
    })
    stops.push(plain.dispose)
    expect(await plain.templates?.()).toMatchObject({ code: "unsupported" })
    const signed = { value: true }
    const a = computer(gov, "Mac A", { account: () => (signed.value ? account(gov) : undefined) })
    expect(await a.local.templates?.()).toMatchObject({ code: "unreachable" })
    signed.value = false
    expect(await a.local.templates?.()).toMatchObject({ code: "signed-out" })
    expect(await a.local.activate?.("review", { timezone: ZONE })).toMatchObject({ code: "signed-out" })
  })

  test("activating makes the person's linked routine, which reaches Governance, and only once", async () => {
    const gov = governance()
    gov.state.templates = [template("review", { revision: 4 })]
    const a = computer(gov, "Mac A")
    await a.reader.read()
    const made = await a.local.activate?.("review", { timezone: ZONE, folder: "/work/odoo", cron: "30 7 * * 1-5" })
    if (!made || isFailure(made)) throw new Error(made?.message ?? "Not activated")
    expect(made.definition).toMatchObject({
      name: "Template review",
      template: { id: "review", revision: 4 },
      schedule: { cron: "30 7 * * 1-5", timezone: ZONE },
      options: { permissions: "ask", connectors: ["dynapps-odoo"], folder: "/work/odoo" },
    })
    await a.sync.sync()
    const row = gov.state.routines.get(made.ref.id)
    expect(row?.definition).toMatchObject({ template: { id: "review", revision: 4 } })
    expect(await a.local.activate?.("review", { timezone: ZONE, folder: "/work/odoo" })).toMatchObject({
      code: "conflict",
    })
    expect((await offered(a.local)).links).toEqual([{ id: "review", state: "published", retire: null }])
  })

  test("a linked routine says which template it came from, what it locks and whether it is mandatory", async () => {
    const gov = governance()
    gov.state.templates = [template("review", { name: "Project review" })]
    const a = computer(gov, "Mac A")
    await a.reader.read()
    const made = await a.local.activate?.("review", { timezone: ZONE, folder: "/work" })
    if (!made || isFailure(made)) throw new Error(made?.message ?? "Not activated")
    // In Governance before the template turns mandatory, which would otherwise make the person's task of it there.
    await a.sync.sync()
    const expected = { id: "review", name: "Project review", state: "published", mandatory: false }
    expect(made.template).toEqual({ ...expected, locked: RoutinesTemplates.locked(template("review")) })
    expect(made.template?.locked).toContain("schedule.weekday")
    const listed = await a.local.list()
    if (isFailure(listed)) throw new Error(listed.message)
    expect(listed[0]?.template).toEqual(made.template)
    const read = await a.local.get(made.ref.id)
    if (isFailure(read)) throw new Error(read.message)
    expect(read.template).toEqual(made.template)
    // A routine of the person's own carries none.
    const own = await a.local.create({
      name: "Own",
      instructions: { kind: "prompt", text: "Do it." },
      enabled: true,
      options: {},
    })
    if (isFailure(own)) throw new Error(own.message)
    expect(own.template).toBeUndefined()

    // The template changes under it, and its link says where it stands now.
    gov.state.templates = [
      template("review", {
        name: "Project review",
        mandatory: true,
        locks: { model: true, schedule: "locked", timeLimitMax: null },
      }),
    ]
    await a.reader.read()
    const later = await a.local.get(made.ref.id)
    if (isFailure(later)) throw new Error(later.message)
    expect(later.template?.mandatory).toBe(true)
    expect(later.template?.locked).toContain("schedule.minute")
    expect(later.template?.locked).toContain("model")

    // A template the person no longer sees locks nothing here: Governance still checks.
    gov.state.templates = []
    await a.reader.read()
    const gone = await a.local.get(made.ref.id)
    if (isFailure(gone)) throw new Error(gone.message)
    expect(gone.template).toMatchObject({ id: "review", name: "Project review", locked: [], mandatory: false })
  })

  test("a template linked on another computer, a mandatory one and an unknown one are refused", async () => {
    const gov = governance()
    gov.state.templates = [template("review"), template("timesheet", { mandatory: true })]
    const a = computer(gov, "Mac A")
    const b = computer(gov, "Mac B")
    await a.reader.read()
    const made = await a.local.activate?.("review", { timezone: ZONE, folder: "/work" })
    if (!made || isFailure(made)) throw new Error(made?.message ?? "Not activated")
    await a.sync.sync()
    // B reads the links before its feed brings A's routine: Governance already says the person has one.
    await b.reader.read()
    expect(await b.local.activate?.("review", { timezone: ZONE, folder: "/work" })).toMatchObject({ code: "conflict" })
    expect(await b.local.activate?.("timesheet", { timezone: ZONE })).toMatchObject({ code: "conflict" })
    expect(await b.local.activate?.("nothing", { timezone: ZONE })).toMatchObject({ code: "not-found" })
    // Nothing was made here: whatever Mac B has came from Governance (the mandatory template's task among it).
    expect(b.store.value.routines.filter((stored) => stored.revision === undefined)).toEqual([])
  })

  test("what the template needs of the person is checked: the folder, the time zone, the confirmation", async () => {
    const gov = governance()
    gov.state.templates = [
      template("review"),
      template("bypass", {
        definition: {
          instructions: { kind: "prompt", text: "Tidy up." },
          options: { permissions: "bypass", connectors: ["dynapps-odoo"] },
        },
      }),
    ]
    const a = computer(gov, "Mac A")
    await a.reader.read()
    expect(await a.local.activate?.("review", { timezone: ZONE })).toMatchObject({
      code: "invalid",
      fields: { folder: "This template needs a project folder." },
    })
    expect(await a.local.activate?.("bypass", { timezone: ZONE, folder: "/work" })).toMatchObject({
      code: "invalid",
      fields: { permissions: "Confirm that it runs without asking." },
    })
    expect(await a.local.list()).toEqual([])
  })

  test("two computers activating at once keep Governance's routine, and the second one's goes", async () => {
    const gov = governance()
    gov.state.templates = [template("review")]
    const a = computer(gov, "Mac A")
    const b = computer(gov, "Mac B")
    await a.reader.read()
    await b.reader.read()
    const first = await a.local.activate?.("review", { timezone: ZONE, folder: "/a" })
    const second = await b.local.activate?.("review", { timezone: ZONE, folder: "/b" })
    if (!first || isFailure(first) || !second || isFailure(second)) throw new Error("Not activated")
    await a.sync.sync()
    await b.sync.sync()
    const kept = await b.local.list()
    if (isFailure(kept)) throw new Error(kept.message)
    expect(kept.map((routine) => routine.ref.id)).toEqual([first.ref.id])
    expect(kept[0]?.definition.options.folder).toBe("/a")
    expect(b.store.value.outbox ?? []).toEqual([])
    expect([...gov.state.routines.values()].filter((row) => !row.deleted)).toHaveLength(1)
    expect(b.sync.synced()).toBe(true)
  })
})

// A template whose revisions the merge tests change one field at a time: a weekday task whose frequency is locked.
const daily = (revision: number, extra: Partial<Template> = {}, options: Partial<Template["definition"]> = {}) =>
  template("daily", {
    revision,
    name: "Daily review",
    personal: { folder: "required", hint: null },
    ...extra,
    definition: {
      instructions: { kind: "prompt", text: "Review the project." },
      model: "anthropic/a",
      schedule: { cron: "0 8 * * 1-5" },
      options: { permissions: "ask", connectors: ["dynapps-odoo"], notify: "failures", timeLimit: 30 },
      ...options,
    },
  })

// The person's task of `base`, with what they changed since.
function taskOf(base: Template, change: (definition: Definition) => Definition = (definition) => definition) {
  const made = RoutinesTemplates.activate(base, { timezone: ZONE, folder: "/work", approved: true })
  if (isFailure(made)) throw new Error(made.message)
  return change(made)
}

const withCron = (definition: Definition, cron: string): Definition => ({
  ...definition,
  schedule: { cron, timezone: definition.schedule?.timezone ?? ZONE },
})

describe("merging a new revision into a task", () => {
  test("what the template locks takes the new revision's value, and the link names it", () => {
    const base = daily(1)
    const next = daily(
      2,
      { locks: { model: true, schedule: "time", timeLimitMax: null } },
      {
        instructions: { kind: "prompt", text: "Review the project and its tickets." },
        agent: "plan",
        model: "anthropic/b",
        schedule: { cron: "0 8 * * 1-6" },
        options: { permissions: "ask", connectors: ["dynapps-odoo", "dynbrain"], notify: "failures", timeLimit: 30 },
      },
    )
    // The model was the person's to change under revision 1; revision 2 locks it.
    const task = taskOf(base, (definition) => ({ ...definition, model: "anthropic/c" }))
    const merged = RoutinesTemplates.merge({ base, next, task, zone: ZONE })
    expect(merged.changes).toEqual([])
    expect(merged.definition).toEqual({
      ...task,
      instructions: { kind: "prompt", text: "Review the project and its tickets." },
      agent: "plan",
      model: "anthropic/b",
      schedule: { cron: "0 8 * * 1-6", timezone: ZONE },
      options: { ...task.options, connectors: ["dynapps-odoo", "dynbrain"] },
      template: { id: "daily", revision: 2 },
    })
  })

  test("a default the person left as the template had it takes the new value", () => {
    const base = daily(1)
    const next = daily(
      2,
      { name: "Morning review" },
      {
        model: "anthropic/b",
        schedule: { cron: "30 7 * * 1-5" },
        options: { permissions: "ask", connectors: ["dynapps-odoo"], notify: "every", timeLimit: 45 },
      },
    )
    const task = taskOf(base)
    const merged = RoutinesTemplates.merge({ base, next, task, zone: ZONE })
    expect(merged.changes).toEqual([])
    expect(merged.definition).toMatchObject({
      name: "Morning review",
      model: "anthropic/b",
      schedule: { cron: "30 7 * * 1-5", timezone: ZONE },
      options: { notify: "every", timeLimit: 45, folder: "/work" },
    })
  })

  test("a default the person changed keeps their value and says what the template changed; their own change alone stays", () => {
    const base = daily(1)
    const next = daily(
      2,
      {},
      {
        schedule: { cron: "30 7 * * 1-5" },
        options: { permissions: "ask", connectors: ["dynapps-odoo"], notify: "every", timeLimit: 30 },
      },
    )
    const task = taskOf(base, (definition) => ({
      ...withCron(definition, "15 8 * * 1-5"),
      name: "My review",
      options: { ...definition.options, notify: "never" },
    }))
    const merged = RoutinesTemplates.merge({ base, next, task, zone: ZONE })
    expect(merged.definition).toMatchObject({
      name: "My review",
      schedule: { cron: "15 8 * * 1-5", timezone: ZONE },
      options: { notify: "never" },
      template: { id: "daily", revision: 2 },
    })
    expect(merged.changes).toEqual([
      { path: "schedule", from: "0 8 * * 1-5", to: "30 7 * * 1-5" },
      { path: "options.notify", from: "failures", to: "every" },
    ])
  })

  test("each field of a free schedule merges on its own", () => {
    const base = daily(1, { locks: { model: false, schedule: "free", timeLimitMax: null } })
    const next = daily(
      2,
      { locks: { model: false, schedule: "free", timeLimitMax: null } },
      {
        schedule: { cron: "0 8 * * 1-6" },
      },
    )
    const task = taskOf(base, (definition) => withCron(definition, "30 8 * * 1-5"))
    const merged = RoutinesTemplates.merge({ base, next, task, zone: ZONE })
    expect(merged.definition.schedule).toEqual({ cron: "30 8 * * 1-6", timezone: ZONE })
    expect(merged.changes).toEqual([])
  })

  test("permissions are a ceiling: never raised to Don't ask on their own, lowered at once", () => {
    const bypass = { permissions: "bypass" as const, connectors: ["dynapps-odoo"], notify: "failures" as const }
    const ask = { ...bypass, permissions: "ask" as const }
    // Ask → Don't ask: the person keeps asking and is told, so Apply is their confirmation.
    const raised = RoutinesTemplates.merge({
      base: daily(1, {}, { options: ask }),
      next: daily(2, {}, { options: bypass }),
      task: taskOf(daily(1, {}, { options: ask })),
      zone: ZONE,
    })
    expect(raised.definition.options.permissions).toBe("ask")
    expect(raised.changes).toEqual([{ path: "options.permissions", from: "ask", to: "bypass" }])
    // Don't ask, which the person lowered to Ask: it stays as they left it.
    const permitted = daily(1, {}, { options: bypass })
    const permissions = (value: string) =>
      taskOf(permitted, (own) => ({ ...own, options: { ...own.options, permissions: value } }))
    const lowered = RoutinesTemplates.merge({
      base: permitted,
      next: daily(2, { name: "Renamed" }, { options: bypass }),
      task: permissions("ask"),
      zone: ZONE,
    })
    expect([lowered.definition.options.permissions, lowered.changes]).toEqual(["ask", []])
    // Don't ask → Ask: the ceiling comes down for everyone.
    const capped = RoutinesTemplates.merge({
      base: permitted,
      next: daily(2, {}, { options: ask }),
      task: permissions("bypass"),
      zone: ZONE,
    })
    expect([capped.definition.options.permissions, capped.changes]).toEqual(["ask", []])
  })

  test("a time limit under a ceiling keeps the person's value up to the new ceiling", () => {
    // The ceiling is the default: 60, which the person lowered to 50.
    const locks = (max: number) => ({ locks: { model: false, schedule: "time" as const, timeLimitMax: max } })
    const options = { permissions: "ask" as const, connectors: ["dynapps-odoo"] }
    const base = daily(1, locks(60), { options })
    const task = taskOf(base, (definition) => ({ ...definition, options: { ...definition.options, timeLimit: 50 } }))
    const lower = RoutinesTemplates.merge({ base, next: daily(2, locks(40), { options }), task, zone: ZONE })
    expect([lower.definition.options.timeLimit, lower.changes]).toEqual([40, []])
    const higher = RoutinesTemplates.merge({ base, next: daily(2, locks(90), { options }), task, zone: ZONE })
    expect([higher.definition.options.timeLimit, higher.changes]).toEqual([
      50,
      [{ path: "options.timeLimit", from: 60, to: 90 }],
    ])
  })

  test("a change the person has not answered stays while their value still differs, and goes once it matches", () => {
    const base = daily(2, {}, { schedule: { cron: "30 7 * * 1-5" } })
    const next = daily(3, { name: "Morning review" }, { schedule: { cron: "30 7 * * 1-5" } })
    const previous = [{ path: "schedule", from: "0 8 * * 1-5", to: "30 7 * * 1-5" }]
    const pending = RoutinesTemplates.merge({
      base,
      next,
      task: taskOf(base, (definition) => withCron(definition, "15 8 * * 1-5")),
      zone: ZONE,
      previous,
    })
    expect(pending.changes).toEqual(previous)
    const settled = RoutinesTemplates.merge({ base, next, task: taskOf(base), zone: ZONE, previous })
    expect(settled.changes).toEqual([])
  })

  test("Apply writes the template's value of each change, in the task's own time zone", () => {
    const task = taskOf(daily(1), (definition) => ({
      ...withCron(definition, "15 8 * * 1-5"),
      options: { ...definition.options, notify: "never" },
    }))
    const applied = RoutinesTemplates.apply(task, [
      { path: "schedule", from: "0 8 * * 1-5", to: "30 7 * * 1-5" },
      { path: "options.notify", from: "failures", to: "every" },
    ])
    expect(applied).toEqual({
      ...task,
      schedule: { cron: "30 7 * * 1-5", timezone: ZONE },
      options: { ...task.options, notify: "every" },
    })
  })
})

// The person's task of `made` on Mac A, activated and synced; `personal` is what they filled in.
async function activated(
  each: ReturnType<typeof computer>,
  made: Template,
  personal: Partial<Personal> = {},
): Promise<string> {
  await each.reader.read()
  const routine = await each.local.activate?.(made.id, { timezone: ZONE, folder: "/work", ...personal })
  if (!routine || isFailure(routine)) throw new Error(routine?.message ?? "Not activated")
  await each.sync.sync()
  return routine.ref.id
}

async function read(local: RoutinesLocal.Local, id: string) {
  const routine = await local.get(id)
  if (isFailure(routine)) throw new Error(routine.message)
  return routine
}

const definitionOf = (gov: FakeGovernance, id: string) => gov.state.routines.get(id)?.definition as Definition

describe("a template's new revision on the person's computers", () => {
  test("reaches the owner's task in one write: the locked fields, the untouched defaults and the link", async () => {
    const gov = governance()
    gov.publish(daily(1))
    const a = computer(gov, "Mac A")
    const id = await activated(a, daily(1))
    gov.publish(
      daily(
        2,
        {},
        { instructions: { kind: "prompt", text: "Review the tickets too." }, schedule: { cron: "30 7 * * 1-5" } },
      ),
    )
    gov.state.requests.length = 0
    await a.sync.sync()
    expect(gov.state.requests).toEqual([
      "GET /templates -",
      "GET /changes -",
      "GET /templates/daily/revisions/1 -",
      `PUT /routines/${id} 1`,
    ])
    expect(definitionOf(gov, id)).toMatchObject({
      instructions: { kind: "prompt", text: "Review the tickets too." },
      schedule: { cron: "30 7 * * 1-5", timezone: ZONE },
      options: { folder: "/work" },
      template: { id: "daily", revision: 2 },
    })
    const routine = await read(a.local, id)
    expect([routine.conflict, routine.template?.update]).toEqual([undefined, undefined])
    expect(routine.definition.schedule?.cron).toBe("30 7 * * 1-5")
  })

  test("a default the person changed keeps their value, and the task says what the template changed", async () => {
    const gov = governance()
    gov.publish(daily(1))
    const a = computer(gov, "Mac A")
    const id = await activated(a, daily(1), { cron: "15 8 * * 1-5" })
    gov.publish(daily(2, {}, { schedule: { cron: "30 7 * * 1-5" } }))
    await a.sync.sync()
    const routine = await read(a.local, id)
    expect(routine.definition.schedule?.cron).toBe("15 8 * * 1-5")
    expect(routine.template?.update).toEqual({
      revision: 2,
      changes: [{ path: "schedule", from: "0 8 * * 1-5", to: "30 7 * * 1-5" }],
    })
    expect(definitionOf(gov, id)).toMatchObject({
      schedule: { cron: "15 8 * * 1-5" },
      template: { id: "daily", revision: 2 },
    })
  })

  test("Apply writes the template's value to Governance; Keep mine writes nothing; the notice goes either way", async () => {
    const gov = governance()
    const other = template("standup", { personal: { folder: "none", hint: null } })
    gov.publish(daily(1))
    gov.publish(other)
    const a = computer(gov, "Mac A")
    const applied = await activated(a, daily(1), { cron: "15 8 * * 1-5" })
    const kept = await activated(a, other, { cron: "45 9 * * 1-5" })
    gov.publish(daily(2, {}, { schedule: { cron: "30 7 * * 1-5" } }))
    gov.publish({ ...other, revision: 2, definition: { ...other.definition, schedule: { cron: "0 10 * * 1-5" } } })
    await a.sync.sync()

    expect(await a.local.answer?.(applied, true)).toBeUndefined()
    await a.sync.sync()
    const after = await read(a.local, applied)
    expect([after.definition.schedule, after.template?.update]).toEqual([
      { cron: "30 7 * * 1-5", timezone: ZONE },
      undefined,
    ])
    expect(definitionOf(gov, applied).schedule?.cron).toBe("30 7 * * 1-5")

    gov.state.requests.length = 0
    expect(await a.local.answer?.(kept, false)).toBeUndefined()
    await a.sync.sync()
    const mine = await read(a.local, kept)
    expect([mine.definition.schedule?.cron, mine.template?.update]).toEqual(["45 9 * * 1-5", undefined])
    expect(gov.state.requests.filter((request) => request.startsWith("PUT"))).toEqual([])
    expect(await a.local.answer?.("no-such-task", true)).toMatchObject({ code: "not-found" })
  })

  test("a 409 while it is written merges again on Governance's row: the edit made elsewhere stays, without a conflict", async () => {
    const gov = governance()
    gov.publish(daily(1))
    const a = computer(gov, "Mac A")
    const b = computer(gov, "Mac B")
    const id = await activated(a, daily(1))
    await b.sync.sync()
    gov.publish(daily(2, {}, { instructions: { kind: "prompt", text: "Review the tickets too." } }))
    // Mac A merges, and Governance does not take the write yet.
    gov.state.readOnly = true
    await a.sync.sync()
    gov.state.readOnly = false
    // Meanwhile the person renames the task on Mac B.
    await b.local.update(id, { ...(await read(b.local, id)).definition, name: "Mine" })
    await b.sync.sync()
    await a.sync.sync()
    // Mac A's write at the revision it read is refused, and its merge on Governance's row is taken.
    expect(gov.state.requests.filter((request) => request.startsWith(`PUT /routines/${id}`)).slice(-2)).toEqual([
      `PUT /routines/${id} 1`,
      `PUT /routines/${id} 2`,
    ])
    expect(definitionOf(gov, id)).toMatchObject({
      name: "Mine",
      instructions: { kind: "prompt", text: "Review the tickets too." },
      template: { id: "daily", revision: 2 },
    })
    const routine = await read(a.local, id)
    expect([routine.definition.name, routine.conflict]).toEqual(["Mine", undefined])
    expect(a.store.value.outbox).toEqual([])
  })

  test("only the owner computer merges; the others get the new revision from the feed", async () => {
    const gov = governance()
    gov.publish(daily(1))
    const a = computer(gov, "Mac A")
    const b = computer(gov, "Mac B")
    const id = await activated(a, daily(1))
    await b.sync.sync()
    gov.publish(daily(2, {}, { schedule: { cron: "30 7 * * 1-5" } }))
    gov.state.requests.length = 0
    await b.sync.sync()
    expect(gov.state.requests).toEqual(["GET /templates -", "GET /changes -"])
    expect((await read(b.local, id)).definition.template).toEqual({ id: "daily", revision: 1 })
    await a.sync.sync()
    await b.sync.sync()
    const there = await read(b.local, id)
    expect([there.definition.template, there.definition.schedule?.cron]).toEqual([
      { id: "daily", revision: 2 },
      "30 7 * * 1-5",
    ])
  })

  test("a computer that missed two revisions catches up in one merge from the revision it follows", async () => {
    const gov = governance()
    gov.publish(daily(1))
    const a = computer(gov, "Mac A")
    const id = await activated(a, daily(1), { cron: "15 8 * * 1-5" })
    gov.publish(
      daily(2, {}, { options: { permissions: "ask", connectors: ["dynapps-odoo"], notify: "every", timeLimit: 30 } }),
    )
    gov.publish(
      daily(
        3,
        {},
        {
          schedule: { cron: "30 7 * * 1-5" },
          options: { permissions: "ask", connectors: ["dynapps-odoo"], notify: "every", timeLimit: 30 },
        },
      ),
    )
    gov.state.requests.length = 0
    await a.sync.sync()
    expect(gov.state.requests.filter((request) => !request.startsWith("GET /changes"))).toEqual([
      "GET /templates -",
      "GET /templates/daily/revisions/1 -",
      `PUT /routines/${id} 1`,
    ])
    const routine = await read(a.local, id)
    expect(routine.definition).toMatchObject({
      schedule: { cron: "15 8 * * 1-5" },
      options: { notify: "every" },
      template: { id: "daily", revision: 3 },
    })
    expect(routine.template?.update).toEqual({
      revision: 3,
      changes: [{ path: "schedule", from: "0 8 * * 1-5", to: "30 7 * * 1-5" }],
    })
  })

  test("a template's write that waits stays the template's until an edit of the person's joins it", () => {
    const draft: { outbox?: Op[] } = {}
    const said = () => draft.outbox?.map((op) => [op.routine, op.kind === "put" && op.template === true])
    enqueue(draft, { kind: "put", routine: "on-its-way" })
    enqueue(draft, { kind: "put", routine: "linked", template: true })
    enqueue(draft, { kind: "put", routine: "linked", template: true })
    expect(said()).toEqual([
      ["on-its-way", false],
      ["linked", true],
    ])
    enqueue(draft, { kind: "put", routine: "linked" })
    expect(said()).toEqual([
      ["on-its-way", false],
      ["linked", false],
    ])
  })

  test("a 409 on the template's write while the person's edit waits behind it keeps Governance's row and says so", async () => {
    const gov = governance()
    gov.publish(daily(1))
    const a = computer(gov, "Mac A")
    const b = computer(gov, "Mac B")
    const id = await activated(a, daily(1))
    await b.sync.sync()
    gov.publish(daily(2, {}, { instructions: { kind: "prompt", text: "Review the tickets too." } }))
    // Mac A merges, and Governance does not take the write yet; meanwhile the task is renamed on Mac B.
    gov.state.readOnly = true
    await a.sync.sync()
    gov.state.readOnly = false
    await b.local.update(id, { ...(await read(b.local, id)).definition, name: "From B" })
    await b.sync.sync()
    // The person edits it on Mac A while the template's write is on its way.
    gov.state.meanwhile = async () => {
      await a.local.update(id, { ...(await read(a.local, id)).definition, name: "Mine" })
    }
    await a.sync.sync()
    const routine = await read(a.local, id)
    expect([routine.definition.name, routine.conflict]).toEqual(["From B", expect.any(Number)])
    // The template's change is still made, on Governance's row.
    await a.sync.sync()
    expect(definitionOf(gov, id)).toMatchObject({
      name: "From B",
      instructions: { kind: "prompt", text: "Review the tickets too." },
      template: { id: "daily", revision: 2 },
    })
    expect((await read(a.local, id)).conflict).toBeNumber()
  })

  test("a template_locked refusal while the person's edit waits behind it says so too, and that revision waits", async () => {
    const gov = governance()
    gov.publish(daily(1))
    const a = computer(gov, "Mac A")
    const id = await activated(a, daily(1))
    gov.state.history.set("daily@2", daily(2, {}, { instructions: { kind: "prompt", text: "Something else." } }))
    gov.publish(daily(2, {}, { instructions: { kind: "prompt", text: "Review the tickets too." } }))
    gov.state.meanwhile = async () => {
      await a.local.update(id, { ...(await read(a.local, id)).definition, name: "Mine" })
    }
    const puts = () => gov.state.requests.filter((request) => request.startsWith("PUT"))
    gov.state.requests.length = 0
    await a.sync.sync()
    await a.sync.sync()
    expect(puts()).toEqual([`PUT /routines/${id} 1`])
    const routine = await read(a.local, id)
    expect([routine.definition.name, routine.definition.template, routine.conflict]).toEqual([
      "Daily review",
      { id: "daily", revision: 1 },
      expect.any(Number),
    ])
    expect(a.store.value.outbox).toEqual([])
  })

  test("a merge Governance refuses as template_locked takes its row, and that revision waits for the next start", async () => {
    const gov = governance()
    gov.publish(daily(1))
    const a = computer(gov, "Mac A")
    const id = await activated(a, daily(1), { cron: "15 8 * * 1-5" })
    // Governance's revision 2 is not the one it serves: what the merge writes for it is refused.
    gov.state.history.set("daily@2", daily(2, {}, { instructions: { kind: "prompt", text: "Something else." } }))
    gov.publish(
      daily(
        2,
        {},
        { instructions: { kind: "prompt", text: "Review the tickets too." }, schedule: { cron: "30 7 * * 1-5" } },
      ),
    )
    const puts = () => gov.state.requests.filter((request) => request.startsWith("PUT"))
    gov.state.requests.length = 0
    await a.sync.sync()
    await a.sync.sync()
    expect(puts()).toEqual([`PUT /routines/${id} 1`])
    const routine = await read(a.local, id)
    expect([routine.definition.template, routine.definition.instructions, routine.definition.schedule?.cron]).toEqual([
      { id: "daily", revision: 1 },
      { kind: "prompt", text: "Review the project." },
      "15 8 * * 1-5",
    ])
    expect([routine.conflict, routine.template?.update, a.store.value.outbox]).toEqual([undefined, undefined, []])
    expect(definitionOf(gov, id).template).toEqual({ id: "daily", revision: 1 })

    // Started again, it tries that revision once more.
    a.sync.dispose()
    a.local.dispose()
    const restarted = computer(gov, "Mac A", { store: a.store })
    await restarted.sync.sync()
    expect(puts()).toEqual([`PUT /routines/${id} 1`, `PUT /routines/${id} 1`])
  })

  test("an edit of the person's refused as template_locked comes back as Governance has it, with the conflict note", async () => {
    const gov = governance()
    gov.publish(daily(1))
    const a = computer(gov, "Mac A")
    const id = await activated(a, daily(1))
    const before = (await read(a.local, id)).definition
    await a.local.update(id, { ...before, instructions: { kind: "prompt", text: "Do something else." } })
    await a.sync.sync()
    const routine = await read(a.local, id)
    expect(routine.definition.instructions).toEqual(before.instructions)
    expect(routine.conflict).toBeNumber()
    expect(a.store.value.outbox).toEqual([])
    expect(definitionOf(gov, id).instructions).toEqual(before.instructions)
  })

  test("without the revision it follows from Governance, the task waits as it is", async () => {
    const gov = governance()
    gov.publish(daily(1))
    const a = computer(gov, "Mac A")
    const id = await activated(a, daily(1))
    gov.state.history.delete("daily@1")
    gov.publish(daily(2, {}, { schedule: { cron: "30 7 * * 1-5" } }))
    gov.state.requests.length = 0
    await a.sync.sync()
    expect(gov.state.requests.filter((request) => request.startsWith("PUT"))).toEqual([])
    expect((await read(a.local, id)).definition.template).toEqual({ id: "daily", revision: 1 })
  })

  test("a closed template leaves its tasks as they are and still sends them its new revisions", async () => {
    const gov = governance()
    gov.publish(daily(1))
    const a = computer(gov, "Mac A")
    const id = await activated(a, daily(1))
    gov.close("daily")
    gov.state.requests.length = 0
    await a.sync.sync()
    expect(gov.state.requests.filter((request) => request.startsWith("PUT"))).toEqual([])
    expect((await read(a.local, id)).template?.state).toBe("closed")
    gov.publish(daily(2, {}, { schedule: { cron: "30 7 * * 1-5" } }))
    await a.sync.sync()
    expect(definitionOf(gov, id)).toMatchObject({ schedule: { cron: "30 7 * * 1-5" }, template: { revision: 2 } })
  })
})

describe("a template that is retired or out of reach", () => {
  test("retired, unlink: the task stays as an ordinary one and says the template was retired", async () => {
    const gov = governance()
    gov.publish(daily(1))
    const a = computer(gov, "Mac A")
    const id = await activated(a, daily(1), { cron: "15 8 * * 1-5" })
    // A change the person has not answered yet goes with the link.
    gov.publish(daily(2, {}, { schedule: { cron: "30 7 * * 1-5" } }))
    await a.sync.sync()
    expect(a.store.value.routines[0]?.update?.revision).toBe(2)
    gov.retire("daily", "unlink")
    await a.sync.sync()
    expect(definitionOf(gov, id).template).toBeUndefined()
    expect(a.store.value.routines[0]?.update).toBeUndefined()
    const routine = await read(a.local, id)
    expect([routine.template, routine.notice, routine.state]).toEqual([undefined, "retired", "active"])
    // Governance has no link left to say so again; the next edit here clears it.
    await a.sync.sync()
    expect((await offered(a.local)).links).toEqual([])
    expect((await read(a.local, id)).notice).toBe("retired")
    await a.local.update(id, { ...routine.definition, name: "Mine now" })
    expect((await read(a.local, id)).notice).toBeUndefined()
  })

  test("retired, pause: Governance paused it, and the task drops the link and says so", async () => {
    const gov = governance()
    gov.publish(daily(1))
    const a = computer(gov, "Mac A")
    const id = await activated(a, daily(1))
    gov.retire("daily", "pause")
    await a.sync.sync()
    expect(definitionOf(gov, id)).toMatchObject({ enabled: false })
    expect(definitionOf(gov, id).template).toBeUndefined()
    const routine = await read(a.local, id)
    expect([routine.template, routine.notice, routine.state]).toEqual([undefined, "retired-paused", "paused"])
  })

  test("retired, remove: the task goes as any removed task does", async () => {
    const gov = governance()
    gov.publish(daily(1))
    const a = computer(gov, "Mac A")
    await activated(a, daily(1))
    gov.retire("daily", "remove")
    await a.sync.sync()
    expect(await a.local.list()).toEqual([])
    expect(a.store.value.outbox).toEqual([])
  })

  test("no access: the owner pauses it once and says why; resuming is the person's, and access back resumes nothing", async () => {
    const gov = governance()
    gov.publish(daily(1))
    const a = computer(gov, "Mac A")
    const b = computer(gov, "Mac B")
    const id = await activated(a, daily(1))
    await b.sync.sync()
    gov.revoke("daily")
    gov.state.requests.length = 0
    await b.sync.sync()
    expect(gov.state.requests.filter((request) => request.startsWith("PUT"))).toEqual([])
    await a.sync.sync()
    expect(gov.state.requests.filter((request) => request.startsWith("PUT"))).toEqual([`PUT /routines/${id} 1`])
    const paused = await read(a.local, id)
    expect([paused.state, paused.notice, paused.template?.state]).toEqual(["paused", "no-access", "no_access"])
    expect(definitionOf(gov, id)).toMatchObject({ enabled: false, template: { id: "daily", revision: 1 } })

    // The person resumes it: it is not paused again.
    await a.local.resume(id)
    await a.sync.sync()
    await a.sync.sync()
    const resumed = await read(a.local, id)
    expect([resumed.state, resumed.notice]).toEqual(["active", undefined])
    expect(definitionOf(gov, id).enabled).toBe(true)

    // Paused again by a new loss; access back leaves it paused.
    gov.grant(daily(1))
    await a.sync.sync()
    gov.revoke("daily")
    await a.sync.sync()
    expect((await read(a.local, id)).state).toBe("paused")
    gov.grant(daily(1))
    await a.sync.sync()
    const back = await read(a.local, id)
    expect([back.state, back.notice, back.template?.state]).toEqual(["paused", undefined, "published"])
  })

  test("a mandatory template's task is claimed with this computer's time zone", async () => {
    const gov = governance()
    gov.publish(daily(1, { mandatory: true, personal: { folder: "none", hint: null } }))
    const a = computer(gov, "Mac A")
    await a.sync.sync()
    const rows = [...gov.state.routines.values()]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      owner_device: a.device.id,
      definition: { schedule: { cron: "0 8 * * 1-5", timezone: ZONE }, template: { id: "daily", revision: 1 } },
    })
    const listed = await a.local.list()
    if (isFailure(listed)) throw new Error(listed.message)
    expect(listed.map((routine) => [routine.definition.schedule?.timezone, routine.template?.mandatory])).toEqual([
      [ZONE, true],
    ])
    await a.sync.sync()
    expect(gov.state.routines.size).toBe(1)
  })

  test("two computers in different zones race to claim it: the other takes the winner's, with no conflict note", async () => {
    const gov = governance()
    gov.publish(daily(1, { mandatory: true, personal: { folder: "none", hint: null } }))
    gov.state.readOnly = true
    const a = computer(gov, "Mac A")
    const b = computer(gov, "Mac B", { zone: "America/New_York" })
    await a.sync.sync()
    await b.sync.sync()
    gov.state.readOnly = false
    await a.sync.sync()
    await b.sync.sync()
    const lost = b.store.value.routines
    expect(lost).toMatchObject([{ owner: { device: a.device.id }, definition: { schedule: { timezone: ZONE } } }])
    expect(lost[0]?.conflict).toBeUndefined()
  })
})
