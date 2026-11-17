import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { OpenCode } from "@opencode/client/promise"
import { isFailure, type Definition, type Failure, type Run } from "../../src/routines/contract"
import { RoutinesLocal } from "../../src/routines/local/backend"
import { clock, MINUTE, storage } from "./fixture"
import { fakeService, until } from "./service"

const home = await mkdtemp(path.join(tmpdir(), "routines-timeout-"))
const stops: Array<() => void> = []
afterAll(() => stops.forEach((stop) => stop()))

type Time = ReturnType<typeof clock>

// Timers on the test's clock, as `clock.test.ts` has them: `run(to)` moves the clock to `to`, firing each timer at its
// time on the way and waiting for what it did. `armed` is how many are waiting.
function timers(time: Time) {
  const armed = new Set<{ at: number; fire: () => unknown }>()
  return {
    armed: () => armed.size,
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

// The app: a fake service and the store; `launch` makes a backend over them, as when Dynwork starts.
function app() {
  const time = clock()
  const service = fakeService({ now: time.now })
  stops.push(service.stop)
  const store = storage(RoutinesLocal.Saved, RoutinesLocal.initial)
  const client = OpenCode.make({ baseUrl: service.url, headers: { authorization: "Basic c2VjcmV0" } })
  const notices: RoutinesLocal.Notice[] = []
  const launch = () => {
    const clocks = timers(time)
    const backend = RoutinesLocal.make({
      label: "Test Mac",
      store,
      client: () => client,
      server: "sidecar",
      home,
      now: time.now,
      notify: (notice) => void notices.push(notice),
      retry: 10,
      timers: clocks,
    })
    stops.push(backend.dispose)
    return { backend, clocks }
  }
  const interrupts = () => service.received.filter((request) => request.path.endsWith("/interrupt")).length
  return { time, service, notices, launch, interrupts }
}

const prompt = (options: Definition["options"] = {}): Definition => ({
  name: "Weekly report",
  instructions: { kind: "prompt", text: "Summarise the week." },
  enabled: true,
  options: { permissions: "ask", notify: "failures", ...options },
})

async function ok<A>(answer: Promise<A | Failure>): Promise<A> {
  const value = await answer
  if (isFailure(value)) throw new Error(`${value.code}: ${value.message}`)
  return value
}

const read = async (backend: RoutinesLocal.Local, routine: string) =>
  (await ok(backend.runs({ routine }))).items[0] as Run

describe("a run's time limit", () => {
  test("a run still going when its limit passes is interrupted, recorded failed (timeout) and told", async () => {
    const { time, launch, interrupts, notices } = app()
    const { backend, clocks } = launch()
    const routine = await ok(backend.create(prompt({ timeLimit: 10 })))
    const started = await ok(backend.start(routine.ref.id))
    const begun = time.now()

    await clocks.run(begun + 9 * MINUTE)
    expect(interrupts()).toBe(0)
    expect(backend.running()).toBe(1)

    await clocks.run(begun + 10 * MINUTE)
    expect(interrupts()).toBe(1)
    expect(backend.running()).toBe(0)
    expect(await read(backend, routine.ref.id)).toMatchObject({
      ref: started.ref,
      state: "failed",
      reason: "timeout",
      finished: begun + 10 * MINUTE,
    })
    await Bun.sleep(20)
    // The interrupt's own event does not turn it into a cancelled run, and it is told once.
    expect(await read(backend, routine.ref.id)).toMatchObject({ state: "failed", reason: "timeout" })
    expect(notices.map((notice) => notice.kind)).toEqual(["failed"])
    expect(notices[0]?.run.reason).toBe("timeout")
  })

  test("Notify me: never keeps a timeout quiet", async () => {
    const { time, launch, notices } = app()
    const { backend, clocks } = launch()
    const routine = await ok(backend.create(prompt({ notify: "never" })))
    await ok(backend.start(routine.ref.id))
    await clocks.run(time.now() + 30 * MINUTE)
    expect(await read(backend, routine.ref.id)).toMatchObject({ state: "failed", reason: "timeout" })
    expect(notices).toEqual([])
  })

  test("a run that ends before its limit is left alone and its timer is cleared", async () => {
    const { time, service, launch, interrupts } = app()
    const { backend, clocks } = launch()
    const routine = await ok(backend.create(prompt({ timeLimit: 10 })))
    await ok(backend.start(routine.ref.id))
    expect(clocks.armed()).toBe(1)
    await until(() => service.listeners() > 0)

    time.advance(2 * MINUTE)
    service.finish()
    await until(() => backend.running() === 0)
    expect(clocks.armed()).toBe(0)

    await clocks.run(time.now() + 20 * MINUTE)
    expect(interrupts()).toBe(0)
    expect(await read(backend, routine.ref.id)).toMatchObject({ state: "ok" })
  })

  test("a cancelled run's timer is cleared too", async () => {
    const { launch, interrupts } = app()
    const { backend, clocks } = launch()
    const routine = await ok(backend.create(prompt()))
    const run = await ok(backend.start(routine.ref.id))
    expect(await backend.cancel(run.ref.id)).toBeUndefined()
    expect(clocks.armed()).toBe(0)
    expect(interrupts()).toBe(1)
  })

  test("a run waiting for a permission nobody answers times out, and no longer reads as waiting", async () => {
    const { time, service, launch, notices } = app()
    const { backend, clocks } = launch()
    const routine = await ok(backend.create(prompt({ timeLimit: 5 })))
    const run = await ok(backend.start(routine.ref.id))
    await until(() => service.listeners() > 0)
    service.ask(run.ref.id, "per_1")
    await until(() => notices.length === 1)
    expect(await read(backend, routine.ref.id)).toMatchObject({ state: "running", reason: "permission" })

    await clocks.run(time.now() + 5 * MINUTE)
    const ended = await read(backend, routine.ref.id)
    expect(ended).toMatchObject({ state: "failed", reason: "timeout" })
    expect(ended.unread).toBe(true)
    expect(notices.map((notice) => notice.kind)).toEqual(["waiting", "failed"])
  })

  test("a run started before a restart whose limit passed is timed out on the next read; one within it is not", async () => {
    const { time, launch, interrupts } = app()
    const before = launch()
    const routine = await ok(before.backend.create(prompt({ timeLimit: 20 })))
    const quick = await ok(before.backend.create(prompt({ timeLimit: 120 })))
    await ok(before.backend.start(routine.ref.id))
    await ok(before.backend.start(quick.ref.id))
    before.backend.dispose()

    // The app was closed for 25 minutes. The new backend arms what is left, and a read does not wait for the timer.
    time.advance(25 * MINUTE)
    const after = launch()
    expect(after.clocks.armed()).toBe(2)
    expect(await read(after.backend, routine.ref.id)).toMatchObject({ state: "failed", reason: "timeout" })
    expect(interrupts()).toBe(1)
    expect(await read(after.backend, quick.ref.id)).toMatchObject({ state: "running" })
    expect(after.clocks.armed()).toBe(1)
  })
})
