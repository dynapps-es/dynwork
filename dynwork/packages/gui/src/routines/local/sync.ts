export * as RoutinesSync from "./sync"

import { Schema } from "effect"
import type { Persisted } from "@opencode/plugin/gui/main"
import { Definition } from "../contract"
import type { Device, Local } from "./backend"
import type { RoutinesClock } from "./clock"
import { enqueue, type Op, type Saved, type SavedRoutine } from "./store"

// The local routines' definitions, shared with the user's other computers through Governance (the `dynwork-routines`
// extension: a change feed and writes with optimistic concurrency). It runs in main, with the account's session; the
// JWT never reaches a window.
//
// - Read: `GET /changes?since=<cursor>` at launch, every 5 minutes (every 30 s while Governance does not answer), when
//   the account changes, on wake, and at once on the relay's `routines.changed` hint. Each page is applied to the store
//   and its cursor kept with it.
// - Write: every change made here is already in the store and in its outbox (`enqueue`, in the same write). The outbox
//   is sent in order, each routine with `If-Match` at the revision it was last synced at. A `409` takes Governance's
//   row and keeps it, and the routine says "Changed on another computer": nothing is overwritten silently. While a
//   change of a routine waits in the outbox, the feed leaves that routine alone: its `If-Match` settles it.
// - Runs: the owner computer alone reports each run's state, reason and times.
// - First sync: a routine Governance does not have yet is uploaded with this computer as its owner.
// - Without Governance everything keeps working here; the outbox waits and the Agents view says "Not synced".

/** Where the routines API is on a Governance instance. */
export const PATH = "/api/dynwork/routines/v1"
/** How often the feed is read when nothing else asks for it. */
export const POLL = 5 * 60_000
/** How often it is tried again while Governance does not answer. */
export const RETRY = 30_000
const PAGE = 200

/** The Governance account the routines sync with: the active, signed-in one. */
export interface Account {
  id: string
  url: string
  /** Its session's JWT, renewed as needed. */
  token: () => Promise<string>
}

export interface Options {
  store: Persisted<Saved, Saved>
  local: Local
  account: () => Account | undefined
  /** This computer: its relay peer id (32 hex digits, `X-Dynwork-Peer`) and its name. */
  device: () => Device | undefined
  now: () => number
  fetch?: (input: string, init?: RequestInit) => Promise<Response>
  timers?: RoutinesClock.Timers
}

// A routine as Governance answers it; a tombstone has `deleted` and no definition.
const Row = Schema.Struct({
  id: Schema.String,
  revision: Schema.Number,
  owner_device: Schema.String,
  owner_name: Schema.String,
  definition: Schema.NullOr(Schema.Unknown),
  deleted: Schema.Boolean,
  updated_at: Schema.String,
})
type Row = typeof Row.Type
const decodeRow = Schema.decodeUnknownOption(Row)
const decodePage = Schema.decodeUnknownOption(
  Schema.Struct({ routines: Schema.Array(Row), cursor: Schema.String, more: Schema.Boolean }),
)
const decodeConflict = Schema.decodeUnknownOption(Schema.Struct({ current: Row }))
const decodeDefinition = Schema.decodeUnknownOption(Definition)

type Sent = "done" | "again" | "offline"
type Answer = { status: number; body: unknown } | undefined

const real: RoutinesClock.Timers = {
  set: (fire, ms) => {
    const timer = setTimeout(() => void fire(), ms)
    return () => clearTimeout(timer)
  },
}

export function make(options: Options) {
  const timers = options.timers ?? real
  const send = options.fetch ?? fetch
  const life: {
    running?: Promise<void>
    again: boolean
    cancel?: () => void
    disposed: boolean
    /** Undefined: no account or no device, nothing to sync. */
    synced?: boolean
  } = { again: false, disposed: false }

  const saved = () => options.store.value
  const outbox = () => saved().outbox ?? []
  const routineOf = (routine: string) => saved().routines.find((stored) => stored.id === routine)

  // One pass at a time: a request while one runs makes one more pass after it.
  function sync(): Promise<void> {
    if (life.disposed) return Promise.resolve()
    if (life.running) {
      life.again = true
      return life.running
    }
    const running = (async () => {
      do {
        life.again = false
        await pass()
      } while (life.again && !life.disposed)
    })().finally(() => {
      life.running = undefined
      arm()
    })
    life.running = running
    return running
  }

  function arm() {
    life.cancel?.()
    life.cancel = life.disposed ? undefined : timers.set(sync, life.synced === false ? RETRY : POLL)
  }

  async function pass() {
    const account = options.account()
    const device = options.device()
    if (!account || !device) return settle(undefined)
    const pulled = await pull(account, device)
    if (pulled) upload(device)
    settle(pulled && (await flush(account, device)))
  }

  function settle(synced: boolean | undefined) {
    if (life.synced === synced) return
    life.synced = synced
    options.local.touched()
  }

  // A request to the routines API; undefined when Governance did not answer or no session could be had.
  async function call(
    account: Account,
    device: Device,
    method: string,
    route: string,
    input: { body?: unknown; revision?: number } = {},
  ): Promise<Answer> {
    const token = await account.token().catch(() => undefined)
    if (token === undefined) return undefined
    const response = await send(`${account.url.replace(/\/+$/, "")}${PATH}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "x-dynwork-peer": device.id,
        ...(input.body === undefined ? {} : { "content-type": "application/json" }),
        ...(input.revision === undefined ? {} : { "if-match": `"${input.revision}"` }),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    }).catch(() => undefined)
    if (!response) return undefined
    return { status: response.status, body: await response.json().catch(() => undefined) }
  }

  // Reads the feed from the cursor to its end. A cursor Governance refuses (its data was reset) starts over.
  async function pull(account: Account, device: Device): Promise<boolean> {
    for (;;) {
      const kept = saved().sync
      const since = kept?.account === account.id ? kept.cursor : undefined
      const answer = await call(
        account,
        device,
        "GET",
        `/changes?limit=${PAGE}${since === undefined ? "" : `&since=${encodeURIComponent(since)}`}`,
      )
      if (answer?.status === 400 && since !== undefined) {
        options.store.update((draft) => void delete draft.sync)
        continue
      }
      const page = answer?.status === 200 ? decodePage(answer.body) : undefined
      if (!page || page._tag === "None") return false
      apply(page.value.routines)
      options.store.update((draft) => {
        draft.sync = { account: account.id, cursor: page.value.cursor }
      })
      if (!page.value.more) return true
    }
  }

  // Applies a page of the feed. A routine with a change of its own still in the outbox is left alone.
  function apply(rows: readonly Row[]) {
    const touched: string[] = []
    options.store.update((draft) => {
      const waiting = new Set((draft.outbox ?? []).filter((op) => op.kind !== "run").map((op) => op.routine))
      rows.forEach((row) => {
        if (!waiting.has(row.id) && adopt(draft, row)) touched.push(row.id)
      })
    })
    touched.forEach((routine) => options.local.touched(routine))
  }

  // Takes Governance's row into the store: a tombstone removes the routine and its runs, anything newer than what the
  // store has replaces its definition and owner. `force` takes it whatever the revision, and `conflict` notes the
  // replaced edit. Answers whether anything changed.
  function adopt(draft: Draft, row: Row, input: { force?: boolean; conflict?: number } = {}) {
    const index = draft.routines.findIndex((stored) => stored.id === row.id)
    const current = index >= 0 ? draft.routines[index] : undefined
    if (row.deleted) {
      if (!current) return false
      draft.routines.splice(index, 1)
      draft.runs = draft.runs.filter((record) => record.routine !== row.id)
      return true
    }
    if (!input.force && current?.revision !== undefined && current.revision >= row.revision) return false
    const definition = decodeDefinition(row.definition)
    if (definition._tag === "None") return false
    const changed = Date.parse(row.updated_at)
    const { conflict: _, ...kept } = current ?? { id: row.id }
    const next: SavedRoutine = {
      ...kept,
      id: row.id,
      definition: definition.value,
      revision: row.revision,
      owner: { device: row.owner_device, name: row.owner_name },
      // When it changed in Governance: the clock counts nothing missed before then, as after an edit here.
      updated: Number.isFinite(changed) ? changed : options.now(),
      ...(input.conflict === undefined ? {} : { conflict: input.conflict }),
    }
    if (current) draft.routines[index] = next
    if (!current) draft.routines.push(next)
    return true
  }

  // First sync: the routines Governance does not have yet go to it, with this computer as their owner.
  function upload(device: Device) {
    const missing = saved().routines.filter(
      (stored) =>
        stored.revision === undefined && !outbox().some((op) => op.kind === "put" && op.routine === stored.id),
    )
    if (missing.length === 0) return
    options.store.update((draft) => {
      missing.forEach((routine) => {
        const stored = draft.routines.find((candidate) => candidate.id === routine.id)
        if (!stored) return
        stored.owner ??= { device: device.id, name: device.name }
        enqueue(draft, { kind: "put", routine: stored.id })
      })
    })
  }

  // Sends the outbox in order until it is empty, or Governance stops answering.
  async function flush(account: Account, device: Device) {
    for (;;) {
      const op = outbox()[0]
      if (!op) return true
      const sent = await deliver(account, device, op)
      if (sent === "offline") return false
      if (sent === "done")
        options.store.update((draft) => {
          draft.outbox = (draft.outbox ?? []).filter((queued) => queued.id !== op.id)
        })
    }
  }

  function deliver(account: Account, device: Device, op: Op): Promise<Sent> {
    if (op.kind === "put") return put(account, device, op)
    if (op.kind === "delete") return remove(account, device, op)
    return run(account, device, op)
  }

  async function put(account: Account, device: Device, op: Op): Promise<Sent> {
    const stored = routineOf(op.routine)
    // Gone, or a later change of the same routine sends it as it is by then.
    if (!stored || outbox().some((queued) => queued.id !== op.id && queued.routine === op.routine && queued.kind !== "run"))
      return "done"
    const answer = await call(account, device, "PUT", `/routines/${encodeURIComponent(op.routine)}`, {
      body: {
        owner_device: stored.owner?.device ?? device.id,
        owner_name: (stored.owner?.name ?? device.name).slice(0, 128),
        definition: stored.definition,
      },
      revision: stored.revision,
    })
    if (!answer) return "offline"
    const row = answer.status === 200 ? decodeRow(answer.body) : undefined
    if (row?._tag === "Some") {
      written(row.value)
      return "done"
    }
    if (answer.status === 409) return conflict(op, stored, device, answer.body)
    // Governance lost a routine it had: it is created again.
    if (answer.status === 404 && stored.revision !== undefined) {
      options.store.update((draft) => {
        const found = draft.routines.find((candidate) => candidate.id === op.routine)
        if (found) delete found.revision
      })
      return "again"
    }
    return failed(answer)
  }

  async function remove(account: Account, device: Device, op: Extract<Op, { kind: "delete" }>): Promise<Sent> {
    // It never reached Governance.
    if (op.revision === undefined) return "done"
    const answer = await call(account, device, "DELETE", `/routines/${encodeURIComponent(op.routine)}`, {
      revision: op.revision,
    })
    if (!answer) return "offline"
    if (answer.status !== 409) return answer.status === 200 ? "done" : failed(answer)
    // Changed on another computer after this one removed it: it comes back as the other one left it, and says so.
    const current = decodeConflict(answer.body)
    if (current._tag === "None" || current.value.current.deleted) return "done"
    options.store.update((draft) => void adopt(draft, current.value.current, { force: true, conflict: options.now() }))
    options.local.touched(op.routine)
    return "done"
  }

  async function run(account: Account, device: Device, op: Extract<Op, { kind: "run" }>): Promise<Sent> {
    const record = saved().runs.find((candidate) => candidate.id === op.run)
    const stored = routineOf(op.routine)
    if (!record || !stored || stored.revision === undefined || !options.local.here(stored.id)) return "done"
    const answer = await call(account, device, "PUT", `/runs/${encodeURIComponent(op.run)}`, {
      body: {
        routine_id: op.routine,
        device: stored.owner?.device ?? device.id,
        state: record.state,
        ...(record.reason ? { reason: record.reason.slice(0, 500) } : {}),
        ...(record.started === undefined ? {} : { started_at: new Date(record.started).toISOString() }),
        ...(record.finished === undefined ? {} : { ended_at: new Date(record.finished).toISOString() }),
      },
    })
    if (!answer) return "offline"
    return answer.status === 200 ? "done" : failed(answer)
  }

  // A routine Governance took: its revision and owner, also for a removal of it still waiting behind.
  function written(row: Row) {
    options.store.update((draft) => {
      const stored = draft.routines.find((candidate) => candidate.id === row.id)
      if (stored) {
        stored.revision = row.revision
        stored.owner = { device: row.owner_device, name: row.owner_name }
      }
      ;(draft.outbox ?? []).forEach((queued) => {
        if (queued.kind === "delete" && queued.routine === row.id) queued.revision = row.revision
      })
    })
  }

  // `409`: the routine changed elsewhere since this computer last synced it. When Governance already holds what was
  // sent (an answer that got lost), its revision is taken quietly. Otherwise its row replaces the edit made here, the
  // routine says so, and the later changes of it made on top of that edit are dropped.
  function conflict(op: Op, stored: SavedRoutine, device: Device, body: unknown): Sent {
    const found = decodeConflict(body)
    if (found._tag === "None") return "done"
    const current = found.value.current
    const owner = stored.owner?.device ?? device.id
    if (!current.deleted && same(current.definition, stored.definition) && current.owner_device === owner) {
      written(current)
      return "done"
    }
    options.store.update((draft) => {
      adopt(draft, current, { force: true, conflict: options.now() })
      draft.outbox = (draft.outbox ?? []).filter(
        (queued) => queued.id === op.id || queued.routine !== current.id || queued.kind === "run",
      )
    })
    options.local.touched(current.id)
    return "done"
  }

  void sync()

  return {
    /** Reads the feed and sends the outbox now: on a hint, a new account, a wake, and after a change made here. */
    sync,
    /** Whether the routines are in step with Governance; undefined while there is nothing to sync with. */
    synced: () => life.synced,
    dispose: () => {
      life.disposed = true
      life.cancel?.()
      life.cancel = undefined
    },
  }
}

export type Sync = ReturnType<typeof make>

type Draft = Parameters<Parameters<Persisted<Saved, Saved>["update"]>[0]>[0]

// What Governance refuses for now (a session it does not take, a timeout, a rate limit, its own error) is sent again
// later; what it refuses for good (a bad body, another device's run, an unknown id) is dropped, not sent for ever.
function failed(answer: NonNullable<Answer>): Sent {
  return answer.status === 401 || answer.status === 408 || answer.status === 429 || answer.status >= 500
    ? "offline"
    : "done"
}

// Two JSON values alike whatever the order of their keys (Governance keeps a definition as JSONB, which reorders them).
function same(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b)
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`
}
