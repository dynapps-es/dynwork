export * as ChatsFake from "./fake"

import { PATH } from "./client"

// An in-memory cloud chats instance behind a `fetch`, for tests: the routes of the plan's contract, `If-Match`
// revisions, the change feed with tombstones, and replies whose events stream over the log's SSE. A reply's events are
// queued and sent by `flush`, so a test decides when the reply moves; `interrupt` ends it with the text written so far.
// Every request is recorded, its token checked against `token`.

type Row = {
  id: string
  title: string
  model: { providerID: string; id: string } | null
  revision: number
  archived_at: number | null
  deleted: boolean
  created_at: number
  updated_at: number
  change: number
}

type Envelope = {
  id: string
  type: string
  created: number
  durable: { aggregateID: string; seq: number; version: 1 }
  data: Record<string, unknown>
}

type Pending = { type: string; data: Record<string, unknown> }

type Live = { id: string; text: string; written: string; pending: Pending[] }

export interface Options {
  /** The JWT the instance takes; any other is refused with `401`. */
  token: () => string
  now?: () => number
  /** How the fake answers a prompt: the reply's text deltas. Defaults to echoing the prompt in three pieces. */
  reply?: (text: string) => string[]
  models?: { id: string; name: string; provider: string; reasoning: boolean; tools: boolean }[]
}

export function make(options: Options) {
  // A clock that moves a millisecond on every read, so everything the fake writes has its own time.
  const clock = { at: 1_800_000_000_000 }
  const now = options.now ?? (() => clock.at++)
  const threads = new Map<string, Row>()
  const messages = new Map<string, unknown[]>()
  const log = new Map<string, Envelope[]>()
  const live = new Map<string, Live>()
  const followers = new Map<string, Set<(event: Envelope) => void>>()
  const requests: { method: string; path: string; headers: Record<string, string>; body?: unknown }[] = []
  const counter = { change: 0, event: 0, message: 0 }
  const down = { value: false }
  const closers = new Set<() => void>()

  const reply = options.reply ?? ((text: string) => ["You said: ", text.slice(0, 4), text.slice(4)])
  const models = options.models ?? [
    { id: "claude-sonnet-4", name: "Claude Sonnet 4", provider: "anthropic", reasoning: true, tools: true },
    { id: "gpt-5.4-mini", name: "GPT-5.4 mini", provider: "openai", reasoning: false, tools: true },
  ]

  // Appends an event to the thread's log and sends it to whoever follows it.
  function emit(thread: string, type: string, data: Record<string, unknown>) {
    const events = log.get(thread) ?? []
    const event: Envelope = {
      id: `evt_${String(++counter.event).padStart(6, "0")}`,
      type,
      created: now(),
      durable: { aggregateID: thread, seq: events.length + 1, version: 1 },
      data: { sessionID: thread, ...data },
    }
    events.push(event)
    log.set(thread, events)
    followers.get(thread)?.forEach((listener) => listener(event))
    return event
  }

  function touch(row: Row, change: Partial<Row>) {
    const next = { ...row, ...change, revision: row.revision + 1, updated_at: now(), change: ++counter.change }
    threads.set(row.id, next)
    return next
  }

  const wire = (row: Row) => ({
    id: row.id,
    title: row.title,
    model: row.model,
    revision: row.revision,
    archived_at: row.archived_at,
    deleted: row.deleted,
    created_at: row.created_at,
    updated_at: row.updated_at,
  })

  const json = (status: number, body?: unknown) =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })
  const error = (status: number, key: string, message: string) => json(status, { error: { key, message } })

  async function handle(input: string, init: RequestInit = {}): Promise<Response> {
    if (down.value) throw new TypeError("fetch failed")
    const url = new URL(input)
    const headers = Object.fromEntries(new Headers(init.headers).entries())
    const method = init.method ?? "GET"
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
    const path = url.pathname.slice(PATH.length)
    requests.push({ method, path: `${path}${url.search}`, headers, ...(body ? { body } : {}) })
    if (!url.pathname.startsWith(PATH)) return error(404, "not_found", "No such route.")
    if (headers.authorization !== `Bearer ${options.token()}`) return error(401, "token_invalid", "Sign in again.")
    const match = path.match(/^\/threads\/([^/]+)(?:\/(\w+))?$/)
    const id = match ? decodeURIComponent(match[1]!) : undefined
    const action = match?.[2]
    const revision = headers["if-match"] ? Number(headers["if-match"].replaceAll('"', "")) : undefined

    if (method === "GET" && path === "/models") return json(200, { models })
    if (method === "GET" && path === "/changes") {
      const since = Number(url.searchParams.get("since") ?? 0)
      const rows = [...threads.values()].filter((row) => (since === 0 ? !row.deleted : row.change > since))
      return json(200, { threads: rows.map(wire), cursor: String(counter.change), more: false })
    }
    if (!id) return error(404, "not_found", "No such route.")
    const row = threads.get(id)
    if (method === "PUT" && !action) {
      if (revision === undefined) {
        if (row && !row.deleted) return json(409, { current: wire(row) })
        const created = touch(
          {
            id,
            title: String(body?.title ?? ""),
            model: (body?.model as Row["model"]) ?? null,
            revision: 0,
            archived_at: null,
            deleted: false,
            created_at: now(),
            updated_at: now(),
            change: 0,
          },
          {},
        )
        emit(id, "session.created", { title: created.title })
        return json(200, wire(created))
      }
      if (!row || row.deleted) return error(404, "not_found", "No such chat.")
      if (row.revision !== revision) return json(409, { current: wire(row) })
      const changed = touch(row, {
        ...(typeof body?.title === "string" ? { title: body.title } : {}),
        ...(body?.model ? { model: body.model as Row["model"] } : {}),
        ...(typeof body?.archived === "boolean" ? { archived_at: body.archived ? now() : null } : {}),
      })
      return json(200, wire(changed))
    }
    if (!row || row.deleted) return error(404, "not_found", "No such chat.")
    if (method === "DELETE" && !action) {
      if (row.revision !== revision) return json(409, { current: wire(row) })
      touch(row, { deleted: true })
      return json(204)
    }
    if (method === "GET" && action === "messages")
      return json(200, { messages: [...(messages.get(id) ?? [])].reverse() })
    if (method === "POST" && action === "prompt") {
      const messageID = String(body?.messageID)
      const parts = (body?.parts as { text: string }[] | undefined) ?? []
      const text = parts.map((part) => part.text).join("")
      const held = messages.get(id) ?? []
      const existing = live.get(id)
      if (held.some((item) => (item as { id: string }).id === messageID)) return json(202, { messageID: existing?.id })
      if (existing) return error(409, "busy", "A reply is running.")
      held.push({ type: "user", id: messageID, text, time: { created: now() } })
      messages.set(id, held)
      const assistant = `msg_fake${String(++counter.message).padStart(4, "0")}`
      const deltas = reply(text)
      const pending: Pending[] = [
        { type: "session.execution.started", data: {} },
        {
          type: "session.step.started",
          data: {
            assistantMessageID: assistant,
            agent: "build",
            model: row.model ?? { providerID: models[0]!.provider, id: models[0]!.id },
            started: now(),
          },
        },
        { type: "session.text.started", data: { assistantMessageID: assistant, ordinal: 0 } },
        ...deltas.map((delta) => ({
          type: "session.text.delta",
          data: { assistantMessageID: assistant, ordinal: 0, delta },
        })),
      ]
      live.set(id, { id: assistant, text: deltas.join(""), written: "", pending })
      touch(row, {})
      return json(202, { messageID: assistant })
    }
    if (method === "POST" && action === "interrupt") {
      const running = live.get(id)
      if (running) end(id, running, "session.execution.interrupted")
      return json(204)
    }
    if (method === "GET" && action === "log") {
      const after = Number(url.searchParams.get("after") ?? 0)
      const signal = init.signal
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder()
          const write = (event: Envelope) =>
            controller.enqueue(
              encoder.encode(`id: ${event.durable.seq}\nevent: message\ndata: ${JSON.stringify(event)}\n\n`),
            )
          const listener = (event: Envelope) => {
            if (event.durable.seq > after) write(event)
          }
          ;(log.get(id) ?? []).forEach(listener)
          const set = followers.get(id) ?? new Set()
          set.add(listener)
          followers.set(id, set)
          // A dropped connection and an aborted request both end the stream.
          const close = () => {
            if (!closers.delete(close)) return
            set.delete(listener)
            controller.close()
          }
          closers.add(close)
          signal?.addEventListener("abort", close, { once: true })
        },
      })
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })
    }
    return error(404, "not_found", "No such route.")
  }

  // Sends the next `count` events of a running reply.
  function release(thread: string, running: Live, count: number) {
    running.pending.splice(0, count).forEach((event) => {
      if (event.type === "session.text.delta") running.written += String(event.data.delta)
      emit(thread, event.type, event.data)
    })
  }

  // The reply ends: well, with the rest of its events, or cut, with what it wrote so far. Its message is kept.
  function end(
    thread: string,
    running: Live,
    outcome: "session.execution.succeeded" | "session.execution.interrupted",
  ) {
    const succeeded = outcome === "session.execution.succeeded"
    if (succeeded) release(thread, running, running.pending.length)
    running.pending = []
    const text = succeeded ? running.text : running.written
    emit(thread, "session.text.ended", { assistantMessageID: running.id, ordinal: 0, text })
    emit(thread, "session.step.ended", {
      assistantMessageID: running.id,
      finish: succeeded ? "stop" : "unknown",
      cost: 0,
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    emit(thread, outcome, succeeded ? {} : { reason: "user" })
    const step = log
      .get(thread)
      ?.find((event) => event.type === "session.step.started" && event.data.assistantMessageID === running.id)
    messages.get(thread)?.push({
      type: "assistant",
      id: running.id,
      agent: "build",
      model: step?.data.model,
      content: [{ type: "text", text }],
      time: { created: step?.created ?? now(), completed: now() },
      finish: succeeded ? "stop" : "unknown",
    })
    live.delete(thread)
  }

  return {
    fetch: handle,
    requests,
    threads: () => [...threads.values()].filter((row) => !row.deleted).map(wire),
    log: (thread: string) => log.get(thread) ?? [],
    /** Sends up to `count` queued events of the thread's running reply (all of them by default). */
    flush(thread: string, count = Number.POSITIVE_INFINITY) {
      const running = live.get(thread)
      if (running) release(thread, running, count)
    },
    /** Sends the rest of the running reply and ends it well. */
    finish(thread: string) {
      const running = live.get(thread)
      if (running) end(thread, running, "session.execution.succeeded")
    },
    /** Another device changed a thread. */
    edit(thread: string, change: { title?: string; deleted?: boolean }) {
      const row = threads.get(thread)
      if (row) touch(row, change)
    },
    /** Closes every open log stream, as a dropped connection does. */
    drop() {
      closers.forEach((close) => close())
      closers.clear()
    },
    /** The instance stops answering (or answers again). */
    down(value: boolean) {
      down.value = value
    },
  }
}

export type Fake = ReturnType<typeof make>
