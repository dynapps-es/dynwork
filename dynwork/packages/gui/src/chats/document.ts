export * as ChatsDocument from "./document"

import type {
  OpenCodeEvent,
  SessionMessageAssistant,
  SessionMessageInfo,
  SessionMessageUser,
  SessionStatus,
} from "@opencode/client/promise"
import type { SessionDocument } from "@opencode/session-ui/document"

// A cloud chat as the session UI reads it: a `SessionDocument` (messages, status, no diffs) built from the thread's
// history (`GET messages`, OpenCode `SessionMessageInfo`s) and its live events (`GET log`, OpenCode's v2 envelope).
// The fold is the same one OpenCode's session projection makes of these events, limited to those a cloud chat emits
// (the plan's contract, "Events on /log"): a reply's steps, text and reasoning, and its end. It is pure: every change
// answers a new state, and a message that did not change keeps its identity, which the timeline keys its rows by.
// Only types come from OpenCode here.

export interface Chat {
  readonly sessionID: string
  /** Oldest first. */
  readonly messages: readonly SessionMessageInfo[]
  readonly status: SessionStatus
  /** The last durable seq folded in; a replayed event at or before it is skipped. */
  readonly seq?: number
  /** Where each text and reasoning ordinal of an assistant message sits in its `content`, and which have ended. */
  readonly slots: Readonly<Record<string, Slots>>
}

type Slots = { text: Record<number, number>; reasoning: Record<number, number>; ended: Record<string, true> }

const idle: SessionStatus = { type: "idle" }

export function empty(sessionID: string): Chat {
  return { sessionID, messages: [], status: idle, slots: {} }
}

/** The document the timeline renders. */
export function document(chat: Chat): SessionDocument {
  return { sessionID: chat.sessionID, messages: [...chat.messages], status: chat.status, diffs: [] }
}

/**
 * Adds messages from the history, replacing those it already holds by id. A message that streamed here keeps its
 * identity when the history's copy says the same.
 */
export function load(chat: Chat, messages: readonly unknown[]): Chat {
  const read = messages.flatMap(message)
  if (read.length === 0) return chat
  const byID = new Map(chat.messages.map((item) => [item.id, item] as const))
  read.forEach((item) => {
    const held = byID.get(item.id)
    byID.set(item.id, held && JSON.stringify(held) === JSON.stringify(item) ? held : item)
  })
  return { ...chat, messages: order([...byID.values()]) }
}

/** The user's prompt, shown at once while the instance admits it. */
export function prompted(chat: Chat, input: { id: string; text: string; created: number }): Chat {
  if (chat.messages.some((item) => item.id === input.id)) return chat
  const user: SessionMessageUser = { type: "user", id: input.id, text: input.text, time: { created: input.created } }
  return { ...chat, messages: [...chat.messages, user], status: { type: "busy" } }
}

/** Folds one live event in. Events of other sessions, events it does not know and replays leave it as it is. */
export function event(chat: Chat, value: unknown): Chat {
  if (!isEvent(value, chat.sessionID)) return chat
  const seq = "durable" in value ? value.durable.seq : undefined
  if (seq !== undefined && chat.seq !== undefined && seq <= chat.seq) return chat
  const next = apply(chat, value)
  return seq === undefined ? next : { ...next, seq }
}

export function events(chat: Chat, values: readonly unknown[]): Chat {
  return values.reduce<Chat>(event, chat)
}

/** The streamed text of the newest assistant message: what a reply has written so far. */
export function reply(chat: Chat) {
  const last = chat.messages.findLast((item) => item.type === "assistant")
  if (last?.type !== "assistant") return ""
  return last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
}

function apply(chat: Chat, input: OpenCodeEvent): Chat {
  switch (input.type) {
    case "session.execution.started":
      return { ...chat, status: { type: "busy" } }
    case "session.execution.succeeded":
      return finish(chat, input.id, input.created, "succeeded")
    case "session.execution.failed":
      return finish(chat, input.id, input.created, "failed", input.data.error)
    case "session.execution.interrupted":
      return finish(chat, input.id, input.created, "interrupted")
    case "session.step.started": {
      if (chat.messages.some((item) => item.id === input.data.assistantMessageID)) return chat
      const created: SessionMessageAssistant = {
        type: "assistant",
        id: input.data.assistantMessageID,
        agent: input.data.agent,
        model: input.data.model,
        content: [],
        time: { created: input.data.started },
      }
      return {
        ...chat,
        status: { type: "busy" },
        messages: [...chat.messages, created],
        slots: { ...chat.slots, [created.id]: { text: {}, reasoning: {}, ended: {} } },
      }
    }
    case "session.step.ended":
      return assistant(chat, input.data.assistantMessageID, (message) => ({
        ...message,
        finish: input.data.finish,
        cost: input.data.cost,
        tokens: input.data.tokens,
        time: { ...message.time, completed: input.created },
      }))
    case "session.text.started":
      return part(chat, input.data.assistantMessageID, "text", input.data.ordinal, input.created, undefined)
    case "session.text.delta":
      return part(
        chat,
        input.data.assistantMessageID,
        "text",
        input.data.ordinal,
        input.created,
        (text) => text + input.data.delta,
      )
    case "session.text.ended":
      return part(
        chat,
        input.data.assistantMessageID,
        "text",
        input.data.ordinal,
        input.created,
        () => input.data.text,
        true,
      )
    case "session.reasoning.started":
      return part(chat, input.data.assistantMessageID, "reasoning", input.data.ordinal, input.created, undefined)
    case "session.reasoning.delta":
      return part(
        chat,
        input.data.assistantMessageID,
        "reasoning",
        input.data.ordinal,
        input.created,
        (text) => text + input.data.delta,
      )
    case "session.reasoning.ended":
      return part(
        chat,
        input.data.assistantMessageID,
        "reasoning",
        input.data.ordinal,
        input.created,
        () => input.data.text,
        true,
      )
    default:
      return chat
  }
}

// The reply ended: the session goes idle, and the outcome is kept as OpenCode's projection keeps it, an idle message.
function finish(
  chat: Chat,
  id: string,
  created: number,
  outcome: "succeeded" | "failed" | "interrupted",
  error?: { type: string; message: string },
): Chat {
  if (chat.messages.some((item) => item.id === id)) return { ...chat, status: idle }
  return {
    ...chat,
    status: idle,
    messages: [...chat.messages, { type: "idle", id, outcome, ...(error ? { error } : {}), time: { created } }],
  }
}

function assistant(
  chat: Chat,
  id: string,
  change: (message: SessionMessageAssistant) => SessionMessageAssistant,
): Chat {
  const index = chat.messages.findIndex((item) => item.id === id)
  const message = chat.messages[index]
  if (message?.type !== "assistant") return chat
  const messages = [...chat.messages]
  messages[index] = change(message)
  return { ...chat, messages }
}

// A text or reasoning part of an assistant message, by its ordinal: made the first time it is named, then changed.
// Once it ended, a late delta does not change it.
function part(
  chat: Chat,
  id: string,
  kind: "text" | "reasoning",
  ordinal: number,
  created: number,
  change: ((text: string) => string) | undefined,
  end = false,
): Chat {
  const held = chat.slots[id] ?? { text: {}, reasoning: {}, ended: {} }
  const key = `${kind}:${ordinal}`
  if (held.ended[key] && !end) return chat
  const slots: Slots = {
    text: { ...held.text },
    reasoning: { ...held.reasoning },
    ended: end ? { ...held.ended, [key]: true } : held.ended,
  }
  const next = assistant(chat, id, (message) => {
    const content = [...message.content]
    const at = slots[kind][ordinal] ?? content.length
    if (slots[kind][ordinal] === undefined) {
      slots[kind][ordinal] = at
      content[at] = kind === "text" ? { type: "text", text: "" } : { type: "reasoning", text: "", time: { created } }
    }
    const current = content[at]
    if (change && current?.type === kind) {
      const text = change(current.text)
      content[at] =
        current.type === "reasoning" && end
          ? { ...current, text, time: { created: current.time?.created ?? created, completed: created } }
          : { ...current, text }
    }
    return { ...message, content }
  })
  if (next === chat) return chat
  return { ...next, slots: { ...next.slots, [id]: slots } }
}

// A prompt and its reply share the prompt's millisecond (the server stamps the reply with it), so within one instant the
// user's message comes first; the id only settles what is left.
function order(messages: SessionMessageInfo[]) {
  const rank = (message: SessionMessageInfo) => (message.type === "user" ? 0 : 1)
  return messages.toSorted(
    (a, b) => a.time.created - b.time.created || rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
}

// A history entry: OpenCode's `SessionMessageInfo`, or the stored `{ info, parts }` pair, whose parts are an assistant
// message's content.
function message(value: unknown): SessionMessageInfo[] {
  if (typeof value !== "object" || value === null) return []
  if ("info" in value && typeof value.info === "object" && value.info !== null) {
    const parts = "parts" in value && Array.isArray(value.parts) ? value.parts : undefined
    const info = value.info as SessionMessageInfo
    return message(info.type === "assistant" && parts ? { ...info, content: parts } : info)
  }
  if (!("id" in value) || typeof value.id !== "string" || !("type" in value) || typeof value.type !== "string")
    return []
  if (!("time" in value) || typeof value.time !== "object" || value.time === null) return []
  // SAFETY: the instance stores and serves OpenCode's own message shapes (the plan's contract, principle 2).
  return [value as SessionMessageInfo]
}

// An event of this session. Its shape past `type` and `data.sessionID` is OpenCode's, as the instance sends it.
function isEvent(value: unknown, sessionID: string): value is OpenCodeEvent {
  if (typeof value !== "object" || value === null || !("type" in value) || typeof value.type !== "string") return false
  if (!("data" in value) || typeof value.data !== "object" || value.data === null) return false
  return "sessionID" in value.data && value.data.sessionID === sessionID
}
