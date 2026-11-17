import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { OpenCode } from "@opencode/client/promise"
import { isFailure, type Definition, type Failure, type Run } from "../../src/routines/contract"
import { RoutinesLocal } from "../../src/routines/local/backend"
import { clock, MINUTE, storage } from "./fixture"
import { fakeService, until } from "./service"

const home = await mkdtemp(path.join(tmpdir(), "routines-permissions-"))
const stops: Array<() => void> = []
afterAll(() => stops.forEach((stop) => stop()))

// A local backend over a fresh fake service that records what it tells the user and whether it asks to stay awake.
function setup() {
  const time = clock()
  const service = fakeService({ now: time.now })
  stops.push(service.stop)
  const notices: RoutinesLocal.Notice[] = []
  const awake: boolean[] = []
  const client = OpenCode.make({ baseUrl: service.url, headers: { authorization: "Basic c2VjcmV0" } })
  const backend = RoutinesLocal.make({
    label: "Test Mac",
    store: storage(RoutinesLocal.Saved, RoutinesLocal.initial),
    client: () => client,
    server: "sidecar",
    home,
    now: time.now,
    notify: (notice) => void notices.push(notice),
    busy: (going) => void awake.push(going),
    retry: 10,
  })
  stops.push(backend.dispose)
  return { time, service, backend, notices, awake }
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

// Waits for an async condition: the backend reacts to events over real sockets.
async function eventually(condition: () => Promise<boolean>) {
  const deadline = Date.now() + 3_000
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the condition")
    await Bun.sleep(2)
  }
}

// The run's state as the history reads it now.
async function read(backend: RoutinesLocal.Local, routine: string) {
  return (await ok(backend.runs({ routine }))).items[0] as Run
}

describe("the permissions of a run", () => {
  test("Don't ask creates the run's session with every request allowed and questions denied; Ask me asks for changes", async () => {
    const { backend, service } = setup()
    const bypass = await ok(backend.create(prompt({ permissions: "bypass" })))
    const asking = await ok(backend.create(prompt({ permissions: "ask" })))
    // Run now is a run like any other.
    await ok(backend.start(bypass.ref.id))
    await ok(backend.start(asking.ref.id))

    const children = service.received.filter(
      (request) => request.path === "/api/session" && request.method === "POST" && request.body?.parentID,
    )
    expect(children).toHaveLength(2)
    expect(children[0]?.body?.permissions).toEqual([
      { action: "*", resource: "*", effect: "allow" },
      { action: "question", resource: "*", effect: "deny" },
    ])
    // The last matching rule wins: reads and searches go ahead; edits, the shell, other folders and .env files ask.
    expect(children[1]?.body?.permissions).toEqual([
      { action: "*", resource: "*", effect: "ask" },
      ...["read", "glob", "grep", "webfetch", "websearch", "skill", "todowrite", "question", "subagent"].map((action) => ({
        action,
        resource: "*",
        effect: "allow",
      })),
      { action: "read", resource: "*.env", effect: "ask" },
      { action: "read", resource: "*.env.*", effect: "ask" },
      { action: "read", resource: "*.env.example", effect: "allow" },
    ])
  })

  test("a request makes the run wait, told once; answering the last one has it run again, and the run's end clears it", async () => {
    const { backend, service, time, notices } = setup()
    const routine = await ok(backend.create(prompt()))
    const started = await ok(backend.start(routine.ref.id))
    const seen: Run[] = []
    const stop = backend.watch((change) => change.run && seen.push(change.run))
    await until(() => service.listeners() > 0)

    service.ask(started.ref.id, "per_1")
    await until(() => seen.some((run) => run.reason === "permission"))
    expect(await read(backend, routine.ref.id)).toMatchObject({ state: "running", reason: "permission", unread: true })
    // A second request in the same wait is not told again, and one answer does not end the wait.
    service.ask(started.ref.id, "per_2")
    service.reply(started.ref.id, "per_1")
    await Bun.sleep(30)
    expect(await read(backend, routine.ref.id)).toMatchObject({ reason: "permission" })

    service.reply(started.ref.id, "per_2")
    await until(() => seen.some((run) => run.state === "running" && run.reason === undefined))
    const running = await read(backend, routine.ref.id)
    expect(running.state).toBe("running")
    expect(running.reason).toBeUndefined()
    expect(running.unread).toBe(false)
    expect(notices.map((notice) => notice.kind)).toEqual(["waiting"])

    // Waiting again, and the run ends: nothing of the wait is left on it.
    service.ask(started.ref.id, "per_3")
    await until(() => notices.length === 2)
    time.advance(MINUTE)
    service.finish()
    await until(() => backend.running() === 0)
    const ended = await read(backend, routine.ref.id)
    expect(ended.state).toBe("ok")
    expect(ended.reason).toBeUndefined()
    stop()
  })

  test("denying a request ends the run as stopped by the user, though core never marks its session idle", async () => {
    const { backend, service } = setup()
    const routine = await ok(backend.create(prompt()))
    const started = await ok(backend.start(routine.ref.id))
    const seen: Run[] = []
    const stop = backend.watch((change) => change.run && seen.push(change.run))
    await until(() => service.listeners() > 0)

    service.ask(started.ref.id, "per_1")
    await until(() => seen.some((run) => run.reason === "permission"))
    service.reply(started.ref.id, "per_1", "reject")
    await until(() => backend.running() === 0)
    // The session still reads as busy, and reading it again does not bring the run back.
    await ok(backend.runs({ routine: routine.ref.id }))
    expect(await read(backend, routine.ref.id)).toMatchObject({ state: "cancelled", reason: "user" })
    stop()
  })

  test("the routine's Notify me decides what is told; a run waiting for a permission is always told", async () => {
    const wanted = {
      failures: { ok: [], failed: ["failed"] },
      every: { ok: ["finished"], failed: ["failed"] },
      never: { ok: [], failed: [] },
    }
    for (const mode of ["failures", "every", "never"] as const) {
      for (const outcome of ["ok", "failed"] as const) {
        const { backend, service, notices } = setup()
        const routine = await ok(backend.create(prompt({ notify: mode })))
        const run = await ok(backend.start(routine.ref.id))
        await until(() => service.listeners() > 0)
        service.ask(run.ref.id, "per_1")
        await until(() => notices.length === 1)
        service.reply(run.ref.id, "per_1")
        service.finish(outcome === "ok" ? "succeeded" : "failed")
        await until(() => backend.running() === 0)
        await Bun.sleep(20)
        expect(notices.map((notice) => notice.kind)).toEqual(["waiting", ...wanted[mode][outcome]])
      }
    }
  })

  test("a cancelled run is not told, whatever Notify me says", async () => {
    const { backend, notices } = setup()
    const routine = await ok(backend.create(prompt({ notify: "every" })))
    const run = await ok(backend.start(routine.ref.id))
    expect(await backend.cancel(run.ref.id)).toBeUndefined()
    await Bun.sleep(20)
    expect(notices).toEqual([])
  })
})

describe("keeping the computer awake", () => {
  test("it is asked for when the first run starts and released when the last one ends, not before", async () => {
    const { backend, service, awake } = setup()
    const routine = await ok(backend.create(prompt()))
    expect(awake).toEqual([])
    const first = await ok(backend.start(routine.ref.id))
    const second = await ok(backend.start(routine.ref.id))
    expect(awake).toEqual([true])

    await backend.cancel(first.ref.id)
    expect(awake).toEqual([true])
    await backend.cancel(second.ref.id)
    expect(awake).toEqual([true, false])

    // And again with one run, which ends on its own.
    await ok(backend.start(routine.ref.id))
    expect(awake).toEqual([true, false, true])
    service.finish()
    await until(() => awake.length === 4)
    expect(awake).toEqual([true, false, true, false])
  })
})

describe("the service restarting while the app stays open", () => {
  test("a run the new service does not run is recorded as interrupted at once; one started after is left alone", async () => {
    const { backend, service, time } = setup()
    const routine = await ok(backend.create(prompt()))
    const cut = await ok(backend.start(routine.ref.id))
    await until(() => service.listeners() > 0)

    time.advance(MINUTE)
    service.restart()
    await eventually(async () => (await read(backend, routine.ref.id)).state === "failed")
    expect(await read(backend, routine.ref.id)).toMatchObject({ ref: cut.ref, state: "failed", reason: "restart" })

    // The reconnected stream follows what starts next.
    const next = await ok(backend.start(routine.ref.id))
    await Bun.sleep(50)
    expect((await ok(backend.runs({ routine: routine.ref.id }))).items.find((run) => run.ref.id === next.ref.id)).toMatchObject({
      state: "running",
    })
  })
})
