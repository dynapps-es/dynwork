import { describe, expect, test } from "bun:test"
import {
  cronOf,
  dayEnd,
  dayOf,
  dayStart,
  onTheHour,
  presetOf,
  scheduleProblem,
  upcoming,
  zones,
  type Preset,
} from "../../../src/views/agents/schedule"

const madrid = (cron: string) => ({ cron, timezone: "Europe/Madrid" })
const local = (at: number) =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Madrid",
    hourCycle: "h23",
    dateStyle: "short",
    timeStyle: "medium",
  }).format(at)

describe("presets are written as cron and read back from it", () => {
  test.each<[Preset, string]>([
    [{ kind: "daily", time: "09:00" }, "0 9 * * *"],
    [{ kind: "weekdays", time: "07:30" }, "30 7 * * 1-5"],
    [{ kind: "weekly", time: "08:45", days: [1] }, "45 8 * * 1"],
    [{ kind: "weekly", time: "17:05", days: [5, 1, 3, 1] }, "5 17 * * 1,3,5"],
    [{ kind: "monthly", time: "03:00", day: 1 }, "0 3 1 * *"],
    [{ kind: "cron", cron: "*/15 * * * *" }, "*/15 * * * *"],
  ])("%j is %s", (preset, cron) => {
    expect(cronOf(preset)).toBe(cron)
    // The weekly list is sorted and without repeats on the way out, so it reads back that way.
    expect(cronOf(presetOf(cron))).toBe(cron)
  })

  test.each<[string, Preset["kind"]]>([
    ["30 7 * * 1-5", "weekdays"],
    ["0 9 * * *", "daily"],
    ["0 17 * * 5,1", "weekly"],
    ["0 3 15 * *", "monthly"],
    ["0 9 * 1 *", "cron"],
    ["0 9 * * 1-3", "cron"],
    ["not a cron", "cron"],
  ])("%s is read as %s", (cron, kind) => {
    expect(presetOf(cron).kind).toBe(kind)
  })

  test("a preset that cannot be written has no cron, and says what is wrong", () => {
    const bad: [Preset, string][] = [
      [{ kind: "daily", time: "25:00" }, "agents.form.error.time"],
      [{ kind: "daily", time: "" }, "agents.form.error.time"],
      [{ kind: "weekly", time: "09:00", days: [] }, "agents.form.error.days"],
      [{ kind: "monthly", time: "09:00", day: 32 }, "agents.form.error.day"],
      [{ kind: "cron", cron: "  " }, "agents.form.error.cron"],
    ]
    bad.forEach(([preset, key]) => {
      expect(cronOf(preset)).toBeUndefined()
      expect(scheduleProblem(preset)).toBe(key)
    })
    expect(scheduleProblem({ kind: "daily", time: "09:00" })).toBeUndefined()
  })

  test("the hour hint is for a minute of zero only", () => {
    expect([
      onTheHour("0 9 * * *"),
      onTheHour("45 8 * * 1"),
      onTheHour("*/15 * * * *"),
      onTheHour("0 * * * *"),
    ]).toEqual([true, false, false, true])
  })
})

describe("the next runs in the form's zone", () => {
  test("a weekly preset follows Madrid wall time across the spring change (29 March 2026)", () => {
    const cron = cronOf({ kind: "weekly", time: "08:45", days: [0, 1] }) ?? ""
    const runs = upcoming(madrid(cron), Date.UTC(2026, 2, 26), 4).map(local)
    expect(runs).toEqual(["2026-03-29 08:45:00", "2026-03-30 08:45:00", "2026-04-05 08:45:00", "2026-04-06 08:45:00"])
  })

  test("a daily preset keeps its wall time through the autumn change (25 October 2026)", () => {
    const runs = upcoming(madrid("45 8 * * *"), Date.UTC(2026, 9, 23, 12))
    expect(runs.map(local)).toEqual(["2026-10-24 08:45:00", "2026-10-25 08:45:00", "2026-10-26 08:45:00"])
    // The 25th is 25 hours long: its run is an hour further from the 24th's than usual.
    expect([runs[1] - runs[0], runs[2] - runs[1]]).toEqual([25 * 3_600_000, 24 * 3_600_000])
  })

  test("a time inside the spring gap runs once that day, after the gap", () => {
    const runs = upcoming(madrid("30 2 * * *"), Date.UTC(2026, 2, 27, 12), 4)
    const day = runs.map(local).filter((text) => text.startsWith("2026-03-29"))
    expect(day).toHaveLength(1)
    expect(day[0] >= "2026-03-29 03:00:00").toBe(true)
    expect(runs.every((at, index) => index === 0 || at > runs[index - 1])).toBe(true)
  })

  test("a time inside the repeated autumn hour runs once, not twice", () => {
    const runs = upcoming(madrid("30 2 * * *"), Date.UTC(2026, 9, 23, 12), 4).map(local)
    expect(runs.filter((text) => text.startsWith("2026-10-25"))).toHaveLength(1)
  })

  test("a zone or cron that cannot be read gives none", () => {
    expect(upcoming({ cron: "0 9 * * *", timezone: "Mars/Olympus" }, Date.UTC(2026, 10, 16))).toEqual([])
    expect(upcoming(madrid("nope"), Date.UTC(2026, 10, 16))).toEqual([])
  })
})

describe("the zones to choose from", () => {
  test("hold the current zone and UTC, once each and in order", () => {
    const list = zones("Europe/Madrid")
    expect(list).toContain("Europe/Madrid")
    expect(list).toContain("UTC")
    expect(new Set(list).size).toBe(list.length)
    expect(list).toEqual([...list].toSorted())
  })

  test("keep a stored zone the system does not list", () => {
    expect(zones("Mars/Olympus")).toContain("Mars/Olympus")
  })
})

describe("a window's days in the schedule's zone", () => {
  test("start at the zone's midnight and end at its last millisecond", () => {
    expect(dayStart("2026-12-01", "Europe/Madrid")).toBe(Date.UTC(2026, 10, 30, 23))
    expect(dayEnd("2026-12-31", "Europe/Madrid")).toBe(Date.UTC(2026, 11, 31, 22, 59, 59, 999))
    // Summer time: the same day starts an hour earlier in UTC.
    expect(dayStart("2026-07-01", "Europe/Madrid")).toBe(Date.UTC(2026, 5, 30, 22))
  })

  test("read back as the same day", () => {
    const at = dayStart("2026-10-25", "Europe/Madrid") ?? 0
    expect(dayOf(at, "Europe/Madrid")).toBe("2026-10-25")
    expect(dayOf(dayEnd("2026-10-25", "Europe/Madrid") ?? 0, "Europe/Madrid")).toBe("2026-10-25")
  })

  test("are nothing for a day or zone that cannot be read", () => {
    expect(dayStart("", "Europe/Madrid")).toBeUndefined()
    expect(dayStart("2026-12-01", "Mars/Olympus")).toBeUndefined()
    expect(dayEnd("soon", "Europe/Madrid")).toBeUndefined()
  })
})
