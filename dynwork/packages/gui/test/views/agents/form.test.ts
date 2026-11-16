import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import type { Capabilities, Routine } from "../../../src/routines/contract"
import { defaults, layout } from "../../../src/views/agents/fields"
import {
  blank,
  createFormModel,
  fromRoutine,
  localProblems,
  problemText,
  toDefinition,
  unplaced,
  type Draft,
  type Problem,
} from "../../../src/views/agents/form"
import { setup, t } from "./fixture"

const ZONE = "Europe/Madrid"

type View = Awaited<ReturnType<typeof setup>>

function form(view: View, input: { routine?: Routine; backend?: string } = {}) {
  return createRoot(() =>
    createFormModel({
      client: () => view.wire.client,
      backends: view.model.backends,
      routine: input.routine,
      backend: input.backend,
      zone: ZONE,
      now: view.time.now,
    }),
  )
}

const caps = (view: View, backend: string) => view.model.capabilities(backend) as Capabilities
const said = (problem?: Problem) => problem && problemText(t, problem)

describe("a new routine starts closed and manual", () => {
  test("the local draft takes the backend's defaults: read only, no catch-all, one prompt", async () => {
    const view = await setup()
    const draft = blank(caps(view, "local"), ZONE)
    expect(draft).toMatchObject({ name: "", what: "prompt", trigger: "none", timezone: ZONE, enabled: true })
    expect(draft.options).toEqual({
      permissions: "read-only",
      ask: false,
      timeLimit: 30,
      recover: "recent",
      catchUp: 6,
      notify: "failures",
    })
  })

  test("the remote draft takes the farm's defaults, and its cost cap is off", async () => {
    const view = await setup()
    const draft = blank(caps(view, "farm"), ZONE)
    expect(draft.options).toMatchObject({
      branch: "main",
      timeLimit: 15,
      capped: false,
      overlap: "skip",
      profile: "standard",
    })
    expect(draft.options).not.toHaveProperty("budget")
  })

  test("saved as typed it is a manual routine with the backend's defaults", async () => {
    const view = await setup()
    const definition = toDefinition(
      { ...blank(caps(view, "local"), ZONE), name: " Digest ", text: "Summarise." },
      caps(view, "local"),
    )
    expect(definition).toEqual({
      name: "Digest",
      instructions: { kind: "prompt", text: "Summarise." },
      enabled: true,
      options: {
        permissions: "read-only",
        ask: false,
        timeLimit: 30,
        recover: "recent",
        catchUp: 6,
        notify: "failures",
      },
    })
  })
})

describe("the trigger becomes a schedule", () => {
  const base = async () => {
    const view = await setup()
    return { view, draft: { ...blank(caps(view, "local"), ZONE), name: "x", text: "y" } satisfies Draft }
  }

  test.each<[Partial<Draft>, string]>([
    [{ trigger: "daily", time: "09:00" }, "0 9 * * *"],
    [{ trigger: "weekdays", time: "07:30" }, "30 7 * * 1-5"],
    [{ trigger: "weekly", time: "08:45", days: [1, 3] }, "45 8 * * 1,3"],
    [{ trigger: "monthly", time: "03:00", day: 15 }, "0 3 15 * *"],
    [{ trigger: "cron", cron: "*/20 * * * *" }, "*/20 * * * *"],
  ])("%j writes %s in the chosen zone", async (patch, cron) => {
    const { view, draft } = await base()
    const definition = toDefinition({ ...draft, ...patch, timezone: "Europe/Lisbon" }, caps(view, "local"))
    expect(definition.schedule).toEqual({ cron, timezone: "Europe/Lisbon" })
  })

  test("a trigger of none leaves no schedule even when the other fields are filled", async () => {
    const { view, draft } = await base()
    expect(toDefinition({ ...draft, trigger: "none", time: "09:00" }, caps(view, "local")).schedule).toBeUndefined()
  })

  test("the window is the farm's: days in the zone, a count, and nothing locally", async () => {
    const view = await setup()
    const window = { trigger: "daily", time: "09:00", starts: "2026-12-01", ends: "2026-12-31", max: "5" } as const
    const farm = toDefinition(
      { ...blank(caps(view, "farm"), ZONE), name: "x", text: "y", ...window },
      caps(view, "farm"),
    )
    expect(farm.schedule).toEqual({
      cron: "0 9 * * *",
      timezone: ZONE,
      starts: Date.UTC(2026, 10, 30, 23),
      ends: Date.UTC(2026, 11, 31, 22, 59, 59, 999),
      max: 5,
    })
    const local = toDefinition(
      { ...blank(caps(view, "local"), ZONE), name: "x", text: "y", ...window },
      caps(view, "local"),
    )
    expect(local.schedule).toEqual({ cron: "0 9 * * *", timezone: ZONE })
  })

  test("a preset that cannot be written is a problem of the schedule, before anything is sent", async () => {
    const { view, draft } = await base()
    const problems = (patch: Partial<Draft>) => localProblems({ ...draft, ...patch }, caps(view, "local"))
    expect(Object.keys(problems({ trigger: "weekly", days: [] }))).toEqual(["schedule"])
    expect(said(problems({ trigger: "weekly", days: [] }).schedule)).toBe("Choose at least one day.")
    expect(said(problems({ trigger: "daily", time: "" }).schedule)).toBe("Choose a time.")
    expect(said(problems({ trigger: "monthly", day: 40 }).schedule)).toBe("Choose a day from 1 to 31.")
    expect(problems({ trigger: "daily", time: "09:00" })).toEqual({})
    expect(problems({ trigger: "none", days: [] })).toEqual({})
  })
})

describe("the backend's own fields in the definition", () => {
  test("a field its `when` hides is not sent, even with a value left in it", async () => {
    const view = await setup()
    const farm = caps(view, "farm")
    const draft = {
      ...blank(farm, ZONE),
      name: "x",
      text: "y",
      options: { ...defaults(farm), repository: "https://git.example.com/a.git", budget: 5 },
    }
    expect(toDefinition(draft, farm).options).not.toHaveProperty("budget")
    const capped = { ...draft, options: { ...draft.options, capped: true } }
    expect(toDefinition(capped, farm).options).toMatchObject({ capped: true, budget: 5 })
  })

  test("empty values are left out, and the backend's private keys are kept", async () => {
    const view = await setup()
    const farm = caps(view, "farm")
    const draft = {
      ...blank(farm, ZONE),
      name: "x",
      text: "y",
      options: { ...defaults(farm), label: "", plugins: [], secret: "kept" },
    }
    const options = toDefinition(draft, farm).options
    expect(options).not.toHaveProperty("label")
    expect(options).not.toHaveProperty("plugins")
    expect(options.secret).toBe("kept")
  })

  test("the agent and the model are sent only where the backend takes them", async () => {
    const view = await setup()
    const local = toDefinition(
      { ...blank(caps(view, "local"), ZONE), name: "x", text: "y", agent: "build", model: "claude-opus-5-5" },
      caps(view, "local"),
    )
    expect([local.agent, local.model]).toEqual(["build", "claude-opus-5-5"])
    const farm = toDefinition(
      { ...blank(caps(view, "farm"), ZONE), name: "x", text: "y", agent: "build", model: "m" },
      caps(view, "farm"),
    )
    expect([farm.agent, farm.model]).toEqual([undefined, undefined])
  })

  test("a skill carries its extra text only when there is some", async () => {
    const view = await setup()
    const local = caps(view, "local")
    const skill = { ...blank(local, ZONE), name: "x", what: "skill", skill: "timesheet-report" } as const
    expect(toDefinition(skill, local).instructions).toEqual({ kind: "skill", skill: "timesheet-report" })
    expect(toDefinition({ ...skill, text: "for Friday" }, local).instructions).toEqual({
      kind: "skill",
      skill: "timesheet-report",
      text: "for Friday",
    })
  })
})

describe("editing a routine reads it back as it was", () => {
  test("every routine of both demo backends survives the round trip", async () => {
    const view = await setup()
    const routines = view.model.routines()
    expect(routines.length).toBeGreaterThan(6)
    routines.forEach((routine) => {
      const capabilities = caps(view, routine.ref.backend)
      const back = toDefinition(fromRoutine(routine, capabilities), capabilities)
      const original = routine.definition
      expect([routine.definition.name, back.instructions]).toEqual([original.name, original.instructions])
      expect([back.agent, back.model, back.schedule, back.enabled]).toEqual([
        original.agent,
        original.model,
        original.schedule,
        original.enabled,
      ])
      // What the routine had is kept; the fields it never set come back with their defaults.
      expect(back.options).toMatchObject(original.options)
    })
  })

  test("a schedule that is not a preset opens as a custom cron, unchanged", async () => {
    const view = await setup()
    const routine = view.find("Sync CRM")
    const odd = {
      ...routine,
      definition: { ...routine.definition, schedule: { cron: "05 8,17 * * *", timezone: "UTC" } },
    }
    const draft = fromRoutine(odd, caps(view, "farm"))
    expect([draft.trigger, draft.cron, draft.timezone]).toEqual(["cron", "05 8,17 * * *", "UTC"])
    expect(toDefinition(draft, caps(view, "farm")).schedule).toEqual(odd.definition.schedule)
  })

  test("a cron a preset would write differently opens as custom, so saving does not rewrite it", async () => {
    const view = await setup()
    const routine = view.find("Sync CRM")
    const padded = {
      ...routine,
      definition: { ...routine.definition, schedule: { cron: "05 8 * * *", timezone: ZONE } },
    }
    const draft = fromRoutine(padded, caps(view, "farm"))
    expect(draft.trigger).toBe("cron")
    expect(toDefinition(draft, caps(view, "farm")).schedule?.cron).toBe("05 8 * * *")
  })

  test("a window reads back as the days in the schedule's zone", async () => {
    const view = await setup()
    const routine = view.find("Sync CRM")
    const schedule = { cron: "30 7 * * 1-5", timezone: ZONE, starts: Date.UTC(2026, 10, 30, 23), max: 3 }
    const draft = fromRoutine({ ...routine, definition: { ...routine.definition, schedule } }, caps(view, "farm"))
    expect([draft.starts, draft.ends, draft.max]).toEqual(["2026-12-01", "", "3"])
  })
})

describe("the form's model", () => {
  test("opens a new routine on the first backend, or on the one asked for", async () => {
    const view = await setup()
    expect(form(view).state.backend).toBe("local")
    expect(form(view, { backend: "farm" }).state.backend).toBe("farm")
    expect(form(view).mode).toBe("create")
  })

  test("opens an edit on its routine's backend and cannot move it", async () => {
    const view = await setup()
    const model = form(view, { routine: view.find("Sync CRM") })
    expect([model.mode, model.state.backend, model.state.draft.what, model.state.draft.agentRef]).toEqual([
      "edit",
      "farm",
      "agent",
      "crm-sync",
    ])
    model.choose("local")
    expect(model.state.backend).toBe("farm")
  })

  test("moving a new routine to the other backend keeps what is common and adapts the rest", async () => {
    const view = await setup()
    const model = form(view)
    model.set({
      name: "Digest",
      text: "Summarise.",
      what: "skill",
      skill: "timesheet-report",
      agent: "build",
      model: "claude-opus-5-5",
    })
    model.option("folder", "/Users/demo/support")
    model.choose("farm")
    expect(model.state.backend).toBe("farm")
    expect(model.state.draft).toMatchObject({
      name: "Digest",
      text: "Summarise.",
      what: "prompt",
      agent: "",
      model: "",
    })
    expect(model.state.draft.options).toMatchObject({ branch: "main", timeLimit: 15 })
    expect(model.state.draft.options).not.toHaveProperty("folder")
    model.choose("local")
    expect(model.state.draft.options.folder).toBe("/Users/demo/support")
  })

  test("the fields shown follow the backend and what the user has set", async () => {
    const view = await setup()
    const model = form(view, { backend: "farm" })
    expect(model.fields().where.map((item) => item.key)).not.toContain("budget")
    model.option("capped", true)
    expect(model.fields().where.map((item) => item.key)).toContain("budget")
    expect(layout(caps(view, "farm"), model.state.draft.options).where).toEqual(model.fields().where)
  })

  test("previews the next three runs in the chosen zone, across the autumn change", async () => {
    const view = await setup()
    view.time.advance(Date.UTC(2026, 9, 23, 12) - view.time.now())
    const model = form(view)
    expect(model.preview()).toEqual([])
    model.set({ trigger: "daily", time: "08:45" })
    expect(model.preview()).toEqual([
      Date.UTC(2026, 9, 24, 6, 45),
      Date.UTC(2026, 9, 25, 7, 45),
      Date.UTC(2026, 9, 26, 7, 45),
    ])
    model.set({ timezone: "UTC" })
    expect(model.preview()[0]).toBe(Date.UTC(2026, 9, 24, 8, 45))
    model.set({ trigger: "weekly", days: [] })
    expect(model.preview()).toEqual([])
  })

  test("choosing a custom cron starts from the cron of the preset it replaces", async () => {
    const view = await setup()
    const model = form(view)
    model.set({ trigger: "weekdays", time: "07:30" })
    model.setTrigger("cron")
    expect([model.state.draft.trigger, model.state.draft.cron]).toEqual(["cron", "30 7 * * 1-5"])
    model.set({ cron: "*/10 * * * *" })
    model.setTrigger("daily")
    model.setTrigger("cron")
    expect(model.state.draft.cron).toBe("*/10 * * * *")
  })

  test("warns that a run on the hour can start late, and only then", async () => {
    const view = await setup()
    const model = form(view)
    expect(model.late()).toBe(false)
    model.set({ trigger: "daily", time: "09:00" })
    expect(model.late()).toBe(true)
    model.set({ time: "09:07" })
    expect(model.late()).toBe(false)
  })
})

describe("saving", () => {
  test("creates a local routine that the list then shows, and answers its ref", async () => {
    const view = await setup()
    const model = form(view)
    model.set({ name: "Digest", text: "Summarise the inbox.", trigger: "weekdays", time: "07:30" })
    const ref = await model.save()
    expect(ref).toMatchObject({ backend: "local" })
    const created = view.model.routines().find((routine) => routine.ref.id === ref?.id)
    expect(created?.definition).toMatchObject({
      name: "Digest",
      schedule: { cron: "30 7 * * 1-5", timezone: ZONE },
      instructions: { kind: "prompt", text: "Summarise the inbox." },
    })
    expect(model.state.saving).toBe(false)
    expect(model.state.failure).toBeUndefined()
  })

  test("creates a farm routine from the farm's fields", async () => {
    const view = await setup()
    const model = form(view, { backend: "farm" })
    model.set({ name: "Audit", what: "agent", agentRef: "module-audit", text: "Check the modules." })
    model.option("repository", "https://git.example.com/odoo/modules.git")
    model.option("plugins", ["review-kit"])
    const ref = await model.save()
    expect(ref?.backend).toBe("farm")
    const created = view.model.routines().find((routine) => routine.ref.id === ref?.id)
    expect(created?.definition.instructions).toEqual({
      kind: "agent",
      agent: "module-audit",
      input: "Check the modules.",
    })
    expect(created?.definition.options).toMatchObject({
      plugins: ["review-kit"],
      repository: "https://git.example.com/odoo/modules.git",
    })
  })

  test("an invalid draft is not saved and each field gets its own message", async () => {
    const view = await setup()
    const before = view.model.routines().length
    const model = form(view, { backend: "farm" })
    model.set({ name: "  ", what: "prompt", text: "" })
    expect(await model.save()).toBeUndefined()
    expect(view.model.routines().length).toBe(before)
    expect(model.state.saving).toBe(false)
    expect(Object.keys(model.state.errors).toSorted()).toEqual(["instructions", "name", "repository"])
    expect(said(model.error("name"))).toBe("A name is required.")
    expect(said(model.error("repository"))).toBe("Repository is required.")
    expect(model.firstError()).toBe("name")
  })

  test("a field's message goes away as soon as the user changes that field, and only that one", async () => {
    const view = await setup()
    const model = form(view, { backend: "farm" })
    await model.save()
    expect(Object.keys(model.state.errors).toSorted()).toEqual(["instructions", "name", "repository"])
    model.set({ name: "x" })
    expect(Object.keys(model.state.errors).toSorted()).toEqual(["instructions", "repository"])
    model.option("repository", "https://git.example.com/a.git")
    expect(Object.keys(model.state.errors)).toEqual(["instructions"])
    model.set({ text: "y" })
    expect(model.state.errors).toEqual({})
  })

  test("a hidden field's message is not asked for: the budget only counts once the cap is on", async () => {
    const view = await setup()
    const model = form(view, { backend: "farm" })
    model.set({ name: "x", text: "y" })
    model.option("repository", "https://git.example.com/a.git")
    expect(await model.save()).toBeDefined()
    const capped = form(view, { backend: "farm" })
    capped.set({ name: "x2", text: "y" })
    capped.option("repository", "https://git.example.com/a.git")
    capped.option("capped", true)
    expect(await capped.save()).toBeUndefined()
    expect(Object.keys(capped.state.errors)).toEqual(["budget"])
  })

  test("a message for a field the form does not draw is still found, apart", async () => {
    const view = await setup()
    const model = form(view, { backend: "farm" })
    model.set({ name: "x", text: "y" })
    await model.save()
    expect(model.orphans()).toEqual([])
    expect(unplaced({ name: "Bad.", somethingElse: "Also bad.", budget: "Hidden." }, ["name", "schedule"])).toEqual([
      "somethingElse",
      "budget",
    ])
  })

  test("a failure that is not about a field is shown as a whole and keeps the form's content", async () => {
    const view = await setup()
    await Array.from({ length: 13 }).reduce<Promise<unknown>>(
      (previous, _, index) =>
        previous.then(() =>
          view.wire.client.create({
            backend: "farm",
            definition: {
              name: `Filler ${index}`,
              instructions: { kind: "prompt", text: "x" },
              schedule: { cron: "0 4 * * *", timezone: ZONE },
              enabled: true,
              options: { repository: "https://git.example.com/a.git" },
            },
          }),
        ),
      Promise.resolve(),
    )
    const model = form(view, { backend: "farm" })
    model.set({ name: "One too many", text: "y", trigger: "daily", time: "04:07" })
    model.option("repository", "https://git.example.com/a.git")
    expect(await model.save()).toBeUndefined()
    expect(model.state.failure?.code).toBe("quota")
    expect(model.state.errors).toEqual({})
    expect(model.state.draft.name).toBe("One too many")
    // The next try starts clean.
    model.set({ trigger: "none" })
    expect(await model.save()).toBeDefined()
    expect(model.state.failure).toBeUndefined()
  })

  test("a backend that is signed out says so", async () => {
    const view = await setup()
    view.farm.setStatus("signed-out")
    await view.wire.client.refresh()
    const model = form(view, { backend: "farm" })
    model.set({ name: "x", text: "y" })
    model.option("repository", "https://git.example.com/a.git")
    expect(await model.save()).toBeUndefined()
    expect(model.state.failure?.code).toBe("signed-out")
  })

  test("saves once at a time", async () => {
    const view = await setup()
    const model = form(view)
    model.set({ name: "Digest", text: "Summarise." })
    const first = model.save()
    const second = model.save()
    expect(model.state.saving).toBe(true)
    expect((await Promise.all([first, second])).filter(Boolean)).toHaveLength(1)
    expect(view.model.routines().filter((routine) => routine.definition.name === "Digest")).toHaveLength(1)
  })

  test("without the Ipc it does nothing and does not throw", async () => {
    const view = await setup()
    const model = createRoot(() =>
      createFormModel({
        client: () => undefined,
        backends: () => view.model.backends(),
        zone: ZONE,
        now: view.time.now,
      }),
    )
    model.set({ name: "x", text: "y" })
    expect(await model.save()).toBeUndefined()
    expect(model.state.saving).toBe(false)
  })
})

describe("editing and saving", () => {
  test("a local routine is updated in place and nothing else changes", async () => {
    const view = await setup()
    const routine = view.find("Weekly ticket summary")
    const model = form(view, { routine })
    model.set({ name: "Weekly tickets" })
    const ref = await model.save()
    expect(ref).toEqual(routine.ref)
    const saved = view.model.routines().find((candidate) => candidate.ref.id === routine.ref.id)
    expect(saved?.definition).toEqual({ ...routine.definition, name: "Weekly tickets" })
  })

  test("changing the schedule through the presets rewrites its cron", async () => {
    const view = await setup()
    const model = form(view, { routine: view.find("Weekly ticket summary") })
    expect([model.state.draft.trigger, model.state.draft.time, model.state.draft.days]).toEqual([
      "weekly",
      "08:45",
      [1],
    ])
    model.set({ trigger: "weekdays" })
    await model.save()
    expect(view.find("Weekly ticket summary").definition.schedule).toEqual({ cron: "45 8 * * 1-5", timezone: ZONE })
  })

  test("a farm routine is replaced: its new ref is answered, and the form says it will be", async () => {
    const view = await setup()
    const crm = view.find("Sync CRM")
    const model = form(view, { routine: crm })
    expect(model.replaces()).toBe(true)
    expect(form(view, { routine: view.find("Weekly ticket summary") }).replaces()).toBe(false)
    model.set({ name: "Sync the CRM" })
    const ref = await model.save()
    expect(ref?.backend).toBe("farm")
    expect(ref?.id).not.toBe(crm.ref.id)
    const names = view.model.routines().map((routine) => routine.definition.name)
    expect(names).toContain("Sync the CRM")
    expect(names).not.toContain("Sync CRM")
  })

  test("a routine without its schedule saved as manual loses it", async () => {
    const view = await setup()
    const model = form(view, { routine: view.find("Weekly ticket summary") })
    model.set({ trigger: "none" })
    await model.save()
    expect(view.find("Weekly ticket summary").definition.schedule).toBeUndefined()
  })
})
