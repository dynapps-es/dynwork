import { describe, expect, test } from "bun:test"
import type { OpenCodeEvent } from "@opencode/client"
import { Project, Reduce, State } from "../src"
import { assistant, info, text, user } from "./build"
import { load, replay } from "./support"

// The reducer's tolerance, on small event streams built by hand: duplicates, order, late and missing pieces, and what
// it does with an event it has never heard of.

let id = 0
const event = (type: string, data: Record<string, unknown>, extra: { seq?: number; created?: number } = {}) =>
  ({
    id: `evt_${String(++id).padStart(6, "0")}`,
    type,
    created: extra.created ?? 1_000 + id,
    ...(extra.seq === undefined ? {} : { durable: { aggregateID: "ses_a", seq: extra.seq, version: 1 } }),
    data: { sessionID: "ses_a", ...data },
  }) as unknown as OpenCodeEvent

const model = { id: "m", providerID: "p" }
const started = (message = "msg_a1", seq = 5, at = 2_000) =>
  event("session.step.started", { assistantMessageID: message, agent: "build", model, started: at }, { seq })
const ended = (message = "msg_a1", value = "hello", seq = 7) =>
  event("session.text.ended", { assistantMessageID: message, ordinal: 0, text: value }, { seq })

const empty = () => State.empty({ desktop: "Studio Mac" })
const blocks = (state: State.State) => Project.session(state, "ses_a")?.turns.flatMap((turn) => turn.blocks)

describe("reduce", () => {
  test("an event it does not know is ignored, a known one for a missing session makes a bare session", () => {
    const state = Reduce.events(empty(), [
      event("something.new", { x: 1 }),
      { id: "evt_x", type: "server.connected", data: {} } as unknown as OpenCodeEvent,
    ])
    expect(state).toEqual(empty())
    expect(Object.keys(Reduce.event(empty(), event("session.renamed", { title: "T" }, { seq: 1 })).sessions)).toEqual([
      "ses_a",
    ])
  })

  test("a durable event is applied once, and a late one that fills a gap still is", () => {
    const state = Reduce.events(empty(), [
      started("msg_a1", 5),
      ended("msg_a1", "one", 7),
      started("msg_a1", 5),
      ended("msg_a1", "two", 7),
    ])
    expect(blocks(state)).toEqual([{ kind: "text", text: "one", streaming: false }])
    const rename = (title: string, seq: number) => event("session.renamed", { title }, { seq })
    expect(Reduce.events(empty(), [rename("a", 0), rename("c", 2)]).cursors.ses_a).toEqual({ through: 0, above: [2] })
    const filled = Reduce.events(empty(), [rename("a", 0), rename("c", 2), rename("b", 1)])
    expect(filled.cursors.ses_a).toEqual({ through: 2, above: [] })
    expect(filled.sessions.ses_a?.info.title).toBe("b")
  })

  test("events for a message that has not started wait for it", () => {
    const early = Reduce.event(empty(), ended("msg_a1", "hello", 7))
    expect(blocks(early)).toEqual([])
    expect(early.cursors.ses_a).toBeUndefined()
    const state = Reduce.event(early, started())
    expect(blocks(state)).toEqual([{ kind: "text", text: "hello", streaming: false }])
    expect(state.sessions.ses_a?.orphans).toEqual({})
  })

  test("the events that wait for a message are bounded", () => {
    const flood = Array.from({ length: 1_000 }, (_, index) => ended("msg_a1", "x", index + 10))
    expect(Reduce.events(empty(), flood).sessions.ses_a?.orphans.msg_a1?.length).toBe(256)
    const spread = Array.from({ length: 200 }, (_, index) => ended(`msg_${index}`, "x", index + 10))
    expect(Object.keys(Reduce.events(empty(), spread).sessions.ses_a?.orphans ?? {}).length).toBe(64)
  })

  test("a tool result that arrives before its call is kept", () => {
    const events = [
      started(),
      event(
        "session.tool.success",
        { assistantMessageID: "msg_a1", id: "t", content: [{ type: "text", text: "found" }], executed: false },
        { seq: 10 },
      ),
      event(
        "session.tool.called",
        { assistantMessageID: "msg_a1", id: "t", input: { pattern: "*" }, executed: false },
        { seq: 8 },
      ),
      event("session.tool.input.started", { assistantMessageID: "msg_a1", id: "t", name: "glob" }, { seq: 7 }),
    ]
    expect(blocks(Reduce.events(empty(), events))).toEqual([
      {
        kind: "toolGroup",
        running: 0,
        failed: 0,
        tools: [{ id: "t", name: "glob", label: "glob *", status: "done", output: "found" }],
      },
    ])
  })

  test("a delta after the full text, or after a snapshot that holds it, does not append", () => {
    const delta = (value: string) =>
      event("session.text.delta", { assistantMessageID: "msg_a1", ordinal: 0, delta: value })
    const streamed = Reduce.events(empty(), [
      started(),
      event("session.text.started", { assistantMessageID: "msg_a1", ordinal: 0 }, { seq: 6 }),
      delta("hel"),
    ])
    expect(blocks(streamed)).toEqual([{ kind: "text", text: "hel", streaming: false }])
    expect(blocks(Reduce.events(streamed, [delta("lo"), ended("msg_a1", "hello", 7), delta("!!")]))).toEqual([
      { kind: "text", text: "hello", streaming: false },
    ])
    const whole = Reduce.snapshot(empty(), {
      sessions: [info()],
      messages: { ses_a: [user("msg_u", "q"), assistant("msg_a1", [text("hello")])] },
    })
    expect(blocks(Reduce.event(whole, delta("!!")))).toEqual([{ kind: "text", text: "hello", streaming: false }])
  })

  test("a snapshot taken before a step finished does not reopen it", () => {
    const done = Reduce.events(empty(), [
      started(),
      ended(),
      event(
        "session.step.ended",
        {
          assistantMessageID: "msg_a1",
          finish: "stop",
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          cost: 0,
        },
        { seq: 9 },
      ),
    ])
    const stale = Reduce.snapshot(done, {
      messages: { ses_a: [assistant("msg_a1", [text("hel")], { time: { created: 2_000 } })] },
    })
    const message = stale.sessions.ses_a?.messages.msg_a1
    expect(message?.type === "assistant" && message.time.completed).toBeDefined()
    expect(blocks(stale)).toEqual([{ kind: "text", text: "hello", streaming: false }])
  })

  test("a replayed execution event never undoes a newer status", () => {
    const run = [
      event("session.execution.started", {}, { seq: 1, created: 1_100 }),
      event("session.execution.succeeded", {}, { seq: 2, created: 1_200 }),
    ]
    const done = Reduce.events(empty(), run)
    expect(Project.sessions(done)[0]?.status).toBe("done")
    const replayed = Reduce.events(done, [event("session.execution.started", {}, { created: 1_100 })])
    expect(Project.sessions(replayed)[0]?.status).toBe("done")
    const snapshot = Reduce.snapshot(empty(), {
      sessions: [info("ses_a", { time: { created: 1_000, updated: 1_300, busy: 1_250, idle: 1_200 } })],
    })
    expect(
      Project.sessions(Reduce.events(snapshot, [event("session.execution.succeeded", {}, { created: 1_150 })]))[0]
        ?.status,
    ).toBe("working")
  })

  test("a reply that arrives before its request leaves nothing waiting", () => {
    const request = { id: "per_1", action: "edit", resources: ["a"] }
    const state = Reduce.events(empty(), [
      event("permission.replied", { requestID: "per_1", reply: "once" }),
      event("permission.asked", request),
    ])
    expect(state.permissions.per_1?.reply).toBe("once")
    expect(Project.session(state, "ses_a")).toBeUndefined()
    const form = { id: "frm_1", sessionID: "ses_a", title: "Q", fields: [{ key: "q0", type: "string", options: [] }] }
    const answered = Reduce.events(empty(), [
      event("form.replied", { id: "frm_1", answer: { q0: "x" } }),
      event("form.created", { form }),
    ])
    expect(answered.forms.frm_1?.state).toBe("answered")
  })

  test("a snapshot closes the requests it no longer lists", () => {
    const asked = Reduce.event(empty(), event("permission.asked", { id: "per_1", action: "edit", resources: ["a"] }))
    expect(asked.permissions.per_1?.reply).toBeUndefined()
    const closed = Reduce.snapshot(asked, { sessions: [info()], permissions: [] })
    expect(closed.permissions.per_1?.reply).toBe("closed")
  })

  test("the session list: roots only, newest first, a child's waiting request is the parent's", () => {
    const state = Reduce.snapshot(State.empty({ desktop: "Studio Mac" }), {
      sessions: [
        info("ses_old", { title: "Old", time: { created: 1, updated: 10 }, location: { directory: "/work/api" } }),
        info("ses_new", { title: "New", time: { created: 2, updated: 50 }, location: { directory: "/work/app/web" } }),
        info("ses_kid", { parentID: "ses_old", time: { created: 3, updated: 60 } }),
        info("ses_gone", { time: { created: 4, updated: 70, archived: 71 } }),
      ],
      permissions: [{ id: "per_1", sessionID: "ses_kid", action: "shell", resources: ["ls"] }],
    })
    expect(Project.sessions(state).map((row) => [row.id, row.status, row.project, row.desktop])).toEqual([
      ["ses_new", "done", "web", "Studio Mac"],
      ["ses_old", "needs-you", "api", "Studio Mac"],
    ])
  })

  test("the state survives JSON, so a store can persist and restore it", () => {
    const recorded = load("subagent-background")
    const state = replay(recorded)
    expect(JSON.parse(JSON.stringify(state))).toEqual(state)
  })

  test("the edit scenario's diff card adds up what the edit and write calls changed", () => {
    const recorded = load("edit")
    const card = Project.session(replay(recorded), recorded.root)?.turns[0]?.blocks.find(
      (block) => block.kind === "diffSummary",
    )
    expect(card).toEqual({
      kind: "diffSummary",
      additions: 4,
      deletions: 1,
      files: [
        { file: "hello.txt", additions: 1, deletions: 1, status: "modified" },
        { file: "added.txt", additions: 3, deletions: 0, status: "added" },
      ],
    })
  })
})
