import { Schema } from "effect"
import { Ipc } from "@opencode/plugin/gui"

// The cloud chats contract: what crosses between main, which talks to the active instance's `/api/dynwork/chats/v1`,
// and a window. Times are epoch milliseconds. Messages and live events keep OpenCode's v2 shapes (`SessionMessageInfo`
// and the session log's events) as plain JSON, so the session UI renders them unchanged; nothing else of OpenCode is
// involved. No credential ever crosses: main holds the account's JWT.

/** A model the user may chat with, as `GET /models` lists it. */
export const Model = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** The provider's id. */
  provider: Schema.String,
  /** The provider's display name; the id when the instance sends none. */
  providerName: Schema.String,
  reasoning: Schema.Boolean,
  tools: Schema.Boolean,
})
export type Model = typeof Model.Type

/** A model as OpenCode names one: `ModelRef`. */
export const ModelRef = Schema.Struct({ providerID: Schema.String, id: Schema.String })
export type ModelRef = typeof ModelRef.Type

/** A chat thread, as the last read of the feed or the last write left it. */
export const Thread = Schema.Struct({
  /** A `ses_…` id, chosen by the device that created it. */
  id: Schema.String,
  title: Schema.String,
  model: Schema.optional(ModelRef),
  /** The `If-Match` of the next write. */
  revision: Schema.Number,
  archived: Schema.optional(Schema.Number),
  created: Schema.Number,
  updated: Schema.Number,
})
export type Thread = typeof Thread.Type

/**
 * Where the chats stand:
 * - `ready`: the feed was read; `threads` is the list.
 * - `loading`: the first read is under way.
 * - `signed-out`: no active, signed-in account.
 * - `unreachable`: the instance did not answer; `threads` keeps the last list.
 */
export const Status = Schema.Literals(["ready", "loading", "signed-out", "unreachable"])
export type Status = typeof Status.Type

/** What main pushes to every window. */
export const State = Schema.Struct({
  status: Status,
  /** Newest change first. Archived threads are in it, with `archived`. */
  threads: Schema.Array(Thread),
})
export type State = typeof State.Type

/**
 * A failure, as data: an Ipc rejection reaches a window as plain text, so nothing is thrown.
 * - `signed-out`, `unreachable`: the instance cannot be asked right now.
 * - `conflict`: the thread changed elsewhere since its `revision`; the state already holds the current row.
 * - `not-found`, `invalid`: no such thread, or a request the instance refused. `failed`: anything else.
 */
export const Failure = Schema.Struct({
  code: Schema.Literals(["signed-out", "unreachable", "conflict", "not-found", "invalid", "failed"]),
  message: Schema.String,
  retryable: Schema.Boolean,
})
export type Failure = typeof Failure.Type

/** One page of a thread's history, newest page first, each message an OpenCode `SessionMessageInfo`. */
export const Page = Schema.Struct({
  messages: Schema.Array(Schema.Json),
  /** Pass it back as `before` for the older page; absent, there is none. */
  before: Schema.optional(Schema.String),
})
export type Page = typeof Page.Type

/** A live event of a followed thread: OpenCode's v2 envelope (`type`, `data`, `created`, `durable.seq`). */
export const Event = Schema.Struct({ thread: Schema.String, event: Schema.Json })
export type Event = typeof Event.Type

export function isFailure(value: unknown): value is Failure {
  return typeof value === "object" && value !== null && "code" in value && "message" in value && "retryable" in value
}

const Outcome = <S extends Schema.Top>(success: S) => Schema.Union([Failure, success])
const Done = Schema.UndefinedOr(Failure)
const OnThread = { id: Schema.String }

/** DynWork's cloud chats, held by the main process. Every method answers a `Failure` instead of rejecting. */
export const Chats = Ipc.define({
  id: "dynwork.chats",
  state: State,
  events: {
    /** A live event of a thread a window follows. */
    event: Event,
  },
  methods: {
    /** Reads the change feed now and pushes `state`. */
    refresh: {},
    models: { output: Outcome(Schema.Array(Model)) },
    /** Creates a thread under the id the window chose. */
    create: {
      input: Schema.Struct({ ...OnThread, title: Schema.String, model: Schema.optional(ModelRef) }),
      output: Outcome(Thread),
    },
    /** Renames a thread, changes its model, or archives or unarchives it, at its current revision. */
    update: {
      input: Schema.Struct({
        ...OnThread,
        title: Schema.optional(Schema.String),
        model: Schema.optional(ModelRef),
        archived: Schema.optional(Schema.Boolean),
      }),
      output: Outcome(Thread),
    },
    remove: { input: Schema.Struct(OnThread), output: Done },
    messages: {
      input: Schema.Struct({
        ...OnThread,
        before: Schema.optional(Schema.String),
        limit: Schema.optional(Schema.Number),
      }),
      output: Outcome(Page),
    },
    /**
     * Starts a reply. `messageID` is the window's, so a retry of the same prompt is not sent twice. Answers the
     * assistant message's id.
     */
    prompt: {
      input: Schema.Struct({
        ...OnThread,
        messageID: Schema.String,
        text: Schema.String,
        model: Schema.optional(ModelRef),
      }),
      output: Outcome(Schema.Struct({ messageID: Schema.String })),
    },
    /** Stops the running reply; its partial text is kept. */
    interrupt: { input: Schema.Struct(OnThread), output: Done },
    /**
     * Holds until the window aborts it, and meanwhile sends the thread's live events after `after` (a durable seq) as
     * `event`s, resuming where it left off when the connection drops.
     */
    follow: { input: Schema.Struct({ ...OnThread, after: Schema.optional(Schema.Number) }) },
  },
})
