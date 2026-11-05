import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import { Project, Reduce, State } from "../src"
import { assistant, info, text, user } from "./build"

// The context gauge and its detail: what the window holds is the desktop's count (packages/gui-plugins context), the
// last step with usage after the last completed compaction, cache included; a root's cost includes its subagents'.

const tokens = (input: number, read = 0, write = 0, output = 0, reasoning = 0) => ({
  input,
  output,
  reasoning,
  cache: { read, write },
})
const compaction = (id: string, status: "completed" | "failed"): SessionMessageInfo =>
  status === "completed"
    ? { type: "compaction", id, status, reason: "auto", summary: "s", time: { created: 5_000 } }
    : { type: "compaction", id, status, reason: "auto", error: { type: "x", message: "m" }, time: { created: 5_000 } }

const usageOf = (messages: SessionMessageInfo[], sessions = [info()]) =>
  Project.session(
    Reduce.snapshot(State.empty({ desktop: "Studio Mac" }), { sessions, messages: { ses_a: messages } }),
    "ses_a",
  )?.info

describe("usage", () => {
  test("the window holds the last step's tokens, the cache read and written included", () => {
    const usage = usageOf([
      user("u1", "q"),
      assistant("a1", [text("one")], { tokens: tokens(10, 0, 0, 5), cost: 0.01 }),
      user("u2", "q"),
      assistant("a2", [text("two")], { tokens: tokens(20, 1_000, 300, 40, 2), cost: 0.02 }),
    ])
    expect(usage?.context).toMatchObject({
      total: 1_362,
      model: "p/m",
      cost: 0.02,
      tokens: tokens(20, 1_000, 300, 40, 2),
    })
    expect(usage?.messages).toEqual({ user: 2, assistant: 2 })
  })

  test("after a completed compaction it is empty until the next step; a failed one changes nothing", () => {
    const step = assistant("a1", [text("one")], { tokens: tokens(900) })
    expect(usageOf([user("u1", "q"), step, compaction("c1", "completed")])?.context).toBeUndefined()
    expect(usageOf([user("u1", "q"), step, compaction("c1", "failed")])?.context?.total).toBe(900)
    const after = usageOf([step, compaction("c1", "completed"), assistant("a2", [text("two")], { tokens: tokens(50) })])
    expect(after?.context?.total).toBe(50)
    expect(after?.compactions).toBe(1)
  })

  test("a root session's cost includes its subagents', a subagent's is its own", () => {
    const sessions = [
      info("ses_a", { cost: 1 }),
      info("ses_b", { parentID: "ses_a", cost: 0.5 }),
      info("ses_c", { parentID: "ses_b", cost: 0.25 }),
    ]
    const state = Reduce.snapshot(State.empty({ desktop: "Studio Mac" }), { sessions })
    expect(Project.session(state, "ses_a")?.info).toMatchObject({ cost: 1, familyCost: 1.75 })
    expect(Project.session(state, "ses_b")?.info).toMatchObject({ cost: 0.5, familyCost: 0.5 })
  })

  test("a step that ends by event keeps its cost and its cache tokens", () => {
    const state = Reduce.events(State.empty({ desktop: "Studio Mac" }), [
      {
        id: "evt_1",
        type: "session.step.started",
        created: 2_000,
        durable: { aggregateID: "ses_a", seq: 1, version: 1 },
        data: {
          sessionID: "ses_a",
          assistantMessageID: "a1",
          agent: "build",
          model: { id: "m", providerID: "p" },
          started: 2_000,
        },
      },
      {
        id: "evt_2",
        type: "session.step.ended",
        created: 2_100,
        durable: { aggregateID: "ses_a", seq: 2, version: 1 },
        data: {
          sessionID: "ses_a",
          assistantMessageID: "a1",
          finish: "stop",
          tokens: tokens(3, 400, 20, 7),
          cost: 0.004,
        },
      },
    ] as never)
    expect(Project.session(state, "ses_a")?.info.context).toMatchObject({ total: 430, cost: 0.004, at: 2_100 })
  })
})
