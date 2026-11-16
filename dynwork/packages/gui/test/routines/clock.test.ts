import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { OpenCode } from "@opencode/client/promise"
import type { Persisted } from "@opencode/plugin/gui/main"
import { isFailure, type Definition, type Run } from "../../src/routines/contract"
import { RoutinesLocal } from "../../src/routines/local/backend"
import { RoutinesClock } from "../../src/routines/local/clock"
import { clock, MINUTE, storage } from "./fixture"
import { fakeService, until } from "./service"

const HOUR = 60 * MINUTE
const home = await mkdtemp(path.join(tmpdir(), "routines-clock-"))
const stops: Array<() => void> = []
afterAll(() => stops.forEach((stop) => stop()))

type Store = Persisted<RoutinesLocal.Saved, RoutinesLocal.Saved>
type Time = ReturnType<typeof clock>

// Timers on the test's clock: `run(to)` moves the clock to `to`, firing each timer at its time on the way and waiting
// for what it started. Nothing waits on real time.
function timers(time: Time) {
  const armed = new Set<{ at: number; fire: () => unknown }>()
  return {
    set: (fire: () => unknown, ms: number) => {
      const entry = { at: time.now() + ms, fire }
      armed.add(entry)
      return () => void armed.delete(entry)
    },
    run: async (to: number) => {
      for (;;) {
        const due = [...armed].toSorted((a, b) => a.at - b.at)[0]
        if (!due || due.at > to) break
        armed.delete(due)
        time.advance(Math.max(due.at - time.now(), 0))
        await due.fire()
      }
      time.advance(Math.max(to - time.now(), 0))
    },
  }
}

// The app: the local backend over a fake service, as the store and the service were left. `launch` opens it again: a
// new backend and clock over the same store, as when Dynwork starts.
function app(start: number) {
  const time = clock(start)
  const service = fakeService({ now: time.now })
  stops.push(service.stop)
  const store = storage(RoutinesLocal.Saved, RoutinesLocal.initial)
  const client = OpenCode.make({ baseUrl: service.url, headers: { authorization: "Basic c2VjcmV0" } })
  const ready = { value: true }
  const launch = (from: Store = store) => {
    const backend = RoutinesLocal.make({
      label: "Test Mac",
      store: from,
      client: () => client,
      server: "sidecar",
      home,
      now: time.now,
      retry: 10,
    })
    const clocks = timers(time)
    const engine = RoutinesClock.make({
      local: backend,
      store: from,
      now: time.now,
      ready: () => ready.value,
      timers: clocks,
    })
    stops.push(backend.dispose, engine.dispose)
    return {
      backend,
      engine,
      run: clocks.run,
      close: () => {
        engine.dispose()
        backend.dispose()
      },
    }
  }
  return { time, service, store, ready, launch }
}

const schedule = (cron: string, options: Definition["options"] = {}): Definition => ({
  name: "Digest",
  instructions: { kind: "prompt", text: "Summarise." },
  schedule: { cron, timezone: "Europe/Madrid" },
  enabled: true,
  options: { permissions: "read-only", ...options },
})

async function create(backend: RoutinesLocal.Local, definition: Definition) {
  const routine = await backend.create(definition)
  if (isFailure(routine)) throw new Error(routine.message)
  return routine.ref.id
}

async function history(backend: RoutinesLocal.Local, routine: string) {
  const page = await backend.runs({ routine })
  if (isFailure(page)) throw new Error(page.message)
  return page.items.toReversed()
}

// What happened to each occurrence, oldest first: "<due ISO> <state> <reason>".
const lines = (runs: readonly Run[]) =>
  runs.map((run) =>
    [run.due === undefined ? "-" : new Date(run.due).toISOString(), run.state, run.reason ?? run.trigger].join(" "),
  )

// Lets the clock's background looks (after a change it watched) come to rest.
const quiet = () => new Promise((resolve) => setTimeout(resolve, 30))

// `until` for a condition read through the backend.
async function eventually(condition: () => Promise<boolean>, ms = 3_000) {
  const deadline = Date.now() + ms
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the condition")
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

const manual = (name: string): Definition => ({
  name,
  instructions: { kind: "prompt", text: "Summarise." },
  enabled: true,
  options: { permissions: "read-only" },
})

async function finishAll(subject: ReturnType<typeof app>, backend: RoutinesLocal.Local) {
  subject.service.finish()
  await until(() => backend.running() === 0)
}

describe("the clock fires a schedule at its time", () => {
  test("in Europe/Madrid across 29 March 2026: the 02:30 the clocks skip runs once, right after the jump", async () => {
    const subject = app(Date.UTC(2026, 2, 28, 12))
    const open = subject.launch()
    const routine = await create(open.backend, schedule("30 2 * * *"))
    await open.engine.check()
    await open.run(Date.UTC(2026, 2, 29, 12))
    await until(() => subject.service.prompts().length === 1)
    await finishAll(subject, open.backend)
    await open.run(Date.UTC(2026, 2, 30, 12))
    await until(() => subject.service.prompts().length === 2)
    await finishAll(subject, open.backend)
    await quiet()
    const runs = await history(open.backend, routine)
    // 03:30 CEST, the first moment after the skipped 02:30; then 02:30 CEST the next day.
    expect(lines(runs)).toEqual(["2026-03-29T01:30:00.000Z ok schedule", "2026-03-30T00:30:00.000Z ok schedule"])
    expect(runs.map((run) => run.started)).toEqual(runs.map((run) => run.due))
    expect(subject.service.prompts()).toEqual(["Summarise.", "Summarise."])
  })

  test("in Europe/Madrid across 25 October 2026: the 02:30 that happens twice runs once", async () => {
    const subject = app(Date.UTC(2026, 9, 24, 12))
    const open = subject.launch()
    const routine = await create(open.backend, schedule("30 2 * * *"))
    await open.engine.check()
    await open.run(Date.UTC(2026, 9, 25, 12))
    await until(() => subject.service.prompts().length === 1)
    await finishAll(subject, open.backend)
    await open.run(Date.UTC(2026, 9, 26, 12))
    await until(() => subject.service.prompts().length === 2)
    await finishAll(subject, open.backend)
    await quiet()
    // 02:30 CEST, the first of the two; then 02:30 CET the next day.
    expect(lines(await history(open.backend, routine))).toEqual([
      "2026-10-25T00:30:00.000Z ok schedule",
      "2026-10-26T01:30:00.000Z ok schedule",
    ])
    expect(subject.service.prompts()).toHaveLength(2)
  })

  test("a restart after the occurrence key was written does not start it again, nor does a second clock", async () => {
    const subject = app(Date.UTC(2026, 10, 16, 7, 59))
    const first = subject.launch()
    const routine = await create(first.backend, schedule("0 9 * * *"))
    const due = Date.UTC(2026, 10, 16, 8)
    subject.time.advance(MINUTE)
    // The key is written and the app dies before the run starts.
    first.backend.take(routine, { due, records: [] })
    first.close()

    const second = subject.launch()
    const third = subject.launch()
    await Promise.all([second.engine.check(), third.engine.check()])
    await second.run(due + 2 * MINUTE)
    await quiet()
    expect(subject.service.prompts()).toEqual([])
    expect(subject.store.value.routines[0]?.due).toBe(due)

    // The next occurrence still runs, and only once with two clocks looking.
    await Promise.all([second.run(due + 24 * HOUR), third.run(due + 24 * HOUR)])
    await until(() => subject.service.prompts().length === 1)
    await quiet()
    expect(subject.service.prompts()).toHaveLength(1)
  })

  test("a run whose previous run is still going is skipped, not queued", async () => {
    const subject = app(Date.UTC(2026, 10, 16, 9))
    const open = subject.launch()
    const routine = await create(open.backend, schedule("*/30 * * * *"))
    await open.engine.check()
    await open.run(Date.UTC(2026, 10, 16, 9, 30))
    await until(() => subject.service.prompts().length === 1)
    await open.run(Date.UTC(2026, 10, 16, 10))
    await eventually(async () => (await history(open.backend, routine)).length === 2)
    await quiet()
    expect(lines(await history(open.backend, routine))).toEqual([
      "2026-11-16T09:30:00.000Z running schedule",
      "2026-11-16T10:00:00.000Z skipped overlap",
    ])
    expect(subject.service.prompts()).toHaveLength(1)
  })

  test("waits for the Governance provider before firing, then runs what came due", async () => {
    const subject = app(Date.UTC(2026, 10, 16, 7, 59))
    subject.ready.value = false
    const open = subject.launch()
    const routine = await create(open.backend, schedule("0 9 * * *"))
    await open.engine.check()
    await open.run(Date.UTC(2026, 10, 16, 8, 2))
    await quiet()
    expect(subject.service.prompts()).toEqual([])

    subject.ready.value = true
    await open.engine.check()
    await until(() => subject.service.prompts().length === 1)
    expect(lines(await history(open.backend, routine))).toEqual(["2026-11-16T08:00:00.000Z running schedule"])
  })
})

describe("runs missed while Dynwork was closed", () => {
  // A routine made at 03:30 UTC, hourly unless `cron` says; Dynwork closes then and opens again at `at`.
  async function missed(at: number, options: Definition["options"] = {}, cron = "0 * * * *") {
    const subject = app(Date.UTC(2026, 10, 16, 3, 30))
    const closed = subject.launch()
    const routine = await create(closed.backend, schedule(cron, options))
    closed.close()
    subject.time.advance(at - subject.time.now())
    const open = subject.launch()
    await open.engine.check()
    await quiet()
    return { subject, open, routine }
  }

  test("five missed within the hours start one catch-up run, and the other four are grouped into it", async () => {
    const { subject, open, routine } = await missed(Date.UTC(2026, 10, 16, 8, 30))
    await until(() => subject.service.prompts().length === 1)
    await quiet()
    expect(lines(await history(open.backend, routine))).toEqual([
      "2026-11-16T04:00:00.000Z missed grouped",
      "2026-11-16T05:00:00.000Z missed grouped",
      "2026-11-16T06:00:00.000Z missed grouped",
      "2026-11-16T07:00:00.000Z missed grouped",
      "2026-11-16T08:00:00.000Z running catch-up",
    ])
    // The prompt says it is a catch-up and since when: 04:00 UTC is 05:00 in Madrid.
    const prompt = subject.service.prompts()[0] ?? ""
    expect(prompt.split("\n")[0]).toStartWith("This is a catch-up run")
    expect(prompt.split("\n")[0]).toContain("05:00")
    expect(prompt).toEndWith("Summarise.")
  })

  test("outside the hours nothing runs and they are recorded as missed", async () => {
    // Daily at 05:00 in Madrid (04:00 UTC), opened again twelve and a half hours later: past the 6 hours.
    const { subject, open, routine } = await missed(Date.UTC(2026, 10, 16, 16, 30), {}, "0 5 * * *")
    expect(subject.service.prompts()).toEqual([])
    expect(lines(await history(open.backend, routine))).toEqual(["2026-11-16T04:00:00.000Z missed closed"])
  })

  test("with the next regular run less than 15 minutes away, nothing catches up and that run comes on time", async () => {
    const { subject, open, routine } = await missed(Date.UTC(2026, 10, 16, 8, 50))
    expect(subject.service.prompts()).toEqual([])
    expect(await history(open.backend, routine)).toHaveLength(5)
    await open.run(Date.UTC(2026, 10, 16, 9, 1))
    await until(() => subject.service.prompts().length === 1)
    expect(lines(await history(open.backend, routine)).at(-1)).toBe("2026-11-16T09:00:00.000Z running schedule")
    expect(subject.service.prompts()).toEqual(["Summarise."])
  })

  test('"Don\'t recover" records them as missed and starts nothing', async () => {
    const { subject, open, routine } = await missed(Date.UTC(2026, 10, 16, 8, 30), { recover: "none" })
    expect(subject.service.prompts()).toEqual([])
    expect(lines(await history(open.backend, routine))).toEqual([
      "2026-11-16T04:00:00.000Z missed closed",
      "2026-11-16T05:00:00.000Z missed closed",
      "2026-11-16T06:00:00.000Z missed closed",
      "2026-11-16T07:00:00.000Z missed closed",
      "2026-11-16T08:00:00.000Z missed closed",
    ])
  })
})

describe("a run that cannot start", () => {
  test("is still told in the history, as failed, and reads as read once viewed", async () => {
    const subject = app(Date.UTC(2026, 10, 16, 7, 59))
    const open = subject.launch()
    const routine = await create(open.backend, schedule("0 9 * * *"))
    await open.engine.check()
    // The service goes away between the clock's look and the run's start.
    subject.service.stop()
    await open.run(Date.UTC(2026, 10, 16, 8))
    await eventually(async () => (await history(open.backend, routine)).length === 1)
    const runs = await history(open.backend, routine)
    expect(lines(runs)).toEqual(["2026-11-16T08:00:00.000Z failed start"])
    expect(runs[0]).toMatchObject({ unread: true, conversation: { kind: "none" } })
    await open.backend.viewed(runs[0]!.ref.id)
    expect((await history(open.backend, routine))[0]?.unread).toBe(false)
    expect(subject.store.value.routines[0]?.due).toBe(Date.UTC(2026, 10, 16, 8))
  })
})

describe("runs cut by a restart", () => {
  test("a run that was going when the service stopped is interrupted at the next launch; one still going is not", async () => {
    const subject = app(Date.UTC(2026, 10, 16, 9))
    const first = subject.launch()
    const cut = await create(first.backend, manual("Cut"))
    const kept = await create(first.backend, manual("Kept"))
    const lost = await first.backend.start(cut)
    if (isFailure(lost)) throw new Error(lost.message)
    first.close()
    subject.service.restart()
    // Started after the restart: the service is running it.
    const second = subject.launch()
    const going = await second.backend.start(kept)
    if (isFailure(going)) throw new Error(going.message)
    second.close()

    const third = subject.launch()
    await third.engine.check()
    await eventually(async () => (await history(third.backend, cut))[0]?.state === "failed")
    expect(lines(await history(third.backend, cut))).toEqual(["- failed restart"])
    expect((await history(third.backend, kept))[0]?.state).toBe("running")
    expect(subject.service.prompts()).toHaveLength(2)
  })
})

describe("the plan", () => {
  const at = Date.UTC(2026, 10, 16, 12)
  const plan = (past: number[], input: { next?: number; going?: boolean } = {}, options = {}) =>
    RoutinesClock.plan(schedule("0 * * * *", options), {
      past,
      oldest: past[0]!,
      now: at,
      going: input.going ?? false,
      ...(input.next === undefined ? {} : { next: input.next }),
    })

  test("an occurrence on time runs as scheduled; older ones are grouped into it when recent", () => {
    expect(plan([at])).toEqual({ due: at, records: [], run: { due: at, trigger: "schedule" } })
    expect(plan([at - HOUR, at])).toEqual({
      due: at,
      records: [{ due: at - HOUR, state: "missed", reason: "grouped" }],
      run: { due: at, trigger: "schedule", since: at - HOUR },
    })
    expect(plan([at - HOUR, at], {}, { recover: "none" })).toEqual({
      due: at,
      records: [{ due: at - HOUR, state: "missed", reason: "closed" }],
      run: { due: at, trigger: "schedule" },
    })
  })

  test("a run skipped for an overlap groups nothing", () => {
    expect(plan([at - 2 * HOUR, at - HOUR], { going: true })).toEqual({
      due: at - HOUR,
      records: [
        { due: at - 2 * HOUR, state: "missed", reason: "closed" },
        { due: at - HOUR, state: "skipped", reason: "overlap" },
      ],
    })
  })
})
