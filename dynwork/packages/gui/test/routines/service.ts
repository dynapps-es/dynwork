import type { JsonValue, SessionInfo } from "@opencode/client/promise"

/** A request the fake service received: method, path, query and JSON body. */
export interface Received {
  readonly method: string
  readonly path: string
  readonly query: Record<string, string>
  readonly body?: Record<string, unknown>
}

type Outcome = NonNullable<SessionInfo["outcome"]>

/**
 * A stand-in for DynWork's service (`opencode serve --service`) over real HTTP, for the local routines backend: the
 * session routes it calls, the agent, model and skill lists, and the event stream. A prompt starts the session's
 * execution at once; `finish` ends every running one, as the model would, `ask` and `reply` put a permission request to
 * a session and answer it, and `restart` drops them as a service that
 * stopped would: they stay busy, but no longer active. Times come from `now`, which the test moves.
 * It speaks the public API's wire shapes (`packages/protocol/src/groups/session.ts`): `{ data }` bodies, 204 for
 * updates, a tagged 404 for an unknown session.
 */
export function fakeService(input: { now: () => number }) {
  const sessions = new Map<string, SessionInfo>()
  const received: Received[] = []
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>()
  // The sessions whose execution this process runs (`GET /api/session/active`).
  const active = new Set<string>()
  const counter = { value: 0 }
  const encoder = new TextEncoder()

  const emit = (event: Record<string, unknown>) =>
    streams.forEach((stream) => stream.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)))

  const missing = (sessionID: string) =>
    Response.json(
      { _tag: "SessionNotFoundError", sessionID, message: `Session not found: ${sessionID}` },
      { status: 404 },
    )

  const patch = (id: string, change: Partial<SessionInfo>, time: Partial<SessionInfo["time"]> = {}) => {
    const session = sessions.get(id)
    if (!session) return
    sessions.set(id, { ...session, ...change, time: { ...session.time, ...time, updated: input.now() } })
  }

  const create = (body: Record<string, unknown>) => {
    const parent = typeof body.parentID === "string" ? sessions.get(body.parentID) : undefined
    if (body.parentID !== undefined && !parent) return missing(String(body.parentID))
    const id = typeof body.id === "string" ? body.id : `ses_fake${String(++counter.value).padStart(4, "0")}`
    const location = (body.location as { directory: string } | undefined) ?? parent?.location ?? { directory: "/" }
    const session: SessionInfo = {
      id,
      projectID: "prj_fake",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: input.now(), updated: input.now() },
      location,
      ...(parent ? { parentID: parent.id } : {}),
      ...(typeof body.title === "string" ? { title: body.title } : {}),
      ...(typeof body.agent === "string" ? { agent: body.agent } : {}),
      ...(body.model ? { model: body.model as SessionInfo["model"] } : {}),
      ...(body.metadata
        ? { metadata: body.metadata as Record<string, JsonValue> }
        : parent?.metadata
          ? { metadata: parent.metadata }
          : {}),
      ...(body.permissions ? { permissions: body.permissions as SessionInfo["permissions"] } : {}),
    } as SessionInfo
    sessions.set(id, session)
    return Response.json({ data: session })
  }

  // Removing a session removes its children with it, as core's `remove` does.
  const remove = (id: string): void => {
    sessions.delete(id)
    ;[...sessions.values()].filter((session) => session.parentID === id).forEach((child) => remove(child.id))
    emit({ type: "session.deleted", data: { sessionID: id } })
  }

  const route = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const text = await request.text()
    const body = text === "" ? undefined : JSON.parse(text)
    received.push({
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      ...(body ? { body } : {}),
    })
    const parts = url.pathname.split("/").filter(Boolean)
    if (url.pathname === "/api/event") return events()
    if (url.pathname === "/api/agent")
      return Response.json({
        location: { directory: "/" },
        data: [
          { id: "build", name: "build" },
          { id: "plan", name: "plan" },
        ],
      })
    if (url.pathname === "/api/model")
      return Response.json({
        location: { directory: "/" },
        data: [
          { id: "claude-sonnet-5-5", modelID: "claude-sonnet-5-5", providerID: "anthropic", name: "Claude Sonnet 5.5" },
        ],
      })
    if (url.pathname === "/api/skill")
      return Response.json({
        location: { directory: "/" },
        data: [{ id: "standup", name: "standup", path: "/s", content: "" }],
      })
    if (url.pathname === "/api/session/active")
      return Response.json({ data: Object.fromEntries([...active].map((id) => [id, { type: "running" }])) })
    if (url.pathname === "/api/session" && request.method === "POST") return create(body)
    if (url.pathname === "/api/session" && request.method === "GET") {
      const parent = url.searchParams.get("parentID")
      return Response.json({
        data: [...sessions.values()].filter((session) => (parent ? session.parentID === parent : true)),
        cursor: {},
      })
    }
    const id = parts[2] ?? ""
    const session = sessions.get(id)
    if (!session) return missing(id)
    const action = parts[3]
    if (!action && request.method === "GET") return Response.json({ data: session })
    if (!action && request.method === "DELETE") {
      remove(id)
      return new Response(null, { status: 204 })
    }
    if (!action && request.method === "PATCH") {
      patch(id, {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
      })
      return new Response(null, { status: 204 })
    }
    if (action === "prompt") {
      patch(id, {}, { busy: input.now() })
      active.add(id)
      emit({ type: "session.execution.started", data: { sessionID: id } })
      return Response.json({
        data: {
          id: body.id ?? `msg_fake${++counter.value}`,
          sessionID: id,
          type: "user",
          time: { created: input.now() },
        },
      })
    }
    if (action === "interrupt") {
      end(id, "interrupted")
      return Response.json({ interrupted: true })
    }
    if (action === "view") {
      patch(id, {}, { viewed: body.idle })
      return new Response(null, { status: 204 })
    }
    if (action === "move") {
      patch(id, { location: { directory: body.directory } })
      return new Response(null, { status: 204 })
    }
    if (action === "fork") {
      const forked = { ...session, id: `ses_fork${++counter.value}`, parentID: undefined, fork: { sessionID: id } }
      sessions.set(forked.id, forked as SessionInfo)
      return Response.json({ data: forked })
    }
    return new Response(null, { status: 404 })
  }

  // An execution reaches its end: the outcome and `time.idle` are recorded, then the terminal event goes out.
  const end = (id: string, outcome: Outcome) => {
    const session = sessions.get(id)
    if (!session || session.time.busy === undefined || (session.time.idle ?? 0) >= session.time.busy) return
    patch(id, { outcome }, { idle: input.now() })
    active.delete(id)
    emit({ type: `session.execution.${outcome}`, data: { sessionID: id } })
  }

  // The event stream: `server.connected` first, then every event while the client holds it.
  const events = () => {
    const holder: { stream?: ReadableStreamDefaultController<Uint8Array> } = {}
    return new Response(
      new ReadableStream<Uint8Array>({
        start: (controller) => {
          holder.stream = controller
          streams.add(controller)
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "server.connected", data: {} })}\n\n`))
        },
        cancel: () => {
          if (holder.stream) streams.delete(holder.stream)
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
  }

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: route })

  return {
    url: server.url.origin,
    sessions,
    received,
    /** Ends every running execution with `outcome`. */
    finish: (outcome: Outcome = "succeeded") => [...sessions.values()].forEach((session) => end(session.id, outcome)),
    /** Removes a session as the user deleting it would. */
    remove,
    /** Closes every event stream, as a restarting service does. */
    drop: () => {
      streams.forEach((stream) => stream.close())
      streams.clear()
    },
    /** Stops every execution without ending it and closes the event streams, as the service stopping does. */
    restart: () => {
      active.clear()
      streams.forEach((stream) => stream.close())
      streams.clear()
    },
    /** A running session asks for a permission, or the user answers one, as core's events say. */
    ask: (sessionID: string, id: string) =>
      emit({ type: "permission.asked", data: { id, sessionID, action: "edit", resources: ["*"] } }),
    reply: (sessionID: string, requestID: string) =>
      emit({ type: "permission.replied", data: { sessionID, requestID, reply: "once" } }),
    /** The text of every prompt sent, in order. */
    prompts: () =>
      received.filter((request) => request.path.endsWith("/prompt")).map((request) => String(request.body?.text)),
    /** How many event streams are open. */
    listeners: () => streams.size,
    stop: () => server.stop(true),
  }
}

/** Waits until `condition` holds, for at most `ms` of real time: the backend reacts to events over real sockets. */
export async function until(condition: () => boolean, ms = 3_000) {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the condition")
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}
