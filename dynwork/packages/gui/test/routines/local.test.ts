import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { OpenCode } from "@opencode/client/promise"
import type { Persisted } from "@opencode/plugin/gui/main"
import { isFailure, type Definition, type Failure, type Run } from "../../src/routines/contract"
import { RoutinesLocal } from "../../src/routines/local/backend"
import { conformance, expectFailure } from "./conformance"
import { clock, MINUTE, storage } from "./fixture"
import { fakeService, until } from "./service"

const home = await mkdtemp(path.join(tmpdir(), "routines-"))
const stops: Array<() => void> = []
afterAll(() => stops.forEach((stop) => stop()))

// A local backend over a fresh fake service, with its own clock and storage.
function setup(options: { store?: Persisted<RoutinesLocal.Saved, RoutinesLocal.Saved>; reachable?: boolean } = {}) {
  const time = clock()
  const service = fakeService({ now: time.now })
  stops.push(service.stop)
  const store = options.store ?? storage(RoutinesLocal.Saved, RoutinesLocal.initial)
  const notices: RoutinesLocal.Notice[] = []
  const awake: boolean[] = []
  const reachable = { value: options.reachable ?? true }
  const client = OpenCode.make({ baseUrl: service.url, headers: { authorization: "Basic c2VjcmV0" } })
  const backend = RoutinesLocal.make({
    label: "Test Mac",
    store,
    client: () => (reachable.value ? client : undefined),
    server: "sidecar",
    home,
    now: time.now,
    notify: (notice) => void notices.push(notice),
    busy: (going) => void awake.push(going),
    retry: 10,
  })
  stops.push(backend.dispose)
  return { time, service, store, backend, notices, awake, reachable }
}

const prompt = (patch: Partial<Definition> = {}, options: Definition["options"] = {}): Definition => ({
  name: "Weekly report",
  instructions: { kind: "prompt", text: "Summarise the week." },
  enabled: true,
  options: { permissions: "ask", timeLimit: 30, catchUp: 6, notify: "failures", ...options },
  ...patch,
})

async function ok<A>(answer: Promise<A | Failure>): Promise<A> {
  const value = await answer
  if (isFailure(value)) throw new Error(`${value.code}: ${value.message}`)
  return value
}

conformance("the local backend over a fake service", () => {
  const subject = setup()
  return {
    backend: subject.backend,
    finish: async () => {
      subject.time.advance(5 * MINUTE)
      subject.service.finish()
      await until(() => subject.backend.running() === 0)
    },
  }
})

describe("the local backend's permissions field", () => {
  test("offers Ask me, the default, and Don't ask, which warns about editing and running without asking", async () => {
    const { backend } = setup()
    const field = (await backend.capabilities()).fields.find((candidate) => candidate.key === "permissions")
    expect(field).toMatchObject({ default: "ask", section: "permissions" })
    expect(field?.choices?.map((choice) => [choice.value, choice.warning])).toEqual([
      ["ask", undefined],
      ["bypass", "The task may edit files and run commands without asking you."],
    ])
  })
})

describe("the local backend", () => {
  test("two starts at once launch one run: the second answers conflict", async () => {
    const { backend, service, time } = setup()
    const routine = await ok(backend.create(prompt()))
    const answers = await Promise.all([backend.start(routine.ref.id), backend.start(routine.ref.id)])
    expect(answers.filter((answer) => !isFailure(answer))).toHaveLength(1)
    expect(answers.filter((answer) => isFailure(answer))).toMatchObject([
      { code: "conflict", message: "A run of this task is still going." },
    ])
    expect(backend.running()).toBe(1)
    // Neither start left the routine marked: once the run ends, it starts again.
    time.advance(5 * MINUTE)
    service.finish()
    await until(() => backend.running() === 0)
    await ok(backend.start(routine.ref.id))
  })

  test("a manual start still launching counts as going, so a scheduled run does not start beside it", async () => {
    const { backend } = setup()
    const routine = await ok(backend.create(prompt()))
    const started = backend.start(routine.ref.id)
    expect(await backend.going(routine.ref.id)).toBe(true)
    await ok(started)
    expect(await backend.going(routine.ref.id)).toBe(true)
  })

  test("start creates the anchor once, then a child session per run with the routine's fields", async () => {
    const { backend, service, time } = setup()
    const routine = await ok(
      backend.create(prompt({ agent: "build", model: "anthropic/claude-sonnet-5-5" }, { folder: "/work/portal" })),
    )
    const first = await ok(backend.start(routine.ref.id))
    expectFailure(await backend.start(routine.ref.id), "conflict")
    time.advance(5 * MINUTE)
    service.finish()
    await until(() => backend.running() === 0)
    const second = await ok(backend.start(routine.ref.id))

    const created = service.received.filter((request) => request.method === "POST" && request.path === "/api/session")
    expect(created).toHaveLength(3)
    const anchor = created[0]?.body
    expect(anchor).toMatchObject({
      title: "Weekly report",
      location: { directory: "/work/portal" },
      metadata: { dynwork: { routine: routine.ref.id, role: "anchor" } },
    })
    expect(anchor?.parentID).toBeUndefined()
    const anchorID = [...service.sessions.values()].find((session) => !session.parentID)?.id
    if (!anchorID) throw new Error("no anchor")
    // A run's id says it is an automation run's child, so it does not report to the anchor or wake it.
    created.slice(1).forEach((request) => expect(String(request.body?.id)).toStartWith("ses_aut_"))
    created.slice(1).forEach((request) =>
      expect(request.body).toMatchObject({
        parentID: anchorID,
        agent: "build",
        model: { providerID: "anthropic", id: "claude-sonnet-5-5" },
        // A run is a conversation of its own: the app gives it the standard composer, not the subagent bar.
        metadata: { conversation: true, dynwork: { routine: routine.ref.id, role: "run", trigger: "manual" } },
      }),
    )
    // "Ask me" brings rules that make edits and the shell wait for the user (permissions.test.ts has them all).
    created.slice(1).forEach((request) =>
      expect((request.body?.permissions as unknown[])[0]).toEqual({ action: "*", resource: "*", effect: "ask" }),
    )
    // A child gets no automatic title: the run's own is "<name> · <when>".
    expect(String(created[1]?.body?.title)).toStartWith("Weekly report · ")
    expect(created[1]?.body?.location).toBeUndefined()

    const prompts = service.received.filter((request) => request.path.endsWith("/prompt"))
    expect(prompts.map((request) => request.path)).toEqual([
      `/api/session/${first.ref.id}/prompt`,
      `/api/session/${second.ref.id}/prompt`,
    ])
    expect(prompts[0]?.body).toMatchObject({ text: "Summarise the week." })
    expect(first.conversation).toEqual({ kind: "session", server: "sidecar", session: first.ref.id, anchor: anchorID })
    expect((await ok(backend.get(routine.ref.id))).conversation).toMatchObject({ kind: "session", anchor: anchorID })
  })

  test("a routine without a folder runs in the routines home; a skill is sent as the prompt's skill", async () => {
    const { backend, service } = setup()
    const routine = await ok(
      backend.create(prompt({ instructions: { kind: "skill", skill: "standup", text: "Only today." } })),
    )
    await ok(backend.start(routine.ref.id))
    const anchor = service.received.find((request) => request.path === "/api/session" && request.method === "POST")
    expect(anchor?.body?.location).toEqual({ directory: home })
    const sent = service.received.find((request) => request.path.endsWith("/prompt"))
    expect(sent?.body).toMatchObject({ text: "Only today.", skills: [{ id: "standup" }] })
  })

  test("an anchor the user deleted is made again at the next run", async () => {
    const { backend, service } = setup()
    const routine = await ok(backend.create(prompt()))
    const first = await ok(backend.start(routine.ref.id))
    if (first.conversation.kind !== "session") throw new Error("no session")
    service.remove(first.conversation.anchor)
    const second = await ok(backend.start(routine.ref.id))
    if (second.conversation.kind !== "session") throw new Error("no session")
    expect(second.conversation.anchor).not.toBe(first.conversation.anchor)
    expect(service.sessions.get(second.conversation.anchor)?.metadata).toMatchObject({ dynwork: { role: "anchor" } })
    // The run whose session went with the anchor stays in the history, as failed.
    const gone = (await ok(backend.runs({ routine: routine.ref.id }))).items.find((run) => run.ref.id === first.ref.id)
    expect(gone).toMatchObject({ state: "failed", reason: "deleted" })
  })

  test("definitions and runs survive a new backend over the same storage", async () => {
    const first = setup()
    const routine = await ok(first.backend.create(prompt()))
    const run = await ok(first.backend.start(routine.ref.id))
    first.time.advance(MINUTE)
    first.service.finish()
    await until(() => first.backend.running() === 0)
    first.backend.dispose()

    const second = setup({ store: first.store })
    const listed = await ok(second.backend.list())
    expect(listed.map((item) => item.definition)).toEqual([routine.definition])
    expect(listed[0]?.last).toMatchObject({ ref: run.ref, state: "ok", unread: true })
    expect(listed[0]?.unread).toBe(1)
  })

  test("viewed marks the run's session viewed at its idle, and the run reads as read", async () => {
    const { backend, service, time } = setup()
    const routine = await ok(backend.create(prompt()))
    const run = await ok(backend.start(routine.ref.id))
    time.advance(MINUTE)
    service.finish()
    await until(() => backend.running() === 0)
    await backend.viewed(run.ref.id)
    const view = service.received.find((request) => request.path === `/api/session/${run.ref.id}/view`)
    expect(view?.body).toEqual({ idle: service.sessions.get(run.ref.id)?.time.idle })
    expect((await ok(backend.get(routine.ref.id))).unread).toBe(0)
  })

  test("a run that ends notes its outcome on the anchor, and a failure is reported once", async () => {
    const { backend, service, time, notices } = setup()
    const routine = await ok(backend.create(prompt()))
    const run = await ok(backend.start(routine.ref.id))
    if (run.conversation.kind !== "session") throw new Error("no session")
    const anchor = run.conversation.anchor
    time.advance(MINUTE)
    service.finish("failed")
    await until(() => backend.running() === 0)
    await until(() => service.sessions.get(anchor)?.metadata?.dynwork !== undefined && notices.length > 0)
    expect(service.sessions.get(anchor)?.metadata).toMatchObject({
      dynwork: { routine: routine.ref.id, role: "anchor", last: { run: run.ref.id, state: "failed" } },
    })
    await ok(backend.runs({ routine: routine.ref.id }))
    expect(notices.map((notice) => [notice.kind, notice.run.ref.id])).toEqual([["failed", run.ref.id]])
  })

  test("cancel interrupts the run's session and the run reads cancelled at once", async () => {
    const { backend, service } = setup()
    const routine = await ok(backend.create(prompt()))
    const run = await ok(backend.start(routine.ref.id))
    expect(await backend.cancel(run.ref.id)).toBeUndefined()
    expect(service.received.some((request) => request.path === `/api/session/${run.ref.id}/interrupt`)).toBe(true)
    expect((await ok(backend.runs({ routine: routine.ref.id }))).items[0]).toMatchObject({ state: "cancelled" })
  })

  test("renaming retitles the anchor and a new folder moves it", async () => {
    const { backend, service } = setup()
    const routine = await ok(backend.create(prompt()))
    const run = await ok(backend.start(routine.ref.id))
    if (run.conversation.kind !== "session") throw new Error("no session")
    await ok(backend.update(routine.ref.id, { ...routine.definition, name: "Monday report" }))
    expect(service.sessions.get(run.conversation.anchor)?.title).toBe("Monday report")
    await ok(
      backend.update(routine.ref.id, {
        ...routine.definition,
        options: { ...routine.definition.options, folder: "/work/other" },
      }),
    )
    expect(service.sessions.get(run.conversation.anchor)?.location).toEqual({ directory: "/work/other" })
  })

  test("without the service, routines still list but a run cannot start", async () => {
    const { backend } = setup({ reachable: false })
    expect((await backend.capabilities()).status).toBe("unreachable")
    const routine = await ok(backend.create(prompt()))
    expect((await ok(backend.list())).map((item) => item.ref)).toEqual([routine.ref])
    expectFailure(await backend.start(routine.ref.id), "unreachable")
  })

  test("removing a routine keeps its conversation in the service", async () => {
    const { backend, service } = setup()
    const routine = await ok(backend.create(prompt()))
    const run = await ok(backend.start(routine.ref.id))
    expect(await backend.remove(routine.ref.id)).toBeUndefined()
    expect(service.sessions.has(run.ref.id)).toBe(true)
    expect(service.received.some((request) => request.method === "DELETE")).toBe(false)
  })

  test("agents, models and skills come from the service, models as provider/model", async () => {
    const { backend } = setup()
    expect(await backend.options("agents")).toEqual([
      { value: "build", label: "build" },
      { value: "plan", label: "plan" },
    ])
    expect(await backend.options("models")).toEqual([
      { value: "anthropic/claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
    ])
    expect(await backend.options("models", "opus")).toEqual([])
    expect(await backend.options("skills")).toEqual([{ value: "standup", label: "standup" }])
  })

  test("the event stream comes back after the service drops it, and a run ending meanwhile is still seen", async () => {
    const { backend, service, time } = setup()
    const routine = await ok(backend.create(prompt()))
    const seen: Run[] = []
    const stop = backend.watch((change) => change.run && seen.push(change.run))
    await ok(backend.start(routine.ref.id))
    await until(() => service.listeners() > 0)
    service.drop()
    time.advance(MINUTE)
    service.finish()
    await until(() => seen.some((run) => run.state === "ok"))
    stop()
  })
})
