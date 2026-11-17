export * as RoutinesLocalStore from "./store"

import { randomUUID } from "node:crypto"
import { Schema } from "effect"
import { Definition, Run, RunState } from "../contract"

// What the local backend keeps in the plugin's storage (`ctx.storage`, main): the definitions, and every run it started
// with the last state it read. A run's live state is in its session; the record is the history, and it outlives a
// session the user deletes.

export const SavedRoutine = Schema.Struct({
  id: Schema.String,
  definition: Definition,
  /** The routine's anchor session, once its first run made it. */
  anchor: Schema.optional(Schema.String),
  /** The directory the anchor is in, so a new folder moves it. */
  directory: Schema.optional(Schema.String),
  /**
   * The newest occurrence the clock took: the occurrence key `(routine, due)`, written before its run starts, so no
   * occurrence at or before it starts again (`clock.ts`).
   */
  due: Schema.optional(Schema.Number),
  updated: Schema.Number,
  /** Its revision in Governance, as last written or read; absent until it was first synced (`sync.ts`). */
  revision: Schema.optional(Schema.Number),
  /**
   * The computer that runs it: its relay peer id and its name. Absent: this one (a routine from before the sync). Null:
   * none yet, it was made for this user in Governance; the sync claims it for this computer, and nothing runs it until
   * Governance takes the claim.
   */
  owner: Schema.optional(Schema.NullOr(Schema.Struct({ device: Schema.String, name: Schema.String }))),
  /** When another computer's change replaced an edit made here (a sync conflict); cleared by the next edit here. */
  conflict: Schema.optional(Schema.Number),
  /**
   * The Governance account it belongs to, set when it is synced or created while signed in. Only the active account's
   * routines show, fire and sync; one without (never synced) counts as the active account's and is tagged on its first
   * sync.
   */
  account: Schema.optional(Schema.String),
})
export type SavedRoutine = typeof SavedRoutine.Type

export const SavedRun = Schema.Struct({
  /** The run's session id, which is also the run's id; `occ_…` for an occurrence that never had a session. */
  id: Schema.String,
  routine: Schema.String,
  /** The anchor its session is under; absent for an occurrence that did not run (missed, skipped). */
  anchor: Schema.optional(Schema.String),
  trigger: Run.fields.trigger,
  title: Schema.String,
  /** The occurrence it was due at; absent for a manual run. */
  due: Schema.optional(Schema.Number),
  started: Schema.optional(Schema.Number),
  /** The state last read from the session; terminal states are final. */
  state: RunState,
  reason: Schema.optional(Schema.String),
  finished: Schema.optional(Schema.Number),
  /** The user opened it after it finished. */
  viewed: Schema.Boolean,
})
export type SavedRun = typeof SavedRun.Type

const Account = Schema.optional(Schema.String)

/**
 * A change made here that Governance has not taken yet, in the order it was made (`sync.ts` sends them in order):
 * - `put`: the routine as it is in the store when it is sent (create, edit, pause, resume, move);
 * - `delete`: the routine was removed here, at its last known `revision` (absent: it never reached Governance);
 * - `run`: the summary of a run of a routine this computer owns, as the store has it when it is sent.
 * Each carries its routine's account: it is sent only while that account is active, never with another one's token.
 */
export const Op = Schema.Union([
  Schema.Struct({ id: Schema.String, kind: Schema.Literal("put"), routine: Schema.String, account: Account }),
  Schema.Struct({
    id: Schema.String,
    kind: Schema.Literal("delete"),
    routine: Schema.String,
    revision: Schema.optional(Schema.Number),
    account: Account,
  }),
  Schema.Struct({
    id: Schema.String,
    kind: Schema.Literal("run"),
    routine: Schema.String,
    run: Schema.String,
    account: Account,
  }),
])
export type Op = typeof Op.Type

export const Saved = Schema.Struct({
  routines: Schema.Array(SavedRoutine),
  /** Newest first. */
  runs: Schema.Array(SavedRun),
  /** The changes still to send to Governance, oldest first. */
  outbox: Schema.optional(Schema.Array(Op)),
  /** Where the feed was read up to, and for which account: another account starts from the beginning. */
  sync: Schema.optional(Schema.Struct({ account: Schema.String, cursor: Schema.String })),
})
export type Saved = typeof Saved.Type

export const initial: Saved = { routines: [], runs: [] }

type Draft = { outbox?: Array<Op> }
type NewOp = (
  | { kind: "put"; routine: string }
  | { kind: "delete"; routine: string; revision?: number }
  | { kind: "run"; routine: string; run: string }
) & { account?: string }

/**
 * Adds a change to the outbox, in the same store write as the change itself. A `put` or `run` already waiting behind
 * the first entry (which may be on its way) is not added twice: it sends what the store holds when it goes.
 */
export function enqueue(draft: Draft, op: NewOp) {
  const outbox = draft.outbox ?? []
  const twin = (queued: Op) => {
    if (op.kind === "put") return queued.kind === "put" && queued.routine === op.routine
    if (op.kind === "run") return queued.kind === "run" && queued.run === op.run
    return false
  }
  if (outbox.slice(1).some(twin)) return
  draft.outbox = [...outbox, { ...op, id: randomUUID() }]
}
