import type { Service } from "./service"

// The recording of one scenario: the events `/api/event` carried for its sessions, in arrival order, and snapshots of
// the state the REST routes returned at named moments. The reducer in `@dynwork/mobile-model` consumes exactly this.

export type Wire = {
  id: string
  type: string
  created: number
  data: Record<string, any>
  durable?: unknown
  location?: unknown
}

export type Snapshot = {
  label: string
  /** How many events had arrived when it was taken; a snapshot may be a little ahead of or behind its position. */
  after: number
  sessions: unknown[]
  messages: Record<string, unknown[]>
  permissions: unknown[]
  forms: unknown[]
}

export type Line =
  | { kind: "meta"; scenario: string; description: string; version: string; root: string; sessions: string[] }
  | { kind: "event"; event: Wire }
  | { kind: "snapshot"; snapshot: Snapshot }

export type Scenario = {
  name: string
  description: string
  /** Agents or session settings the scenario needs, applied to the session it creates. */
  permissions?: Array<{ action: string; resource: string; effect: "allow" | "deny" | "ask" }>
  /** Files the scenario's project starts with. */
  files?: Record<string, string>
  run: (context: Context) => Promise<void>
}

export type Context = {
  directory: string
  /** The root session: created with the scenario's model and permissions. */
  session: string
  prompt: (text: string, session?: string) => Promise<void>
  /** Waits until the session's agent loop is idle. */
  wait: (session?: string) => Promise<void>
  /** Polls until the events heard so far satisfy `check`. */
  until: (what: string, check: (events: Wire[]) => boolean, ms?: number) => Promise<void>
  snapshot: (label: string) => Promise<void>
  get: (route: string) => Promise<any>
  post: (route: string, body?: unknown) => Promise<any>
  events: () => Wire[]
}

/** Opens `/api/event` and keeps what arrives until `close`. */
export async function listen(service: Service) {
  const controller = new AbortController()
  const events: Wire[] = []
  const response = await fetch(`${service.url}/api/event`, { headers: service.headers, signal: controller.signal })
  if (!response.ok || !response.body) throw new Error(`GET /api/event: ${response.status}`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const pump = (async () => {
    const buffer = { text: "" }
    while (true) {
      const chunk = await reader.read().catch(() => ({ done: true as const, value: undefined }))
      if (chunk.done) return
      buffer.text += decoder.decode(chunk.value, { stream: true })
      const frames = buffer.text.split("\n\n")
      buffer.text = frames.pop() ?? ""
      frames.forEach((frame) => {
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("")
        if (data) events.push(JSON.parse(data))
      })
    }
  })()
  // The stream opens with `server.connected`: wait for it, so nothing the scenario does can be missed
  const deadline = Date.now() + 10_000
  while (!events.some((event) => event.type === "server.connected")) {
    if (Date.now() > deadline) throw new Error("no server.connected on /api/event")
    await Bun.sleep(20)
  }
  return {
    events,
    close: async () => {
      controller.abort()
      await pump
    },
  }
}

/** The sessions a recording is about: the root and every descendant that announced itself. */
export function family(events: Wire[], root: string) {
  const ids = new Set([root])
  const created = events.filter((event) => event.type === "session.created")
  while (created.some((event) => event.data.parentID && ids.has(event.data.parentID) && !ids.has(event.data.sessionID)))
    created.forEach((event) => {
      if (event.data.parentID && ids.has(event.data.parentID)) ids.add(event.data.sessionID)
    })
  return ids
}

/** The session an event is about, if any. Forms nest it under `form`. */
export function owner(event: Wire): string | undefined {
  return event.data.sessionID ?? event.data.form?.sessionID
}

/** Runs a scenario against the service and returns what it recorded, as the lines of its fixture. */
export async function run(service: Service, scenario: Scenario): Promise<Line[]> {
  const directory = await service.project(scenario.name)
  await Promise.all(Object.entries(scenario.files ?? {}).map(([name, text]) => Bun.write(`${directory}/${name}`, text)))
  const heard = await listen(service)
  const first = heard.events.length
  const created = await service.post(
    "/api/session",
    {
      location: { directory },
      // A titled session asks the model for no title, so every request the fake sees is a step of the agent loop
      title: scenario.name,
      model: { id: "fake-1", providerID: "fake" },
      ...(scenario.permissions ? { permissions: scenario.permissions } : {}),
    },
    directory,
  )
  const root: string = created.data.id
  const snapshots: Snapshot[] = []
  const mine = () => heard.events.slice(first)

  const settle = async () => {
    // Events trail the REST answers a little: wait until the stream has been still for a moment
    const last = { count: -1 }
    while (last.count !== heard.events.length) {
      last.count = heard.events.length
      await Bun.sleep(400)
    }
  }
  const until: Context["until"] = async (what, check, ms = 30_000) => {
    const deadline = Date.now() + ms
    while (!check(mine())) {
      if (Date.now() > deadline)
        throw new Error(
          `${scenario.name}: timed out waiting for ${what}; the last events were ${mine()
            .slice(-12)
            .map((event) => event.type)
            .join(", ")}`,
        )
      await Bun.sleep(50)
    }
  }
  const context: Context = {
    directory,
    session: root,
    events: mine,
    get: (route) => service.get(route, directory),
    post: (route, body) => service.post(route, body, directory),
    prompt: async (text, session = root) => {
      await service.post(`/api/session/${session}/prompt`, { text }, directory)
    },
    wait: async (session = root) => {
      await service.post(`/api/experimental/session/${session}/wait`, undefined, directory)
      await settle()
    },
    until,
    snapshot: async (label) => {
      await settle()
      const ids = [...family(mine(), root)]
      const sessions = await Promise.all(
        ids.map(async (id) => (await service.get(`/api/session/${id}`, directory)).data),
      )
      const messages = await Promise.all(ids.map(async (id) => [id, await everything(service, id, directory)] as const))
      const permissions = (
        await Promise.all(ids.map(async (id) => (await service.get(`/api/session/${id}/permission`, directory)).data))
      ).flat()
      const forms = (
        await Promise.all(ids.map(async (id) => (await service.get(`/api/session/${id}/form`, directory)).data))
      ).flat()
      snapshots.push({
        label,
        after: mine().length,
        sessions,
        messages: Object.fromEntries(messages),
        permissions,
        forms,
      })
    },
  }
  const outcome = await scenario.run(context).then(
    () => undefined,
    (error: unknown) => error,
  )
  await settle()
  await heard.close()
  if (outcome) throw outcome

  const events = mine()
  const ids = family(events, root)
  const own = events.filter((event) => {
    const id = owner(event)
    return id !== undefined && ids.has(id)
  })
  // A snapshot's position counts every event; recount it among the kept ones
  const position = (after: number) => events.slice(0, after).filter((event) => own.includes(event)).length
  return [
    {
      kind: "meta",
      scenario: scenario.name,
      description: scenario.description,
      version: (await service.get("/api/info")).version as string,
      root,
      sessions: [...ids],
    },
    ...own.map((event): Line => ({ kind: "event", event })),
    ...snapshots.map(
      (snapshot): Line => ({ kind: "snapshot", snapshot: { ...snapshot, after: position(snapshot.after) } }),
    ),
  ]
}

async function everything(service: Service, session: string, directory: string) {
  const limit = 200
  const page = await service.get(`/api/session/${session}/message?order=asc&limit=${limit}`, directory)
  if (page.data.length >= limit) throw new Error(`${session} has ${page.data.length} messages: page them`)
  return page.data as unknown[]
}
