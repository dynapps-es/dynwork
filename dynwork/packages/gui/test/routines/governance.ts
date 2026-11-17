import { randomUUID } from "node:crypto"
import type { Definition, Template, TemplateLink } from "../../src/routines/contract"
import { RoutinesSync } from "../../src/routines/local/sync"
import { RoutinesTemplates } from "../../src/routines/templates"

// A fake Governance over real HTTP with the `dynwork-routines` routes as its README states them: the change feed with an
// opaque cursor, revisions with `If-Match`, tombstones, runs reported only by the owner device, and routines made for
// the user directly in its database, unclaimed (owner `""`, or null), that a PUT claims (`COALESCE`). One user.
// Templates as the plan's `docs/contract.md` §2-§3 state them: `GET /templates` with an `ETag` and `304`, a link per
// template the user has a live routine of, and `409 already_activated` for a second live routine of one template.
// Every revision it served or published is kept for `GET /templates/{id}/revisions/{revision}`; a `PUT` of a linked
// routine whose locked fields differ from its named revision's is `409 template_locked` with the row as it is
// (`current`); a mandatory template the user has no live routine of gets one, unclaimed and in no time zone, when
// `GET /templates` is read (§4); `retire` and `revoke` do what §8 and §6 say the server does.
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
    /** The published templates the user sees, as `GET /templates` serves them. */
    templates: [] as unknown[],
    /** What each `GET /templates` answered: its status and the `If-None-Match` it came with. */
    served: [] as Array<{ status: number; etag?: string }>,
    /** Every revision of a template served or published, by `<id>@<revision>`. */
    history: new Map<string, Template>(),
    /** Runs once before the next write is handled, while its request waits: what happens meanwhile on the computer. */
    meanwhile: undefined as undefined | (() => Promise<void>),
    /** Where a template stands for the user when it is not `published`: closed, retired, no access. */
    links: new Map<string, Omit<TemplateLink, "id">>(),
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
      const meanwhile = state.meanwhile
      if (meanwhile && request.method !== "GET") {
        state.meanwhile = undefined
        await meanwhile()
      }
      const answer = await handle(request, url, route, expected)
      if (!state.lose || request.method === "GET") return answer
      state.lose = false
      return new Response("lost", { status: 503 })
    },
  })

  // The template a routine's definition links to, if any.
  const linkOf = (definition: unknown) => {
    if (typeof definition !== "object" || definition === null || !("template" in definition)) return undefined
    const template = definition.template
    if (typeof template !== "object" || template === null || !("id" in template)) return undefined
    return String(template.id)
  }

  // A revision never changes: the first one kept under its number stays.
  const record = (template: Template) => {
    const key = `${template.id}@${template.revision}`
    if (!state.history.has(key)) state.history.set(key, template)
  }
  const live = () => [...state.routines.values()].filter((row) => !row.deleted)
  const linkedTo = (template: string) => live().filter((row) => linkOf(row.definition) === template)

  function templates(request: Request) {
    const offered = state.templates as Template[]
    offered.forEach(record)
    offered
      .filter((template) => template.mandatory && linkedTo(template.id).length === 0)
      .forEach((template) => {
        const definition = RoutinesTemplates.defaults(template, "")
        save({
          id: randomUUID(),
          revision: 1,
          owner_device: "",
          owner_name: "",
          definition: {
            ...definition,
            ...(definition.schedule ? { schedule: { cron: definition.schedule.cron } } : {}),
          },
          deleted: false,
        })
      })
    const linked = [...new Set(live().flatMap((row) => linkOf(row.definition) ?? []))]
    const body = {
      templates: offered,
      links: linked.map((id) => ({ id, ...(state.links.get(id) ?? { state: "published", retire: null }) })),
    }
    const etag = `"${Bun.hash(JSON.stringify(body)).toString(16)}"`
    const asked = request.headers.get("if-none-match") ?? undefined
    const status = asked === etag ? 304 : 200
    state.served.push({ status, ...(asked === undefined ? {} : { etag: asked }) })
    if (status === 304) return new Response(null, { status: 304, headers: { etag } })
    return Response.json(body, { headers: { etag } })
  }

  // A linked definition whose locked fields are not those of the revision it names (§2), when that revision is known.
  function lockedOff(definition: Definition) {
    const link = definition.template
    const named = link && state.history.get(`${link.id}@${link.revision}`)
    if (!named) return false
    const own = RoutinesTemplates.defaults(named, definition.schedule?.timezone ?? "")
    return RoutinesTemplates.violates(named, own, definition).length > 0
  }

  async function handle(request: Request, url: URL, route: string, expected?: number) {
    if (request.method === "GET" && route === "/templates") return templates(request)
    const revision = route.match(/^\/templates\/([^/]+)\/revisions\/(\d+)$/)
    if (request.method === "GET" && revision) {
      const found = state.history.get(`${decodeURIComponent(revision[1] ?? "")}@${revision[2]}`)
      return found ? json(found) : json({ error: "not_found" }, 404)
    }
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
        const link = linkOf(body.definition)
        const twin = [...state.routines.values()].find((row) => !row.deleted && link && linkOf(row.definition) === link)
        if (twin) return json({ error: "already_activated", routine: view(twin) }, 409)
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
      if (lockedOff(body.definition as Definition))
        return json({ error: "template_locked", message: "locked", current: view(existing) }, 409)
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
    /** An admin publishes a revision: it replaces the template's previous one in `GET /templates`. */
    publish: (template: Template) => {
      record(template)
      state.templates = [...(state.templates as Template[]).filter((item) => item.id !== template.id), template]
    },
    /**
     * An admin retires a template (§8): it leaves `GET /templates`, its link says `retired`, and the server pauses
     * (`pause`) or tombstones (`remove`) every live routine of it.
     */
    retire: (id: string, retire: "unlink" | "pause" | "remove") => {
      state.templates = (state.templates as Template[]).filter((item) => item.id !== id)
      state.links.set(id, { state: "retired", retire })
      linkedTo(id).forEach((row) => {
        if (retire === "pause")
          save({ ...row, revision: row.revision + 1, definition: { ...(row.definition as object), enabled: false } })
        if (retire === "remove") save({ ...row, revision: row.revision + 1, definition: null, deleted: true })
      })
    },
    /** An admin closes a template: no new activations, the routines keep it and its new revisions (§3). */
    close: (id: string) => void state.links.set(id, { state: "closed", retire: null }),
    /** The user loses every anchor plugin of a template (§6): it leaves `GET /templates`, its link says `no_access`. */
    revoke: (id: string) => {
      state.templates = (state.templates as Template[]).filter((item) => item.id !== id)
      state.links.set(id, { state: "no_access", retire: null })
    },
    /** The user sees the template again. */
    grant: (template: Template) => {
      state.links.delete(template.id)
      record(template)
      state.templates = [...(state.templates as Template[]).filter((item) => item.id !== template.id), template]
    },
    stop: () => server.stop(true),
  }
}

export type FakeGovernance = ReturnType<typeof fakeGovernance>
