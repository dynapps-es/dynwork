export * as RoutinesLocal from "./backend"

import { randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { Cron, DateTime, Result } from "effect"
import { ClientError, type OpenCodeClient, type SessionInfo } from "@opencode/client/promise"
import type { Persisted } from "@opencode/plugin/gui/main"
import { fail, type Backend } from "../backend"
import {
  isFailure,
  type Capabilities,
  type Change,
  type Choice,
  type Definition,
  type Failure,
  type Field,
  type Routine,
  type Run,
  type RunState,
} from "../contract"
import { RoutinesValidate } from "../validate"
import type { Saved, SavedRoutine, SavedRun } from "./store"

export { Saved, initial } from "./store"

// The routines of this computer, run by DynWork's own service (docs/04-ui.md §A.3, model (i)). Each routine gets an
// anchor session, a top-level conversation in the sidebar, the first time it runs; each run is a child session of the
// anchor, created and prompted through the service's public HTTP API from the main process. Definitions and the run
// history live in the plugin's storage; a run's live state is read from its session and its events.
//
// Not here yet (phase F4 of the plan): the clock that fires a schedule, catch-up of missed runs, resuming a run cut by a
// service restart, and closing the permissions of an unattended run. A run started here is "Run now": someone is there.

export const id = "local"

const PAGE = 20
// How long to wait before following the service's events again after the stream ended.
const RETRY = 2_000
const EVENTS = [
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
] as const

/** The local routine's own fields, as the form draws them. */
export const fields: readonly Field[] = [
  { key: "folder", section: "workspace", label: "Project folder", kind: "folder", help: "Where the routine works." },
  {
    key: "permissions",
    section: "permissions",
    label: "Permissions",
    kind: "select",
    choices: [
      { value: "read-only", label: "Read only" },
      { value: "edit", label: "Edit files" },
      { value: "edit-run", label: "Edit files and run commands" },
    ],
    default: "read-only",
  },
  { key: "ask", section: "permissions", label: "Ask me when something else is needed", kind: "toggle", default: false },
  { key: "timeLimit", section: "limits", label: "Time limit (minutes)", kind: "number", min: 1, max: 240, default: 30 },
  {
    key: "catchUp",
    section: "limits",
    label: "Catch up missed runs within (hours)",
    kind: "number",
    min: 0,
    max: 12,
    default: 6,
  },
  {
    key: "notify",
    section: "notifications",
    label: "Notify me",
    kind: "select",
    choices: [
      { value: "failures", label: "Only when something fails" },
      { value: "every", label: "Every run" },
      { value: "never", label: "Never" },
    ],
    default: "failures",
  },
]

/** What a local routine may do, by its `permissions` field: the tool actions its runs are denied. */
const denied: Record<string, readonly string[]> = { "read-only": ["edit", "shell"], edit: ["shell"], "edit-run": [] }

export interface Options {
  /** The backend's id; `local` by default. */
  id?: string
  /** This device's name, the routines' badge. */
  label: string
  store: Persisted<Saved, Saved>
  /** DynWork's service, while it is running. */
  client: () => OpenCodeClient | undefined
  /** The service's `ServerRef.id` in a window (`sidecar`), for the runs' conversations. */
  server: string
  /** Where a routine without a folder works (`~/Dynwork/Routines`). */
  home: string
  now: () => number
  /** A run ended `failed`, and its routine does not say "never" to notifications. */
  failed?: (run: Run, routine: Definition) => void
  /** Milliseconds before following the service's events again. */
  retry?: number
}

export interface Local extends Backend {
  /** The runs that have not ended, as last read. */
  running(): number
  /** Stops following the service. */
  dispose(): void
}

export function make(options: Options): Local {
  const backend = options.id ?? id
  const watchers = new Set<(change: Change) => void>()
  const follower: { controller?: AbortController; timer?: ReturnType<typeof setTimeout>; disposed: boolean } = {
    disposed: false,
  }
  // One anchor at a time per routine: two quick "Run now" share the one being made.
  const anchoring = new Map<string, Promise<string | Failure>>()

  const saved = () => options.store.value
  const routineOf = (routine: string) => saved().routines.find((stored) => stored.id === routine)
  const recordOf = (run: string) => saved().runs.find((stored) => stored.id === run)
  const inflight = () => saved().runs.filter((record) => !ended(record.state))
  const emit = (change: Change) => [...watchers].forEach((watcher) => watcher(change))
  const ref = (routine: string) => ({ backend, id: routine })
  const missing = (what: string, key: string) => fail("not-found", `No ${what} ${key}.`)
  const offline = () => fail("unreachable", "DynWork's service is not running.")

  const toRun = (record: SavedRun): Run => ({
    ref: { backend, id: record.id },
    routine: ref(record.routine),
    state: record.state,
    ...(record.reason ? { reason: record.reason } : {}),
    trigger: record.trigger,
    started: record.started,
    ...(record.finished === undefined ? {} : { finished: record.finished }),
    title: record.title,
    unread: ended(record.state) && !record.viewed,
    conversation: { kind: "session", server: options.server, session: record.id, anchor: record.anchor },
  })

  const toRoutine = (stored: SavedRoutine): Routine => {
    const own = saved().runs.filter((record) => record.routine === stored.id)
    const next = upcoming(stored.definition, options.now())
    return {
      ref: ref(stored.id),
      definition: stored.definition,
      state: stored.definition.enabled ? "active" : "paused",
      ...(next === undefined ? {} : { next }),
      ...(own[0] ? { last: toRun(own[0]) } : {}),
      unread: own.filter((record) => ended(record.state) && !record.viewed).length,
      owner: { label: options.label, online: true, here: true },
      conversation: stored.anchor
        ? { kind: "session", server: options.server, session: stored.anchor, anchor: stored.anchor }
        : { kind: "none" },
      updated: stored.updated,
    }
  }

  const capabilities = async (): Promise<Capabilities> => ({
    backend,
    kind: "local",
    label: options.label,
    status: options.client() ? "ready" : "unreachable",
    ...(options.client() ? {} : { detail: "DynWork's service is not running." }),
    instructions: ["prompt", "skill"],
    agent: "optional",
    model: "choose",
    schedule: { window: false, minimum: 5 },
    actions: { edit: "in-place", reply: "in-place", cancel: true },
    fields,
  })

  const saveRoutine = (routine: string, patch: Partial<SavedRoutine>) =>
    options.store.update((draft) => {
      const index = draft.routines.findIndex((stored) => stored.id === routine)
      if (index >= 0) draft.routines[index] = { ...draft.routines[index]!, ...patch }
    })

  const saveRun = (record: SavedRun) =>
    options.store.update((draft) => {
      const index = draft.runs.findIndex((stored) => stored.id === record.id)
      if (index >= 0) draft.runs[index] = record
    })

  // Reads a run that has not ended from its session, and records and reports what changed. A run that ended stays as
  // it is: its session may go on with a reply, which is the conversation's business, not the run's.
  async function refresh(record: SavedRun): Promise<SavedRun> {
    const client = options.client()
    if (ended(record.state) || !client) return record
    const info = await client.session.get({ sessionID: record.id }).then(
      (session) => session,
      (error: unknown) => (gone(error) ? null : undefined),
    )
    // Another read, or a cancel, may have ended it meanwhile: it is reported once.
    const current = recordOf(record.id)
    if (!current || ended(current.state) || info === undefined) return current ?? record
    const next = derive(current, info, options.now())
    if (next.state === current.state) return current
    saveRun(next)
    emit({ routine: ref(next.routine), run: toRun(next) })
    if (ended(next.state)) finished(next)
    return next
  }

  // A run ended: the anchor notes it (it rises in the sidebar), and a failure is told to the user.
  function finished(record: SavedRun) {
    const stored = routineOf(record.routine)
    void options
      .client()
      ?.session.update({
        sessionID: record.anchor,
        metadata: {
          dynwork: {
            backend,
            routine: record.routine,
            role: "anchor",
            last: { run: record.id, state: record.state, at: record.finished ?? options.now() },
          },
        },
      })
      .catch(() => undefined)
    if (record.state === "failed" && stored && stored.definition.options.notify !== "never")
      options.failed?.(toRun(record), stored.definition)
  }

  // The routine's anchor session: the one it has, or a new one when it has none or the user deleted it.
  function anchor(stored: SavedRoutine, client: OpenCodeClient) {
    const pending = anchoring.get(stored.id)
    if (pending) return pending
    const made = ensure(stored, client).finally(() => anchoring.delete(stored.id))
    anchoring.set(stored.id, made)
    return made
  }

  async function ensure(stored: SavedRoutine, client: OpenCodeClient): Promise<string | Failure> {
    if (stored.anchor) {
      const found = await client.session.get({ sessionID: stored.anchor }).then(
        () => true,
        (error: unknown) => (gone(error) ? false : failure(error)),
      )
      if (found === true) return stored.anchor
      if (isFailure(found)) return found
    }
    const directory = folderOf(stored.definition, options.home)
    if (directory === options.home) await mkdir(directory, { recursive: true }).catch(() => undefined)
    const created = await call(() =>
      client.session.create({
        title: stored.definition.name,
        location: { directory },
        ...(stored.definition.agent ? { agent: stored.definition.agent } : {}),
        metadata: { dynwork: { backend, routine: stored.id, role: "anchor" } },
      }),
    )
    if (isFailure(created)) return created
    saveRoutine(stored.id, { anchor: created.id, directory })
    return created.id
  }

  // Follows the service's execution events while a run is going, and reads each run they name. After every
  // (re)connection it reads all the runs that are going, so an event missed while away is not lost. It runs whether or
  // not a window watches: a failure is told to the user either way.
  function follow() {
    if (follower.controller || follower.timer || follower.disposed) return
    if (inflight().length === 0) return
    const controller = new AbortController()
    follower.controller = controller
    void listen(controller.signal)
      .catch(() => undefined)
      .then(() => {
        if (follower.controller !== controller) return
        follower.controller = undefined
        if (controller.signal.aborted || follower.disposed) return
        follower.timer = setTimeout(() => {
          follower.timer = undefined
          follow()
        }, options.retry ?? RETRY)
      })
  }

  async function listen(signal: AbortSignal) {
    const client = options.client()
    if (!client) return
    for await (const event of client.event.subscribe({ types: EVENTS, signal })) {
      if (event.type === "server.connected") await Promise.all(inflight().map(refresh))
      if (event.type !== "server.connected") {
        const record = recordOf(event.data.sessionID)
        if (record) await refresh(record)
      }
      if (inflight().length === 0) return
    }
  }

  function stop() {
    follower.controller?.abort()
    follower.controller = undefined
    clearTimeout(follower.timer)
    follower.timer = undefined
  }

  const local: Local = {
    id: backend,
    capabilities,
    running: () => inflight().length,
    dispose: () => {
      follower.disposed = true
      stop()
    },
    options: async (lookup, query) => {
      const client = options.client()
      if (!client) return offline()
      const choices = await call(() => lookupOf(client, lookup))
      if (choices === undefined) return missing("lookup", lookup)
      if (isFailure(choices)) return choices
      const needle = query?.trim().toLowerCase() ?? ""
      return choices.filter((choice) => `${choice.value} ${choice.label}`.toLowerCase().includes(needle))
    },
    validate: async (definition) => RoutinesValidate.check(await capabilities(), definition),
    list: async () => saved().routines.map(toRoutine),
    get: async (routine) => {
      const stored = routineOf(routine)
      return stored ? toRoutine(stored) : missing("routine", routine)
    },
    create: async (definition) => {
      const invalid = RoutinesValidate.check(await capabilities(), definition)
      if (invalid) return invalid
      const stored: SavedRoutine = { id: `rtn_${randomUUID()}`, definition, updated: options.now() }
      options.store.update((draft) => void draft.routines.push(stored))
      emit({ routine: ref(stored.id) })
      return toRoutine(stored)
    },
    update: async (routine, definition) => {
      const stored = routineOf(routine)
      if (!stored) return missing("routine", routine)
      const invalid = RoutinesValidate.check(await capabilities(), definition)
      if (invalid) return invalid
      saveRoutine(routine, { definition, updated: options.now() })
      await follows(stored, definition)
      emit({ routine: ref(routine) })
      return toRoutine(routineOf(routine) ?? stored)
    },
    // The anchor and its runs stay in the service: the user may still read them, and the sidebar keeps the anchor.
    remove: async (routine) => {
      if (!routineOf(routine)) return missing("routine", routine)
      options.store.update((draft) => {
        draft.routines = draft.routines.filter((stored) => stored.id !== routine)
        draft.runs = draft.runs.filter((record) => record.routine !== routine)
      })
      emit({ routine: ref(routine) })
      return undefined
    },
    pause: async (routine) => switchTo(routine, false),
    resume: async (routine) => switchTo(routine, true),
    start: async (routine) => {
      const stored = routineOf(routine)
      if (!stored) return missing("routine", routine)
      const client = options.client()
      if (!client) return offline()
      const parent = await anchor(stored, client)
      if (isFailure(parent)) return parent
      const at = options.now()
      const definition = stored.definition
      const title = `${definition.name} · ${stamp(at, definition.schedule?.timezone)}`
      // Every run carries its own permissions and metadata, or it would inherit the anchor's (docs/04-ui.md §A.3.1).
      const child = await call(() =>
        client.session.create({
          parentID: parent,
          title,
          ...(definition.agent ? { agent: definition.agent } : {}),
          ...modelOf(definition),
          permissions: (denied[String(definition.options.permissions ?? "read-only")] ?? denied["read-only"]!).map(
            (action) => ({ action, resource: "*", effect: "deny" as const }),
          ),
          metadata: { dynwork: { backend, routine, role: "run", trigger: "manual" } },
        }),
      )
      if (isFailure(child)) return child
      const record: SavedRun = {
        id: child.id,
        routine,
        anchor: parent,
        trigger: "manual",
        title,
        started: at,
        state: "queued",
        viewed: false,
      }
      options.store.update((draft) => void draft.runs.unshift(record))
      const prompted = await call(() => client.session.prompt({ sessionID: child.id, ...promptOf(definition) }))
      if (isFailure(prompted)) {
        const failed: SavedRun = { ...record, state: "failed", reason: "prompt", finished: options.now() }
        saveRun(failed)
        emit({ routine: ref(routine), run: toRun(failed) })
        return prompted
      }
      follow()
      const read = await refresh(record)
      const run = toRun(read)
      if (read === record) emit({ routine: ref(routine), run })
      return run
    },
    cancel: async (run) => {
      const record = recordOf(run)
      if (!record) return missing("run", run)
      const current = await refresh(record)
      if (ended(current.state)) return fail("conflict", "The run has already finished.")
      const client = options.client()
      if (!client) return offline()
      const interrupted = await call(() => client.session.interrupt({ sessionID: run }))
      if (isFailure(interrupted)) return interrupted
      const cancelled: SavedRun = {
        ...current,
        state: "cancelled",
        reason: "user",
        finished: options.now(),
        viewed: true,
      }
      saveRun(cancelled)
      emit({ routine: ref(cancelled.routine), run: toRun(cancelled) })
      return undefined
    },
    runs: async (input) => {
      if (input.routine && !routineOf(input.routine)) return missing("routine", input.routine)
      const own = saved().runs.filter((record) => !input.routine || record.routine === input.routine)
      const start = input.cursor === undefined ? 0 : Number(input.cursor)
      if (!Number.isInteger(start) || start < 0) return fail("invalid", "That cursor is not one of this backend's.")
      const end = start + PAGE
      const items = await Promise.all(own.slice(start, end).map(refresh))
      return { items: items.map(toRun), ...(end < own.length ? { next: String(end) } : {}) }
    },
    transcript: async (run) =>
      recordOf(run) ? fail("unsupported", "This run is read in its session.") : missing("run", run),
    // Upstream marks only a root session viewed, never a child: the run's own session is marked here.
    viewed: async (run) => {
      const record = recordOf(run)
      if (!record || !ended(record.state) || record.viewed) return
      saveRun({ ...record, viewed: true })
      emit({ routine: ref(record.routine), run: toRun({ ...record, viewed: true }) })
      const client = options.client()
      const idle = await client?.session.get({ sessionID: run }).then(
        (session) => session.time.idle,
        () => undefined,
      )
      if (client && idle !== undefined) await client.session.view({ sessionID: run, idle }).catch(() => undefined)
    },
    watch: (changed) => {
      watchers.add(changed)
      return () => void watchers.delete(changed)
    },
  }

  async function switchTo(routine: string, enabled: boolean) {
    const stored = routineOf(routine)
    if (!stored) return missing("routine", routine)
    saveRoutine(routine, { definition: { ...stored.definition, enabled }, updated: options.now() })
    emit({ routine: ref(routine) })
    return undefined
  }

  // The anchor follows its routine: a new name retitles it, a new folder moves it (runs after that start there).
  async function follows(stored: SavedRoutine, definition: Definition) {
    const client = options.client()
    if (!stored.anchor || !client) return
    if (definition.name !== stored.definition.name)
      await client.session.update({ sessionID: stored.anchor, title: definition.name }).catch(() => undefined)
    const directory = folderOf(definition, options.home)
    if (directory === stored.directory) return
    const moved = await client.session
      .move({ sessionID: stored.anchor, directory })
      .then(() => true)
      .catch(() => false)
    if (moved) saveRoutine(stored.id, { directory })
  }

  // A run left going when the app last closed is read again as soon as the service answers.
  follow()
  return local
}

function ended(state: RunState) {
  return state !== "queued" && state !== "running"
}

// A run's state from its session: queued until its execution starts, running until it ends with an outcome.
function derive(record: SavedRun, info: SessionInfo | null, now: number): SavedRun {
  if (info === null) return { ...record, state: "failed", reason: "deleted", finished: now }
  const busy = info.time.busy
  const idle = info.time.idle
  if (busy === undefined) return { ...record, state: "queued" }
  if (idle === undefined || idle < busy || !info.outcome) return { ...record, state: "running" }
  if (info.outcome === "succeeded") return { ...record, state: "ok", finished: idle }
  if (info.outcome === "failed") return { ...record, state: "failed", reason: "error", finished: idle }
  return { ...record, state: "cancelled", reason: "user", finished: idle }
}

function folderOf(definition: Definition, home: string) {
  const folder = definition.options.folder
  return typeof folder === "string" && folder.trim() !== "" ? folder : home
}

// The model is chosen as `<provider>/<model>`, the value `options("models")` answers.
function modelOf(definition: Definition) {
  const slash = definition.model?.indexOf("/") ?? -1
  if (!definition.model || slash <= 0) return {}
  return { model: { providerID: definition.model.slice(0, slash), id: definition.model.slice(slash + 1) } }
}

function promptOf(definition: Definition) {
  const instructions = definition.instructions
  if (instructions.kind === "skill")
    return { text: instructions.text ?? `Run the ${instructions.skill} skill.`, skills: [{ id: instructions.skill }] }
  if (instructions.kind === "agent") return { text: instructions.input }
  return { text: instructions.text }
}

// The choices of the shared selects; undefined for a lookup this backend does not serve.
async function lookupOf(client: OpenCodeClient, lookup: string): Promise<Choice[] | undefined> {
  if (lookup === "agents") {
    const agents = await client.agent.list()
    return agents.data
      .filter((agent) => agent.hidden !== true && agent.mode !== "subagent")
      .map((agent) => ({ value: agent.id, label: agent.name }))
  }
  if (lookup === "models") {
    const models = await client.model.list()
    return models.data.map((model) => ({ value: `${model.providerID}/${model.id}`, label: model.name }))
  }
  if (lookup === "skills") {
    const skills = await client.skill.list()
    return skills.data.map((skill) => ({ value: skill.id, label: skill.name }))
  }
  return undefined
}

// When a scheduled, enabled routine would run next. Nothing fires it yet (F4): the view shows it as planned.
function upcoming(definition: Definition, now: number) {
  if (!definition.schedule || !definition.enabled) return undefined
  const zone = DateTime.zoneMakeNamed(definition.schedule.timezone)
  if (zone._tag === "None") return undefined
  const parsed = Cron.parse(definition.schedule.cron, zone.value)
  if (Result.isFailure(parsed)) return undefined
  return Cron.next(parsed.success, new Date(now)).getTime()
}

// "Mon 16 Nov, 09:00" in the system's language: a child session gets no automatic title.
function stamp(at: number, timeZone?: string) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  }).format(at)
}

function gone(error: unknown) {
  return error instanceof Error && error.name === "SessionNotFoundError"
}

// A request to the service, with what it throws as a failure: its message may carry what no window should see.
function call<A>(request: () => Promise<A>): Promise<A | Failure> {
  return request().catch((error: unknown) => failure(error))
}

function failure(error: unknown): Failure {
  if (error instanceof ClientError && error.reason === "Transport")
    return fail("unreachable", "DynWork's service did not answer.")
  if (gone(error)) return fail("not-found", "The routine's session is gone.")
  return fail("failed", "DynWork's service refused the request.")
}
