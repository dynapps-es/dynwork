import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { RoutinesBackend } from "../../../src/routines/backend"
import { isFailure, type Routine, type Template } from "../../../src/routines/contract"
import { RoutinesFake } from "../../../src/routines/fake"
import { RoutinesLocal } from "../../../src/routines/local/backend"
import { asks, createFormModel, personalOf, problemText } from "../../../src/views/agents/form"
import { createAgentsModel, templateCard } from "../../../src/views/agents/model"
import { clock } from "../../routines/fixture"
import { connect } from "../../routines/wire"
import { setup, t } from "./fixture"

const ZONE = "Europe/Madrid"

const template = (id: string, extra: Partial<Template> = {}): Template => ({
  id,
  revision: 2,
  name: `Template ${id}`,
  description: "A task the whole team runs.",
  mandatory: false,
  where: "local",
  definition: {
    instructions: { kind: "prompt", text: "Review the project." },
    model: "anthropic/claude-sonnet-5-5",
    schedule: { cron: "0 9 * * 1-5" },
    options: { permissions: "ask", connectors: ["dynbrain"] },
  },
  locks: { model: false, schedule: "free", timeLimitMax: null },
  personal: { folder: "none", hint: null },
  ...extra,
})

const routine = (id: string, linked: string, here: boolean): Routine => ({
  ref: { backend: "local", id },
  definition: {
    name: id,
    instructions: { kind: "prompt", text: "Review." },
    enabled: true,
    options: {},
    template: { id: linked, revision: 1 },
  },
  state: "active",
  unread: 0,
  owner: { label: here ? "Demo MacBook" : "Home laptop", online: here, here },
  conversation: { kind: "none" },
  updated: 0,
})

describe("a template's card", () => {
  const review = template("review")

  test("available: nothing of it here, and its connectors are", () => {
    expect(templateCard({ template: review, links: [], routines: [], connectors: ["dynbrain", "odoo"] })).toEqual({
      kind: "available",
    })
  })

  test("active here or on another computer: the person's routine of it, which the card opens", () => {
    const mine = routine("here", "review", true)
    const theirs = routine("there", "review", false)
    expect(templateCard({ template: review, links: [], routines: [mine] })).toEqual({ kind: "active", routine: mine })
    expect(templateCard({ template: review, links: [], routines: [theirs] })).toEqual({
      kind: "active",
      routine: theirs,
    })
  })

  test("active on a computer whose routine is not here yet: Governance links it", () => {
    expect(
      templateCard({ template: review, links: [{ id: "review", state: "published", retire: null }], routines: [] }),
    ).toEqual({ kind: "active" })
  })

  test("a connector this computer lacks is named, once the connectors are known", () => {
    expect(templateCard({ template: review, links: [], routines: [], connectors: ["odoo"] })).toEqual({
      kind: "requires",
      server: "dynbrain",
    })
    expect(templateCard({ template: review, links: [], routines: [] })).toEqual({ kind: "available" })
  })

  test("mandatory: assigned by Dynapps, never used by hand, and opened once its routine is here", () => {
    const assigned = template("timesheet", { mandatory: true })
    const arrived = routine("timesheet", "timesheet", false)
    expect(templateCard({ template: assigned, links: [], routines: [], connectors: [] })).toEqual({ kind: "assigned" })
    expect(templateCard({ template: assigned, links: [], routines: [arrived] })).toEqual({
      kind: "assigned",
      routine: arrived,
    })
  })
})

describe("the Templates tab", () => {
  test("lists the templates of the backends that have them, each with its card", async () => {
    const view = await setup()
    await view.model.loadTemplates(true)
    expect(view.model.offered().map((item) => [item.backend, item.template.id, item.card.kind])).toEqual([
      ["local", "project-health", "available"],
      ["local", "timesheet-draft", "assigned"],
    ])
    const assigned = view.model.offered()[1]?.card
    expect(assigned?.kind === "assigned" && assigned.routine?.definition.name).toBe("Timesheet draft")
    // The farm's demo has no templates: no failure for it either.
    expect(view.model.offeredPage()).toEqual({ loading: false, failures: [] })
  })

  test("a template once used is active, and its card opens the routine", async () => {
    const view = await setup()
    await view.model.loadTemplates(true)
    const made = await view.wire.client.activate({
      backend: "local",
      template: "project-health",
      personal: { timezone: ZONE, folder: "/work/odoo" },
    })
    if (isFailure(made)) throw new Error(made.message)
    await view.model.loadTemplates()
    const card = view.model.offered()[0]?.card
    expect(card?.kind).toBe("active")
    expect(card?.kind === "active" && card.routine?.ref).toEqual(made.ref)
  })
})

describe("what an activation asks", () => {
  test.each([
    ["free schedule, model locked", { model: true, schedule: "free" as const }, ["free", false]],
    ["fixed frequency, model free and here", { model: false, schedule: "time" as const }, ["time", false]],
    ["everything locked", { model: true, schedule: "locked" as const }, ["locked", false]],
  ])("%s", (_, locks, expected) => {
    const asked = asks(template("review", { locks: { ...locks, timeLimitMax: null } }), ["anthropic/claude-sonnet-5-5"])
    expect([asked.schedule, asked.model]).toEqual(expected)
  })

  test("the model only where the template's is not on this computer and it may change", () => {
    const missing = ["openai/gpt-6"]
    expect(asks(template("review"), missing).model).toBe(true)
    expect(asks(template("review"), undefined).model).toBe(false)
    expect(
      asks(template("review", { locks: { model: true, schedule: "free", timeLimitMax: null } }), missing).model,
    ).toBe(false)
  })

  test("the folder with its hint where it is required, the confirmation where it runs without asking", () => {
    const needs = template("review", {
      personal: { folder: "required", hint: "The project it reviews." },
      definition: { ...template("review").definition, options: { permissions: "bypass", connectors: ["dynbrain"] } },
    })
    expect(asks(needs)).toMatchObject({ folder: true, hint: "The project it reviews.", confirm: true })
    expect(asks(template("review"))).toMatchObject({ folder: false, confirm: false })
  })

  test("a template without a schedule leaves it free", () => {
    const manual = template("review", {
      locks: { model: false, schedule: "locked", timeLimitMax: null },
      definition: { ...template("review").definition, schedule: undefined },
    })
    expect(asks(manual).schedule).toBe("free")
  })
})

describe("the activation form", () => {
  test("starts from the template, keeps a schedule, and needs the folder before it activates", async () => {
    const view = await setup()
    await view.model.loadTemplates(true)
    const offered = view.model.offered()[0]?.template
    if (!offered) throw new Error("No template")
    const form = createRoot(() =>
      createFormModel({
        client: () => view.wire.client,
        backends: view.model.backends,
        template: offered,
        backend: "local",
        zone: ZONE,
        now: view.time.now,
        models: () => ["claude-sonnet-5-5"],
      }),
    )
    expect(form.mode).toBe("activate")
    expect(form.state.draft).toMatchObject({
      name: "Project health check",
      what: "prompt",
      trigger: "weekdays",
      time: "09:00",
      timezone: ZONE,
      model: "claude-sonnet-5-5",
    })
    expect(form.triggers()).not.toContain("none")
    expect(form.asks()).toMatchObject({ folder: true, schedule: "time", model: false, confirm: false })
    const before = view.model.routines().length
    expect(await form.save()).toBeUndefined()
    expect(problemText(t, form.error("folder") ?? "")).toBe("Choose the project folder this task works in.")
    await view.wire.client.refresh()
    expect(view.model.routines()).toHaveLength(before)
    form.option("folder", "/work/odoo")
    form.set({ time: "07:30" })
    const ref = await form.save()
    if (!ref) throw new Error(JSON.stringify(form.state.errors))
    const made = await view.wire.client.get(ref)
    if (isFailure(made)) throw new Error(made.message)
    expect(made.definition).toMatchObject({
      template: { id: "project-health", revision: 2 },
      schedule: { cron: "30 7 * * 1-5", timezone: ZONE },
      options: { folder: "/work/odoo" },
    })
  })

  test("a template that runs without asking needs the person's confirmation", async () => {
    const bypass = template("cleanup", {
      definition: {
        instructions: { kind: "prompt", text: "Tidy up." },
        schedule: { cron: "0 9 * * 1-5" },
        options: { permissions: "bypass", connectors: ["dynbrain"] },
      },
      personal: { folder: "required", hint: null },
    })
    const time = clock()
    const registry = RoutinesBackend.make()
    registry.register(
      RoutinesFake.make({
        id: "local",
        capabilities: {
          kind: "local",
          label: "Demo MacBook",
          status: "ready",
          instructions: ["prompt", "skill"],
          agent: "optional",
          model: "choose",
          schedule: { window: false, minimum: 5 },
          actions: { edit: "in-place", reply: "in-place", cancel: true },
          fields: RoutinesLocal.fields,
        },
        templates: [bypass],
        conversation: "session",
        now: time.now,
      }),
    )
    const wire = connect(registry)
    await wire.client.refresh()
    const agents = createRoot(() => createAgentsModel({ client: () => wire.client }))
    const form = createRoot(() =>
      createFormModel({
        client: () => wire.client,
        backends: agents.backends,
        template: bypass,
        backend: "local",
        zone: ZONE,
        now: time.now,
      }),
    )
    form.option("folder", "/work")
    expect(await form.save()).toBeUndefined()
    expect(problemText(t, form.error("permissions") ?? "")).toBe("Confirm that it runs without asking.")
    form.approve(true)
    expect(form.error("permissions")).toBeUndefined()
    const ref = await form.save()
    if (!ref) throw new Error(JSON.stringify(form.state.errors))
    const made = await wire.client.get(ref)
    if (isFailure(made)) throw new Error(made.message)
    expect(made.definition.options).toMatchObject({ permissions: "bypass", folder: "/work" })
  })

  test("what it sends is only the person's: the zone, the folder, the time, the model and the confirmation", () => {
    const review = template("review", {
      locks: { model: false, schedule: "locked", timeLimitMax: null },
      personal: { folder: "required", hint: null },
    })
    const draft = {
      ...createRoot(() =>
        createFormModel({ client: () => undefined, backends: () => [], template: review, zone: ZONE, now: Date.now }),
      ).state.draft,
      options: { folder: " /work ", notify: "every" },
      model: "openai/gpt-6",
    }
    expect(personalOf(draft, asks(review, ["anthropic/claude-sonnet-5-5"]), false)).toEqual({
      timezone: ZONE,
      folder: "/work",
    })
    expect(personalOf(draft, asks(review, ["openai/gpt-6"]), false)).toEqual({
      timezone: ZONE,
      folder: "/work",
      model: "openai/gpt-6",
    })
  })
})
