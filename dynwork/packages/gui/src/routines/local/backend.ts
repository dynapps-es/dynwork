export * as RoutinesLocal from "./backend"

import { randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
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
import { RoutinesClock } from "./clock"
import { enqueue, type Saved, type SavedRoutine, type SavedRun } from "./store"

export { Saved, initial } from "./store"

// The routines of this computer, run by DynWork's own service (docs/04-ui.md §A.3, model (i)). Each routine gets an
// anchor session, a top-level conversation in the sidebar, the first time it runs; each run is a child session of the
// anchor, created and prompted through the service's public HTTP API from the main process. Definitions and the run
// history live in the plugin's storage; a run's live state is read from its session and its events.
//
// The clock that fires a schedule and recovers missed runs is `./clock.ts`: it decides, and this backend records what it
// took (`take`) and starts the run (`fire`). A run asks for permissions as in any conversation ("Ask me"), or has them
// all granted ("Don't ask"); either way it is told to the user (`notify`). A run still going when its "Time limit"
// passes is interrupted and recorded as failed (`timeout`): one timer per run, and every read of a run checks it too, so
// a run left going by a closed app is stopped at once when it opens again.
//
// Definitions are shared with the user's other computers through Governance (`./sync.ts`): every change made here goes
// to the store and to its outbox in one write, and a routine runs only on its owner computer (`here`).

export const id = "local"

const PAGE = 20
// A routine's "Time limit (minutes)" when it does not say (the field's default).
const LIMIT = 30
// How long to wait before following the service's events again after the stream ended.
const RETRY = 2_000
const EVENTS = [
  "permission.asked",
  "permission.replied",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
] as const

/** The local routine's own fields, as the form draws them. */
export const fields: readonly Field[] = [
  { key: "folder", section: "workspace", label: "Project folder", kind: "folder", help: "Where the task works." },
  {
    key: "permissions",
    section: "permissions",
    label: "Permissions",
    kind: "select",
    choices: [
      { value: "ask", label: "Ask me" },
      {
        value: "bypass",
        label: "Don't ask",
        warning: "The task may edit files and run commands without asking you.",
      },
    ],
    default: "ask",
  },
  {
    key: "connectors",
    section: "connectors",
    label: "Connectors",
    help: "The task's runs can use only the checked connectors.",
    kind: "multiselect",
    lookup: "connectors",
    default: "all",
  },
  { key: "timeLimit", section: "limits", label: "Time limit (minutes)", kind: "number", min: 1, max: 240, default: 30 },
  {
    key: "recover",
    section: "limits",
    label: "Recover missed runs",
    help: "Runs missed while Dynwork was closed or asleep. Several missed runs start one run, never one each.",
    kind: "select",
    choices: [
      { value: "recent", label: "If recent" },
      { value: "none", label: "Don't recover" },
    ],
    default: "recent",
  },
  {
    key: "catchUp",
    section: "limits",
    label: "Within (hours)",
    kind: "number",
    min: 1,
    max: 48,
    default: RoutinesClock.HOURS,
    when: { key: "recover", equals: "recent" },
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

// A session's rules come after its agent's and the last matching rule wins (`packages/core/src/permission.ts`).
// "Don't ask": every request is allowed except a question, which would open a form that waits for a person.
const bypass = () => [
  { action: "*", resource: "*", effect: "allow" as const },
  { action: "question", resource: "*", effect: "deny" as const },
]

// "Ask me": OpenCode's agents allow almost everything by default, so asking takes rules of its own. As in Claude Code,
// reading and searching go ahead and everything else (edits, the shell, other folders, connectors) waits for the user.
// Subagents inherit these rules (`packages/core/src/session.ts`).
const ask = () => [
  { action: "*", resource: "*", effect: "ask" as const },
  ...["read", "glob", "grep", "webfetch", "websearch", "skill", "todowrite", "question", "subagent"].map((action) => ({
    action,
    resource: "*",
    effect: "allow" as const,
  })),
  { action: "read", resource: "*.env", effect: "ask" as const },
  { action: "read", resource: "*.env.*", effect: "ask" as const },
  { action: "read", resource: "*.env.example", effect: "allow" as const },
]

// A connector's tools are permission actions named `<namespace>_<tool>`, where the namespace is the server's name with
// everything but letters, digits, `_` and `-` replaced by `_` (`normalizedName` in `packages/core/src/tool/runtime.ts`,
// `McpTool.namespace` in `packages/core/src/tool/mcp.ts`): gui may not import core, so it is mirrored here.
// Denying `<namespace>_*` hides a server whose tools are all denied from the model and refuses every call.
const namespace = (server: string) => server.replace(/[^a-zA-Z0-9_-]/g, "_")

/** The rules that keep a run off the connectors it may not use: one deny per server the routine's list leaves out. */
export const denyConnectors = (servers: readonly string[], allowed: readonly string[]) =>
  servers
    .filter((server) => !allowed.includes(server))
    .map((server) => ({ action: `${namespace(server)}_*`, resource: "*", effect: "deny" as const }))

/** What the user is told about a run: it finished, it failed, or it waits for a permission. */
export interface Notice {
  kind: "finished" | "failed" | "waiting"
  run: Run
  routine: Definition
}

// The routine's "Notify me" decides, except that a run waiting for a permission is always told: it will not go on alone.
function wanted(kind: Notice["kind"], mode: unknown) {
  if (kind === "waiting") return true
  if (mode === "never") return false
  return kind === "failed" || mode === "every"
}

/** A computer as the sync names it: its relay peer id (32 hex digits) and its name. */
export interface Device {
  id: string
  name: string
}

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
  /** Arms the timer of a run's time limit; `set` answers what cancels it. Tests pass their own. */
  timers?: RoutinesClock.Timers
  /** Something the routine's "Notify me" says to tell the user (`Notice`). */
  notify?: (notice: Notice) => void
  /** Whether a run is going: called when the first one starts and when the last one ends. */
  busy?: (going: boolean) => void
  /** Milliseconds before following the service's events again. */
  retry?: number
  /** This computer, the owner of the routines created here. Absent or undefined: not known, every routine is here's. */
  device?: () => Device | undefined
  /**
   * The active Governance account's id; undefined while signed out. Only its routines (and those of no account yet)
   * show, fire and sync: another account's stay stored, hidden, until it is active again. Absent: no accounts.
   */
  account?: () => string | undefined
  /** Whether the routines are in step with Governance (`Capabilities.synced`). Absent: no sync. */
  synced?: () => boolean | undefined
  /** Something went to the outbox: the sync sends it. */
  queued?: () => void
}

export interface Local extends Backend {
  /** The runs that have not ended, as last read. */
  running(): number
  /** Reads the routine's runs that have not ended: whether one is still going. */
  going(routine: string): Promise<boolean>
  /**
   * Writes the clock's plan for a routine in one step: its occurrence key, and the occurrences that do not run in the
   * history. Before the run starts: nothing after this starts that occurrence again.
   */
  take(routine: string, plan: RoutinesClock.Plan): void
  /** Starts the run of an occurrence `take` took. A start that fails is recorded as a failed run. */
  fire(routine: string, run: NonNullable<RoutinesClock.Plan["run"]>): Promise<Run | Failure>
  /**
   * Records as failed (`restart`) the runs that were going when this backend was made and that the service no longer
   * runs: core does not resume a child session after a restart. Call it once the service answers.
   */
  interrupted(): Promise<void>
  /** Whether this computer runs the routine: it owns it. Only the owner's clock fires it. */
  here(routine: string): boolean
  /** The sync changed the store: tells the watchers (the clock, the windows). Without a routine: the sync's status. */
  touched(routine?: string): void
  /** Makes this computer the routine's owner. */
  move(routine: string): Promise<Failure | undefined>
  /** Stops following the service. */
  dispose(): void
}

export function make(options: Options): Local {
  const backend = options.id ?? id
  const watchers = new Set<(change: Change) => void>()
  const follower: {
    controller?: AbortController
    timer?: ReturnType<typeof setTimeout>
    /** When the event stream was lost with runs going: the next connection checks them against the service. */
    dropped?: number
    disposed: boolean
  } = { disposed: false }
  // One anchor at a time per routine: two quick "Run now" share the one being made.
  const anchoring = new Map<string, Promise<string | Failure>>()
  // The runs going when the app last closed: `interrupted` tells which of them a restart cut.
  const left = new Set(options.store.value.runs.filter((record) => !ended(record.state)).map((record) => record.id))
  // The permission requests each running session waits for, by session id.
  const asking = new Map<string, Set<string>>()
  const busy = { value: false }
  // The timer of each running run's time limit, by run id: what cancels it.
  const deadlines = new Map<string, () => void>()
  const timers = options.timers ?? {
    set: (fire: () => unknown, ms: number) => {
      const timer = setTimeout(fire, ms)
      timer.unref()
      return () => clearTimeout(timer)
    },
  }

  const saved = () => options.store.value
  // Another account's routine is not there for anything here: not listed, read, edited, run or fired.
  const mine = (stored: SavedRoutine) => !stored.account || stored.account === options.account?.()
  const routineOf = (routine: string) => saved().routines.find((stored) => stored.id === routine && mine(stored))
  const recordOf = (run: string) => saved().runs.find((stored) => stored.id === run)
  const inflight = () => saved().runs.filter((record) => !ended(record.state))
  const here = (stored: SavedRoutine) => !stored.owner || stored.owner.device === options.device?.()?.id
  const emit = (change: Change) => {
    if (change.run) report(change.run.ref.id)
    ;[...watchers].forEach((watcher) => watcher(change))
    const now = inflight().length > 0
    if (now === busy.value) return
    busy.value = now
    options.busy?.(now)
  }
  const ref = (routine: string) => ({ backend, id: routine })
  const missing = (what: string, key: string) => fail("not-found", `No ${what} ${key}.`)
  const offline = () => fail("unreachable", "Dynwork's service is not running.")

  const toRun = (record: SavedRun): Run => ({
    ref: { backend, id: record.id },
    routine: ref(record.routine),
    state: record.state,
    ...(record.reason ? { reason: record.reason } : {}),
    trigger: record.trigger,
    ...(record.due === undefined ? {} : { due: record.due }),
    ...(record.started === undefined ? {} : { started: record.started }),
    ...(record.finished === undefined ? {} : { finished: record.finished }),
    title: record.title,
    unread: (ended(record.state) && !record.viewed) || asking.has(record.id),
    conversation: record.anchor
      ? { kind: "session", server: options.server, session: record.id, anchor: record.anchor }
      : { kind: "none" },
  })

  const toRoutine = (stored: SavedRoutine): Routine => {
    const own = saved().runs.filter((record) => record.routine === stored.id)
    const next = RoutinesClock.next(stored.definition, options.now())
    return {
      ref: ref(stored.id),
      definition: stored.definition,
      state: stored.definition.enabled ? "active" : "paused",
      ...(next === undefined ? {} : { next }),
      ...(own[0] ? { last: toRun(own[0]) } : {}),
      unread: own.filter((record) => ended(record.state) && !record.viewed).length,
      // Whether another computer is online is not known here.
      owner:
        here(stored) || !stored.owner
          ? { label: options.label, online: true, here: true }
          : { label: stored.owner.name, online: false, here: false },
      conversation: stored.anchor
        ? { kind: "session", server: options.server, session: stored.anchor, anchor: stored.anchor }
        : { kind: "none" },
      updated: stored.updated,
      ...(stored.conflict === undefined ? {} : { conflict: stored.conflict }),
    }
  }

  const capabilities = async (): Promise<Capabilities> => ({
    backend,
    kind: "local",
    label: options.label,
    status: options.client() ? "ready" : "unreachable",
    ...(options.client() ? {} : { detail: "Dynwork's service is not running." }),
    ...(options.synced?.() === undefined ? {} : { synced: options.synced() }),
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

  // A change of the routine made here: written with its outbox entry in one step, and it clears a conflict's note.
  const write = (routine: string, patch: Partial<SavedRoutine>) => {
    options.store.update((draft) => {
      const index = draft.routines.findIndex((stored) => stored.id === routine)
      if (index < 0) return
      const { conflict: _, ...rest } = { ...draft.routines[index]!, ...patch }
      draft.routines[index] = rest
      enqueue(draft, { kind: "put", routine, account: rest.account })
    })
    options.queued?.()
  }

  // A run of a routine this computer owns and Governance has: its summary goes to the outbox.
  function report(run: string) {
    const record = recordOf(run)
    const stored = record && routineOf(record.routine)
    if (!stored || !here(stored) || stored.revision === undefined || !options.queued) return
    options.store.update((draft) => void enqueue(draft, { kind: "run", routine: stored.id, run, account: stored.account }))
    options.queued()
  }

  // When a run's time limit passes: its start plus the routine's limit.
  const deadline = (record: SavedRun) => {
    const minutes = saved().routines.find((stored) => stored.id === record.routine)?.definition.options.timeLimit
    return (record.started ?? 0) + (typeof minutes === "number" ? minutes : LIMIT) * 60_000
  }

  const saveRun = (record: SavedRun) => {
    options.store.update((draft) => {
      const index = draft.runs.findIndex((stored) => stored.id === record.id)
      if (index >= 0) draft.runs[index] = record
    })
    // Whatever ended the run, its timer goes with it.
    if (!ended(record.state)) return
    deadlines.get(record.id)?.()
    deadlines.delete(record.id)
  }

  const arm = (record: SavedRun) => {
    if (record.started === undefined || deadlines.has(record.id)) return
    deadlines.set(
      record.id,
      timers.set(() => expire(record.id), Math.max(deadline(record) - options.now(), 0)),
    )
  }

  // The time limit passed with the run going, even while it waits for a permission: it is recorded before the session is
  // interrupted, or the interrupt's own event would read as the user stopping it.
  async function expire(run: string): Promise<SavedRun | undefined> {
    const record = recordOf(run)
    if (!record || ended(record.state)) return record
    const stopped: SavedRun = { ...quiet(record), state: "failed", reason: "timeout", finished: options.now() }
    saveRun(stopped)
    emit({ routine: ref(stopped.routine), run: toRun(stopped) })
    finished(stopped)
    await options.client()?.session.interrupt({ sessionID: run }).catch(() => undefined)
    return stopped
  }

  // Reads a run that has not ended from its session, and records and reports what changed. A run that ended stays as
  // it is: its session may go on with a reply, which is the conversation's business, not the run's.
  async function refresh(record: SavedRun): Promise<SavedRun> {
    if (ended(record.state)) return record
    if (record.started !== undefined && deadline(record) <= options.now()) return (await expire(record.id)) ?? record
    const client = options.client()
    if (!client) return record
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
    if (record.anchor)
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
    asking.delete(record.id)
    if (!stored || (record.state !== "ok" && record.state !== "failed")) return
    const kind = record.state === "ok" ? "finished" : "failed"
    if (wanted(kind, stored.definition.options.notify))
      options.notify?.({ kind, run: toRun(record), routine: stored.definition })
  }

  // A running session asks for a permission, or its request was answered: the run reads as waiting while any is open.
  // The first request of a wait is told to the user; nothing here ever answers one.
  function permission(session: string, request: string, open: boolean) {
    const record = recordOf(session)
    if (!record || ended(record.state)) return
    const pending = asking.get(session) ?? new Set<string>()
    if (open) pending.add(request)
    else pending.delete(request)
    if (pending.size > 0) asking.set(session, pending)
    else asking.delete(session)
    const waiting = pending.size > 0
    if (waiting === (record.reason === "permission")) return
    const next: SavedRun = waiting ? { ...record, state: "running", reason: "permission" } : quiet(record)
    saveRun(next)
    emit({ routine: ref(next.routine), run: toRun(next) })
    const stored = routineOf(next.routine)
    if (waiting && stored) options.notify?.({ kind: "waiting", run: toRun(next), routine: stored.definition })
  }

  // The user denied a request: core ends the step there (`packages/core/src/session/runner/step.ts`) but never marks
  // the session idle, so the run ends here, as if the user had stopped it.
  function declined(session: string) {
    const record = recordOf(session)
    if (!record || ended(record.state)) return
    asking.delete(session)
    const cancelled: SavedRun = { ...quiet(record), state: "cancelled", reason: "user", finished: options.now() }
    saveRun(cancelled)
    emit({ routine: ref(cancelled.routine), run: toRun(cancelled) })
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
        follower.dropped ??= options.now()
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
      if (event.type === "server.connected") {
        // The service went away and came back: a run it no longer runs was cut by the restart, and is told at once.
        const dropped = follower.dropped
        follower.dropped = undefined
        await Promise.all(inflight().map(refresh))
        if (dropped !== undefined) await cut(inflight().filter((record) => (record.started ?? 0) <= dropped))
      }
      if (event.type === "permission.asked") permission(event.data.sessionID, event.data.id, true)
      if (event.type === "permission.replied" && event.data.reply === "reject") declined(event.data.sessionID)
      if (event.type === "permission.replied") permission(event.data.sessionID, event.data.requestID, false)
      if (event.type !== "server.connected" && !event.type.startsWith("permission.")) {
        const record = recordOf(event.data.sessionID)
        if (record) await refresh(record)
      }
      if (inflight().length === 0) return
    }
  }

  // Records as failed (`restart`) the runs among `candidates` that the service does not run: core does not resume a
  // child session after a restart.
  async function cut(candidates: SavedRun[]) {
    const client = options.client()
    if (candidates.length === 0 || !client) return
    const active = await client.session.active().catch(() => undefined)
    if (!active) return
    await Promise.all(
      candidates.map(async (candidate) => {
        const read = await refresh(candidate)
        if (ended(read.state) || read.id in active) return
        const interrupted: SavedRun = { ...quiet(read), state: "failed", reason: "restart", finished: options.now() }
        saveRun(interrupted)
        emit({ routine: ref(read.routine), run: toRun(interrupted) })
        finished(interrupted)
      }),
    )
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
      deadlines.forEach((cancel) => cancel())
      deadlines.clear()
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
    list: async () => saved().routines.filter(mine).map(toRoutine),
    get: async (routine) => {
      const stored = routineOf(routine)
      return stored ? toRoutine(stored) : missing("routine", routine)
    },
    create: async (definition) => {
      const invalid = RoutinesValidate.check(await capabilities(), definition)
      if (invalid) return invalid
      const device = options.device?.()
      const account = options.account?.()
      const stored: SavedRoutine = {
        id: `rtn_${randomUUID()}`,
        definition,
        updated: options.now(),
        ...(device ? { owner: { device: device.id, name: device.name } } : {}),
        ...(account ? { account } : {}),
      }
      options.store.update((draft) => {
        draft.routines.push(stored)
        enqueue(draft, { kind: "put", routine: stored.id, account })
      })
      options.queued?.()
      emit({ routine: ref(stored.id) })
      return toRoutine(stored)
    },
    update: async (routine, definition) => {
      const stored = routineOf(routine)
      if (!stored) return missing("routine", routine)
      const invalid = RoutinesValidate.check(await capabilities(), definition)
      if (invalid) return invalid
      write(routine, { definition, updated: options.now() })
      await follows(stored, definition)
      emit({ routine: ref(routine) })
      return toRoutine(routineOf(routine) ?? stored)
    },
    // The anchor and its runs stay in the service: the user may still read them, and the sidebar keeps the anchor.
    remove: async (routine) => {
      const stored = routineOf(routine)
      if (!stored) return missing("routine", routine)
      options.store.update((draft) => {
        draft.routines = draft.routines.filter((candidate) => candidate.id !== routine)
        draft.runs = draft.runs.filter((record) => record.routine !== routine)
        enqueue(draft, {
          kind: "delete",
          routine,
          account: stored.account,
          ...(stored.revision === undefined ? {} : { revision: stored.revision }),
        })
      })
      options.queued?.()
      emit({ routine: ref(routine) })
      return undefined
    },
    pause: async (routine) => switchTo(routine, false),
    resume: async (routine) => switchTo(routine, true),
    start: async (routine) => {
      const stored = routineOf(routine)
      if (!stored) return missing("routine", routine)
      if (!here(stored)) return fail("conflict", `It runs on ${stored.owner?.name}.`)
      return launch(stored, { trigger: "manual" })
    },
    // The same write as an edit: the owner goes to Governance with the routine's revision. Nothing missed before now.
    move: async (routine) => {
      const stored = routineOf(routine)
      if (!stored) return missing("routine", routine)
      const device = options.device?.()
      if (!device) return fail("unsupported", "This computer cannot run tasks of other computers.")
      if (here(stored) && stored.owner) return undefined
      write(routine, { owner: { device: device.id, name: device.name }, updated: options.now() })
      emit({ routine: ref(routine) })
      return undefined
    },
    here: (routine) => {
      const stored = routineOf(routine)
      return !!stored && here(stored)
    },
    touched: (routine) => emit(routine ? { routine: ref(routine) } : {}),
    going: async (routine) => {
      const read = await Promise.all(
        inflight()
          .filter((record) => record.routine === routine)
          .map(refresh),
      )
      return read.some((record) => !ended(record.state))
    },
    take: (routine, plan) => {
      const stored = routineOf(routine)
      if (!stored) return
      const records = plan.records.map(
        (occurrence): SavedRun => ({
          id: `occ_${randomUUID()}`,
          routine,
          trigger: "schedule",
          title: `${stored.definition.name} · ${stamp(occurrence.due, stored.definition.schedule?.timezone)}`,
          due: occurrence.due,
          state: occurrence.state,
          reason: occurrence.reason,
          // Nothing to read: it never had a session.
          viewed: true,
        }),
      )
      options.store.update((draft) => {
        const index = draft.routines.findIndex((candidate) => candidate.id === routine)
        if (index >= 0) draft.routines[index] = { ...draft.routines[index]!, due: plan.due }
        draft.runs.unshift(...records.toReversed())
      })
      records.forEach((record) => emit({ routine: ref(routine), run: toRun(record) }))
    },
    fire: async (routine, run) => {
      const stored = routineOf(routine)
      if (!stored) return missing("routine", routine)
      const started = await launch(stored, run)
      if (!isFailure(started) || saved().runs.some((record) => record.routine === routine && record.due === run.due))
        return started
      // It failed before its session existed: the occurrence is still told in the history.
      const failed: SavedRun = {
        id: `occ_${randomUUID()}`,
        routine,
        trigger: run.trigger,
        title: `${stored.definition.name} · ${stamp(run.due, stored.definition.schedule?.timezone)}`,
        due: run.due,
        state: "failed",
        reason: "start",
        finished: options.now(),
        viewed: false,
      }
      options.store.update((draft) => void draft.runs.unshift(failed))
      emit({ routine: ref(routine), run: toRun(failed) })
      finished(failed)
      return started
    },
    interrupted: async () => {
      if (left.size === 0 || !options.client()) return
      const remaining = saved().runs.filter((record) => left.has(record.id) && !ended(record.state))
      left.clear()
      await cut(remaining)
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
      asking.delete(run)
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
      const shown = new Set(saved().routines.filter(mine).map((stored) => stored.id))
      const own = saved().runs.filter((record) =>
        input.routine ? record.routine === input.routine : shown.has(record.routine),
      )
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
      if (!record.anchor) return
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

  // Starts a run of the routine: a child session of its anchor, prompted with its instructions. A catch-up run's prompt
  // first says since when it covers.
  async function launch(
    stored: SavedRoutine,
    occurrence: { trigger: Run["trigger"]; due?: number; since?: number },
  ): Promise<Run | Failure> {
    const routine = stored.id
    const client = options.client()
    if (!client) return offline()
    const parent = await anchor(stored, client)
    if (isFailure(parent)) return parent
    const at = options.now()
    const definition = stored.definition
    const title = `${definition.name} · ${stamp(at, definition.schedule?.timezone)}`
    const trigger = occurrence.trigger
    // "all" (or no option, as in a routine made before it) leaves every connector to the run. A list is checked against
    // the servers the service has now, so one added later stays out.
    const connectors = definition.options.connectors
    const servers = Array.isArray(connectors)
      ? await call(() =>
          client.mcp.list({ location: { directory: folderOf(definition, options.home) } }).then((list) => list.data),
        )
      : []
    if (isFailure(servers)) return servers
    // Every run carries its own permissions and metadata, or it would inherit the anchor's (docs/04-ui.md §A.3.1).
    // `conversation: true` has the app treat the child as a conversation of its own, with the standard composer,
    // rather than as a subagent's read-only session (DynWork's patch in `packages/app/src/session/subagent.ts`).
    const child = await call(() =>
      client.session.create({
        parentID: parent,
        title,
        ...(definition.agent ? { agent: definition.agent } : {}),
        ...modelOf(definition),
        permissions: [
          ...(definition.options.permissions === "bypass" ? bypass() : ask()),
          ...denyConnectors(
            servers.map((server) => server.name),
            Array.isArray(connectors) ? connectors.map(String) : [],
          ),
        ],
        metadata: { conversation: true, dynwork: { backend, routine, role: "run", trigger } },
      }),
    )
    if (isFailure(child)) return child
    const record: SavedRun = {
      id: child.id,
      routine,
      anchor: parent,
      trigger,
      title,
      ...(occurrence.due === undefined ? {} : { due: occurrence.due }),
      started: at,
      state: "queued",
      viewed: false,
    }
    options.store.update((draft) => void draft.runs.unshift(record))
    arm(record)
    const prompt = promptOf(definition)
    const text =
      occurrence.since === undefined ? prompt.text : `${catchUp(occurrence.since, definition)}\n\n${prompt.text}`
    const prompted = await call(() => client.session.prompt({ sessionID: child.id, ...prompt, text }))
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
  }

  async function switchTo(routine: string, enabled: boolean) {
    const stored = routineOf(routine)
    if (!stored) return missing("routine", routine)
    write(routine, { definition: { ...stored.definition, enabled }, updated: options.now() })
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

  // A run left going when the app last closed is read again as soon as the service answers, and its limit still counts.
  inflight().forEach(arm)
  follow()
  return local
}

function ended(state: RunState) {
  return state !== "queued" && state !== "running"
}

// A run's state from its session: queued until its execution starts, running until it ends with an outcome.
function derive(stored: SavedRun, info: SessionInfo | null, now: number): SavedRun {
  const record = quiet(stored)
  if (info === null) return { ...record, state: "failed", reason: "deleted", finished: now }
  const busy = info.time.busy
  const idle = info.time.idle
  if (busy === undefined) return { ...record, state: "queued" }
  if (idle === undefined || idle < busy || !info.outcome) return { ...record, state: "running" }
  if (info.outcome === "succeeded") return { ...record, state: "ok", finished: idle }
  if (info.outcome === "failed") return { ...record, state: "failed", reason: "error", finished: idle }
  return { ...record, state: "cancelled", reason: "user", finished: idle }
}

// A run that is no longer waiting for a permission: the reason that said so goes.
function quiet(record: SavedRun): SavedRun {
  if (record.reason !== "permission") return record
  const { reason: _, ...rest } = record
  return rest
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

// The first line of a catch-up run's prompt: it is one, and since when, so the agent covers the whole gap.
function catchUp(since: number, definition: Definition) {
  const zone = definition.schedule?.timezone
  const at = new Intl.DateTimeFormat("en-GB", { dateStyle: "full", timeStyle: "short", timeZone: zone }).format(since)
  return `This is a catch-up run: Dynwork was closed or asleep when this scheduled task was due, so cover everything since ${at}${zone ? ` (${zone})` : ""}.`
}

// The choices of the shared selects; undefined for a lookup this backend does not serve.
// Governance's own MCP server is named after the product behind it, which the UI never shows.
function connectorLabel(name: string, status: string) {
  const shown = name === "systemprompt" ? "Governance" : name
  return status === "connected" ? shown : `${shown} · ${status}`
}

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
  if (lookup === "connectors") {
    const servers = await client.mcp.list()
    return servers.data.map((server) => ({
      value: server.name,
      label: connectorLabel(server.name, server.status.status),
    }))
  }
  if (lookup === "skills") {
    const skills = await client.skill.list()
    return skills.data.map((skill) => ({ value: skill.id, label: skill.name }))
  }
  return undefined
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
  if (gone(error)) return fail("not-found", "The task's session is gone.")
  return fail("failed", "DynWork's service refused the request.")
}
