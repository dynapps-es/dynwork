import { RoutinesSync } from "../../src/routines/local/sync"

// A fake Governance over real HTTP with the `dynwork-routines` routes as its README states them: the change feed with an
// opaque cursor, revisions with `If-Match`, tombstones, runs reported only by the owner device, and routines made for
// the user directly in its database, unclaimed (owner `""`, or null), that a PUT claims (`COALESCE`). One user.
type Row = {
  id: string
  revision: number
  owner_device: string | null
  owner_name: string | null
  definition: unknown
  deleted: boolean
  updated_at: string
  seq: number
}

export function fakeGovernance(now: () => number = Date.now) {
  const token = "governance-jwt"
  const state = {
    routines: new Map<string, Row>(),
    runs: new Map<string, Record<string, unknown>>(),
    seq: 0,
    /** Answers 503 to everything, as a Governance that is down. */
    down: false,
    /** Applies the next write, then answers 503: an answer lost on the way. */
    lose: false,
    /** Answers 503 to every write and still serves the feed. */
    readOnly: false,
    /** Every request, in order: `<METHOD> <route> <If-Match or ->`. */
    requests: [] as string[],
  }
  const view = (row: Row) => {
    const { seq: _, ...rest } = row
    return { ...rest, deleted_at: row.deleted ? row.updated_at : null }
  }
  const save = (row: Omit<Row, "seq" | "updated_at">) => {
    const next = { ...row, seq: ++state.seq, updated_at: new Date(now()).toISOString() }
    state.routines.set(row.id, next)
    return next
  }
  const json = (body: unknown, status = 200) => Response.json(body, { status })
  const conflict = (row: Row) => json({ error: "revision_conflict", message: "conflict", current: view(row) }, 409)

  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      const route = url.pathname.slice(RoutinesSync.PATH.length)
      if (state.down || (state.readOnly && request.method !== "GET")) return new Response("down", { status: 503 })
      if (request.headers.get("authorization") !== `Bearer ${token}`) return json({ error: "unauthorized" }, 401)
      const match = request.headers.get("if-match")?.match(/^"?(\d+)"?$/)
      const expected = match ? Number(match[1]) : undefined
      state.requests.push(`${request.method} ${route.split("?")[0]} ${expected ?? "-"}`)
      const answer = await handle(request, url, route, expected)
      if (!state.lose || request.method === "GET") return answer
      state.lose = false
      return new Response("lost", { status: 503 })
    },
  })

  async function handle(request: Request, url: URL, route: string, expected?: number) {
    if (request.method === "GET" && route === "/changes") {
      const since = Number(url.searchParams.get("since") ?? 0)
      const limit = Number(url.searchParams.get("limit") ?? 200)
      if (!Number.isInteger(since)) return json({ error: "bad_request" }, 400)
      const rows = [...state.routines.values()].filter((row) => row.seq > since).toSorted((a, b) => a.seq - b.seq)
      const page = rows.slice(0, limit)
      return json({ routines: page.map(view), cursor: String(page.at(-1)?.seq ?? since), more: rows.length > limit })
    }
    const [, kind, id = ""] = route.split("/")
    const existing = state.routines.get(id)
    if (kind === "routines" && request.method === "PUT") {
      const body = (await request.json()) as { owner_device?: string; owner_name?: string; definition: unknown }
      if (expected === undefined) {
        if (existing) return conflict(existing)
        if (!body.owner_device) return json({ error: "bad_request" }, 400)
        return json(
          view(
            save({
              id,
              revision: 1,
              owner_device: body.owner_device,
              owner_name: body.owner_name ?? "",
              definition: body.definition,
              deleted: false,
            }),
          ),
        )
      }
      if (!existing) return json({ error: "not_found" }, 404)
      if (existing.deleted || existing.revision !== expected) return conflict(existing)
      return json(
        view(
          save({
            ...existing,
            revision: existing.revision + 1,
            owner_device: body.owner_device ?? existing.owner_device,
            owner_name: body.owner_name ?? existing.owner_name,
            definition: body.definition,
          }),
        ),
      )
    }
    if (kind === "routines" && request.method === "DELETE") {
      if (expected === undefined) return json({ error: "bad_request" }, 400)
      if (!existing) return json({ error: "not_found" }, 404)
      if (existing.deleted || existing.revision !== expected) return conflict(existing)
      return json(view(save({ ...existing, revision: existing.revision + 1, definition: null, deleted: true })))
    }
    if (kind === "runs" && request.method === "PUT") {
      const body = (await request.json()) as Record<string, unknown>
      const routine = state.routines.get(String(body.routine_id))
      if (!routine || routine.deleted) return json({ error: "not_found" }, 404)
      if (body.device !== routine.owner_device) return json({ error: "not_owner_device" }, 403)
      state.runs.set(id, body)
      return json({ id, ...body })
    }
    return json({ error: "not_found" }, 404)
  }

  return {
    url: `http://127.0.0.1:${server.port}`,
    token,
    state,
    /** A change made outside this test's computers, such as the "My routines" page: no `If-Match`. */
    write: (id: string, change: (definition: Record<string, unknown>) => Record<string, unknown>) => {
      const row = state.routines.get(id)!
      save({ ...row, revision: row.revision + 1, definition: change(row.definition as Record<string, unknown>) })
    },
    /** A routine made for this user straight in Governance's table: revision 1, no owner (`""` today, or null). */
    assign: (id: string, definition: unknown, owner: "" | null = "") =>
      void save({ id, revision: 1, owner_device: owner, owner_name: owner, definition, deleted: false }),
    remove: (id: string) => {
      const row = state.routines.get(id)!
      save({ ...row, revision: row.revision + 1, definition: null, deleted: true })
    },
    stop: () => server.stop(true),
  }
}

export type FakeGovernance = ReturnType<typeof fakeGovernance>
