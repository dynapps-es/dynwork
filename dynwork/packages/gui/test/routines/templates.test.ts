import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { MainContext } from "@opencode/plugin/gui/main"
import { isFailure, type Template } from "../../src/routines/contract"
import { RoutinesMain } from "../../src/routines/main"
import { RoutinesTemplates } from "../../src/routines/templates"
import { RoutinesLocal } from "../../src/routines/local/backend"
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
function computer(gov: FakeGovernance, name: string, input: { account?: () => RoutinesSync.Account | undefined } = {}) {
  const active = input.account ?? (() => account(gov))
  const store = storage(RoutinesLocal.Saved, RoutinesLocal.initial)
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
  })
  shared.sync = sync
  stops.push(local.dispose, sync.dispose)
  return { store, local, reader, sync, shared }
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
    expect(await b.local.list()).toEqual([])
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
