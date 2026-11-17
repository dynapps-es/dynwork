import { describe, expect, test } from "bun:test"
import type { DynWorkRoutines } from "@dynwork/server-plugin/routines"
import { RoutinesBackend, type Backend } from "../../src/routines/backend"
import { RoutinesChat } from "../../src/routines/chat"
import { Card, chatPrompt, isFailure, type Definition, type Routine, type Template } from "../../src/routines/contract"
import { RoutinesDemo } from "../../src/routines/demo"
import { RoutinesFarm } from "../../src/routines/farm/backend"
import { clock } from "./fixture"
import { crossing } from "./wire"

// Routines from a chat, main's side: the tools' requests arrive as the server plugin publishes them, and every answer
// the tool would read is recorded. The local backend is the local demo fake, which validates as the real one does.

const proposal: DynWorkRoutines.Proposal = {
  name: "Daily cluster check",
  instructions: "Check the es-prod-01 cluster, read only, and say whether all is well.",
  repeat: "daily",
  time: "08:00",
}

function stand(options: { farm?: Backend; farmEnabled?: boolean } = {}) {
  const time = clock()
  const registry = RoutinesBackend.make()
  const local = RoutinesDemo.local(time.now)
  registry.register(local)
  if (options.farm) registry.register(options.farm)
  const answers: DynWorkRoutines.Answer[] = []
  const changes = { count: 0 }
  const on = (id: string) => {
    const target = registry.get(id)
    if (!target) throw new Error(`no backend ${id}`)
    return target
  }
  const chat = RoutinesChat.make({
    registry,
    farm: options.farmEnabled ?? false,
    answer: async (answer) => void answers.push(answer),
    act: {
      create: async (backend, definition) => on(backend).create(definition),
      update: async (ref, definition) => on(ref.backend).update(ref.id, definition),
      remove: async (ref) => on(ref.backend).remove(ref.id),
      pause: async (ref) => on(ref.backend).pause(ref.id),
      resume: async (ref) => on(ref.backend).resume(ref.id),
      start: async (ref) => on(ref.backend).start(ref.id),
    },
    changed: () => void changes.count++,
    now: time.now,
  })
  const names = async () => {
    const list = await local.list()
    if (isFailure(list)) throw new Error(list.message)
    return list.map((routine: Routine) => routine.definition.name)
  }
  const routine = async (id: string) => {
    const found = await local.get(id)
    if (isFailure(found)) throw new Error(found.message)
    return found
  }
  return { chat, answers, changes, names, local, routine }
}

const propose = (id: string, value: DynWorkRoutines.Proposal = proposal): DynWorkRoutines.Request => ({
  id,
  session: "ses_chat",
  kind: "propose",
  proposal: value,
})

describe("a proposal", () => {
  test("shows a card and creates nothing until the user presses Schedule", async () => {
    const subject = stand()
    const before = await subject.names()
    await subject.chat.request(propose("call_1"))
    const cards = subject.chat.cards()
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ id: "call_1", session: "ses_chat", backend: "local", label: "Demo MacBook" })
    expect(cards[0]?.definition).toEqual({
      name: "Daily cluster check",
      instructions: { kind: "prompt", text: proposal.instructions },
      schedule: { cron: "0 8 * * *", timezone: "Europe/Madrid" },
      enabled: true,
      options: { permissions: "ask", notify: "failures" },
    })
    // The card crosses to a window as the Ipc carries it.
    expect(crossing(Card, cards[0])).toEqual(cards[0])
    expect(subject.changes.count).toBe(1)
    expect(subject.answers).toEqual([])
    expect(await subject.names()).toEqual(before)

    expect(await subject.chat.decide("call_1", true)).toBeUndefined()
    expect(subject.chat.cards()).toEqual([])
    expect(await subject.names()).toEqual([...before, "Daily cluster check"])
    expect(subject.answers).toHaveLength(1)
    expect(subject.answers[0]).toMatchObject({ id: "call_1", error: false })
    expect(subject.answers[0]?.text).toMatch(/- local:\S+ · Daily cluster check · Demo MacBook · Every day at 08:00 \(Europe\/Madrid\)/)
  })

  test("Cancel creates nothing and tells the agent", async () => {
    const subject = stand()
    const before = await subject.names()
    await subject.chat.request(propose("call_2"))
    expect(await subject.chat.decide("call_2", false)).toBeUndefined()
    expect(subject.chat.cards()).toEqual([])
    expect(await subject.names()).toEqual(before)
    expect(subject.answers).toEqual([
      {
        id: "call_2",
        text: "The user cancelled: nothing was created. Ask what to change before proposing again.",
        error: true,
      },
    ])
  })

  test("is decided once: a second answer, from another window, creates nothing", async () => {
    const subject = stand()
    const before = await subject.names()
    await subject.chat.request(propose("call_3"))
    const [first, second] = await Promise.all([
      subject.chat.decide("call_3", true),
      subject.chat.decide("call_3", true),
    ])
    expect(first).toBeUndefined()
    expect(second).toMatchObject({ code: "not-found" })
    expect(await subject.names()).toHaveLength(before.length + 1)
  })

  test("that is invalid is refused before any card", async () => {
    const subject = stand()
    const before = await subject.names()
    await subject.chat.request(propose("call_time", { ...proposal, time: "8am" }))
    await subject.chat.request(propose("call_cron", { ...proposal, repeat: "cron", cron: "every morning" }))
    await subject.chat.request(propose("call_name", { ...proposal, name: "  " }))
    expect(subject.chat.cards()).toEqual([])
    expect(subject.changes.count).toBe(0)
    expect(await subject.names()).toEqual(before)
    expect(subject.answers.map((answer) => [answer.id, answer.error])).toEqual([
      ["call_time", true],
      ["call_cron", true],
      ["call_name", true],
    ])
    expect(subject.answers[0]?.text).toContain("- schedule: Choose a time.")
    expect(subject.answers[1]?.text).toContain("schedule:")
    expect(subject.answers[2]?.text).toContain("name: A name is required.")
    expect(subject.answers.every((answer) => answer.text.endsWith("Nothing was created."))).toBe(true)
  })

  test("that the tool withdrew (the user stopped the step) leaves no card to schedule", async () => {
    const subject = stand()
    const before = await subject.names()
    await subject.chat.request(propose("call_4"))
    subject.chat.withdraw("call_4")
    expect(subject.chat.cards()).toEqual([])
    expect(await subject.chat.decide("call_4", true)).toMatchObject({ code: "not-found" })
    expect(await subject.names()).toEqual(before)
  })

  test("read again after main reconnects is shown once, and one the service no longer holds is dropped", async () => {
    const subject = stand()
    await subject.chat.request(propose("call_5"))
    await subject.chat.sync([propose("call_5"), propose("call_6")])
    expect(subject.chat.cards().map((card) => card.id)).toEqual(["call_5", "call_6"])
    await subject.chat.sync([propose("call_6")])
    expect(subject.chat.cards().map((card) => card.id)).toEqual(["call_6"])
  })

  test("takes the form's options: weekly days, Don't ask, a folder, connectors and notifications", () => {
    const definition = RoutinesChat.definitionOf(
      {
        ...proposal,
        repeat: "weekly",
        days: [5, 1],
        timezone: "UTC",
        permissions: "bypass",
        folder: "/Users/me/ops",
        connectors: ["github"],
        notify: "every",
      },
      Date.UTC(2026, 10, 16),
    )
    expect(definition).toMatchObject({
      schedule: { cron: "0 8 * * 1,5", timezone: "UTC" },
      options: { permissions: "bypass", folder: "/Users/me/ops", connectors: ["github"], notify: "every" },
    })
    expect(RoutinesChat.definitionOf({ ...proposal, repeat: "manual" }, 0)).not.toHaveProperty("schedule")
  })
})

describe("the list", () => {
  test("returns the local routines, one line each, and the connectors a local routine may name", async () => {
    const subject = stand()
    await subject.chat.request({ id: "call_list", session: "ses_chat", kind: "list" })
    expect(subject.answers).toHaveLength(1)
    const all = subject.answers[0]?.text.split("\n") ?? []
    expect(all.at(-1)).toStartWith("Connectors available to tasks on this computer: ")
    const lines = all.slice(0, -1)
    expect(lines).toHaveLength((await subject.names()).length)
    expect(lines.every((line) => line.startsWith("- local:") && line.includes(" · Demo MacBook · "))).toBe(true)
    expect(subject.answers[0]?.error).toBe(false)
    // Each line carries the id the other tools take, the permissions, the next run and the last run with its reason.
    const tests = lines.find((line) => line.includes("Nightly test run")) ?? ""
    expect(tests).toStartWith("- local:tests · Nightly test run · Demo MacBook · Weekdays at 23:00 (Europe/Madrid) · active")
    expect(tests).toContain("permissions: Don't ask")
    expect(tests).toContain("next run: ")
    expect(tests).toMatch(/last run: (Failed|Done|Late|Missed|Blocked)/)
    expect(lines.some((line) => /last run: \w+ \(\w+\)/.test(line))).toBe(true)
  })
})

const ask = (
  id: string,
  kind: DynWorkRoutines.Request["kind"],
  routine: string,
  changes?: DynWorkRoutines.Changes,
): DynWorkRoutines.Request => ({ id, session: "ses_chat", kind, routine, ...(changes ? { changes } : {}) })

describe("an update", () => {
  test("changes only the given fields, and nothing before Save", async () => {
    const subject = stand()
    const before = await subject.routine("tickets")
    await subject.chat.request(ask("call_rename", "update", "local:tickets", { name: "es-prod-01 health check" }))
    const card = subject.chat.cards()[0]
    expect(card).toMatchObject({ kind: "update", backend: "local", routine: "tickets", before: before.definition })
    expect(card?.definition).toEqual({ ...before.definition, name: "es-prod-01 health check" })
    expect(crossing(Card, card)).toEqual(card)
    expect(subject.answers).toEqual([])
    expect((await subject.routine("tickets")).definition).toEqual(before.definition)

    expect(await subject.chat.decide("call_rename", true)).toBeUndefined()
    expect((await subject.routine("tickets")).definition).toEqual({ ...before.definition, name: "es-prod-01 health check" })
    expect(subject.answers[0]).toMatchObject({ id: "call_rename", error: false })
    expect(subject.answers[0]?.text).toBe(
      'Changed "es-prod-01 health check" (local:tickets) on Demo MacBook:\n- Task: Weekly ticket summary → es-prod-01 health check',
    )
  })

  test("of the time keeps how often it runs, and keeps the backend's other options", async () => {
    const subject = stand()
    const before = await subject.routine("tests")
    await subject.chat.request(ask("call_time", "update", "local:tests", { time: "06:30", permissions: "ask" }))
    const definition = subject.chat.cards()[0]?.definition
    expect(definition?.schedule).toEqual({ cron: "30 6 * * 1-5", timezone: "Europe/Madrid" })
    expect(definition?.options).toEqual({ ...before.definition.options, permissions: "ask" })
    expect(definition?.instructions).toEqual(before.definition.instructions)
  })

  test("that Cancel answers changes nothing", async () => {
    const subject = stand()
    const before = await subject.routine("tickets")
    await subject.chat.request(ask("call_no", "update", "local:tickets", { name: "Renamed" }))
    expect(await subject.chat.decide("call_no", false)).toBeUndefined()
    expect(await subject.routine("tickets")).toEqual(before)
    expect(subject.answers).toEqual([
      {
        id: "call_no",
        text: "The user cancelled: the task was not changed. Ask what to change before proposing again.",
        error: true,
      },
    ])
  })

  test("that is invalid or changes nothing is refused before any card", async () => {
    const subject = stand()
    await subject.chat.request(ask("call_bad", "update", "local:tickets", { time: "8am" }))
    await subject.chat.request(ask("call_same", "update", "local:tickets", { name: "Weekly ticket summary" }))
    expect(subject.chat.cards()).toEqual([])
    expect(subject.answers.map((answer) => [answer.id, answer.error])).toEqual([
      ["call_bad", true],
      ["call_same", true],
    ])
    expect(subject.answers[0]?.text).toContain("- schedule: Choose a time.")
    expect(subject.answers[1]?.text).toContain("already has")
    expect(subject.answers.every((answer) => answer.text.endsWith("Nothing changed."))).toBe(true)
  })
})

describe("a deletion", () => {
  test("removes the task only after Delete", async () => {
    const subject = stand()
    await subject.chat.request(ask("call_delete", "delete", "local:brain"))
    expect(subject.chat.cards()[0]).toMatchObject({ kind: "delete", routine: "brain" })
    expect(await subject.names()).toContain("Sort the Brain inbox")
    expect(await subject.chat.decide("call_delete", true)).toBeUndefined()
    expect(await subject.names()).not.toContain("Sort the Brain inbox")
    expect(subject.answers[0]?.text).toBe(
      'Deleted "Sort the Brain inbox" (local:brain) on Demo MacBook. Its past runs stay in Tasks.',
    )
  })

  test("cancelled leaves the task", async () => {
    const subject = stand()
    await subject.chat.request(ask("call_keep", "delete", "local:brain"))
    await subject.chat.decide("call_keep", false)
    expect(await subject.names()).toContain("Sort the Brain inbox")
    expect(subject.answers[0]).toMatchObject({ text: "The user cancelled: the task was not deleted.", error: true })
  })
})

describe("pause and resume", () => {
  test("act at once, with no card, and say what changed", async () => {
    const subject = stand()
    await subject.chat.request(ask("call_pause", "pause", "local:tickets"))
    expect(subject.chat.cards()).toEqual([])
    expect((await subject.routine("tickets")).state).toBe("paused")
    expect(subject.answers[0]).toEqual({
      id: "call_pause",
      text: 'Paused "Weekly ticket summary" (local:tickets) on Demo MacBook: it does not run on its schedule until it is resumed.',
      error: false,
    })
    await subject.chat.request(ask("call_resume", "resume", "local:tickets"))
    expect((await subject.routine("tickets")).state).toBe("active")
    expect(subject.answers[1]?.text).toStartWith('Resumed "Weekly ticket summary" (local:tickets) on Demo MacBook.')
  })
})

describe("a run", () => {
  test("of a Don't ask task waits for its dock", async () => {
    const subject = stand()
    const runs = async () => {
      const page = await subject.local.runs({ routine: "tests" })
      if (isFailure(page)) throw new Error(page.message)
      return page.items.length
    }
    const before = await runs()
    await subject.chat.request(ask("call_run", "run", "local:tests"))
    expect(subject.chat.cards()[0]).toMatchObject({ kind: "run", routine: "tests" })
    expect(await runs()).toBe(before)
    expect(subject.answers).toEqual([])
    expect(await subject.chat.decide("call_run", true)).toBeUndefined()
    expect(await runs()).toBe(before + 1)
    expect(subject.answers[0]?.text).toStartWith('Started a run of "Nightly test run" (local:tests) on Demo MacBook.')
  })

  test("of an Ask me task starts at once", async () => {
    const subject = stand()
    await subject.chat.request(ask("call_ask", "run", "local:tickets"))
    expect(subject.chat.cards()).toEqual([])
    expect(subject.answers[0]?.error).toBe(false)
    expect(subject.answers[0]?.text).toContain("It is set to Ask me: it waits for the user's approval")
  })
})

describe("an id", () => {
  test("that names no task is a clear error, and nothing is shown", async () => {
    const subject = stand()
    await subject.chat.request(ask("call_x", "update", "local:nope", { name: "x" }))
    await subject.chat.request(ask("call_y", "delete", "nope"))
    await subject.chat.request(ask("call_z", "pause", "elsewhere:tickets"))
    expect(subject.chat.cards()).toEqual([])
    expect(subject.answers.map((answer) => answer.error)).toEqual([true, true, true])
    expect(subject.answers[0]?.text).toBe(
      'Not done: No scheduled task has the id "local:nope". Call list_scheduled_tasks for the ids.\nNothing changed.',
    )
    expect(subject.answers[1]?.text).toContain('"nope"')
  })
})

describe("one task in full", () => {
  test("gives its definition in create's terms and its last runs", async () => {
    const subject = stand()
    await subject.chat.request(ask("call_get", "get", "local:tests"))
    const text = subject.answers[0]?.text ?? ""
    expect(text).toStartWith("local:tests · Nightly test run · Demo MacBook")
    const json = text.split("\n")[1]?.replace("Definition, in create_scheduled_task's terms: ", "") ?? ""
    expect(JSON.parse(json)).toMatchObject({
      name: "Nightly test run",
      repeat: "weekdays",
      time: "23:00",
      where: "local",
      permissions: "bypass",
      folder: "/Users/demo/Projects/portal",
    })
    expect(text).toContain("Last runs, newest first:\n- ")
    expect(text).toContain("conversation ses-")
  })
})

describe("what is running", () => {
  test("lists the runs going now on every backend, and says which wait for the user", async () => {
    const subject = stand()
    await subject.chat.request({ id: "call_idle", session: "ses_chat", kind: "running" })
    expect(subject.answers[0]?.text).toBe("Nothing is running right now.")
    await subject.local.start("tickets")
    await subject.chat.request({ id: "call_now", session: "ses_chat", kind: "running" })
    expect(subject.answers[1]?.text).toMatch(
      /^- Weekly ticket summary · local:tickets · Demo MacBook · Running · started .+ · conversation \S+$/,
    )
  })

  test("says when a run waits for permission", async () => {
    const time = clock()
    const local = RoutinesDemo.local(time.now)
    const waiting: Backend = {
      ...local,
      runs: async (input) => {
        const page = await local.runs(input)
        if (isFailure(page)) return page
        const first = page.items[0]
        return { items: first ? [{ ...first, state: "running", reason: "permission" }] : [] }
      },
    }
    const registry = RoutinesBackend.make()
    registry.register(waiting)
    const answers: DynWorkRoutines.Answer[] = []
    const chat = RoutinesChat.make({
      registry,
      farm: false,
      answer: async (answer) => void answers.push(answer),
      act: {} as RoutinesChat.Act,
      changed: () => {},
      now: time.now,
    })
    await chat.request({ id: "call_wait", session: "ses_chat", kind: "running" })
    expect(answers[0]?.text).toContain(" · Waiting for your permission")
  })
})

describe("a farm task", () => {
  test("reaches the farm backend, whose skeleton answers not implemented", async () => {
    const skeleton = RoutinesFarm.make()
    const local = RoutinesDemo.local(clock().now)
    const known = await local.get("tickets")
    if (isFailure(known)) throw new Error(known.message)
    const asked: string[] = []
    const farm: Backend = {
      ...skeleton,
      get: async (id) => {
        asked.push(`get ${id}`)
        return { ...known, ref: { backend: "farm", id } }
      },
      pause: (id) => {
        asked.push(`pause ${id}`)
        return skeleton.pause(id)
      },
    }
    const subject = stand({ farm, farmEnabled: true })
    await subject.chat.request(ask("call_farm_pause", "pause", "farm:sch_1"))
    expect(asked).toEqual(["get sch_1", "pause sch_1"])
    expect(subject.answers[0]).toMatchObject({ id: "call_farm_pause", error: true })
    expect(subject.answers[0]?.text).toContain("not implemented")
  })

  test("is refused while Cloud is only its demo", async () => {
    const subject = stand()
    await subject.chat.request(ask("call_farm_demo", "delete", "farm:crm"))
    expect(subject.chat.cards()).toEqual([])
    expect(subject.answers[0]?.text).toContain("Cloud is not available in this Dynwork yet.")
  })
})

describe("a farm proposal", () => {
  test("reaches the farm backend, whose skeleton refuses it: no card", async () => {
    const skeleton = RoutinesFarm.make()
    const seen: Definition[] = []
    const farm: Backend = {
      ...skeleton,
      validate: (definition) => {
        seen.push(definition)
        return skeleton.validate(definition)
      },
    }
    const subject = stand({ farm, farmEnabled: true })
    await subject.chat.request(propose("call_farm", { ...proposal, where: "farm" }))
    expect(seen).toHaveLength(1)
    expect(seen[0]?.name).toBe("Daily cluster check")
    expect(subject.chat.cards()).toEqual([])
    expect(subject.answers[0]).toMatchObject({ id: "call_farm", error: true })
    expect(subject.answers[0]?.text).toContain("not implemented")
  })

  test("is refused while Cloud is only its demo", async () => {
    const subject = stand()
    await subject.chat.request(propose("call_demo", { ...proposal, where: "farm" }))
    expect(subject.chat.cards()).toEqual([])
    expect(subject.answers[0]?.text).toContain("Cloud is not available in this Dynwork yet.")
  })
})

test("Create with Dynwork opens the conversation with David's setup prompt", () => {
  expect(chatPrompt).toBe(
    "Help me set up a scheduled task. Ask me what it should do, how often it should run, and when, then create it.",
  )
})

// The demo's `timesheet` is the person's task of the mandatory template `timesheet-draft`: its instructions, connectors
// and permissions are set, and so is how often it runs (Fridays); only the time of day is theirs.
describe("a task made from a template", () => {
  test("is listed and read with where it comes from and what it sets", async () => {
    const subject = stand()
    await subject.chat.request({ id: "call_list", session: "ses_chat", kind: "list" })
    const line = subject.answers[0]?.text.split("\n").find((item) => item.startsWith("- local:timesheet")) ?? ""
    expect(line).toContain('from Dynapps template "Timesheet draft"')
    expect(line).toContain("assigned by Dynapps: it cannot be deleted, only paused")
    expect(line).toContain(
      "set by the template: instructions, agent, connectors, permissions, how often it runs (the time is the user's)",
    )
    // A task of the person's own says nothing of the kind.
    expect(subject.answers[0]?.text.split("\n").find((item) => item.startsWith("- local:tests"))).not.toContain(
      "template",
    )

    await subject.chat.request(ask("call_get", "get", "local:timesheet"))
    expect(subject.answers[1]?.text).toContain('from Dynapps template "Timesheet draft"')
  })

  test.each([
    ["instructions", { instructions: "Draft something else." }],
    ["permissions", { permissions: "bypass" }],
    ["connectors", { connectors: ["dynbrain"] }],
    ["repeat", { repeat: "daily" }],
  ] satisfies Array<[string, DynWorkRoutines.Changes]>)(
    "refuses a change to %s before any card, and changes nothing",
    async (field, changes) => {
      const subject = stand()
      const before = await subject.routine("timesheet")
      await subject.chat.request(ask("call_locked", "update", "local:timesheet", changes))
      expect(subject.chat.cards()).toEqual([])
      expect(subject.answers).toHaveLength(1)
      expect(subject.answers[0]?.error).toBe(true)
      expect(subject.answers[0]?.text).toContain(
        'Set by the Dynapps template "Timesheet draft"; ask your administrator.',
      )
      expect(subject.answers[0]?.text).toContain(`- ${field}: Set by the template.`)
      expect(subject.answers[0]?.text.endsWith("Nothing changed.")).toBe(true)
      expect(await subject.routine("timesheet")).toEqual(before)
    },
  )

  test("takes a change to a field the template leaves free: the name, the time, the notifications", async () => {
    const subject = stand()
    const before = await subject.routine("timesheet")
    await subject.chat.request(
      ask("call_free", "update", "local:timesheet", { name: "My timesheet", time: "08:15", notify: "every" }),
    )
    expect(subject.answers).toEqual([])
    const card = subject.chat.cards()[0]
    expect(card?.definition).toMatchObject({
      name: "My timesheet",
      schedule: { cron: "15 8 * * 5" },
      options: { notify: "every", connectors: ["odoo"] },
      template: { id: "timesheet-draft", revision: 3 },
    })
    expect(await subject.chat.decide("call_free", true)).toBeUndefined()
    expect((await subject.routine("timesheet")).definition.name).toBe("My timesheet")
    expect((await subject.routine("timesheet")).definition.schedule?.cron).toBe("15 8 * * 5")
    expect((await subject.routine("timesheet")).definition).not.toEqual(before.definition)
  })

  test("that is assigned by Dynapps is not deleted, and says to pause it", async () => {
    const subject = stand()
    await subject.chat.request(ask("call_delete", "delete", "local:timesheet"))
    expect(subject.chat.cards()).toEqual([])
    expect(subject.answers[0]?.error).toBe(true)
    expect(subject.answers[0]?.text).toContain(
      'is assigned by the Dynapps template "Timesheet draft" and cannot be deleted',
    )
    expect(subject.answers[0]?.text).toContain("pause_scheduled_task")
    expect(await subject.names()).toContain("Timesheet draft")
    // Pausing it is allowed.
    await subject.chat.request(ask("call_pause", "pause", "local:timesheet"))
    expect(subject.answers[1]?.error).toBe(false)
    expect((await subject.routine("timesheet")).state).toBe("paused")
  })
})

const template = (id: string, changes: Omit<DynWorkRoutines.Activation, "id"> = {}): DynWorkRoutines.Request => ({
  id: `call_${id}`,
  session: "ses_chat",
  kind: "activate",
  activation: { id, ...changes },
})

describe("the templates", () => {
  test("are listed with what they set, what the user gives and where the user stands", async () => {
    const subject = stand()
    await subject.chat.request({ id: "call_templates", session: "ses_chat", kind: "templates" })
    expect(subject.answers[0]?.error).toBe(false)
    const text = subject.answers[0]?.text ?? ""
    expect(text).toContain("- project-health · Project health check · optional · Weekdays at 09:00 · not active")
    expect(text).toContain(
      "Set by the template: instructions, agent, connectors, permissions, model, how often it runs (the time is the user's), time limit.",
    )
    expect(text).toContain("The user gives: a project folder (The folder of the project it reviews.); the time of day.")
    expect(text).toContain(
      "- timesheet-draft · Timesheet draft · assigned by Dynapps · Fridays at 17:00 · active as local:timesheet",
    )
  })

  test("are not available where the backend has none", async () => {
    const answers: DynWorkRoutines.Answer[] = []
    const alone = RoutinesChat.make({
      registry: RoutinesBackend.make(),
      farm: false,
      answer: async (answer) => void answers.push(answer),
      act: {} as never,
      changed: () => {},
      now: Date.now,
    })
    await alone.request({ id: "call_none", session: "ses_chat", kind: "templates" })
    expect(answers).toEqual([{ id: "call_none", text: "No templates are available in this Dynwork.", error: true }])
  })

  test("are activated on a card with the user's folder, and the task keeps its link", async () => {
    const subject = stand()
    await subject.chat.request(template("project-health", { folder: "/Users/demo/Projects/portal", time: "07:30" }))
    expect(subject.answers).toEqual([])
    const card = subject.chat.cards()[0]
    expect(card).toMatchObject({ kind: "create", backend: "local", id: "call_project-health" })
    expect(card?.definition).toMatchObject({
      name: "Project health check",
      schedule: { cron: "30 7 * * 1-5", timezone: "Europe/Madrid" },
      model: "claude-sonnet-5-5",
      options: { folder: "/Users/demo/Projects/portal", permissions: "ask", connectors: ["dynbrain"], timeLimit: 30 },
      template: { id: "project-health", revision: 2 },
    })
    expect(crossing(Card, card)).toEqual(card)
    expect(await subject.names()).not.toContain("Project health check")

    expect(await subject.chat.decide("call_project-health", true)).toBeUndefined()
    const made = (await subject.local.list()) as Routine[]
    expect(made.find((routine) => routine.definition.name === "Project health check")?.template).toMatchObject({
      id: "project-health",
      name: "Project health check",
      mandatory: false,
    })
    // A second activation of the same template is refused, naming the task.
    await subject.chat.request(template("project-health", { folder: "/elsewhere" }))
    expect(subject.chat.cards()).toEqual([])
    expect(subject.answers.at(-1)?.text).toContain("The user already has this template active as local:")
  })

  test("that run without asking show it on the card, which is the user's confirmation", async () => {
    const time = clock()
    const base = RoutinesDemo.local(time.now)
    const offered = await base.templates?.()
    if (!offered || isFailure(offered)) throw new Error("no templates")
    const bypass = {
      ...(offered.templates[0] as Template),
      id: "tidy",
      name: "Tidy up",
      definition: {
        instructions: { kind: "prompt" as const, text: "Tidy up." },
        options: { permissions: "bypass" as const },
      },
      locks: { model: false, schedule: "free" as const, timeLimitMax: null },
      personal: { folder: "none" as const, hint: null },
    }
    const registry = RoutinesBackend.make()
    registry.register({ ...base, templates: async () => ({ templates: [bypass], links: [] }) })
    const chat = RoutinesChat.make({
      registry,
      farm: false,
      answer: async () => undefined,
      act: {} as never,
      changed: () => {},
      now: time.now,
    })
    await chat.request(template("tidy"))
    expect(chat.cards()[0]?.definition.options.permissions).toBe("bypass")
    expect(chat.cards()[0]?.definition.template).toEqual({ id: "tidy", revision: 2 })
  })

  test("are refused without the folder they need, with the field named", async () => {
    const subject = stand()
    await subject.chat.request(template("project-health"))
    expect(subject.chat.cards()).toEqual([])
    expect(subject.answers[0]).toMatchObject({ error: true })
    expect(subject.answers[0]?.text).toContain("- folder: This template needs a project folder.")
    expect(subject.answers[0]?.text.endsWith("Nothing was created.")).toBe(true)
  })

  test.each([
    ["a mandatory one", template("timesheet-draft"), "Dynapps assigns this template to the user"],
    ["an unknown one", template("nothing"), 'No template has the id "nothing"'],
    [
      "a change of how often it runs",
      template("project-health", { folder: "/work", repeat: "daily", time: "09:00" }),
      "- schedule: The template sets it.",
    ],
    [
      "a model the template sets",
      template("project-health", { folder: "/work", model: "claude-opus-5-5" }),
      "- model:",
    ],
    ["a manual task", template("project-health", { folder: "/work", repeat: "manual" }), "manual is not an option"],
    ["an unreadable time", template("project-health", { folder: "/work", time: "8am" }), "Choose a time"],
  ])("refuses %s, and shows no card", async (_, request, text) => {
    const subject = stand()
    await subject.chat.request(request)
    expect(subject.chat.cards()).toEqual([])
    expect(subject.answers[0]?.error).toBe(true)
    expect(subject.answers[0]?.text).toContain(text)
  })

  test("that the user made from one are deleted only after Delete, and the answer says the template is off", async () => {
    const subject = stand()
    await subject.chat.request(template("project-health", { folder: "/work" }))
    await subject.chat.decide("call_project-health", true)
    const made = ((await subject.local.list()) as Routine[]).find(
      (routine) => routine.template?.id === "project-health",
    )
    if (!made) throw new Error("not made")
    await subject.chat.request(ask("call_off", "delete", `local:${made.ref.id}`))
    expect(subject.chat.cards()[0]).toMatchObject({ kind: "delete" })
    expect(await subject.chat.decide("call_off", true)).toBeUndefined()
    expect(subject.answers.at(-1)?.text).toContain(
      "It was made from the Dynapps template project-health: that template is no longer active",
    )
    expect(subject.answers.at(-1)?.text).toContain("activate_task_template")
  })
})
