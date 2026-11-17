import { describe, expect, test } from "bun:test"
import type { DynWorkRoutines } from "@dynwork/server-plugin/routines"
import { RoutinesBackend, type Backend } from "../../src/routines/backend"
import { RoutinesChat } from "../../src/routines/chat"
import { Card, chatPrompt, isFailure, type Definition, type Routine } from "../../src/routines/contract"
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
  const chat = RoutinesChat.make({
    registry,
    farm: options.farmEnabled ?? false,
    answer: async (answer) => void answers.push(answer),
    create: async (backend, definition) => {
      const target = registry.get(backend)
      if (!target) throw new Error(`no backend ${backend}`)
      return target.create(definition)
    },
    changed: () => void changes.count++,
    now: time.now,
  })
  const names = async () => {
    const list = await local.list()
    if (isFailure(list)) throw new Error(list.message)
    return list.map((routine: Routine) => routine.definition.name)
  }
  return { chat, answers, changes, names }
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
    expect(subject.answers[0]?.text).toContain("Daily cluster check · Demo MacBook · Every day at 08:00")
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
  test("returns the local routines, one line each", async () => {
    const subject = stand()
    await subject.chat.request({ id: "call_list", session: "ses_chat", kind: "list" })
    expect(subject.answers).toHaveLength(1)
    const lines = subject.answers[0]?.text.split("\n") ?? []
    expect(lines).toHaveLength((await subject.names()).length)
    expect(lines.every((line) => line.startsWith("- ") && line.includes(" · Demo MacBook · "))).toBe(true)
    expect(subject.answers[0]?.error).toBe(false)
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

  test("is refused while the Agent Farm is only its demo", async () => {
    const subject = stand()
    await subject.chat.request(propose("call_demo", { ...proposal, where: "farm" }))
    expect(subject.chat.cards()).toEqual([])
    expect(subject.answers[0]?.text).toContain("The Agent Farm is not available in this Dynwork yet.")
  })
})

test("Create with Dynwork opens the conversation with David's setup prompt", () => {
  expect(chatPrompt).toBe(
    "Help me set up a scheduled task. Ask me what it should do, how often it should run, and when, then create it.",
  )
})
