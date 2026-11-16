export * as RoutinesLocalStore from "./store"

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

export const Saved = Schema.Struct({
  routines: Schema.Array(SavedRoutine),
  /** Newest first. */
  runs: Schema.Array(SavedRun),
})
export type Saved = typeof Saved.Type

export const initial: Saved = { routines: [], runs: [] }
