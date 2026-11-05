export * as Reduce from "./reduce"

// The reducer: a snapshot of what the REST routes returned plus the events of `/api/event`, into `State`. It is the only
// code that knows upstream's event shapes, and it mirrors upstream's own message projection (`message-updater.ts` in
// core) over plain JSON. It is tolerant on purpose:
//
// - idempotent: a durable event is applied once per (aggregate, seq), and everything else is a set, never an
//   increment, so replaying events a snapshot already holds changes nothing;
// - out of order: an event for a message that has not started waits for it, a tool result before its call is kept, a
//   reply before its request is remembered, and a content item is found by its ordinal or id, not by position;
// - open: an event or message kind it does not know is ignored or kept as `other`/`unknown`, never a throw.

import type { FormInfo, OpenCodeEvent, PermissionRequest, SessionInfo, SessionMessageInfo } from "@opencode/client"
import { State } from "./state"

export type Snapshot = {
  sessions?: ReadonlyArray<SessionInfo>
  messages?: Readonly<Record<string, ReadonlyArray<SessionMessageInfo>>>
  /** The requests still waiting. For every session the snapshot covers, one that is not here has been answered. */
  permissions?: ReadonlyArray<PermissionRequest>
  forms?: ReadonlyArray<FormInfo>
}

/** The most durable events kept for messages that have not started, so a flood cannot grow the state without bound. */
const ORPHAN_MESSAGES = 64
const ORPHAN_EVENTS = 256

export function snapshot(state: State.State, input: Snapshot): State.State {
  const sessions = { ...state.sessions }
  const covered = new Set<string>()
  const next: State.State = { ...state, sessions }

  input.sessions?.forEach((info) => {
    covered.add(info.id)
    const current = sessions[info.id] ?? State.session(info.id, info.time.created)
    const busy = info.time.busy
    const idle = info.time.idle
    const statusAt = Math.max(busy ?? 0, idle ?? 0)
    // A status newer than the snapshot's stays: the snapshot may have been taken before it
    const newer = statusAt >= current.statusAt
    sessions[info.id] = {
      ...current,
      info: {
        id: info.id,
        parentID: info.parentID,
        title: info.title,
        directory: info.location.directory,
        agent: info.agent,
        model: info.model && { id: info.model.id, providerID: info.model.providerID },
        cost: info.cost,
        tokens: State.tokens(info.tokens),
        created: info.time.created,
        updated: Math.max(info.time.updated, current.info.updated),
        archived: info.time.archived,
      },
      running: newer ? busy !== undefined && (idle === undefined || busy > idle) : current.running,
      outcome: newer ? info.outcome : current.outcome,
      statusAt: newer ? statusAt : current.statusAt,
    }
  })

  const arrived: Array<[string, string]> = []
  Object.entries(input.messages ?? {}).forEach(([sessionID, list]) => {
    covered.add(sessionID)
    const current = sessions[sessionID] ?? State.session(sessionID, list[0]?.time.created ?? 0)
    const messages = { ...current.messages }
    const slots = { ...current.slots }
    // The snapshot's order, then whatever arrived by events that it does not hold yet
    const heard = new Set(list.map((wire) => wire.id))
    const order = [...list.map((wire) => wire.id), ...current.order.filter((id) => !heard.has(id))]
    list.forEach((wire) => {
      const incoming = State.message(wire)
      const existing = messages[incoming.id]
      // A step that already finished here is not reopened by a snapshot taken before it did
      if (existing?.type === "assistant" && incoming.type === "assistant") {
        if (existing.time.completed !== undefined && incoming.time.completed === undefined) return
        arrived.push([sessionID, incoming.id])
      }
      messages[incoming.id] = incoming
      if (incoming.type === "assistant")
        slots[incoming.id] = State.slots(incoming.content, incoming.time.completed !== undefined)
    })
    sessions[sessionID] = { ...current, messages, order, slots }
  })

  if (input.permissions) {
    const waiting = new Set(input.permissions.map((request) => request.id))
    const permissions = { ...state.permissions }
    input.permissions.forEach((request) => {
      covered.add(request.sessionID)
      permissions[request.id] = {
        id: request.id,
        sessionID: request.sessionID,
        action: request.action,
        resources: [...request.resources],
        message: request.message,
        source: request.source && { messageID: request.source.messageID, id: request.source.id },
        reply: permissions[request.id]?.reply,
      }
    })
    Object.values(permissions).forEach((permission) => {
      if (covered.has(permission.sessionID) && !waiting.has(permission.id) && permission.reply === undefined)
        permissions[permission.id] = { ...permission, reply: "closed" }
    })
    next.permissions = permissions
  }

  if (input.forms) {
    const waiting = new Set(input.forms.map((form) => form.id))
    const forms = { ...state.forms }
    input.forms.forEach((info) => {
      covered.add(info.sessionID)
      forms[info.id] = form(info, forms[info.id]?.state ?? "pending", forms[info.id]?.answer)
    })
    Object.values(forms).forEach((existing) => {
      if (covered.has(existing.sessionID) && !waiting.has(existing.id) && existing.state === "pending")
        forms[existing.id] = { ...existing, state: "cancelled" }
    })
    next.forms = forms
  }

  return arrived.reduce((all, [sessionID, id]) => drain(all, sessionID, id), next)
}

export function events(state: State.State, list: ReadonlyArray<OpenCodeEvent>): State.State {
  return list.reduce(event, state)
}

export function event(state: State.State, input: OpenCodeEvent): State.State {
  const durable = "durable" in input ? input.durable : undefined
  if (durable && applied(state, durable.aggregateID, durable.seq)) return state
  const result = apply(state, input)
  if (!durable || !result.accepted) return result.state
  return {
    ...result.state,
    cursors: {
      ...result.state.cursors,
      [durable.aggregateID]: mark(result.state.cursors[durable.aggregateID], durable.seq),
    },
  }
}

type Result = { state: State.State; accepted: boolean }

/** The events that belong to one assistant message. */
type Scoped = Extract<OpenCodeEvent, { data: { sessionID: string; assistantMessageID: string } }>

const accept = (state: State.State): Result => ({ state, accepted: true })

function apply(state: State.State, input: OpenCodeEvent): Result {
  switch (input.type) {
    case "session.created":
      return accept(
        touch(state, input.data.sessionID, input.created, (session) => ({
          ...session,
          info: {
            ...session.info,
            parentID: input.data.parentID ?? session.info.parentID,
            title: input.data.title ?? session.info.title,
            directory: input.data.location.directory,
            agent: input.data.agent ?? session.info.agent,
            model: input.data.model
              ? { id: input.data.model.id, providerID: input.data.model.providerID }
              : session.info.model,
            created: Math.min(session.info.created, input.created),
          },
        })),
      )
    case "session.renamed":
      return accept(
        touch(state, input.data.sessionID, input.created, (session) => ({
          ...session,
          info: { ...session.info, title: input.data.title },
        })),
      )
    case "session.archived":
      return accept(
        touch(state, input.data.sessionID, input.created, (session) => ({
          ...session,
          info: { ...session.info, archived: input.created },
        })),
      )
    case "session.unarchived":
      return accept(
        touch(state, input.data.sessionID, input.created, (session) => ({
          ...session,
          info: { ...session.info, archived: undefined },
        })),
      )
    case "session.agent.selected":
      return accept(
        touch(state, input.data.sessionID, input.created, (session) => ({
          ...session,
          info: { ...session.info, agent: input.data.agent },
        })),
      )
    case "session.model.selected":
      return accept(
        touch(state, input.data.sessionID, input.created, (session) => ({
          ...session,
          info: { ...session.info, model: { id: input.data.model.id, providerID: input.data.model.providerID } },
        })),
      )
    case "session.moved":
      return accept(
        touch(state, input.data.sessionID, input.created, (session) => ({
          ...session,
          info: { ...session.info, directory: input.data.location.directory },
        })),
      )
    case "session.usage.updated":
      return accept(
        touch(state, input.data.sessionID, input.created, (session) => ({
          ...session,
          info: {
            ...session.info,
            cost: input.data.cost,
            tokens: State.tokens(input.data.tokens),
          },
        })),
      )
    case "session.deleted": {
      const sessions = { ...state.sessions }
      delete sessions[input.data.sessionID]
      return accept({ ...state, sessions })
    }
    case "session.inbox.enqueued": {
      const item = input.data.item
      const kept: State.Inbox["item"] =
        item.type === "user"
          ? {
              type: "user",
              text: item.payload.text,
              files: (item.payload.files ?? []).map((file) => ({ name: file.name, mime: file.mime })),
            }
          : item.type === "synthetic"
            ? {
                type: "synthetic",
                text: item.payload.text,
                description: item.payload.description,
                metadata: item.payload.metadata,
              }
            : { type: item.type }
      return accept(
        touch(state, input.data.sessionID, input.created, (session) =>
          deliver(session, input.data.inboxID, { ...session.inbox[input.data.inboxID], item: kept }),
        ),
      )
    }
    case "session.inbox.delivered":
      return accept(
        touch(state, input.data.sessionID, input.created, (session) =>
          deliver(session, input.data.inboxID, {
            ...session.inbox[input.data.inboxID],
            delivered: input.created,
            seq: input.durable.seq,
          }),
        ),
      )
    case "session.inbox.cancelled":
      return accept(
        touch(state, input.data.sessionID, input.created, (session) => {
          const inbox = { ...session.inbox }
          delete inbox[input.data.inboxID]
          return { ...session, inbox }
        }),
      )
    case "session.execution.started":
      return accept(
        touch(state, input.data.sessionID, input.created, (session) =>
          status(session, input.created, { running: true }),
        ),
      )
    case "session.execution.succeeded":
      return accept(touch(state, input.data.sessionID, input.created, (session) => finish(session, input, "succeeded")))
    case "session.execution.failed":
      return accept(
        touch(state, input.data.sessionID, input.created, (session) =>
          finish(session, input, "failed", State.failure(input.data.error)),
        ),
      )
    case "session.execution.interrupted":
      // A shutdown keeps the execution: the resumed drain carries on the same turn
      if (input.data.reason === "shutdown") return accept(touch(state, input.data.sessionID, input.created, clearRetry))
      return accept(
        touch(state, input.data.sessionID, input.created, (session) => finish(session, input, "interrupted")),
      )
    case "session.synthetic":
      return accept(
        touch(state, input.data.sessionID, input.created, (session) =>
          put(
            session,
            {
              type: "synthetic",
              id: fromEvent(input.id),
              text: input.data.text,
              description: input.data.description,
              metadata: input.data.metadata,
              time: { created: input.created },
            },
            seqOf(input),
          ),
        ),
      )
    case "session.shell.started":
      return accept(
        touch(state, input.data.sessionID, input.created, (session) =>
          put(
            session,
            {
              type: "shell",
              id: fromEvent(input.id),
              shellID: input.data.shell.id,
              command: input.data.shell.command,
              status: input.data.shell.status,
              background: input.data.shell.metadata.background === true,
              time: { created: input.created },
            },
            seqOf(input),
          ),
        ),
      )
    case "session.shell.ended":
      return accept(
        touch(state, input.data.sessionID, input.created, (session) => {
          const shell = Object.values(session.messages).find(
            (message) => message.type === "shell" && message.shellID === input.data.shell.id,
          )
          if (shell?.type !== "shell") return session
          return put(session, {
            ...shell,
            status: input.data.shell.status,
            exit: input.data.shell.exit,
            time: { ...shell.time, completed: input.created },
          })
        }),
      )
    case "session.step.started":
      return accept(started(state, input))
    case "session.step.streamed":
      return assistant(state, input, input.data.assistantMessageID, (message) => ({
        ...message,
        time: { ...message.time, streamed: input.created },
      }))
    case "session.step.ended":
      return assistant(state, input, input.data.assistantMessageID, (message) => ({
        ...message,
        finish: input.data.finish,
        tokens: State.tokens(input.data.tokens),
        cost: input.data.cost,
        time: { ...message.time, completed: input.created },
      }))
    case "session.step.failed":
      return assistant(state, input, input.data.assistantMessageID, (message) => ({
        ...message,
        finish: input.data.finish ?? "error",
        error: State.failure(input.data.error),
        retry: undefined,
        time: { ...message.time, completed: input.created },
      }))
    case "session.retry.scheduled":
      return assistant(state, input, input.data.assistantMessageID, (message) => ({
        ...message,
        retry: { attempt: input.data.attempt, at: input.data.at, error: State.failure(input.data.error) },
      }))
    case "session.text.started":
      return assistant(state, input, input.data.assistantMessageID, (message, slots) =>
        text(message, slots, input.data.ordinal, undefined),
      )
    case "session.text.delta":
      return assistant(state, input, input.data.assistantMessageID, (message, slots) =>
        slots.done[`text:${input.data.ordinal}`]
          ? message
          : text(message, slots, input.data.ordinal, (before) => before + input.data.delta),
      )
    case "session.text.ended":
      return assistant(state, input, input.data.assistantMessageID, (message, slots) => {
        slots.done[`text:${input.data.ordinal}`] = true
        return text(message, slots, input.data.ordinal, () => input.data.text)
      })
    case "session.reasoning.started":
      return assistant(state, input, input.data.assistantMessageID, (message, slots) =>
        reasoning(message, slots, input.data.ordinal, input.created, undefined),
      )
    case "session.reasoning.delta":
      return assistant(state, input, input.data.assistantMessageID, (message, slots) =>
        slots.done[`reasoning:${input.data.ordinal}`]
          ? message
          : reasoning(message, slots, input.data.ordinal, input.created, (before) => before + input.data.delta),
      )
    case "session.reasoning.ended":
      return assistant(state, input, input.data.assistantMessageID, (message, slots) => {
        slots.done[`reasoning:${input.data.ordinal}`] = true
        return reasoning(message, slots, input.data.ordinal, input.created, () => input.data.text, input.created)
      })
    case "session.tool.input.started":
      return assistant(state, input, input.data.assistantMessageID, (message, slots) =>
        tool(message, slots, input.data.id, input.created, (current) => ({ ...current, name: input.data.name })),
      )
    case "session.tool.input.delta":
      return assistant(state, input, input.data.assistantMessageID, (message, slots) =>
        tool(message, slots, input.data.id, input.created, (current) =>
          current.state.status === "streaming"
            ? { ...current, state: { status: "streaming", input: current.state.input + input.data.delta } }
            : current,
        ),
      )
    case "session.tool.input.ended":
      return assistant(state, input, input.data.assistantMessageID, (message, slots) =>
        tool(message, slots, input.data.id, input.created, (current) =>
          current.state.status === "streaming"
            ? { ...current, state: { status: "streaming", input: input.data.text } }
            : current,
        ),
      )
    case "session.tool.called":
      return assistant(state, input, input.data.assistantMessageID, (message, slots) =>
        tool(message, slots, input.data.id, input.created, (current) =>
          // A result that got here first is final: the call must not reopen it, but it fills in the arguments it lacks
          current.state.status === "completed" || current.state.status === "error"
            ? Object.keys(current.state.input).length > 0
              ? current
              : { ...current, state: { ...current.state, input: input.data.input } }
            : {
                ...current,
                time: { ...current.time, ran: input.created },
                state: {
                  status: "running",
                  input: input.data.input,
                  metadata: current.state.status === "running" ? current.state.metadata : {},
                },
              },
        ),
      )
    case "session.tool.progress":
      return assistant(state, input, input.data.assistantMessageID, (message, slots) =>
        tool(message, slots, input.data.id, input.created, (current) =>
          current.state.status === "running"
            ? { ...current, state: { ...current.state, metadata: input.data.metadata } }
            : current,
        ),
      )
    case "session.tool.success":
      return assistant(state, input, input.data.assistantMessageID, (message, slots) =>
        tool(message, slots, input.data.id, input.created, (current) => ({
          ...current,
          time: { ...current.time, completed: input.created },
          state: {
            status: "completed",
            input: inputOf(current.state),
            content: input.data.content,
            metadata: input.data.metadata,
          },
        })),
      )
    case "session.tool.failed":
      return assistant(state, input, input.data.assistantMessageID, (message, slots) =>
        tool(message, slots, input.data.id, input.created, (current) => ({
          ...current,
          time: { ...current.time, completed: input.created },
          state: {
            status: "error",
            input: inputOf(current.state),
            error: State.failure(input.data.error),
            content: input.data.content,
            metadata: input.data.metadata,
          },
        })),
      )
    case "session.compaction.started":
      return accept(
        touch(state, input.data.sessionID, input.created, (session) =>
          put(
            session,
            {
              type: "compaction",
              id: input.data.inputID ?? fromEvent(input.id),
              status: "running",
              reason: input.data.reason,
              summary: "",
              time: { created: input.created },
            },
            seqOf(input),
          ),
        ),
      )
    case "session.compaction.delta":
      return accept(
        touch(state, input.data.sessionID, input.created, (session) => {
          const running = compaction(session, "running")
          return running ? put(session, { ...running, summary: (running.summary ?? "") + input.data.text }) : session
        }),
      )
    case "session.compaction.ended":
      return accept(
        touch(state, input.data.sessionID, input.created, (session) => {
          const running = compaction(session, "running")
          return put(
            session,
            {
              type: "compaction",
              id: running?.id ?? fromEvent(input.id),
              status: "completed",
              reason: input.data.reason,
              summary: input.data.text,
              time: running?.time ?? { created: input.created },
            },
            seqOf(input),
          )
        }),
      )
    case "session.compaction.failed":
      return accept(
        touch(state, input.data.sessionID, input.created, (session) => {
          const running = compaction(session, "running")
          return put(
            session,
            {
              type: "compaction",
              id: running?.id ?? input.data.inputID ?? fromEvent(input.id),
              status: "failed",
              reason: input.data.reason,
              error: State.failure(input.data.error),
              time: running?.time ?? { created: input.created },
            },
            seqOf(input),
          )
        }),
      )
    case "permission.asked":
      return accept({
        ...state,
        permissions: {
          ...state.permissions,
          [input.data.id]: {
            id: input.data.id,
            sessionID: input.data.sessionID,
            action: input.data.action,
            resources: [...input.data.resources],
            message: input.data.message,
            source: input.data.source && { messageID: input.data.source.messageID, id: input.data.source.id },
            reply: state.permissions[input.data.id]?.reply ?? state.early.permissions[input.data.id],
          },
        },
      })
    case "permission.replied": {
      const known = state.permissions[input.data.requestID]
      if (!known)
        return accept({
          ...state,
          early: {
            ...state.early,
            permissions: { ...state.early.permissions, [input.data.requestID]: input.data.reply },
          },
        })
      return accept({
        ...state,
        permissions: { ...state.permissions, [known.id]: { ...known, reply: input.data.reply } },
      })
    }
    case "form.created":
      return accept({
        ...state,
        forms: {
          ...state.forms,
          [input.data.form.id]: form(
            input.data.form,
            state.forms[input.data.form.id]?.state ?? state.early.forms[input.data.form.id] ?? "pending",
            state.forms[input.data.form.id]?.answer,
          ),
        },
      })
    case "form.replied": {
      const known = state.forms[input.data.id]
      if (!known)
        return accept({
          ...state,
          early: { ...state.early, forms: { ...state.early.forms, [input.data.id]: "answered" } },
        })
      return accept({
        ...state,
        forms: { ...state.forms, [known.id]: { ...known, state: "answered", answer: answer(input.data.answer) } },
      })
    }
    case "form.cancelled": {
      const known = state.forms[input.data.id]
      if (!known)
        return accept({
          ...state,
          early: { ...state.early, forms: { ...state.early.forms, [input.data.id]: "cancelled" } },
        })
      return accept({ ...state, forms: { ...state.forms, [known.id]: { ...known, state: "cancelled" } } })
    }
    default:
      // Everything else on the stream (providers, MCP, files, the TUI...) is not a session's business
      return accept(state)
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Sessions and messages

/** Applies `change` to the session, creating a bare one for an event that arrives before `session.created`. */
function touch(
  state: State.State,
  id: string,
  at: number,
  change: (session: State.Session) => State.Session,
): State.State {
  const current = state.sessions[id] ?? State.session(id, at)
  const changed = change(current)
  return {
    ...state,
    sessions: {
      ...state.sessions,
      [id]: { ...changed, info: { ...changed.info, updated: Math.max(changed.info.updated, at) } },
    },
  }
}

const fromEvent = (id: string) => id.replace(/^evt_/, "msg_")

/**
 * Stores a message. A new one goes after every message that was created before it (by durable sequence) and before the
 * ones created after, so the order is the same whichever way the events arrived; one with no sequence goes last.
 */
function put(session: State.Session, message: State.Message, seq?: number): State.Session {
  const messages = { ...session.messages, [message.id]: message }
  if (message.id in session.messages) return { ...session, messages }
  const at = { value: session.order.length }
  while (seq !== undefined && at.value > 0 && (session.rank[session.order[at.value - 1]!] ?? -1) > seq) at.value--
  return {
    ...session,
    messages,
    order: [...session.order.slice(0, at.value), message.id, ...session.order.slice(at.value)],
    rank: seq === undefined ? session.rank : { ...session.rank, [message.id]: seq },
  }
}

const seqOf = (input: OpenCodeEvent) => ("durable" in input ? input.durable.seq : undefined)

/** A user or synthetic message exists once its item and its delivery have both been heard, in either order. */
function deliver(session: State.Session, id: string, inbox: State.Inbox): State.Session {
  const item = inbox.item
  if (!item || inbox.delivered === undefined) return { ...session, inbox: { ...session.inbox, [id]: inbox } }
  const rest = { ...session.inbox }
  delete rest[id]
  const time = { created: inbox.delivered }
  if (item.type === "user")
    return put(
      { ...session, inbox: rest },
      { type: "user", id, text: item.text ?? "", files: item.files ?? [], time },
      inbox.seq,
    )
  if (item.type === "synthetic")
    return put(
      { ...session, inbox: rest },
      { type: "synthetic", id, text: item.text ?? "", description: item.description, metadata: item.metadata, time },
      inbox.seq,
    )
  return { ...session, inbox: rest }
}

function status(
  session: State.Session,
  at: number,
  change: { running: boolean; outcome?: State.Session["outcome"] },
): State.Session {
  // Whatever decided the status last, by the clock of the events, wins: a replayed older event never undoes it
  if (at < session.statusAt) return session
  return {
    ...session,
    running: change.running,
    outcome: change.outcome ?? (change.running ? undefined : session.outcome),
    statusAt: at,
  }
}

function finish(
  session: State.Session,
  input: OpenCodeEvent & { created: number },
  outcome: NonNullable<State.Session["outcome"]>,
  error?: State.Error,
): State.Session {
  const idle: State.Idle = { type: "idle", id: fromEvent(input.id), outcome, error, time: { created: input.created } }
  return status(put(clearRetry(session), idle, seqOf(input)), input.created, { running: false, outcome })
}

/** The step that was retrying is over: its retry notice goes. */
function clearRetry(session: State.Session): State.Session {
  const retrying = Object.values(session.messages).filter((message) => message.type === "assistant" && message.retry)
  if (retrying.length === 0) return session
  const messages = { ...session.messages }
  retrying.forEach((message) => {
    if (message.type === "assistant") messages[message.id] = { ...message, retry: undefined }
  })
  return { ...session, messages }
}

function compaction(session: State.Session, status: State.Compaction["status"]) {
  const found = Object.values(session.messages)
    .filter((message): message is State.Compaction => message.type === "compaction" && message.status === status)
    .sort((a, b) => (a.id < b.id ? -1 : 1))
  return found[found.length - 1]
}

function started(state: State.State, input: Extract<OpenCodeEvent, { type: "session.step.started" }>): State.State {
  const id = input.data.assistantMessageID
  const model = { id: input.data.model.id, providerID: input.data.model.providerID }
  const next = touch(state, input.data.sessionID, input.created, (session) => {
    const existing = session.messages[id]
    if (existing?.type === "assistant") {
      // The same step started again (a retry) restarts the message; one that is not newer is a replay
      if (input.data.started <= existing.time.created) return session
      return put(session, {
        ...existing,
        agent: input.data.agent,
        model,
        retry: undefined,
        error: undefined,
        finish: undefined,
        time: { created: input.data.started },
      })
    }
    const created: State.Assistant = {
      type: "assistant",
      id,
      agent: input.data.agent,
      model,
      content: [],
      time: { created: input.data.started },
    }
    return { ...put(clearRetry(session), created, seqOf(input)), slots: { ...session.slots, [id]: State.noSlots() } }
  })
  return drain(next, input.data.sessionID, id)
}

/** The assistant message, or the event kept for when it starts. Ephemeral events for a missing message are dropped. */
function assistant(
  state: State.State,
  input: Scoped,
  id: string,
  change: (message: State.Assistant, slots: State.Slots) => State.Assistant,
): Result {
  const sessionID = input.data.sessionID
  const session = state.sessions[sessionID]
  const message = session?.messages[id]
  if (!session || message?.type !== "assistant") {
    if (!("durable" in input)) return { state, accepted: true }
    return { state: orphan(state, sessionID, id, input), accepted: false }
  }
  const slots = clone(session.slots[id] ?? State.slots(message.content, message.time.completed !== undefined))
  const changed = change({ ...message, content: [...message.content] }, slots)
  return accept(
    touch(state, sessionID, input.created, (current) => ({
      ...put(current, changed),
      slots: { ...current.slots, [id]: slots },
    })),
  )
}

function clone(slots: State.Slots): State.Slots {
  return {
    text: { ...slots.text },
    reasoning: { ...slots.reasoning },
    tool: { ...slots.tool },
    done: { ...slots.done },
  }
}

function orphan(state: State.State, sessionID: string, id: string, input: Scoped): State.State {
  const session = state.sessions[sessionID] ?? State.session(sessionID, input.created)
  const waiting = session.orphans[id] ?? []
  const orphans = { ...session.orphans, [id]: waiting.length >= ORPHAN_EVENTS ? waiting : [...waiting, input] }
  const keys = Object.keys(orphans)
  if (keys.length > ORPHAN_MESSAGES) delete orphans[keys[0]!]
  return { ...state, sessions: { ...state.sessions, [sessionID]: { ...session, orphans } } }
}

/** Replays what waited for a message that now exists, in the order upstream numbered it. */
function drain(state: State.State, sessionID: string, id: string): State.State {
  const waiting = state.sessions[sessionID]?.orphans[id] as OpenCodeEvent[] | undefined
  if (!waiting) return state
  const orphans = { ...state.sessions[sessionID]!.orphans }
  delete orphans[id]
  const cleared: State.State = {
    ...state,
    sessions: { ...state.sessions, [sessionID]: { ...state.sessions[sessionID]!, orphans } },
  }
  const order = (item: OpenCodeEvent) => ("durable" in item ? item.durable.seq : 0)
  return [...waiting].sort((a, b) => order(a) - order(b)).reduce(event, cleared)
}

function text(
  message: State.Assistant,
  slots: State.Slots,
  ordinal: number,
  change: ((before: string) => string) | undefined,
): State.Assistant {
  const at = slots.text[ordinal] ?? message.content.length
  if (slots.text[ordinal] === undefined) {
    slots.text[ordinal] = at
    message.content[at] = { type: "text", text: "" }
  }
  const part = message.content[at]
  if (part?.type === "text" && change) message.content[at] = { type: "text", text: change(part.text) }
  return message
}

function reasoning(
  message: State.Assistant,
  slots: State.Slots,
  ordinal: number,
  at: number,
  change: ((before: string) => string) | undefined,
  completed?: number,
): State.Assistant {
  const index = slots.reasoning[ordinal] ?? message.content.length
  if (slots.reasoning[ordinal] === undefined) {
    slots.reasoning[ordinal] = index
    message.content[index] = { type: "reasoning", text: "", time: { created: at } }
  }
  const part = message.content[index]
  if (part?.type === "reasoning")
    message.content[index] = {
      type: "reasoning",
      text: change ? change(part.text) : part.text,
      time: { created: Math.min(part.time?.created ?? at, at), completed: completed ?? part.time?.completed },
    }
  return message
}

function tool(
  message: State.Assistant,
  slots: State.Slots,
  id: string,
  at: number,
  change: (current: State.Tool) => State.Tool,
): State.Assistant {
  const index = slots.tool[id] ?? message.content.length
  const existing = message.content[index]
  const current: State.Tool =
    slots.tool[id] !== undefined && existing?.type === "tool"
      ? existing
      : { type: "tool", id, name: "", state: { status: "streaming", input: "" }, time: { created: at } }
  slots.tool[id] = index
  message.content[index] = change(current)
  return message
}

function inputOf(state: State.ToolState): Record<string, unknown> {
  if (state.status === "streaming") {
    // The raw text of a call whose arguments never completed: nothing to show but nothing to lose
    return {}
  }
  return state.input
}

// ---------------------------------------------------------------------------------------------------------------------
// Durable sequence

function applied(state: State.State, aggregate: string, seq: number) {
  const cursor = state.cursors[aggregate]
  return cursor !== undefined && (seq <= cursor.through || cursor.above.includes(seq))
}

function mark(cursor: State.Cursor | undefined, seq: number): State.Cursor {
  const current = cursor ?? { through: -1, above: [] }
  const above = [...current.above, seq].sort((a, b) => a - b)
  const through = { value: current.through }
  while (above.length > 0 && above[0]! <= through.value + 1) through.value = Math.max(through.value, above.shift()!)
  return { through: through.value, above }
}

// ---------------------------------------------------------------------------------------------------------------------
// Requests

function form(info: FormInfo, state: State.Form["state"], answered?: State.Form["answer"]): State.Form {
  return {
    id: info.id,
    sessionID: info.sessionID,
    title: info.title,
    metadata: info.metadata ?? {},
    fields: info.fields.map((field) => ({
      key: field.key,
      type: field.type,
      title: "title" in field ? field.title : undefined,
      description: "description" in field ? field.description : undefined,
      options:
        "options" in field && field.options
          ? field.options.map((option) => ({
              value: option.value,
              label: option.label,
              description: option.description,
            }))
          : [],
    })),
    state,
    answer: answered,
  }
}

function answer(value: Record<string, unknown>): NonNullable<State.Form["answer"]> {
  const kept: NonNullable<State.Form["answer"]> = {}
  Object.entries(value).forEach(([key, item]) => {
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") kept[key] = item
    if (Array.isArray(item)) kept[key] = item.map(String)
  })
  return kept
}
