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
  updated: Schema.Number,
})
export type SavedRoutine = typeof SavedRoutine.Type

export const SavedRun = Schema.Struct({
  /** The run's session id, which is also the run's id. */
  id: Schema.String,
  routine: Schema.String,
  anchor: Schema.String,
  trigger: Run.fields.trigger,
  title: Schema.String,
  started: Schema.Number,
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
