import { Schema } from "effect"
import { Ipc } from "@opencode/plugin/gui"

// The routines contract: what every routines backend (local, Agent Farm, fakes) speaks and what crosses to a window.
// All times are epoch milliseconds. Every backend-specific value rides in `Definition.options`, keyed as the backend's
// `Capabilities.fields` declares, so the view never special-cases a backend.

/** A routine or run is addressed by its backend and that backend's own id. */
export const Ref = Schema.Struct({ backend: Schema.String, id: Schema.String })
export type Ref = typeof Ref.Type

/** What a routine does when it runs. Which kinds a backend takes is `Capabilities.instructions`. */
export const Instructions = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("prompt"), text: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("skill"), skill: Schema.String, text: Schema.optional(Schema.String) }),
  /** A catalogue agent of the backend (the farm's), run on `input`. */
  Schema.Struct({ kind: Schema.Literal("agent"), agent: Schema.String, input: Schema.String }),
])
export type Instructions = typeof Instructions.Type

export const Schedule = Schema.Struct({
  /** Five fields, minute first. The form's presets are written as cron. */
  cron: Schema.String,
  /** The IANA zone the cron is read in. */
  timezone: Schema.String,
  /** First moment the routine may run. Only for a backend with `schedule.window`. */
  starts: Schema.optional(Schema.Number),
  /** Last moment the routine may run. Only for a backend with `schedule.window`. */
  ends: Schema.optional(Schema.Number),
  /** Stops after this many runs. Only for a backend with `schedule.window`. */
  max: Schema.optional(Schema.Number),
})
export type Schedule = typeof Schedule.Type

/** What the user edits. */
export const Definition = Schema.Struct({
  name: Schema.String,
  instructions: Instructions,
  /** The agent that runs the instructions, where `Capabilities.agent` allows one. */
  agent: Schema.optional(Schema.String),
  /** The model, where `Capabilities.model` is `choose`. */
  model: Schema.optional(Schema.String),
  /** Absent: the routine runs only when the user starts it. */
  schedule: Schema.optional(Schedule),
  enabled: Schema.Boolean,
  /** The backend's own fields, by `Field.key`. Keys never collide with the common ones above. */
  options: Schema.Record(Schema.String, Schema.Json),
})
export type Definition = typeof Definition.Type

/** Where a run's conversation is read. */
export const Conversation = Schema.Union([
  /** A session on a DynWork server: a local run, opened in place under its anchor session. */
  Schema.Struct({
    kind: Schema.Literal("session"),
    server: Schema.String,
    session: Schema.String,
    anchor: Schema.String,
  }),
  /** Read through `transcript(run)`: the farm's result and log. Read only. */
  Schema.Struct({ kind: Schema.Literal("transcript") }),
  /** Somewhere else, such as a page of the backend. */
  Schema.Struct({ kind: Schema.Literal("external"), url: Schema.String }),
  /** Nothing to read: a run that never started. */
  Schema.Struct({ kind: Schema.Literal("none") }),
])
export type Conversation = typeof Conversation.Type

/**
 * Where a run is.
 * - `queued`, `running`: not finished.
 * - `ok`: finished well on time. `late`: finished well, but after its slot because the app was closed or busy.
 * - `failed`: stopped by an error or the time limit; `reason` says which.
 * - `blocked`: stopped because it needed a permission nobody could grant.
 * - `missed`: its slot passed and it never ran. `skipped`: it did not run on purpose (an overlap, a quota).
 * - `cancelled`: the user stopped it.
 */
export const RunState = Schema.Literals([
  "queued",
  "running",
  "ok",
  "late",
  "failed",
  "blocked",
  "missed",
  "skipped",
  "cancelled",
])
export type RunState = typeof RunState.Type

export const Run = Schema.Struct({
  ref: Ref,
  /** The routine it belongs to; a farm task started outside DynWork has none. */
  routine: Schema.optional(Ref),
  state: RunState,
  /** Machine code for the state, such as `timeout`, `closed`, `overlap`, `quota`, `permission`, `restart`. */
  reason: Schema.optional(Schema.String),
  trigger: Schema.Literals(["schedule", "manual", "catch-up"]),
  /** The slot it was due at; absent for a manual run. */
  due: Schema.optional(Schema.Number),
  started: Schema.optional(Schema.Number),
  finished: Schema.optional(Schema.Number),
  title: Schema.String,
  summary: Schema.optional(Schema.String),
  cost: Schema.optional(Schema.Struct({ amount: Schema.Number, currency: Schema.String })),
  /** Finished and not opened yet, or waiting for the user's answer. */
  unread: Schema.Boolean,
  conversation: Conversation,
})
export type Run = typeof Run.Type

/**
 * Where a routine runs, when that differs by routine: a local routine belongs to one device. `here` is this device; a
 * routine of another device waits until that device is online. A remote routine has none.
 */
export const Owner = Schema.Struct({ label: Schema.String, online: Schema.Boolean, here: Schema.Boolean })
export type Owner = typeof Owner.Type

export const Routine = Schema.Struct({
  ref: Ref,
  definition: Definition,
  /** `paused` is a routine switched off; `finished` one whose schedule ended; `error` one the backend cannot run. */
  state: Schema.Literals(["active", "paused", "finished", "error"]),
  next: Schema.optional(Schema.Number),
  /** The newest run. */
  last: Schema.optional(Run),
  /** How many of its runs are unread. */
  unread: Schema.Number,
  owner: Schema.optional(Owner),
  /** The routine's own conversation: a local routine's anchor session; otherwise `none`. */
  conversation: Conversation,
  updated: Schema.Number,
  /**
   * When an edit made on this device was replaced by a change made on another one (a sync conflict): the routine is
   * as the other device left it, and the view says so until the next edit here.
   */
  conflict: Schema.optional(Schema.Number),
})
export type Routine = typeof Routine.Type

export const Choice = Schema.Struct({
  value: Schema.String,
  label: Schema.String,
  /** One line the form shows, as a warning, while this choice is selected. */
  warning: Schema.optional(Schema.String),
})
export type Choice = typeof Choice.Type

/**
 * One backend field of the form, rendered from this data alone.
 * - `text`, `textarea`, `number`, `toggle`: plain values (`string`, `string`, `number`, `boolean`).
 * - `select` takes a string from `choices` or `lookup`; `multiselect` an array of them.
 * - `folder` is a local path picked with the desktop's picker; `repo` an https repository URL.
 * - `list` is an array of strings the user adds and removes.
 */
export const Field = Schema.Struct({
  /** The key in `Definition.options`. */
  key: Schema.String,
  /** The group the form puts it in, such as `workspace`, `permissions`, `limits`, `advanced`. */
  section: Schema.String,
  /** English copy from the backend: the view translates the keys it knows and falls back to this. */
  label: Schema.String,
  help: Schema.optional(Schema.String),
  kind: Schema.Literals(["text", "textarea", "number", "toggle", "select", "multiselect", "folder", "repo", "list"]),
  required: Schema.optional(Schema.Boolean),
  /** Static choices. */
  choices: Schema.optional(Schema.Array(Choice)),
  /** The name of an `options` lookup that supplies the choices, such as `plugins` or `credentials:git_token`. */
  lookup: Schema.optional(Schema.String),
  min: Schema.optional(Schema.Number),
  max: Schema.optional(Schema.Number),
  /** A regular expression a `text` value must match. */
  pattern: Schema.optional(Schema.String),
  default: Schema.optional(Schema.Json),
  /** Shown, and checked, only while the field `key` has this value. */
  when: Schema.optional(Schema.Struct({ key: Schema.String, equals: Schema.Json })),
})
export type Field = typeof Field.Type

/** What a backend can do. The view enables, disables and paints the form from it. */
// JESÚS: the farm's `capabilities()` fills `fields` from what `GET /agents`, `/plugins`, `/credentials` and `/whoami`
// allow (repository, branch, repository access, plugins, MCP servers, limits, overlap, window, advanced), with
// `lookup` for the dropdowns it serves through `options()`. It sets `quota` from the tenant's schedule limit.
export const Capabilities = Schema.Struct({
  backend: Schema.String,
  /** The list's filter: every backend is either local or remote. */
  kind: Schema.Literals(["local", "remote"]),
  /** The card badge: the device's name, or "Agent Farm". */
  label: Schema.String,
  /**
   * `ready` serves requests. `signed-out`, `unreachable` and `disabled` explain why it cannot; `detail` says more.
   * `capabilities()` answers whatever the status: it never fails.
   */
  status: Schema.Literals(["ready", "signed-out", "unreachable", "disabled"]),
  detail: Schema.optional(Schema.String),
  /**
   * Whether the routines are in step with Governance, for a backend that keeps them on this device and syncs them:
   * false while it cannot reach Governance (the view says "Not synced"; changes wait to be sent). Absent: no sync.
   */
  synced: Schema.optional(Schema.Boolean),
  /** The kinds of `Instructions` it takes. */
  instructions: Schema.Array(Schema.Literals(["prompt", "skill", "agent"])),
  /** `Definition.agent`: `required`, `optional` or not there (`none`: the instructions name the agent). */
  agent: Schema.Literals(["required", "optional", "none"]),
  /** `Definition.model`: `choose` lets the user pick; `agent` means the agent fixes it; `none` hides it. */
  model: Schema.Literals(["choose", "agent", "none"]),
  /** `window`: `starts`, `ends` and `max` apply. `minimum`: the shortest interval between runs, in minutes. */
  schedule: Schema.Struct({ window: Schema.Boolean, minimum: Schema.Number }),
  actions: Schema.Struct({
    /** `replace`: an update makes a new routine and removes the old one (the farm has no PATCH). */
    edit: Schema.Literals(["in-place", "replace"]),
    /** `resume`: a reply starts a new run that continues the session (the farm's `session_ref`). */
    reply: Schema.Literals(["in-place", "resume", "none"]),
    cancel: Schema.Boolean,
  }),
  /** The most scheduled routines the backend takes. `shared`: other people count against it too. */
  quota: Schema.optional(Schema.Struct({ max: Schema.Number, used: Schema.Number, shared: Schema.Boolean })),
  fields: Schema.Array(Field),
})
export type Capabilities = typeof Capabilities.Type

/**
 * A failure, as data: an Ipc rejection reaches the window as plain text (`accounts/ipc.ts`), so nothing is thrown.
 * - `signed-out`, `unreachable`: the backend cannot be asked right now.
 * - `invalid`: the input is wrong; `fields` names each field and what is wrong with it.
 * - `quota`: the backend is full. `conflict`: the thing is not in a state that allows it (cancelling a finished run).
 * - `not-found`: no such routine, run or lookup. `unsupported`: this backend never does that. `failed`: anything else.
 */
// JESÚS: the farm's `{ error: { code, message, retryable, details } }` becomes one of these: `details` into `fields`,
// `401 token_expired|token_invalid` into `signed-out`, `429 quota_exceeded` and `422 limits_exceed_tenant_policy` into
// `quota` or `invalid`, a network error into `unreachable`.
export const Failure = Schema.Struct({
  code: Schema.Literals([
    "signed-out",
    "unreachable",
    "invalid",
    "quota",
    "conflict",
    "not-found",
    "unsupported",
    "failed",
  ]),
  message: Schema.String,
  retryable: Schema.Boolean,
  /** Per-field messages for `invalid`, keyed by `Field.key` or a common key (`name`, `instructions`, ...). */
  fields: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})
export type Failure = typeof Failure.Type

/** A run's read-only conversation, for a run whose `conversation` is `transcript`. */
export const Transcript = Schema.Struct({
  /** The result, in Markdown. Absent while the run is still going. */
  result: Schema.optional(Schema.String),
  /** The last lines of the run's log. */
  log: Schema.optional(Schema.String),
  usage: Schema.optional(
    Schema.Struct({
      cost: Schema.optional(Schema.Struct({ amount: Schema.Number, currency: Schema.String })),
      turns: Schema.optional(Schema.Number),
      /** Milliseconds. */
      duration: Schema.optional(Schema.Number),
    }),
  ),
})
export type Transcript = typeof Transcript.Type

/** One page of runs, newest first. Pass `next` back as `cursor` for the following page; absent, there is none. */
export const RunPage = Schema.Struct({ items: Schema.Array(Run), next: Schema.optional(Schema.String) })
export type RunPage = typeof RunPage.Type

/** What a backend reports to `watch`: the routine that changed, and the run when a run did. */
export const Change = Schema.Struct({ routine: Schema.optional(Ref), run: Schema.optional(Run) })
export type Change = typeof Change.Type

/** What main pushes to every window after each change. */
export const State = Schema.Struct({
  /** Every registered backend, in registration order. */
  backends: Schema.Array(Capabilities),
  /** The routines of every backend, as of the last read. A backend that cannot be read keeps its last answer. */
  routines: Schema.Array(Routine),
})
export type State = typeof State.Type

export function isFailure(value: unknown): value is Failure {
  return typeof value === "object" && value !== null && "code" in value && "message" in value && "retryable" in value
}

// The failure goes first: a `Transcript` has only optional fields, so it would take a failure for an empty transcript.
const Outcome = <S extends Schema.Top>(success: S) => Schema.Union([Failure, success])
const Done = Schema.UndefinedOr(Failure)
const OnBackend = { backend: Schema.String }
const OnRoutine = { backend: Schema.String, id: Schema.String }

/**
 * DynWork's routines, held by the main process: scheduled and recurring agent tasks, local or remote. Every method
 * names its `backend` and answers a `Failure` instead of rejecting.
 */
export const Routines = Ipc.define({
  id: "dynwork.routines",
  state: State,
  events: {
    /** A run changed state, as it happens. The routines in `state` follow right after. */
    run: Run,
    /** The user clicked a notification: the window in focus opens the run in place. */
    open: Run,
  },
  methods: {
    /** Reads every backend again and pushes `state`. */
    refresh: {},
    /**
     * Holds until the window aborts the call, and keeps live updates (`run` events, `state` pushes) coming from
     * backends that only produce them while watched, such as the farm's polling. Call it while a routines view is open.
     */
    watch: {},
    list: { input: Schema.Struct(OnBackend), output: Outcome(Schema.Array(Routine)) },
    get: { input: Schema.Struct(OnRoutine), output: Outcome(Routine) },
    create: { input: Schema.Struct({ ...OnBackend, definition: Definition }), output: Outcome(Routine) },
    /** The answer may carry a new ref: where `edit` is `replace`, the new routine replaces the old one. */
    update: { input: Schema.Struct({ ...OnRoutine, definition: Definition }), output: Outcome(Routine) },
    remove: { input: Schema.Struct(OnRoutine), output: Done },
    pause: { input: Schema.Struct(OnRoutine), output: Done },
    resume: { input: Schema.Struct(OnRoutine), output: Done },
    /** Starts a run now, whatever the schedule says. */
    start: { input: Schema.Struct(OnRoutine), output: Outcome(Run) },
    /** Makes this device the one that runs a routine of another device; `unsupported` for a backend without owners. */
    move: { input: Schema.Struct(OnRoutine), output: Done },
    cancel: { input: Schema.Struct({ ...OnBackend, run: Schema.String }), output: Done },
    /** Newest first. Without `routine`: every run the backend knows (Activity). */
    runs: {
      input: Schema.Struct({
        ...OnBackend,
        routine: Schema.optional(Schema.String),
        cursor: Schema.optional(Schema.String),
      }),
      output: Outcome(RunPage),
    },
    transcript: { input: Schema.Struct({ ...OnBackend, run: Schema.String }), output: Outcome(Transcript) },
    /** The user opened the run: it stops counting as unread. */
    viewed: { input: Schema.Struct({ ...OnBackend, run: Schema.String }) },
    /** Choices for a `Field.lookup` or the shared selects (`agents`, `models`, `skills`). */
    options: {
      input: Schema.Struct({ ...OnBackend, lookup: Schema.String, query: Schema.optional(Schema.String) }),
      output: Outcome(Schema.Array(Choice)),
    },
    /** Checks a definition without saving it; `invalid` carries one message per field. */
    validate: { input: Schema.Struct({ ...OnBackend, definition: Definition }), output: Done },
  },
})
