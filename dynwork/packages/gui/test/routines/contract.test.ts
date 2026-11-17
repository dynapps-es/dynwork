import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  Definition,
  Failure,
  Field,
  isFailure,
  Routine,
  Routines,
  Run,
  RunState,
  Template,
  TemplateLink,
  Templates,
  type Personal,
} from "../../src/routines/contract"
import { RoutinesTemplates } from "../../src/routines/templates"
import { crossing } from "./wire"

const run = {
  ref: { backend: "local", id: "r1" },
  state: "ok",
  trigger: "schedule",
  title: "Run",
  unread: false,
  conversation: { kind: "none" },
}

describe("the routines contract", () => {
  test("its Ipc lives under the dynwork built-in and has every method the backends have, plus refresh", () => {
    expect(Routines.id).toBe("dynwork.routines")
    expect(Object.keys(Routines.spec.methods).sort()).toEqual(
      [
        "activate",
        "cancel",
        "create",
        "get",
        "list",
        "move",
        "options",
        "pause",
        "refresh",
        "remove",
        "resume",
        "runs",
        "start",
        "templates",
        "transcript",
        "update",
        "validate",
        "viewed",
        "watch",
      ].sort(),
    )
    expect(Object.keys(Routines.spec.events ?? {})).toEqual(["run", "open"])
  })

  test("a run state is one of the nine the views know", () => {
    expect(RunState.literals).toEqual([
      "queued",
      "running",
      "ok",
      "late",
      "failed",
      "blocked",
      "missed",
      "skipped",
      "cancelled",
    ])
    expect(() => Schema.decodeUnknownSync(Run)({ ...run, state: "succeeded" })).toThrow()
    expect(Schema.decodeUnknownSync(Run)({ ...run, state: "late" }).state).toBe("late")
  })

  test("a definition takes JSON options and the three kinds of instructions, and nothing else", () => {
    const base = { name: "N", enabled: true, options: { list: ["a"], nested: { n: 1 }, nothing: null } }
    expect(Schema.decodeUnknownSync(Definition)({ ...base, instructions: { kind: "prompt", text: "x" } })).toBeDefined()
    expect(Schema.decodeUnknownSync(Definition)({ ...base, instructions: { kind: "skill", skill: "s" } })).toBeDefined()
    expect(
      Schema.decodeUnknownSync(Definition)({ ...base, instructions: { kind: "agent", agent: "a", input: "i" } }),
    ).toBeDefined()
    expect(() =>
      Schema.decodeUnknownSync(Definition)({ ...base, instructions: { kind: "macro", text: "x" } }),
    ).toThrow()
    expect(() => Schema.decodeUnknownSync(Definition)({ ...base, instructions: { kind: "prompt" } })).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Definition)({
        ...base,
        instructions: { kind: "prompt", text: "x" },
        options: { fn: () => 1 },
      }),
    ).toThrow()
  })

  test("a field's kind is one of the nine the form paints, and `when` carries a key and a value", () => {
    const field = { key: "k", section: "s", label: "L", kind: "repo", when: { key: "other", equals: true } }
    expect(Schema.decodeUnknownSync(Field)(field).when).toEqual({ key: "other", equals: true })
    expect(() => Schema.decodeUnknownSync(Field)({ ...field, kind: "colour" })).toThrow()
  })

  test("a failure is data with a code, and every answer that may fail takes one in place of its value", () => {
    const failure: Failure = { code: "not-found", message: "No.", retryable: false }
    expect(Schema.decodeUnknownSync(Failure)(failure)).toEqual(failure)
    expect(() => Schema.decodeUnknownSync(Failure)({ ...failure, code: "boom" })).toThrow()
    const { get, list, start, validate, options, transcript } = Routines.spec.methods
    // A transcript has only optional fields: a failure must not pass for an empty one.
    expect(Schema.decodeUnknownSync(transcript.output)(failure)).toEqual(failure)
    expect(Schema.decodeUnknownSync(transcript.output)({ result: "Done." })).toEqual({ result: "Done." })
    expect(Schema.decodeUnknownSync(get.output)(failure)).toEqual(failure)
    expect(Schema.decodeUnknownSync(list.output)(failure)).toEqual(failure)
    expect(Schema.decodeUnknownSync(start.output)(failure)).toEqual(failure)
    expect(Schema.decodeUnknownSync(options.output)(failure)).toEqual(failure)
    expect(Schema.decodeUnknownSync(validate.output)(undefined)).toBeUndefined()
    expect(Schema.decodeUnknownSync(validate.output)(failure)).toEqual(failure)
    expect(() => Schema.decodeUnknownSync(get.output)({ code: "not-found" })).toThrow()
  })

  test("isFailure tells a failure from a routine, a run and nothing", () => {
    expect(isFailure({ code: "failed", message: "x", retryable: false })).toBe(true)
    expect(isFailure(run)).toBe(false)
    expect(isFailure(undefined)).toBe(false)
    expect(isFailure(null)).toBe(false)
    expect(isFailure("failed")).toBe(false)
    expect(isFailure([])).toBe(false)
  })
})

// The example of the contract's §1, as Governance sends it.
const template = {
  id: "daily-odoo-review",
  revision: 4,
  name: "Daily Odoo review",
  description: "Review yesterday's Odoo activity.",
  mandatory: false,
  where: "local",
  definition: {
    instructions: { kind: "prompt", text: "Review yesterday's Odoo activity and list what needs a follow-up." },
    agent: "build",
    model: "claude-sonnet-5-5",
    schedule: { cron: "0 8 * * 1-5" },
    options: { permissions: "ask", connectors: ["dynapps-odoo"], timeLimit: 30, notify: "failures" },
  },
  locks: { model: false, schedule: "free", timeLimitMax: null },
  personal: { folder: "none", hint: null },
}

const decoded = (patch: Record<string, unknown> = {}) => Schema.decodeUnknownSync(Template)({ ...template, ...patch })
const locks = (patch: Partial<Template["locks"]>) => decoded({ locks: { ...template.locks, ...patch } })
const options = (patch: Record<string, unknown>) =>
  decoded({ definition: { ...template.definition, options: { ...template.definition.options, ...patch } } })
const madrid: Personal = { timezone: "Europe/Madrid" }

// A task activated from `source` with nothing personal but its zone.
function activated(source: Template, personal: Personal = madrid) {
  const definition = RoutinesTemplates.activate(source, personal)
  if (isFailure(definition)) throw new Error(`${definition.message} ${JSON.stringify(definition.fields)}`)
  return definition
}

describe("a template", () => {
  test("decodes the contract's example, with `where` cloud too, and refuses what the contract does not name", () => {
    expect(decoded()).toMatchObject({ id: "daily-odoo-review", revision: 4, where: "local" })
    expect(decoded({ where: "cloud" }).where).toBe("cloud")
    expect(() => decoded({ where: "farm" })).toThrow()
    expect(() => locks({ schedule: "weekly" as never })).toThrow()
    expect(() => options({ permissions: "always" })).toThrow()
    expect(() => decoded({ personal: { folder: "optional", hint: null } })).toThrow()
    expect(crossing(Template, decoded())).toEqual(decoded())
  })

  test("never carries a time zone: one sent is dropped", () => {
    const zoned = decoded({
      definition: { ...template.definition, schedule: { cron: "0 8 * * 1-5", timezone: "UTC" } },
    })
    expect(zoned.definition.schedule).toEqual({ cron: "0 8 * * 1-5" })
  })

  test("the answer of `templates` holds the templates and a link per template the caller has a task of", () => {
    const answer = { templates: [template], links: [{ id: "daily-odoo-review", state: "retired", retire: "pause" }] }
    expect(Schema.decodeUnknownSync(Templates)(answer).links[0]).toEqual({
      id: "daily-odoo-review",
      state: "retired",
      retire: "pause",
    })
    expect(Schema.decodeUnknownSync(TemplateLink)({ id: "x", state: "no_access", retire: null }).retire).toBeNull()
    expect(() => Schema.decodeUnknownSync(TemplateLink)({ id: "x", state: "gone", retire: null })).toThrow()
    expect(() => Schema.decodeUnknownSync(TemplateLink)({ id: "x", state: "retired", retire: "archive" })).toThrow()
  })

  test("a task carries its link next to its name, and a routine what the views need of its template", () => {
    const task = activated(decoded())
    expect(crossing(Definition, task).template).toEqual({ id: "daily-odoo-review", revision: 4 })
    const routine = {
      ref: { backend: "local", id: "t1" },
      definition: task,
      state: "active",
      unread: 0,
      conversation: { kind: "none" },
      updated: 0,
      template: {
        id: "daily-odoo-review",
        name: "Daily Odoo review",
        locked: RoutinesTemplates.locked(decoded()),
        state: "published",
        mandatory: false,
        update: { revision: 5 },
      },
    }
    expect(crossing(Routine, routine)).toEqual(Schema.decodeUnknownSync(Routine)(routine))
    expect(() =>
      Schema.decodeUnknownSync(Routine)({ ...routine, template: { ...routine.template, state: "x" } }),
    ).toThrow()
  })

  test("its Ipc calls answer a failure in place of their value", () => {
    const failure: Failure = { code: "unsupported", message: "No.", retryable: false }
    const { templates, activate } = Routines.spec.methods
    expect(Schema.decodeUnknownSync(templates.output)(failure)).toEqual(failure)
    expect(Schema.decodeUnknownSync(activate.output)(failure)).toEqual(failure)
    expect(Schema.decodeUnknownSync(templates.output)({ templates: [], links: [] })).toEqual({
      templates: [],
      links: [],
    })
  })
})

describe("what a template locks", () => {
  const always = ["instructions", "agent", "where", "options.connectors", "options.permissions"]

  test.each([
    { schedule: "free" as const, paths: [] },
    { schedule: "time" as const, paths: ["schedule.day", "schedule.month", "schedule.weekday"] },
    {
      schedule: "locked" as const,
      paths: ["schedule.minute", "schedule.hour", "schedule.day", "schedule.month", "schedule.weekday"],
    },
  ])("a $schedule schedule locks the always-locked fields and its cron fields", (row) => {
    expect(RoutinesTemplates.locked(locks({ schedule: row.schedule }))).toEqual([...always, ...row.paths])
  })

  test("the model and the time limit only when the template says so", () => {
    expect(RoutinesTemplates.locked(locks({ model: true, timeLimitMax: 60 }))).toEqual([
      ...always,
      "model",
      "options.timeLimit",
    ])
  })
})

describe("an edit of a linked task", () => {
  const strict = locks({ model: true, schedule: "locked", timeLimitMax: 45 })
  const task = activated(strict)

  test.each([
    { path: "instructions", after: { ...task, instructions: { kind: "prompt" as const, text: "Something else." } } },
    { path: "agent", after: { ...task, agent: "plan" } },
    { path: "options.connectors", after: { ...task, options: { ...task.options, connectors: ["dynbrain"] } } },
    { path: "options.permissions", after: { ...task, options: { ...task.options, permissions: "bypass" } } },
    { path: "model", after: { ...task, model: "claude-opus-5-5" } },
    { path: "schedule.hour", after: { ...task, schedule: { cron: "0 9 * * 1-5", timezone: "Europe/Madrid" } } },
    { path: "options.timeLimit", after: { ...task, options: { ...task.options, timeLimit: 60 } } },
  ])("that changes $path violates the template", (row) => {
    expect(RoutinesTemplates.violates(strict, task, row.after)).toEqual([row.path])
  })

  test("that changes the weekdays of a frequency-locked schedule violates it, the time does not", () => {
    const timed = locks({ schedule: "time" })
    const own = activated(timed)
    expect(
      RoutinesTemplates.violates(timed, own, { ...own, schedule: { cron: "30 6 * * 1-5", timezone: "Europe/Madrid" } }),
    ).toEqual([])
    expect(
      RoutinesTemplates.violates(timed, own, { ...own, schedule: { cron: "0 8 * * 1", timezone: "Europe/Madrid" } }),
    ).toEqual(["schedule.weekday"])
    expect(RoutinesTemplates.violates(timed, own, { ...own, schedule: undefined })).toEqual([
      "schedule.day",
      "schedule.month",
      "schedule.weekday",
    ])
  })

  test("of the free fields, a lower time limit or fewer permissions violates nothing", () => {
    const bypass = decoded({
      definition: { ...template.definition, options: { ...template.definition.options, permissions: "bypass" } },
      locks: { model: true, schedule: "locked", timeLimitMax: 45 },
      personal: { folder: "required", hint: null },
    })
    const own = activated(bypass, { ...madrid, folder: "/work", approved: true })
    const after = {
      ...own,
      name: "Mine",
      enabled: false,
      schedule: { cron: "0 8 * * 1-5", timezone: "Atlantic/Canary" },
      options: {
        ...own.options,
        permissions: "ask",
        timeLimit: 10,
        recover: "none",
        catchUp: 2,
        notify: "never",
        folder: "/elsewhere",
      },
    }
    expect(RoutinesTemplates.violates(bypass, own, after)).toEqual([])
  })

  test("a locked field the edit does not touch is not its violation", () => {
    const stale = { ...task, agent: "plan" }
    expect(RoutinesTemplates.violates(strict, stale, { ...stale, name: "Renamed" })).toEqual([])
  })
})

describe("activating a template", () => {
  test("makes the template's task with the person's zone and folder, linked to its revision", () => {
    const own = activated(decoded({ personal: { folder: "required", hint: "Your project." } }), {
      timezone: "Europe/Madrid",
      folder: "/Users/me/portal",
    })
    expect(own).toEqual({
      name: "Daily Odoo review",
      instructions: template.definition.instructions,
      agent: "build",
      model: "claude-sonnet-5-5",
      schedule: { cron: "0 8 * * 1-5", timezone: "Europe/Madrid" },
      enabled: true,
      options: {
        permissions: "ask",
        connectors: ["dynapps-odoo"],
        timeLimit: 30,
        notify: "failures",
        folder: "/Users/me/portal",
      },
      template: { id: "daily-odoo-review", revision: 4 },
    })
  })

  test("takes the person's time and model where the template leaves them free, and the ceiling as the limit", () => {
    const own = activated(
      decoded({
        definition: { ...template.definition, options: { permissions: "ask", connectors: ["dynapps-odoo"] } },
        locks: { model: false, schedule: "time", timeLimitMax: 20 },
      }),
      { ...madrid, cron: "15 7 * * 1-5", model: "claude-opus-5-5" },
    )
    expect(own.schedule).toEqual({ cron: "15 7 * * 1-5", timezone: "Europe/Madrid" })
    expect(own.model).toBe("claude-opus-5-5")
    expect(own.options.timeLimit).toBe(20)
  })

  test("refuses a missing folder the template requires", () => {
    const answer = RoutinesTemplates.activate(decoded({ personal: { folder: "required", hint: null } }), madrid)
    expect(isFailure(answer) ? answer : undefined).toMatchObject({
      code: "invalid",
      fields: { folder: expect.any(String) },
    })
  })

  test("refuses a template that runs without asking until the person confirms it", () => {
    const bypass = decoded({
      definition: { ...template.definition, options: { ...template.definition.options, permissions: "bypass" } },
      personal: { folder: "required", hint: null },
    })
    const unconfirmed = RoutinesTemplates.activate(bypass, { ...madrid, folder: "/work" })
    expect(isFailure(unconfirmed) ? unconfirmed : undefined).toMatchObject({
      code: "invalid",
      fields: { permissions: expect.any(String) },
    })
    expect(activated(bypass, { ...madrid, folder: "/work", approved: true }).options.permissions).toBe("bypass")
  })

  test("refuses a personal value the template locks, a Cloud template and a missing zone", () => {
    const strict = locks({ model: true, schedule: "time" })
    const changed = RoutinesTemplates.activate(strict, { ...madrid, cron: "0 8 1 * *", model: "claude-opus-5-5" })
    expect(isFailure(changed) ? changed.fields : undefined).toEqual({
      schedule: expect.any(String),
      model: expect.any(String),
    })
    const cloud = RoutinesTemplates.activate(decoded({ where: "cloud" }), madrid)
    expect(isFailure(cloud) ? Object.keys(cloud.fields ?? {}) : []).toEqual(["where"])
    const zoneless = RoutinesTemplates.activate(decoded(), { timezone: " " })
    expect(isFailure(zoneless) ? Object.keys(zoneless.fields ?? {}) : []).toEqual(["schedule"])
  })
})
