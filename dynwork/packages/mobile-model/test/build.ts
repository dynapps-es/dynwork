import type { SessionInfo, SessionMessageInfo } from "@opencode/client"
import { Project, Reduce, State } from "../src"
import type { Snapshot } from "../src"

// Hand-made sessions for the tests of one rule at a time. Every helper returns the wire shape upstream's REST routes use.

let clock = 1_000

export const tick = () => (clock += 10)

export function info(id = "ses_a", extra: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    projectID: "p",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1_000, updated: 1_000 },
    title: "A session",
    location: { directory: "/work/app" },
    ...extra,
  }
}

export const user = (id: string, text: string): SessionMessageInfo => ({
  type: "user",
  id,
  text,
  time: { created: tick() },
})

export const idle = (
  id: string,
  outcome: "succeeded" | "failed" | "interrupted",
  error?: { type: string; message: string },
): SessionMessageInfo => ({
  type: "idle",
  id,
  outcome,
  error,
  time: { created: tick() },
})

type Content = Extract<SessionMessageInfo, { type: "assistant" }>["content"][number]

export const assistant = (
  id: string,
  content: Content[],
  extra: Partial<Extract<SessionMessageInfo, { type: "assistant" }>> = {},
): SessionMessageInfo => ({
  type: "assistant",
  id,
  agent: "build",
  model: { id: "m", providerID: "p" },
  content,
  time: { created: tick(), completed: tick() },
  ...extra,
})

export const text = (value: string): Content => ({ type: "text", text: value })

export function call(
  id: string,
  name: string,
  input: Record<string, unknown>,
  result:
    | { status: "completed"; text?: string; metadata?: Record<string, unknown> }
    | { status: "error"; message: string }
    | { status: "running"; metadata?: Record<string, unknown> } = {
    status: "completed",
  },
): Content {
  const time = { created: tick(), ran: tick() }
  if (result.status === "running")
    return {
      type: "tool",
      id,
      name,
      time,
      state: { status: "running", input, metadata: result.metadata ?? {} },
    } as Content
  if (result.status === "error")
    return {
      type: "tool",
      id,
      name,
      time,
      state: { status: "error", input, error: { type: "tool.execution", message: result.message } },
    } as Content
  return {
    type: "tool",
    id,
    name,
    time: { ...time, completed: tick() },
    state: {
      status: "completed",
      input,
      content: [{ type: "text", text: result.text ?? "ok" }],
      metadata: result.metadata,
    },
  } as Content
}

/** The session as a client that fetched it once would hold it. */
export function open(
  messages: SessionMessageInfo[],
  extra: Partial<Snapshot> = {},
  session: Partial<SessionInfo> = {},
) {
  const state = Reduce.snapshot(State.empty({ desktop: "Studio Mac" }), {
    sessions: [info("ses_a", session)],
    messages: { ses_a: messages },
    ...extra,
  })
  const view = Project.session(state, "ses_a")
  if (!view) throw new Error("the session is missing")
  return { state, view, blocks: view.turns.flatMap((turn) => turn.blocks) }
}
