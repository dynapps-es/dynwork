import { describe, expect, test } from "bun:test"
import type { Run } from "../../../src/routines/contract"
import {
  backendLine,
  duration,
  instructionsText,
  money,
  reasonText,
  runWhen,
  scheduleText,
  when,
} from "../../../src/views/agents/format"
import { describe as words, upcoming } from "../../../src/views/agents/schedule"
import { MINUTE } from "../../routines/fixture"
import { setup, t } from "./fixture"

const madrid = (cron: string) => ({ cron, timezone: "Europe/Madrid" })
const iso = (times: number[]) => times.map((at) => new Date(at).toISOString())

describe("a schedule in words", () => {
  test.each([
    ["45 8 * * 1", "Mondays at 08:45"],
    ["0 23 * * 1-5", "Weekdays at 23:00"],
    ["0 9 * * *", "Every day at 09:00"],
    ["0 3 1 * *", "Day 1 of every month at 03:00"],
    ["30 7 * * 5,1,3", "Mon, Wed and Fri at 07:30"],
    ["0 17 * * 7", "Sundays at 17:00"],
    ["*/15 * * * *", "Custom schedule"],
    ["0 9 * 1 *", "Custom schedule"],
  ])("%s reads %s", (cron, text) => {
    expect(scheduleText(t, madrid(cron))).toBe(text)
  })

  test("a routine without a schedule runs only when the user starts it", () => {
    expect(scheduleText(t, undefined)).toBe("Only when you run it")
  })

  test("a cron it cannot put in words keeps its cron as a parameter", () => {
    expect(words(madrid("5 4 * * sun"))).toEqual({ key: "agents.repeat.cron", params: { cron: "5 4 * * sun" } })
  })
})

describe("the next runs", () => {
  test("follow the zone across the spring change (29 March 2026)", () => {
    expect(iso(upcoming(madrid("45 8 * * *"), Date.UTC(2026, 2, 28)))).toEqual([
      "2026-03-28T07:45:00.000Z",
      "2026-03-29T06:45:00.000Z",
      "2026-03-30T06:45:00.000Z",
    ])
  })

  test("follow the zone across the autumn change (25 October 2026)", () => {
    expect(iso(upcoming(madrid("45 8 * * *"), Date.UTC(2026, 9, 24)))).toEqual([
      "2026-10-24T06:45:00.000Z",
      "2026-10-25T07:45:00.000Z",
      "2026-10-26T07:45:00.000Z",
    ])
  })

  test("are none for a cron or zone that cannot be read", () => {
    expect(upcoming({ cron: "45 8 * * 1", timezone: "Mars/Olympus" }, Date.UTC(2026, 10, 16))).toEqual([])
    expect(upcoming(madrid("not a cron"), Date.UTC(2026, 10, 16))).toEqual([])
  })
})

describe("times, durations and costs", () => {
  test("a moment reads in the routine's zone", () => {
    expect(when("en-GB", Date.UTC(2026, 10, 16, 7, 45), "Europe/Madrid")).toBe("Mon 16 Nov, 08:45")
  })

  const run = (patch: Partial<Run>): Run => ({
    ref: { backend: "farm", id: "r" },
    state: "ok",
    trigger: "manual",
    title: "A run",
    unread: false,
    conversation: { kind: "transcript" },
    ...patch,
  })

  test("a run's duration, while it runs and once it is done", () => {
    const start = Date.UTC(2026, 10, 16, 7, 30)
    expect(duration(t, run({ started: start, finished: start + 9 * MINUTE }), 0)).toBe("9 min")
    expect(duration(t, run({ started: start, finished: start + 65 * MINUTE }), 0)).toBe("1 h 5 min")
    expect(duration(t, run({ started: start }), start + 20_000)).toBe("under a minute")
    expect(duration(t, run({}), start)).toBeUndefined()
  })

  test("a run without a time reads its title", () => {
    expect(runWhen("en-GB", run({}))).toBe("A run")
    expect(runWhen("en-GB", run({ due: Date.UTC(2026, 10, 2, 7, 45) }))).toContain("2 Nov")
  })

  test("a reason the clock writes reads in words, and one the view does not know reads as the backend wrote it", () => {
    expect(reasonText(t, "closed")).toBe("Dynwork was closed or asleep")
    expect(reasonText(t, "grouped")).toBe("Covered by one catch-up run")
    expect(reasonText(t, "overlap")).toBe("The previous run was still running")
    expect(reasonText(t, "restart")).toBe("Interrupted by a restart")
    expect(reasonText(t, "timeout")).toBe("Stopped at the time limit")
    expect(reasonText(t, "quota_exceeded")).toBe("quota_exceeded")
  })

  test("costs in their currency", () => {
    expect(money("en-GB", { amount: 0.41, currency: "EUR" })).toBe("€0.41")
  })
})

describe("the header and the cards", () => {
  test("the status line names each backend, and the farm's share of the team's schedules", async () => {
    const view = await setup()
    expect(view.model.backends().map((backend) => backendLine(t, backend))).toEqual([
      "Demo MacBook · online",
      "Cloud connected · 7 of 20 team schedules",
    ])
    view.farm.setStatus("signed-out")
    await view.wire.client.refresh()
    expect(backendLine(t, view.model.capabilities("farm")!)).toBe("Cloud: Signed out")
    const local = view.model.capabilities("local")!
    expect(backendLine(t, { ...local, synced: false })).toBe("Demo MacBook · online · Not synced")
    expect(backendLine(t, { ...local, synced: true })).toBe("Demo MacBook · online")
  })

  test("a card's line says what the routine does", async () => {
    const view = await setup()
    expect(instructionsText(t, view.find("Timesheet draft").definition.instructions)).toBe("Skill timesheet-report")
    expect(instructionsText(t, view.find("Sync CRM").definition.instructions)).toStartWith("Agent crm-sync: Copy")
    expect(instructionsText(t, view.find("Weekly ticket summary").definition.instructions)).toStartWith("Review the")
  })
})
