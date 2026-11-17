export * as DynWorkRoutines from "./routines"

import { Effect, Option, Schema } from "effect"

// Routines from a chat. The tools run here, in the service; the routines live in DynWork's main process (its
// `routines` registry), which validates a proposal, shows the approval card and creates the routine only when the user
// presses Schedule. The bridge is this plugin's own RPC: a tool publishes a `request` event, main (which follows the
// plugin's events) answers it with the `answer` method, and `pending` hands main the requests still waiting after it
// (re)connects. Nothing here creates a routine: the tool only waits for main's answer. Only `effect` is imported: main
// bundles this file.

/** The RPC the plugin registers, called at `/api/rpc/<id>/<method>`. */
export const id = "dynwork.routines-chat"

/** The default zone of a schedule, when the user names none. */
export const zone = "Europe/Madrid"

/** One routine as the agent proposes it, in the Agents form's own terms. Main turns it into a routine `Definition`. */
export const Proposal = Schema.Struct({
  name: Schema.String.annotate({ description: "A short name for the routine, such as 'Daily cluster check'." }),
  instructions: Schema.String.annotate({
    description:
      "The prompt the routine runs each time, written for an agent that has none of this conversation: what to do, " +
      "where, and what the result should be.",
  }),
  repeat: Schema.Literals(["manual", "daily", "weekdays", "weekly", "monthly", "cron"]).annotate({
    description:
      "How often it runs: 'manual' (only when the user starts it), 'daily', 'weekdays' (Monday to Friday), 'weekly' " +
      "(on `days`), 'monthly' (on `day`) or 'cron' (a five-field `cron`, for anything else).",
  }),
  time: Schema.optional(Schema.String).annotate({
    description: "The time it runs, 24-hour HH:MM, for daily, weekdays, weekly and monthly.",
  }),
  days: Schema.optional(Schema.Array(Schema.Number)).annotate({
    description: "For weekly: the weekdays it runs, 0 (Sunday) to 6 (Saturday).",
  }),
  day: Schema.optional(Schema.Number).annotate({ description: "For monthly: the day of the month, 1 to 31." }),
  cron: Schema.optional(Schema.String).annotate({
    description: "For repeat 'cron': five fields, minute first, such as '0 8 * * 1'.",
  }),
  timezone: Schema.optional(Schema.String).annotate({
    description: `The IANA zone the time is read in. Default ${zone}, unless the user says otherwise.`,
  }),
  where: Schema.optional(Schema.Literals(["local", "farm"])).annotate({
    description: "Where it runs: 'local' (this computer, only while Dynwork is open; the default) or 'farm' (the Agent Farm).",
  }),
  permissions: Schema.optional(Schema.Literals(["ask", "bypass"])).annotate({
    description:
      "'ask' (the default: edits, commands and connectors wait for the user) or 'bypass' (\"Don't ask\": the routine " +
      "runs everything unattended). Choose 'bypass' only when the user asks for it.",
  }),
  folder: Schema.optional(Schema.String).annotate({
    description: "The absolute path of the project folder it works in, when it needs one.",
  }),
  connectors: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "The connectors (MCP server names) it may use. Leave it out for all of them.",
  }),
  notify: Schema.optional(Schema.Literals(["failures", "every", "never"])).annotate({
    description: "When to tell the user: 'failures' (the default, only when something fails), 'every' run, or 'never'.",
  }),
})
export type Proposal = typeof Proposal.Type

/** What a tool asks main: the user's routines (`list`), or to show a proposal for approval (`propose`). */
export const Request = Schema.Struct({
  id: Schema.String,
  /** The chat session the tool runs in: the card shows in it. */
  session: Schema.String,
  kind: Schema.Literals(["list", "propose"]),
  proposal: Schema.optional(Proposal),
})
export type Request = typeof Request.Type

/** Main's answer, as the text the agent reads. `error`: refused, cancelled or failed; nothing was created. */
export const Answer = Schema.Struct({ id: Schema.String, text: Schema.String, error: Schema.Boolean })
export type Answer = typeof Answer.Type

export const Withdrawn = Schema.Struct({ id: Schema.String })
export const Accepted = Schema.Struct({ accepted: Schema.Boolean })
export const Pending = Schema.Struct({ requests: Schema.Array(Request) })
export type Pending = typeof Pending.Type

/** How long the list waits for main. A proposal waits for the user as long as it takes. */
export const listTimeout = "10 seconds"

/** What a tool says when Dynwork's app does not answer. */
export const closed = "Dynwork's app did not answer: routines can be listed and created only while Dynwork is open."

export interface Emitter {
  readonly request: (request: Request) => Effect.Effect<void>
  readonly withdraw: (id: string) => Effect.Effect<void>
}

interface Waiting {
  readonly request: Request
  readonly resolve: (answer: Answer) => void
}

// The service activates the plugin once per Location and imports the module afresh each time, but main answers on
// whichever Location takes the call: the waiting requests live in one process-wide slot.
const slot = globalThis as typeof globalThis & { __dynworkRoutines?: Map<string, Waiting> }
const waiting: Map<string, Waiting> = (slot.__dynworkRoutines ??= new Map())

/**
 * Publishes `request` and waits for main's answer. An interrupted wait (the user stopped the step) withdraws the
 * request, so main drops its card.
 */
export function ask(emitter: Emitter, request: Request) {
  return Effect.callback<Answer>((resume) => {
    waiting.set(request.id, { request, resolve: (answer) => resume(Effect.succeed(answer)) })
    Effect.runFork(emitter.request(request))
    return Effect.suspend(() => (waiting.delete(request.id) ? emitter.withdraw(request.id) : Effect.void))
  })
}

/** Main's `answer`: settles the request it names; false when nothing waits for it (withdrawn, or answered before). */
export function answer(input: Answer) {
  const found = waiting.get(input.id)
  if (!found) return { accepted: false }
  waiting.delete(input.id)
  found.resolve(input)
  return { accepted: true }
}

/** Main's `pending`: the requests still waiting, for a main that (re)connected after they were published. */
export function pending(): Pending {
  return { requests: [...waiting.values()].map((item) => item.request) }
}

/** The two tools, over an emitter of the Location they run in. */
export function tools(emitter: Emitter) {
  return {
    list: {
      name: "routines_list",
      description:
        "Lists the user's Dynwork routines (scheduled agent tasks): name, where it runs, schedule and state. Call it " +
        "before proposing a routine, to avoid creating one that already exists.",
      input: Schema.Struct({}),
      options: { codemode: false },
      execute: (_input: unknown, context: { readonly sessionID: string; readonly id: string }) =>
        ask(emitter, { id: context.id, session: context.sessionID, kind: "list" }).pipe(
          Effect.timeoutOption(listTimeout),
          Effect.map((answered) => result(Option.getOrElse(answered, () => ({ id: context.id, text: closed, error: true })))),
        ),
    },
    create: {
      name: "routines_create",
      description:
        "Proposes a Dynwork routine: a prompt an agent runs on a schedule. Before calling it, ask the user what it " +
        "should do and what the result should be, how often and when it runs (times are " +
        `${zone} unless they say otherwise), and how to be told when it finishes; ask where it runs (this computer or ` +
        "the Agent Farm), 'Ask me' or 'Don't ask', the project folder and the connectors only when they matter. Call " +
        "routines_list first. The user sees the proposal on a card and creates it with Schedule, or cancels; this " +
        "tool waits for that answer. It never creates a routine by itself. If the user cancels, ask what to change.",
      input: Proposal,
      options: { codemode: false },
      execute: (input: Proposal, context: { readonly sessionID: string; readonly id: string }) =>
        ask(emitter, { id: context.id, session: context.sessionID, kind: "propose", proposal: input }).pipe(
          Effect.map(result),
        ),
    },
  }
}

// The agent reads the text either way; an `error` answer is still a result, so the agent can ask and propose again.
function result(answered: Answer) {
  return { content: answered.text, metadata: { error: answered.error } }
}
