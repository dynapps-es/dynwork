import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { Change, isFailure, Run, RunPage, Transcript, type Definition, type Failure } from "../../src/routines/contract"
import { RoutinesFarm } from "../../src/routines/farm/backend"
import { startFake, until, type Fake } from "../accounts/fixture"
import { fakeFarm, signedIn, type FakeFarm, type Message } from "./farm-server"
import { crossing } from "./wire"

// The runs of the farm backend over the real transport and accounts, against the fake farm behind the fake Governance
// MCP proxy: a run is a farm task, read with the farm's own tools.
let sp: Fake
let farm: FakeFarm
const stops: Array<() => void> = []

beforeAll(() => {
  sp = startFake()
  farm = fakeFarm({ authorize: (bearer) => sp.state.jwts.has(bearer) })
})

afterAll(() => {
  stops.forEach((stop) => stop())
  farm.stop()
  sp.stop()
})

beforeEach(() => {
  Object.assign(farm.state, {
    ceiling: "bypass",
    userCredential: true,
    uploaded: undefined,
    freePrompt: true,
    maxPerUser: 20,
    maxTenant: 500,
    catalogue: ["claude-sonnet-5-5"],
    agents: [{ slug: "code-reviewer" }],
    credentials: [{ name: "git-readonly", type: "git_token" }],
    resultBase: undefined,
    unauthorized: false,
    unavailable: false,
    down: false,
  })
  farm.state.schedules.clear()
  farm.state.tasks.clear()
  farm.state.documents.clear()
  farm.reset()
})

async function cloud(options: { fetch?: typeof fetch } = {}) {
  const connected = await signedIn(sp, farm, options)
  stops.push(connected.accounts.dispose)
  return connected
}

async function ok<A>(answer: Promise<A | Failure>) {
  const value = await answer
  if (isFailure(value)) throw new Error(`${value.code}: ${value.message}`)
  return value
}

const definition = (name: string, extra: Partial<Definition> = {}): Definition => ({
  name,
  instructions: { kind: "prompt", text: `Do ${name}.` },
  schedule: { cron: "0 9 * * 1-5", timezone: "Europe/Madrid" },
  enabled: true,
  options: { overlap: "allow" },
  ...extra,
})

const calls = (name: string) => farm.state.calls.filter((call) => call.name === name)

const iso = (ms: number) => new Date(ms).toISOString()

describe("runs", () => {
  test("a routine's runs are its schedule's tasks, newest first, with the farm's state, seen flag and question", async () => {
    const { backend } = await cloud()
    const routine = await ok(backend.create(definition("Digest")))
    const [first, second, third] = [
      await ok(backend.start(routine.ref.id)),
      await ok(backend.start(routine.ref.id)),
      await ok(backend.start(routine.ref.id)),
    ]
    farm.advance(first.ref.id, { state: "succeeded", started_at: iso(Date.now() - 3000), result: "Done." })
    farm.advance(second.ref.id, { state: "failed", started_at: iso(Date.now() - 2000), failure_reason: "timeout" })
    farm.advance(third.ref.id, {
      state: "running",
      started_at: iso(Date.now() - 1000),
      question: {
        seq: 2,
        text: "Use Bash?",
        asked_at: iso(Date.now()),
        kind: "permission",
        options: ["Allow", "Deny"],
      },
    })

    const page = await ok(backend.runs({ routine: routine.ref.id }))
    expect(page.items.map((run) => run.ref.id)).toEqual([third.ref.id, second.ref.id, first.ref.id])
    expect(page.next).toBeUndefined()
    expect(page.items[0]).toMatchObject({
      routine: routine.ref,
      state: "running",
      reason: "question",
      unread: true,
      trigger: "manual",
      title: "Digest",
      question: { id: "q-2", text: "Use Bash?", choices: ["Allow", "Deny"] },
      conversation: { kind: "transcript" },
    })
    expect(page.items[1]).toMatchObject({ state: "failed", reason: "timeout", unread: true })
    expect(page.items[1]?.finished).toBeNumber()
    expect(page.items[2]).toMatchObject({ state: "ok", unread: true })
    expect(page.items[2]).not.toHaveProperty("question")
    expect(crossing(RunPage, page)).toEqual(page)
    expect(calls("farm_list_schedule_runs")[0]?.args).toEqual({ schedule_id: routine.ref.id })

    const read = await ok(backend.get(routine.ref.id))
    expect(read.last?.ref).toEqual(third.ref)
    expect(read.unread).toBe(3)
    expect((await ok(backend.list()))[0]?.unread).toBe(3)
  })

  test("the farm's states are the contract's: queued, running, ok, failed, cancelled; expired is failed", async () => {
    const { backend } = await cloud()
    const routine = await ok(backend.create(definition("States")))
    const states = ["pending", "queued", "running", "succeeded", "failed", "cancelled", "expired"] as const
    const runs = await Promise.all(states.map(() => ok(backend.start(routine.ref.id))))
    runs.forEach((run, index) =>
      farm.advance(run.ref.id, {
        state: states[index],
        // An expired task may still show the question nobody answered: it is no longer waiting.
        ...(states[index] === "expired"
          ? {
              failure_reason: "question_unanswered",
              question: { seq: 1, text: "Still there?", asked_at: iso(Date.now()), kind: "ask", options: null },
            }
          : {}),
      }),
    )
    const page = await ok(backend.runs({ routine: routine.ref.id }))
    const byId = new Map(page.items.map((run) => [run.ref.id, run]))
    expect(runs.map((run) => byId.get(run.ref.id)?.state)).toEqual([
      "queued",
      "queued",
      "running",
      "ok",
      "failed",
      "cancelled",
      "failed",
    ])
    expect(byId.get(runs[6]?.ref.id ?? "")?.reason).toBe("question_unanswered")
    expect(byId.get(runs[6]?.ref.id ?? "")).not.toHaveProperty("question")
    expect(runs.slice(0, 3).map((run) => byId.get(run.ref.id)?.unread)).toEqual([false, false, false])
  })

  test("a routine's runs are paged here, without repeats, since the farm does not page them", async () => {
    const { backend } = await cloud()
    const routine = await ok(backend.create(definition("Many")))
    const started = await Promise.all(
      Array.from({ length: RoutinesFarm.page + 3 }, () => ok(backend.start(routine.ref.id))),
    )
    const first = await ok(backend.runs({ routine: routine.ref.id }))
    expect(first.items).toHaveLength(RoutinesFarm.page)
    expect(first.next).toBeString()
    const second = await ok(backend.runs({ routine: routine.ref.id, cursor: first.next }))
    expect(second.items).toHaveLength(3)
    expect(second.next).toBeUndefined()
    const seen = [...first.items, ...second.items].map((run) => run.ref.id)
    expect(seen.toSorted()).toEqual(started.map((run) => run.ref.id).toSorted())
    expect(await backend.runs({ routine: routine.ref.id, cursor: "x" })).toMatchObject({ code: "invalid" })
  })

  test("Activity is every task of mine, newest first, following the farm's own cursor", async () => {
    const { backend } = await cloud()
    const routine = await ok(backend.create(definition("Activity")))
    const started: Run[] = []
    for (const _ of Array.from({ length: 27 })) started.push(await ok(backend.start(routine.ref.id)))
    const first = await ok(backend.runs({}))
    expect(calls("farm_list_tasks").at(-1)?.args).toMatchObject({ owner: "me" })
    expect(first.items).toHaveLength(25)
    expect(first.next).toBe("c25")
    const second = await ok(backend.runs({ cursor: first.next }))
    expect(calls("farm_list_tasks").at(-1)?.args).toMatchObject({ owner: "me", cursor: "c25" })
    expect(second.next).toBeUndefined()
    const seen = [...first.items, ...second.items]
    expect(seen.map((run) => run.ref.id)).toEqual(started.map((run) => run.ref.id).toReversed())
    // The routine of each is known from when it was started: the farm does not say it on a task.
    expect(seen.every((run) => run.routine?.id === routine.ref.id && run.title === "Activity")).toBe(true)
  })

  test("a firing Dynwork did not start is known by its routine in Activity once the routine's runs were read", async () => {
    const { backend, client } = await cloud()
    const routine = await ok(backend.create(definition("Elsewhere")))
    const fired = await client.callTool("farm_fire_schedule", { schedule_id: routine.ref.id })
    const id = fired.ok ? String(fired.value.task_id) : ""
    expect((await ok(backend.runs({}))).items.find((run) => run.ref.id === id)?.routine).toBeUndefined()
    await ok(backend.runs({ routine: routine.ref.id }))
    expect((await ok(backend.runs({}))).items.find((run) => run.ref.id === id)).toMatchObject({
      routine: routine.ref,
      title: "Elsewhere",
    })
  })

  test("a run that failed because the user lost Cloud keeps its reason; the routine stays as it was", async () => {
    const { backend } = await cloud()
    const routine = await ok(backend.create(definition("Revoked")))
    const run = await ok(backend.start(routine.ref.id))
    farm.advance(run.ref.id, { state: "failed", failure_reason: "farm_access_revoked" })
    const read = (await ok(backend.runs({ routine: routine.ref.id }))).items[0]
    expect(read).toMatchObject({ state: "failed", reason: "farm_access_revoked" })
    const after = await ok(backend.get(routine.ref.id))
    expect(after.state).toBe("active")
    expect(after.definition).toEqual(routine.definition)
    expect(calls("farm_pause_schedule")).toEqual([])
    expect(calls("farm_delete_schedule")).toEqual([])
  })
})

describe("cancel, viewed and what does not exist", () => {
  test("cancel stops a task that is going; a finished one is a conflict", async () => {
    const { backend } = await cloud()
    const routine = await ok(backend.create(definition("Stop")))
    const run = await ok(backend.start(routine.ref.id))
    expect(await backend.cancel(run.ref.id)).toBeUndefined()
    expect(calls("farm_cancel_task")[0]?.args).toEqual({ task_id: run.ref.id })
    expect(farm.state.tasks.get(run.ref.id)?.state).toBe("cancelled")
    expect(await backend.cancel(run.ref.id)).toMatchObject({ code: "conflict" })
  })

  test("viewed marks the farm task as seen, and it stops counting as unread", async () => {
    const { backend } = await cloud()
    const routine = await ok(backend.create(definition("Seen")))
    const run = await ok(backend.start(routine.ref.id))
    farm.advance(run.ref.id, { state: "succeeded", result: "Done." })
    expect((await ok(backend.get(routine.ref.id))).unread).toBe(1)
    await backend.viewed(run.ref.id)
    expect(calls("farm_mark_task_viewed")[0]?.args).toEqual({ task_id: run.ref.id })
    expect(farm.state.tasks.get(run.ref.id)?.viewed).toBe(true)
    expect((await ok(backend.get(routine.ref.id))).unread).toBe(0)
  })

  test("`last`, which the farm reads as the newest task, is not a run id: not-found, nothing sent", async () => {
    const { backend } = await cloud()
    farm.reset()
    expect(await backend.cancel("last")).toMatchObject({ code: "not-found" })
    expect(await backend.transcript("last")).toMatchObject({ code: "not-found" })
    expect(await backend.reply?.({ run: "last", text: "Go on." })).toMatchObject({ code: "not-found" })
    expect(await backend.answerQuestion?.({ run: "last", question: "q-1", choice: "Yes" })).toMatchObject({
      code: "not-found",
    })
    await backend.viewed("last")
    expect(farm.called()).toEqual([])
  })

  test("a farm that is down answers unreachable to every run method, and nothing rejects", async () => {
    const { backend } = await cloud()
    farm.state.down = true
    const answers = await Promise.all([
      backend.runs({}),
      backend.runs({ routine: "x" }),
      backend.cancel("x"),
      backend.transcript("x"),
      backend.reply?.({ run: "x", text: "Go on." }),
      backend.answerQuestion?.({ run: "x", question: "q-1", choice: "Yes" }),
    ])
    answers.forEach((answer) => expect(answer).toMatchObject({ code: "unreachable" }))
    expect(await backend.viewed("x")).toBeUndefined()
  })
})

describe("transcript", () => {
  const conversation = (count: number): Message[] =>
    Array.from({ length: count }, (_, index) => ({
      seq: index + 1,
      role: index % 2 === 0 ? "user" : "assistant",
      text: `Message ${index + 1}`,
      tool_uses: index === 1 ? [{ name: "Bash", input_summary: "{}", result_summary: "ok", is_error: true }] : [],
      at: null,
      truncated: false,
    }))

  test("the result is the document behind result.url; the conversation is read page by page; usage in ms", async () => {
    const { backend } = await cloud()
    const routine = await ok(backend.create(definition("Read")))
    const run = await ok(backend.start(routine.ref.id))
    const answer = `# Report\n\n${"Long line of the report. ".repeat(40)}`
    farm.advance(run.ref.id, {
      state: "succeeded",
      result: answer,
      usage: { input_tokens: 1, output_tokens: 2, duration_s: 42 },
      transcript: conversation(450),
    })
    const transcript = await ok(backend.transcript(run.ref.id))
    expect(transcript.result).toBe(answer)
    expect(transcript.usage).toEqual({ duration: 42_000, turns: 3 })
    expect(transcript.log).toContain("user: Message 1\n")
    expect(transcript.log).toContain("assistant: Message 2\n")
    expect(transcript.log).toContain("Bash (error)")
    expect(transcript.log).toContain("Message 450")
    expect(calls("farm_get_task_transcript").map((call) => call.args.cursor)).toEqual([undefined, "200", "400"])
    expect(calls("farm_get_task_result")[0]?.args).toEqual({ task_id: run.ref.id })
    expect(crossing(Transcript, transcript)).toEqual(transcript)
  })

  test("a run still going has no result yet and is not asked for one; its conversation so far is there", async () => {
    const { backend } = await cloud()
    const routine = await ok(backend.create(definition("Going")))
    const run = await ok(backend.start(routine.ref.id))
    farm.advance(run.ref.id, { state: "running", transcript: conversation(2) })
    const transcript = await ok(backend.transcript(run.ref.id))
    expect(transcript.result).toBeUndefined()
    expect(transcript.log).toContain("Message 2")
    expect(calls("farm_get_task_result")).toEqual([])
    expect(calls("farm_get_task_transcript")).toHaveLength(1)
  })

  test("a result link that cannot be read, or that points off the farm's https, falls back to the summary", async () => {
    const requested: string[] = []
    const { backend } = await cloud({
      fetch: Object.assign((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        requested.push(String(input instanceof Request ? input.url : input))
        return fetch(input, init)
      }, fetch),
    })
    const routine = await ok(backend.create(definition("Links")))
    const run = await ok(backend.start(routine.ref.id))
    farm.advance(run.ref.id, { state: "succeeded", result: "Short answer." })
    farm.state.resultBase = "http://example.invalid"
    expect((await ok(backend.transcript(run.ref.id))).result).toBe("Short answer.")
    farm.state.resultBase = "https://user:secret@example.invalid"
    expect((await ok(backend.transcript(run.ref.id))).result).toBe("Short answer.")
    expect(requested).toEqual([])
    farm.state.resultBase = `${farm.url}/gone`
    expect((await ok(backend.transcript(run.ref.id))).result).toBe("Short answer.")
    expect(requested).toHaveLength(1)
  })

  test("a run that left no result has none, without failing", async () => {
    const { backend } = await cloud()
    const routine = await ok(backend.create(definition("Nothing")))
    const run = await ok(backend.start(routine.ref.id))
    farm.advance(run.ref.id, { state: "failed", failure_reason: "timeout" })
    const transcript = await ok(backend.transcript(run.ref.id))
    expect(transcript.result).toBeUndefined()
  })
})

describe("watch", () => {
  test("polls the farm only while subscribed, reports each change once with its routine, and stops", async () => {
    const { backend } = await cloud()
    const routine = await ok(backend.create(definition("Watched")))
    const run = await ok(backend.start(routine.ref.id))
    await Bun.sleep(30)
    const polls = () => calls("farm_list_tasks").filter((call) => call.args.updated_since !== undefined)
    expect(polls()).toEqual([])

    const seen: Change[] = []
    const stop = backend.watch((change) => seen.push(change))
    await until(() => polls().length >= 1)
    const since = Date.parse(String(polls()[0]?.args.updated_since))
    expect(Date.now() - since).toBeGreaterThanOrEqual(RoutinesFarm.lookback)
    expect(polls()[0]?.args).toMatchObject({ owner: "me" })

    // The first poll looks back, so it may report the run as it was started; what counts is what follows.
    await until(() => polls().length >= 2)
    const before = seen.length
    farm.advance(run.ref.id, { state: "succeeded", result: "Done." })
    await until(() => seen.length > before)
    const count = polls().length
    await until(() => polls().length >= count + 3)
    expect(seen).toHaveLength(before + 1)
    const change = seen[before] ?? {}
    expect(change.routine).toEqual(routine.ref)
    expect(change.run).toMatchObject({ ref: run.ref, routine: routine.ref, state: "ok", unread: true })
    expect(crossing(Change, change)).toEqual(change)

    // A change in the same instant as the one before it is a change all the same.
    const stored = farm.state.tasks.get(run.ref.id)
    farm.advance(run.ref.id, { state: "failed", failure_reason: "timeout", updated_at: stored?.updated_at })
    await until(() => seen.length > before + 1)
    expect(seen[before + 1]?.run).toMatchObject({ state: "failed", reason: "timeout" })

    stop()
    await Bun.sleep(30)
    const stopped = polls().length
    farm.advance(run.ref.id, { viewed: true })
    await Bun.sleep(30)
    expect(polls()).toHaveLength(stopped)
    expect(seen).toHaveLength(before + 2)
  })

  test("two subscribers share one poll; it stops when the last one leaves", async () => {
    const { backend } = await cloud()
    const polls = () => calls("farm_list_tasks").length
    const first = backend.watch(() => {})
    const second = backend.watch(() => {})
    await until(() => polls() >= 4)
    first()
    await until(() => polls() >= 6)
    second()
    await Bun.sleep(30)
    const after = polls()
    await Bun.sleep(30)
    expect(polls()).toBe(after)
  })

  test("a run that failed for a PAT the farm no longer accepts gives Cloud the PAT again", async () => {
    const { backend, pat } = await cloud()
    const routine = await ok(backend.create(definition("Again")))
    const run = await ok(backend.start(routine.ref.id))
    const stop = backend.watch(() => {})
    await until(() => calls("farm_list_tasks").length >= 1)
    farm.advance(run.ref.id, { state: "failed", failure_reason: "farm_access_revoked" })
    await until(() => farm.state.uploaded === pat)
    expect(calls("farm_request_credential_upload")).toHaveLength(1)
    stop()
    expect((await ok(backend.get(routine.ref.id))).state).toBe("active")
  })
})

describe("questions and replies", () => {
  test("a question is answered with one of its choices and its seq; a stale one is a conflict", async () => {
    const { backend } = await cloud()
    const routine = await ok(backend.create(definition("Ask")))
    const run = await ok(backend.start(routine.ref.id))
    farm.advance(run.ref.id, {
      state: "running",
      question: {
        seq: 3,
        text: "Use Bash?",
        asked_at: iso(Date.now()),
        kind: "permission",
        options: ["Allow", "Deny"],
      },
    })
    expect(await backend.answerQuestion?.({ run: run.ref.id, question: "q-3", choice: "Maybe" })).toMatchObject({
      code: "invalid",
    })
    expect(await backend.answerQuestion?.({ run: run.ref.id, question: "q-2", choice: "Allow" })).toMatchObject({
      code: "conflict",
    })
    expect(calls("farm_answer_task")).toEqual([])
    expect(await backend.answerQuestion?.({ run: run.ref.id, question: "q-3", choice: "Allow" })).toBeUndefined()
    expect(calls("farm_answer_task")[0]?.args).toEqual({ task_id: run.ref.id, answer: "Allow", seq: 3 })
    expect(await backend.answerQuestion?.({ run: run.ref.id, question: "q-3", choice: "Allow" })).toMatchObject({
      code: "conflict",
    })
  })

  test("a free question without choices takes the user's words", async () => {
    const { backend } = await cloud()
    const routine = await ok(backend.create(definition("Free")))
    const run = await ok(backend.start(routine.ref.id))
    farm.advance(run.ref.id, {
      state: "running",
      question: { seq: 1, text: "Which branch?", asked_at: iso(Date.now()), kind: "ask", options: null },
    })
    const waiting = (await ok(backend.runs({ routine: routine.ref.id }))).items[0]
    expect(waiting?.question).toEqual({ id: "q-1", text: "Which branch?", choices: [] })
    expect(await backend.answerQuestion?.({ run: run.ref.id, question: "q-1", choice: "develop" })).toBeUndefined()
    expect(farm.state.tasks.get(run.ref.id)?.answer).toBe("develop")
  })

  test("a reply is a new task in the same conversation, as the user, with the routine's task; it is the routine's newest run", async () => {
    const { backend } = await cloud()
    const routine = await ok(
      backend.create(
        definition("Continue", {
          model: "claude-sonnet-5-5",
          options: {
            overlap: "allow",
            repository: "https://git.example.com/acme/app.git",
            access: "git-readonly",
            permissions: "ask",
            timeLimit: 10,
          },
        }),
      ),
    )
    const run = await ok(backend.start(routine.ref.id))
    farm.advance(run.ref.id, { state: "succeeded", result: "Done." })
    const session = farm.state.tasks.get(run.ref.id)?.session_ref
    // What another client set on the routine's task and that says how a task started, not how it runs.
    Object.assign(farm.state.schedules.get(routine.ref.id)?.task ?? {}, {
      correlation_id: "the-schedules-own",
      notify: [{ kind: "webhook", url: "https://hooks.example.com/x" }],
      origin_context: { channel: "teams" },
    })

    const next = await ok(backend.reply!({ run: run.ref.id, text: "Now the tests." }))
    expect(next).toMatchObject({ routine: routine.ref, trigger: "manual", title: "Continue", unread: false })
    expect(["queued", "running"]).toContain(next.state)
    expect(crossing(Run, next)).toEqual(next)
    const sent = calls("farm_launch_task")[0]?.args ?? {}
    expect(sent).toMatchObject({
      session_ref: session,
      prompt: "Now the tests.",
      model: "claude-sonnet-5-5",
      permission_mode: "ask",
      gateway_identity: "user",
      workspace: { repo: "https://git.example.com/acme/app.git", credentials_ref: "git-readonly" },
      limits: { timeout_s: 600 },
      origin_context: { dynwork_routine: routine.ref.id },
    })
    expect(sent).not.toHaveProperty("agent_id")
    expect(sent).not.toHaveProperty("notify")
    expect(sent).not.toHaveProperty("correlation_id")

    const page = await ok(backend.runs({ routine: routine.ref.id }))
    expect(page.items.map((item) => item.ref.id)).toEqual([next.ref.id, run.ref.id])
    expect(await backend.reply!({ run: next.ref.id, text: "Too soon." })).toMatchObject({ code: "conflict" })
    expect(await backend.reply!({ run: run.ref.id, text: " " })).toMatchObject({ code: "invalid" })
  })

  test("a reply to an agent's run goes to the same agent as its input", async () => {
    const { backend } = await cloud()
    const routine = await ok(
      backend.create(definition("Agent", { instructions: { kind: "agent", agent: "code-reviewer", input: "MR 1" } })),
    )
    const run = await ok(backend.start(routine.ref.id))
    farm.advance(run.ref.id, { state: "succeeded", result: "Done." })
    await ok(backend.reply!({ run: run.ref.id, text: "And MR 2." }))
    expect(calls("farm_launch_task")[0]?.args).toMatchObject({ agent_id: "code-reviewer", input: "And MR 2." })
    expect(calls("farm_launch_task")[0]?.args).not.toHaveProperty("prompt")
  })

  test("a reply the farm refuses for a missing PAT gets the PAT to Cloud and is sent once more", async () => {
    const { backend, pat } = await cloud()
    const routine = await ok(backend.create(definition("Refused")))
    const run = await ok(backend.start(routine.ref.id))
    farm.advance(run.ref.id, { state: "succeeded", result: "Done." })
    farm.state.userCredential = false
    const next = await ok(backend.reply!({ run: run.ref.id, text: "Go on." }))
    expect(farm.state.uploaded).toBe(pat)
    expect(next.routine).toEqual(routine.ref)
    expect(calls("farm_launch_task")).toHaveLength(2)
  })
})

describe("secrets", () => {
  test("no run, page, change or transcript carries the PAT or a JWT", async () => {
    const { backend, pat } = await cloud()
    const routine = await ok(backend.create(definition("Secret")))
    const run = await ok(backend.start(routine.ref.id))
    const seen: Change[] = []
    const stop = backend.watch((change) => seen.push(change))
    farm.advance(run.ref.id, { state: "succeeded", result: "Done.", transcript: conversation() })
    await until(() => seen.length >= 1)
    stop()
    const text = JSON.stringify([
      run,
      seen,
      await backend.runs({ routine: routine.ref.id }),
      await backend.runs({}),
      await backend.transcript(run.ref.id),
      await backend.reply?.({ run: run.ref.id, text: "Go on." }),
    ])
    expect(sp.state.jwts.size).toBeGreaterThan(0)
    expect(text).not.toContain(pat)
    ;[...sp.state.jwts].forEach((jwt) => expect(text).not.toContain(jwt))
    expect(JSON.stringify(farm.state.calls)).not.toContain(pat)
  })

  function conversation(): Message[] {
    return [{ seq: 1, role: "assistant", text: "Done.", tool_uses: [], at: null, truncated: false }]
  }
})
