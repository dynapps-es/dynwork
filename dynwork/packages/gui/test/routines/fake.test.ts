import { describe, expect, test } from "bun:test"
import { RoutinesBackend } from "../../src/routines/backend"
import { isFailure, type Change, type Routine } from "../../src/routines/contract"
import { RoutinesDemo } from "../../src/routines/demo"
import { RoutinesFake } from "../../src/routines/fake"
import { conformance, expectFailure, sample, type Subject } from "./conformance"
import { clock, MINUTE } from "./fixture"

// The fakes run their own conformance: a run takes a minute of the test's clock, and `finish` moves it past that.
function subject(build: (now: () => number) => RoutinesFake.Fake): () => Subject {
  return () => {
    const time = clock()
    const backend = build(time.now)
    return {
      backend,
      finish: async () => {
        time.advance(10 * MINUTE)
        backend.settle()
      },
      ask: async (run, question) => backend.ask(run, question),
    }
  }
}

conformance("the local fake", subject(RoutinesDemo.local))
conformance("the remote fake", subject(RoutinesDemo.remote))

async function routines(backend: RoutinesFake.Fake) {
  const list = await backend.list()
  if (isFailure(list)) throw new Error(list.message)
  return list
}

async function withRuns(backend: RoutinesFake.Fake) {
  const found = (await routines(backend)).find((routine) => routine.last !== undefined)
  if (!found) throw new Error("no seeded routine has runs")
  return found.ref.id
}

async function runsOf(backend: RoutinesFake.Fake, routine: string) {
  const page = await backend.runs({})
  return isFailure(page) ? [] : page.items.filter((run) => run.routine?.id === routine)
}

describe("the demo seeds", () => {
  test("the local one has the mockup's routines: unread, failed, waiting for another device, paused", async () => {
    const list = await routines(RoutinesDemo.local(clock().now))
    expect(list).toHaveLength(4)
    expect(list.filter((routine) => routine.unread > 0).length).toBeGreaterThan(0)
    expect(list.some((routine) => routine.last?.state === "failed")).toBe(true)
    expect(list.some((routine) => routine.owner && !routine.owner.here && !routine.owner.online)).toBe(true)
    expect(list.some((routine) => routine.state === "paused")).toBe(true)
    expect(new Set(list.flatMap((routine) => routine.last?.conversation.kind ?? []))).toEqual(new Set(["session"]))
  })

  test("the remote one has farm routines: one running, one manual only, one paused, a quota shared with the team", async () => {
    const backend = RoutinesDemo.remote(clock().now)
    const list = await routines(backend)
    expect(list).toHaveLength(4)
    expect(list.some((routine) => routine.last?.state === "running")).toBe(true)
    expect(list.some((routine) => routine.definition.schedule === undefined)).toBe(true)
    expect(list.some((routine) => routine.state === "paused")).toBe(true)
    expect(list.every((routine) => routine.owner === undefined)).toBe(true)
    expect((await backend.capabilities()).quota).toEqual({ max: 20, used: 7, shared: true })
  })

  test("every run state of the mockup's history is there", async () => {
    const time = clock()
    const pages = await Promise.all(
      [RoutinesDemo.local(time.now), RoutinesDemo.remote(time.now)].map((backend) => backend.runs({})),
    )
    const states = pages.flatMap((page) => (isFailure(page) ? [] : page.items.map((run) => run.state)))
    expect(new Set(states)).toEqual(new Set(["ok", "late", "failed", "blocked", "running", "missed", "skipped"]))
  })

  test("the farm lists a run started outside DynWork, with no routine, and reads its transcript", async () => {
    const backend = RoutinesDemo.remote(clock().now)
    const page = await backend.runs({})
    if (isFailure(page)) throw new Error(page.message)
    const outside = page.items.find((run) => run.routine === undefined)
    expect(outside?.conversation.kind).toBe("transcript")
    const transcript = await backend.transcript(outside?.ref.id ?? "")
    expect(isFailure(transcript) ? undefined : transcript.result).toBeString()
  })

  test("they register only where no backend is registered already", () => {
    const registry = RoutinesBackend.make()
    const time = clock()
    const real = RoutinesDemo.remote(time.now)
    registry.register(real)
    const added = RoutinesDemo.register(registry, time.now)
    expect(registry.list().map((backend) => backend.id)).toEqual([real.id, "local"])
    expect(registry.get(real.id)).toBe(real)
    expect(added.map((backend) => backend.id)).toEqual(["local"])
  })
})

describe("the clock", () => {
  test("a run finishes when the clock passes its duration and settle runs, not before", async () => {
    const time = clock()
    const backend = RoutinesDemo.local(time.now)
    const changes: Change[] = []
    backend.watch((change) => changes.push(change))
    const first = (await routines(backend))[0] as Routine
    const run = await backend.start(first.ref.id)
    if (isFailure(run)) throw new Error(run.message)

    time.advance(30_000)
    backend.settle()
    const running = await backend.runs({ routine: first.ref.id })
    expect(isFailure(running) ? undefined : running.items[0]).toMatchObject({ state: "running", ref: run.ref })
    const startedAt = time.now() - 30_000
    time.advance(MINUTE)
    backend.settle()
    const page = await backend.runs({ routine: first.ref.id })
    if (isFailure(page)) throw new Error(page.message)
    expect(page.items[0]).toMatchObject({ state: "ok", started: startedAt, finished: startedAt + MINUTE, unread: true })
    expect(changes.filter((change) => change.run?.state === "ok")).toHaveLength(1)
    backend.settle()
    expect(changes.filter((change) => change.run?.state === "ok")).toHaveLength(1)
  })

  test("a scheduled routine's next run is a day after it last changed, and a paused one has none", async () => {
    const time = clock()
    const backend = RoutinesDemo.local(time.now)
    const created = await backend.create(await sample(backend, "Clocked"))
    if (isFailure(created)) throw new Error(created.message)
    expect(created.next).toBe(time.now() + 24 * 60 * MINUTE)
    time.advance(MINUTE)
    await backend.pause(created.ref.id)
    expect(await backend.get(created.ref.id)).toMatchObject({ state: "paused", next: undefined, updated: time.now() })
  })
})

describe("paging", () => {
  test("runs come in pages of the size the fake was made with", async () => {
    const time = clock()
    const backend = RoutinesFake.make({
      id: "paged",
      capabilities: await RoutinesDemo.local(time.now).capabilities(),
      conversation: "session",
      now: time.now,
      pageSize: 2,
    })
    const list = await backend.create(await sample(backend, "Paged"))
    if (isFailure(list)) throw new Error(list.message)
    await Promise.all([1, 2, 3, 4, 5].map(() => backend.start(list.ref.id)))
    const first = await backend.runs({})
    if (isFailure(first)) throw new Error(first.message)
    expect(first.items).toHaveLength(2)
    const second = await backend.runs({ cursor: first.next })
    const third = await backend.runs({ cursor: isFailure(second) ? undefined : second.next })
    expect([second, third].map((page) => (isFailure(page) ? -1 : page.items.length))).toEqual([2, 1])
    expect(isFailure(third) ? "failed" : third.next).toBeUndefined()
    expectFailure(await backend.runs({ cursor: "abc" }), "invalid")
  })
})

describe("status", () => {
  test.each([
    { status: "signed-out" as const, code: "signed-out" as const },
    { status: "unreachable" as const, code: "unreachable" as const },
    { status: "disabled" as const, code: "unsupported" as const },
  ])("a $status backend still answers its capabilities, and nothing else but $code", async (row) => {
    const backend = RoutinesDemo.remote(clock().now)
    backend.setStatus(row.status, "Because.")
    expect(await backend.capabilities()).toMatchObject({ status: row.status, detail: "Because." })
    expectFailure(await backend.list(), row.code)
    expectFailure(await backend.get("anything"), row.code)
    expectFailure(await backend.start("anything"), row.code)
    expectFailure(await backend.runs({}), row.code)
    expectFailure(await backend.options("agents"), row.code)
    backend.setStatus("ready")
    expect(isFailure(await backend.list())).toBe(false)
  })
})

describe("what the fakes keep of the real backends' behavior", () => {
  test("replacing a farm schedule leaves the old one's runs in Activity", async () => {
    const backend = RoutinesDemo.remote(clock().now)
    const mine = (await routines(backend)).find((routine) => routine.last !== undefined && routine.definition.schedule)
    if (!mine) throw new Error("no seeded routine with runs")
    const before = await backend.runs({ routine: mine.ref.id })
    const updated = await backend.update(mine.ref.id, { ...mine.definition, name: "Renamed" })
    if (isFailure(updated)) throw new Error(updated.message)
    expect(await backend.runs({ routine: mine.ref.id })).toEqual(before)
    expect(await backend.runs({ routine: updated.ref.id })).toMatchObject({ items: [] })
  })

  test("removing a local routine removes its runs with its anchor session; a farm one keeps them", async () => {
    const time = clock()
    const local = RoutinesDemo.local(time.now)
    const farm = RoutinesDemo.remote(time.now)
    const [localId, farmId] = await Promise.all([withRuns(local), withRuns(farm)])
    expect(await runsOf(local, localId)).not.toEqual([])
    expect(await runsOf(farm, farmId)).not.toEqual([])
    await local.remove(localId)
    await farm.remove(farmId)
    expect(await runsOf(local, localId)).toEqual([])
    expect(await runsOf(farm, farmId)).not.toEqual([])
  })

  test("a lookup is searched by value and label", async () => {
    const backend = RoutinesDemo.remote(clock().now)
    const found = await backend.options("agents", "MR")
    expect(isFailure(found) ? [] : found.map((choice) => choice.value)).toEqual(["mr-review"])
  })
})

describe("the demo's remote run that waits on a question", () => {
  test("is a running run with the reason `question`, and answering it lets it finish", async () => {
    const time = clock()
    const backend = RoutinesDemo.remote(time.now)
    const page = await backend.runs({})
    if (isFailure(page)) throw new Error(page.message)
    const waiting = page.items.find((run) => run.question)
    const question = waiting?.question
    if (!waiting || !question) throw new Error("the demo has no waiting run")
    expect(waiting.state).toBe("running")
    expect(waiting.reason).toBe("question")
    expect(waiting.unread).toBe(true)
    expect(question.choices.length).toBeGreaterThan(1)

    // Waiting runs do not finish by themselves.
    time.advance(10 * MINUTE)
    backend.settle()
    const still = await backend.runs({})
    if (isFailure(still)) throw new Error(still.message)
    expect(still.items.find((run) => run.ref.id === waiting.ref.id)).toMatchObject({ state: "running" })

    const choice = question.choices[0] ?? ""
    expect(await backend.answerQuestion?.({ run: waiting.ref.id, question: question.id, choice })).toBeUndefined()
    const after = await backend.runs({})
    if (isFailure(after)) throw new Error(after.message)
    const answered = after.items.find((run) => run.ref.id === waiting.ref.id)
    expect(answered).toMatchObject({ state: "running", unread: false })
    expect(answered?.question).toBeUndefined()
    expect(answered?.reason).toBeUndefined()
  })
})

describe("a reply on the fakes", () => {
  test("the remote fake resumes: a new run of the same routine, the old one untouched", async () => {
    const backend = RoutinesDemo.remote(clock().now)
    const page = await backend.runs({})
    if (isFailure(page)) throw new Error(page.message)
    const finished = page.items.find((run) => run.state === "ok" && run.routine)
    if (!finished) throw new Error("no finished run")
    const next = await backend.reply?.({ run: finished.ref.id, text: "Now do the same for the other repository." })
    if (!next || isFailure(next)) throw new Error("reply failed")
    expect(next.routine).toEqual(finished.routine)
    expect(next.ref.id).not.toBe(finished.ref.id)
    expect(next.state).toBe("running")
    const after = await backend.runs({})
    if (isFailure(after)) throw new Error(after.message)
    expect(after.items.find((run) => run.ref.id === finished.ref.id)).toEqual(finished)
  })

  test("the local fake keeps the conversation in place, so it has no reply to give", async () => {
    const backend = RoutinesDemo.local(clock().now)
    const page = await backend.runs({})
    if (isFailure(page)) throw new Error(page.message)
    const run = page.items[0]
    expectFailure(await backend.reply?.({ run: run?.ref.id ?? "", text: "More." }), "unsupported")
    expectFailure(await backend.answerQuestion?.({ run: run?.ref.id ?? "", question: "q", choice: "Yes" }), "conflict")
  })

  test("a run with a question waiting is answered, not replied to", async () => {
    const backend = RoutinesDemo.remote(clock().now)
    const page = await backend.runs({})
    if (isFailure(page)) throw new Error(page.message)
    const waiting = page.items.find((run) => run.question)
    expectFailure(await backend.reply?.({ run: waiting?.ref.id ?? "", text: "Go on." }), "conflict")
  })
})
