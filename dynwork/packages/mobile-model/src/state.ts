export * as State from "./state"

// What the reducer keeps: upstream's sessions and messages, normalized once at the boundary (`message`). Nothing in
// here is a view. It is plain JSON (it can be persisted and rehydrated) and every update returns new objects for what it
// touched, so a React store can compare by reference.

import type { SessionMessageAssistant, SessionMessageAssistantTool, SessionMessageInfo } from "@opencode/client"

export type Error = { type: string; message: string; status?: number; retryAfterMs?: number }

/** What a tool returned for the model: text, or a file by reference. */
export type Content = { type: "text"; text: string } | { type: "file"; uri: string; mime: string; name?: string | null }

export type ToolState =
  | { status: "streaming"; input: string }
  | { status: "running"; input: Record<string, unknown>; metadata: Record<string, unknown> }
  | { status: "completed"; input: Record<string, unknown>; content: Content[]; metadata?: Record<string, unknown> }
  | {
      status: "error"
      input: Record<string, unknown>
      error: Error
      content?: Content[]
      metadata?: Record<string, unknown>
    }

export type Tool = {
  type: "tool"
  id: string
  name: string
  state: ToolState
  time: { created: number; ran?: number; completed?: number }
}
export type Text = { type: "text"; text: string }
export type Reasoning = { type: "reasoning"; text: string; time?: { created: number; completed?: number } }
/** A content kind this version does not know. Kept, so it can be shown as a generic line. */
export type UnknownPart = { type: "unknown"; original: string }
export type Part = Text | Reasoning | Tool | UnknownPart

export type Assistant = {
  type: "assistant"
  id: string
  agent: string
  model?: { id: string; providerID: string }
  content: Part[]
  finish?: string
  error?: Error
  retry?: { attempt: number; at: number; error: Error }
  tokens?: { input: number; output: number; reasoning: number }
  time: { created: number; streamed?: number; completed?: number }
}
export type User = {
  type: "user"
  id: string
  text: string
  files: Array<{ name?: string; mime: string }>
  time: { created: number }
}
export type Synthetic = {
  type: "synthetic"
  id: string
  text: string
  description?: string
  metadata?: Record<string, unknown>
  time: { created: number }
}
export type Shell = {
  type: "shell"
  id: string
  shellID: string
  command: string
  status: "running" | "exited" | "timeout" | "killed"
  exit?: number
  background: boolean
  time: { created: number; completed?: number }
}
export type Compaction = {
  type: "compaction"
  id: string
  status: "running" | "completed" | "failed"
  reason: "auto" | "manual"
  summary?: string
  error?: Error
  time: { created: number }
}
export type Idle = {
  type: "idle"
  id: string
  outcome: "succeeded" | "failed" | "interrupted"
  error?: Error
  time: { created: number }
}
/** A message kind the view does not show or this version does not know (instructions, model switches, skills...). */
export type Other = { type: "other"; id: string; original: string; time: { created: number } }
export type Message = User | Assistant | Synthetic | Shell | Compaction | Idle | Other

/** Where each content item of an assistant message sits, so an event finds it by its own key and order is kept. */
export type Slots = {
  text: Record<number, number>
  reasoning: Record<number, number>
  tool: Record<string, number>
  /** `text:<ordinal>` and `reasoning:<ordinal>` once their full value arrived: a late delta must not append to it. */
  done: Record<string, true>
}

export type Info = {
  id: string
  parentID?: string
  title?: string
  directory?: string
  agent?: string
  model?: { id: string; providerID: string }
  cost: number
  tokens: { input: number; output: number; reasoning: number }
  created: number
  updated: number
  archived?: number
}

export type Inbox = {
  item?: {
    type: "user" | "synthetic" | "compaction" | "move"
    text?: string
    files?: User["files"]
    description?: string
    metadata?: Record<string, unknown>
  }
  delivered?: number
  seq?: number
}

export type Session = {
  info: Info
  messages: Record<string, Message>
  /** Message ids in the order the session holds them: upstream orders by delivery, which is not the order of the ids. */
  order: string[]
  /** The durable sequence of the event that created each message, so late events slot into place. Snapshot messages have none. */
  rank: Record<string, number>
  slots: Record<string, Slots>
  inbox: Record<string, Inbox>
  /** Durable events for an assistant message that has not started yet, replayed when it does. */
  orphans: Record<string, unknown[]>
  running: boolean
  outcome?: "succeeded" | "failed" | "interrupted"
  /** When the status above was last decided, so a replayed event never undoes a newer one. */
  statusAt: number
}

export type Permission = {
  id: string
  sessionID: string
  action: string
  resources: string[]
  message?: string
  source?: { messageID: string; id: string }
  /** Absent while it waits. `closed` means it was gone from a snapshot without a reply being seen. */
  reply?: "once" | "always" | "reject" | "closed"
}

export type Form = {
  id: string
  sessionID: string
  title: string
  metadata: Record<string, unknown>
  fields: Array<{
    key: string
    type: string
    title?: string
    description?: string
    options: Array<{ value: string; label: string; description?: string }>
  }>
  state: "pending" | "answered" | "cancelled"
  answer?: Record<string, string | string[] | number | boolean>
}

/** The highest contiguous durable sequence applied in one aggregate, and the ones applied past a gap. */
export type Cursor = { through: number; above: number[] }

export type State = {
  desktop: string
  sessions: Record<string, Session>
  permissions: Record<string, Permission>
  forms: Record<string, Form>
  cursors: Record<string, Cursor>
  /** A reply that arrived before its request. */
  early: {
    permissions: Record<string, NonNullable<Permission["reply"]>>
    forms: Record<string, "answered" | "cancelled">
  }
}

export function empty(options: { desktop?: string } = {}): State {
  return {
    desktop: options.desktop ?? "",
    sessions: {},
    permissions: {},
    forms: {},
    cursors: {},
    early: { permissions: {}, forms: {} },
  }
}

export function session(id: string, created: number): Session {
  return {
    info: { id, cost: 0, tokens: { input: 0, output: 0, reasoning: 0 }, created, updated: created },
    messages: {},
    order: [],
    rank: {},
    slots: {},
    inbox: {},
    orphans: {},
    running: false,
    statusAt: 0,
  }
}

/** Upstream's message, as this model keeps it. Never throws: a kind it does not know becomes `other`. */
export function message(wire: SessionMessageInfo): Message {
  const time = { created: wire.time.created }
  if (wire.type === "user")
    return {
      type: "user",
      id: wire.id,
      text: wire.text,
      files: (wire.files ?? []).map((file) => ({ name: file.name, mime: file.mime })),
      time,
    }
  if (wire.type === "assistant")
    return {
      type: "assistant",
      id: wire.id,
      agent: wire.agent,
      model: wire.model && { id: wire.model.id, providerID: wire.model.providerID },
      content: wire.content.map(part),
      finish: wire.finish,
      error: wire.error && failure(wire.error),
      retry: wire.retry && { attempt: wire.retry.attempt, at: wire.retry.at, error: failure(wire.retry.error) },
      tokens: wire.tokens && { input: wire.tokens.input, output: wire.tokens.output, reasoning: wire.tokens.reasoning },
      time: { created: wire.time.created, streamed: wire.time.streamed, completed: wire.time.completed },
    }
  if (wire.type === "synthetic")
    return {
      type: "synthetic",
      id: wire.id,
      text: wire.text,
      description: wire.description,
      metadata: wire.metadata,
      time,
    }
  if (wire.type === "shell")
    return {
      type: "shell",
      id: wire.id,
      shellID: wire.shellID,
      command: wire.command,
      status: wire.status,
      exit: typeof wire.exit === "number" ? wire.exit : undefined,
      background: wire.metadata?.background === true,
      time: { created: wire.time.created, completed: wire.time.completed },
    }
  if (wire.type === "compaction")
    return {
      type: "compaction",
      id: wire.id,
      status: wire.status,
      reason: wire.reason,
      summary: wire.status === "completed" ? wire.summary : undefined,
      error: wire.status === "failed" ? failure(wire.error) : undefined,
      time,
    }
  if (wire.type === "idle")
    return { type: "idle", id: wire.id, outcome: wire.outcome, error: wire.error && failure(wire.error), time }
  return { type: "other", id: (wire as { id: string }).id, original: (wire as { type: string }).type, time }
}

export function failure(wire: { type: string; message: string; status?: number; retryAfterMs?: number }): Error {
  return { type: wire.type, message: wire.message, status: wire.status, retryAfterMs: wire.retryAfterMs }
}

function part(wire: SessionMessageAssistant["content"][number]): Part {
  if (wire.type === "text") return { type: "text", text: wire.text }
  if (wire.type === "reasoning") return { type: "reasoning", text: wire.text, time: wire.time }
  if (wire.type === "tool")
    return { type: "tool", id: wire.id, name: wire.name, state: toolState(wire.state), time: wire.time }
  return { type: "unknown", original: (wire as { type: string }).type }
}

function toolState(wire: SessionMessageAssistantTool["state"]): ToolState {
  if (wire.status === "streaming") return { status: "streaming", input: wire.input }
  if (wire.status === "running") return { status: "running", input: wire.input, metadata: wire.metadata }
  if (wire.status === "completed")
    return { status: "completed", input: wire.input, content: wire.content, metadata: wire.metadata }
  return {
    status: "error",
    input: wire.input,
    error: failure(wire.error),
    content: wire.content,
    metadata: wire.metadata,
  }
}

export function noSlots(): Slots {
  return { text: {}, reasoning: {}, tool: {}, done: {} }
}

/**
 * The slots of a message that came whole (a snapshot): text and reasoning count in order, tools by id. A part followed
 * by another, or any part of a message that finished, is done; the last part of a message still streaming is not.
 */
export function slots(content: ReadonlyArray<Part>, finished: boolean): Slots {
  const found = noSlots()
  content.forEach((item, index) => {
    const done = finished || index < content.length - 1
    if (item.type === "text") {
      const ordinal = Object.keys(found.text).length
      found.text[ordinal] = index
      if (done) found.done[`text:${ordinal}`] = true
    }
    if (item.type === "reasoning") {
      const ordinal = Object.keys(found.reasoning).length
      found.reasoning[ordinal] = index
      if (done || item.time?.completed !== undefined) found.done[`reasoning:${ordinal}`] = true
    }
    if (item.type === "tool") found.tool[item.id] = index
  })
  return found
}
