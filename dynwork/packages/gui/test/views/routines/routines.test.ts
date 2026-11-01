import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import { createRoot } from "solid-js"
import { createViewLayout } from "../../../src/views/shell"
import { demoRoutines } from "../../../src/views/routines/demo"
import {
  dayName,
  draftErrors,
  emptyDraft,
  nextRunText,
  scheduleText,
  type Draft,
  type Schedule,
} from "../../../src/views/routines/schedule"
import { createRoutines, isRunning, lastState, pickSelected, summary } from "../../../src/views/routines/store"

// Monday 3 November 2025, 10:00 local time.
const monday = () => new Date(2025, 10, 3, 10, 0)
const draft = (change: Partial<Draft> = {}): Draft => ({
  ...emptyDraft(),
  name: "Inbox",
  prompt: "Sort my inbox",
  ...change,
})
const routines = (options: Parameters<typeof createRoutines>[0] = {}) =>
  createRoot((dispose) => ({ store: createRoutines({ now: monday, ...options }), dispose }))

beforeEach(() => jest.useFakeTimers())
afterEach(() => jest.useRealTimers())

describe("the demo routines", () => {
  test("list the mockup's four, with the last one paused", () => {
    const { store, dispose } = routines()

    expect(store.list().map((routine) => routine.name)).toEqual([
      "Morning stand-up notes",
      "Nightly test sweep",
      "Friday timesheet draft",
      "Brain inbox tidy",
    ])
    expect(store.list().map((routine) => routine.enabled)).toEqual([true, true, true, false])
    expect(store.enabledCount()).toBe(3)
    dispose()
  })

  test("summarise as a skill or as the start of a prompt", () => {
    expect(summary(demoRoutines[0])).toBe("Skill standup-facilitator")
    expect(summary(demoRoutines[1])).toBe("Prompt: Run the unit tests in packages/app and summarise failures")
  })

  test("say their schedule in words", () => {
    expect(demoRoutines.map((routine) => scheduleText(routine.schedule))).toEqual([
      "Weekdays at 08:45",
      "Every day at 23:00",
      "Fridays at 16:00",
      "Mondays at 09:00",
    ])
  })
})

describe("the enabled toggle", () => {
  test("pauses a routine and resumes it with its next run counted from now", () => {
    const { store, dispose } = routines()

    store.toggle("standup")
    expect(store.list()[0].enabled).toBe(false)
    expect(store.list()[0].next).toBe("Off")
    expect(store.enabledCount()).toBe(2)

    store.toggle("standup")
    expect(store.list()[0].enabled).toBe(true)
    expect(store.list()[0].next).toBe("Tomorrow 08:45")
    dispose()
  })

  test("resumes a paused routine from the demo", () => {
    const { store, dispose } = routines()

    store.toggle("brain-inbox")
    expect(store.list()[3].enabled).toBe(true)
    expect(store.list()[3].next).toBe("Mon 10 Nov 09:00")
    dispose()
  })
})

describe("Run now", () => {
  test("shows the run as running, then done after the timer", () => {
    const { store, dispose } = routines({ runMs: 2000 })

    store.run("tests")
    expect(isRunning(store.list()[1])).toBe(true)
    expect(store.list()[1].history[0]).toMatchObject({ state: "running", when: "Today 10:00" })
    expect(store.list()[1].history).toHaveLength(4)

    jest.advanceTimersByTime(1999)
    expect(isRunning(store.list()[1])).toBe(true)

    jest.advanceTimersByTime(1)
    expect(isRunning(store.list()[1])).toBe(false)
    expect(store.list()[1].history[0]).toMatchObject({ state: "succeeded", note: "2 s" })
    expect(lastState(store.list()[1])).toBe("succeeded")
    dispose()
  })

  test("does not start a second run while one is running", () => {
    const { store, dispose } = routines()

    store.run("tests")
    store.run("tests")
    expect(store.list()[1].history).toHaveLength(4)
    dispose()
  })

  test("is cleared when the view unmounts", () => {
    const { store, dispose } = routines({ runMs: 2000 })

    store.run("tests")
    dispose()
    jest.advanceTimersByTime(5000)
    expect(isRunning(store.list()[1])).toBe(true)
  })
})

describe("New routine", () => {
  test("adds the routine first in the list, enabled, with its schedule and next run", () => {
    const { store, dispose } = routines()

    const id = store.add(draft({ name: "  Inbox  ", repeat: "daily", time: "09:30", folder: "~/Dynapps/odoo" }))

    expect(store.list()).toHaveLength(5)
    expect(store.list()[0]).toMatchObject({
      id,
      name: "Inbox",
      folder: "~/Dynapps/odoo",
      enabled: true,
      next: "Tomorrow 09:30",
    })
    expect(scheduleText(store.list()[0].schedule)).toBe("Every day at 09:30")
    dispose()
  })

  test("needs a name, a prompt, a valid time and, for custom, a day", () => {
    expect(draftErrors(draft())).toEqual([])
    expect(draftErrors(draft({ name: " ", prompt: "" }))).toEqual(["name", "prompt"])
    expect(draftErrors(draft({ time: "25:00" }))).toEqual(["time"])
    expect(draftErrors(draft({ time: "9:00" }))).toEqual(["time"])
    expect(draftErrors(draft({ repeat: "custom", days: [] }))).toEqual(["days"])
    expect(draftErrors(draft({ repeat: "weekly", days: [] }))).toEqual([])
  })
})

describe("Remove", () => {
  test("deletes the routine", () => {
    const { store, dispose } = routines()

    store.remove("tests")
    expect(store.list().map((routine) => routine.id)).toEqual(["standup", "timesheet", "brain-inbox"])
    dispose()
  })
})

describe("the schedule in words", () => {
  const at = (repeat: Schedule["repeat"], days: number[] = []) => scheduleText({ repeat, time: "07:30", days })

  test.each([
    [at("daily"), "Every day at 07:30"],
    [at("weekdays"), "Weekdays at 07:30"],
    [at("weekly", [3]), "Wednesdays at 07:30"],
    [at("custom", [5, 1, 3]), "Mon, Wed and Fri at 07:30"],
    [at("custom", [2, 4]), "Tue and Thu at 07:30"],
    [at("custom", [6]), "Sat at 07:30"],
  ])("%s", (text, expected) => expect(text).toBe(expected))

  test("a weekly draft keeps only its first day", () => {
    const { store, dispose } = routines()

    store.add(draft({ repeat: "weekly", days: [4, 2] }))
    expect(scheduleText(store.list()[0].schedule)).toBe("Thursdays at 09:00")
    dispose()
  })

  test("names the days", () => expect([0, 6].map(dayName)).toEqual(["Sun", "Sat"]))
})

describe("the next run", () => {
  const next = (schedule: Schedule, now: Date) => nextRunText(schedule, now)

  test("is today when the time is still ahead, and tomorrow when it has passed", () => {
    expect(next({ repeat: "daily", time: "23:00", days: [] }, monday())).toBe("Today 23:00")
    expect(next({ repeat: "daily", time: "08:00", days: [] }, monday())).toBe("Tomorrow 08:00")
  })

  test("skips the weekend for weekdays", () => {
    expect(next({ repeat: "weekdays", time: "08:45", days: [] }, new Date(2025, 10, 7, 10, 0))).toBe("Mon 10 Nov 08:45")
  })

  test("waits a week for the same weekday once its time has passed", () => {
    expect(next({ repeat: "weekly", time: "09:00", days: [1] }, monday())).toBe("Mon 10 Nov 09:00")
    expect(next({ repeat: "custom", time: "09:00", days: [1, 3] }, monday())).toBe("Wed 5 Nov 09:00")
  })
})

describe("the selected routine", () => {
  const ids = ["a", "b"]
  const resize = (width: number) => window.happyDOM.setViewport({ width })

  afterEach(() => resize(1024))

  test("follows the shell's layout: nothing is picked by default in a narrow window, so the list shows first", () => {
    // happy-dom misses the first change of a query that already matches, so the window starts medium.
    resize(1024)
    createRoot((dispose) => {
      const layout = createViewLayout()
      resize(600)
      expect(layout()).toBe("narrow")
      expect(pickSelected(undefined, ids, layout() === "wide")).toBeUndefined()
      resize(1400)
      expect(layout()).toBe("wide")
      expect(pickSelected(undefined, ids, layout() === "wide")).toBe("a")
      dispose()
    })
  })

  test("is the one picked while it exists", () => expect(pickSelected("b", ids, true)).toBe("b"))
  test("falls back to the first on a wide window", () => {
    expect(pickSelected(undefined, ids, true)).toBe("a")
    expect(pickSelected("gone", ids, true)).toBe("a")
  })
  test("is none on a narrow or medium window until one is picked", () => {
    expect(pickSelected(undefined, ids, false)).toBeUndefined()
    expect(pickSelected("gone", ids, false)).toBeUndefined()
  })
})
