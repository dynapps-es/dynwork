export * as DynWorkRoutines from "./routines"

import { Effect, Option, Schema } from "effect"

// Routines from a chat. The tools run here, in the service; the routines live in DynWork's main process (its
// `routines` registry), which validates a proposal or a change, shows the approval card and creates, changes, deletes
// or runs the routine only when the user presses the card's button (pause and resume need no card). The bridge is this plugin's own RPC: a tool publishes a `request` event, main (which follows the
// plugin's events) answers it with the `answer` method, and `pending` hands main the requests still waiting after it
// (re)connects. Nothing here changes a routine: the tool only waits for main's answer. Only `effect` is imported: main
// bundles this file.

/** The RPC the plugin registers, called at `/api/rpc/<id>/<method>`. */
export const id = "dynwork.routines-chat"

/** The default zone of a schedule, when the user names none. */
export const zone = "Europe/Madrid"

/** One routine as the agent proposes it, in the Agents form's own terms. Main turns it into a routine `Definition`. */
export const Proposal = Schema.Struct({
  name: Schema.String.annotate({ description: "A short name for the task, such as 'Daily cluster check'." }),
  instructions: Schema.String.annotate({
    description:
      "The prompt the task runs each time, written for an agent that has none of this conversation: what to do, " +
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
    description:
      "Where it runs: 'local' (this computer or this Mac, only while Dynwork is open; the default) or 'farm' (Cloud, " +
      "formerly the Agent Farm or 'the farm', which keeps going with the user's laptop closed).",
  }),
  permissions: Schema.optional(Schema.Literals(["ask", "bypass"])).annotate({
    description:
      "'ask' (the default: edits, commands and connectors wait for the user) or 'bypass' (\"Don't ask\": the task " +
      "runs everything unattended). Choose 'bypass' only when the user asks for it.",
  }),
  folder: Schema.optional(Schema.String).annotate({
    description: "The absolute path of the project folder it works in, when it needs one.",
  }),
  connectors: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "The connectors (MCP server names, as list_scheduled_tasks gives them) it may use. Leave it out for all of " +
      "them; [] when the user wants none.",
  }),
  notify: Schema.optional(Schema.Literals(["failures", "every", "never"])).annotate({
    description: "When to tell the user: 'failures' (the default, only when something fails), 'every' run, or 'never'.",
  }),
})
export type Proposal = typeof Proposal.Type

/**
 * What changes in a routine: the proposal's fields, only those given. Where it runs is not one of them: a routine stays
 * on its backend.
 */
export const Changes = Schema.Struct({
  name: Schema.optional(Proposal.fields.name),
  instructions: Schema.optional(Proposal.fields.instructions),
  repeat: Schema.optional(Proposal.fields.repeat),
  time: Proposal.fields.time,
  days: Proposal.fields.days,
  day: Proposal.fields.day,
  cron: Proposal.fields.cron,
  timezone: Proposal.fields.timezone,
  permissions: Proposal.fields.permissions,
  folder: Proposal.fields.folder,
  connectors: Proposal.fields.connectors,
  notify: Proposal.fields.notify,
})
export type Changes = typeof Changes.Type

/** A task as the tools name it: `<backend>:<id>`, as `list_scheduled_tasks` gives it. */
const Task = Schema.String.annotate({
  description: "The task's id, as list_scheduled_tasks gives it, such as 'local:3f2a'.",
})

/**
 * What a tool asks main. `list`, `running` and `get` read; `propose`, `update`, `delete` and `run` may wait for the user's answer
 * on a card; `pause` and `resume` act at once. Every kind but `list`, `running` and `propose` names its `routine`.
 */
export const Request = Schema.Struct({
  id: Schema.String,
  /** The chat session the tool runs in: the card shows in it. */
  session: Schema.String,
  kind: Schema.Literals(["list", "running", "get", "propose", "update", "delete", "pause", "resume", "run"]),
  proposal: Schema.optional(Proposal),
  routine: Schema.optional(Schema.String),
  changes: Schema.optional(Changes),
})
export type Request = typeof Request.Type

/** Main's answer, as the text the agent reads. `error`: refused, cancelled or failed; nothing changed. */
export const Answer = Schema.Struct({ id: Schema.String, text: Schema.String, error: Schema.Boolean })
export type Answer = typeof Answer.Type

export const Withdrawn = Schema.Struct({ id: Schema.String })
export const Accepted = Schema.Struct({ accepted: Schema.Boolean })
export const Pending = Schema.Struct({ requests: Schema.Array(Request) })
export type Pending = typeof Pending.Type

/** How long a read, a pause or a resume waits for main. What waits for the user waits as long as it takes. */
export const listTimeout = "10 seconds"

/** What a tool says when Dynwork's app does not answer. */
export const closed = "Dynwork's app did not answer: scheduled tasks can be managed only while Dynwork is open."

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

// What people call a scheduled task, in the four languages of Dynwork's UI. Every description names it, so a request in
// any of those words leads the agent to these tools; the UI word is task (`decisions.md`, 17-11-2026), routine only an
// alias. `words` adds the tool's own verbs in each language.
const aka = (words?: { es: string; fr: string; nl: string }) =>
  "scheduled task, also called a routine, recurring task, automation or cron job (ES tarea programada, rutina" +
  (words
    ? `, ${words.es}; FR tâche planifiée, ${words.fr}; NL geplande taak, ${words.nl})`
    : "; FR tâche planifiée; NL geplande taak)")

// What every scheduled-task tool says once, in the list's description: the agent reads every tool's description anyway.
// What they are not for names the tools a request could reach instead: OpenCode's project `automation_*` tools (flag
// `automations`, formerly `schedule_*` and `schedules`), its `todowrite`, and the agent-farm connector, which runs farm
// tasks now.
const rules =
  'Words people use: scheduled task, routine, recurring or repeating task, automation, cron-like job, "every morning", ' +
  '"every Monday", "daily at 8"; ES tarea programada, rutina, automatización, "todos los días", "cada lunes"; FR ' +
  'tâche planifiée, routine, automatisation, "tous les jours"; NL geplande taak, routine, automatisering, "elke dag". ' +
  'A task runs on this computer ("this Mac", where \'local\') or on Cloud, formerly the Agent Farm or "the farm" ' +
  "(where 'farm'). These are direct tools, not in Code Mode's search. Anything recurring, or meant to show in Tasks, is a " +
  "scheduled task: never a shell crontab, a launchd job, a reminder app, todowrite (this conversation's to-do list) or " +
  "OpenCode's automation_* tools, which only prompt a conversation of this project later (use those just for a one-off " +
  "follow-up here, such as \"check again in 10 minutes\"). To schedule on the farm use create_scheduled_task with " +
  "where 'farm', never the agent-farm connector's tools; that connector only runs a farm task once, now. " +
  "Scheduled tasks are managed only with the *_scheduled_task(s) tools: never edit Dynwork's files or its database, and " +
  "never call its or OpenCode's APIs or CLI to change one. Before creating a task, call list_scheduled_tasks; if one " +
  "already does the same thing, propose update_scheduled_task instead of a new one, and to rename a task use " +
  "update_scheduled_task. Permissions: 'Ask me' makes a scheduled run wait for the user's approval before it edits " +
  'files or runs shell commands, so a task meant to run unattended needs "Don\'t ask", which lets it edit files, run ' +
  "commands and use its connectors without asking. When the task runs commands, ask the user which one they want and " +
  'say what "Don\'t ask" allows. When the user names a target that does not match what you see (a cluster context ' +
  "missing from the kubeconfig, a folder that does not exist), ask them instead of silently changing the instructions. " +
  "Reply in the user's language."

type Context = { readonly sessionID: string; readonly id: string }

/** The scheduled-task tools, over an emitter of the Location they run in. */
export function tools(emitter: Emitter) {
  // A read, a pause or a resume: main answers at once, or the app is closed.
  const quick = (request: Request) =>
    ask(emitter, request).pipe(
      Effect.timeoutOption(listTimeout),
      Effect.map((answered) =>
        result(Option.getOrElse(answered, () => ({ id: request.id, text: closed, error: true }))),
      ),
    )
  // Waits for the user's answer on a card, as long as it takes.
  const waits = (request: Request) => ask(emitter, request).pipe(Effect.map(result))
  const target = Schema.Struct({ id: Task })
  return {
    list: {
      name: "list_scheduled_tasks",
      description:
        `When the user asks about a ${aka()}: which they have, whether one exists, or before creating, changing or ` +
        "removing one. Lists the user's Dynwork scheduled tasks, one line each: id, name, where it runs, schedule, state, " +
        "permissions, connectors, next run, last run and the start of its instructions; then the connectors a task on " +
        `this computer may use. ${rules}`,
      input: Schema.Struct({}),
      options: { codemode: false },
      execute: (_input: unknown, context: Context) =>
        quick({ id: context.id, session: context.sessionID, kind: "list" }),
    },
    running: {
      name: "list_running_tasks",
      description:
        "When the user asks what is running now or whether a run waits for them, the runs of a " +
        `${aka({ es: "qué se está ejecutando", fr: "ce qui tourne", nl: "wat er nu draait" })}. ` +
        "Lists every run of a Dynwork task going right now, on this computer and on Cloud: the task, where, " +
        'when it started, its state ("Waiting for your permission" when it waits for the user) and its conversation ' +
        "id. Use it to answer what is running.",
      input: Schema.Struct({}),
      options: { codemode: false },
      execute: (_input: unknown, context: Context) =>
        quick({ id: context.id, session: context.sessionID, kind: "running" }),
    },
    get: {
      name: "get_scheduled_task",
      description:
        `When the user asks about one ${aka()}: what it does, when it runs next, how its last runs went or why ` +
        "one failed. Reads one Dynwork scheduled task in full: its definition in create_scheduled_task's terms (as " +
        "update_scheduled_task takes it), its state and next run, and its last runs with their state, reason, time and " +
        "conversation id.",
      input: target,
      options: { codemode: false },
      execute: (input: { readonly id: string }, context: Context) =>
        quick({ id: context.id, session: context.sessionID, kind: "get", routine: input.id }),
    },
    create: {
      name: "create_scheduled_task",
      description:
        'When the user wants something done on a schedule or again and again ("every morning", "every Monday", ' +
        '"daily at 8", "schedule this"; ES "todos los días", "cada lunes", "prográmalo"; FR "tous les jours", ' +
        `\"chaque lundi\"; NL \"elke dag\", \"elke maandag\"), it is a ${aka()}. Proposes a new Dynwork scheduled task: a ` +
        'prompt an agent runs on a schedule, on this computer or on Cloud (formerly the Agent Farm: "on the farm" is ' +
        "where 'farm'). Call list_scheduled_tasks first: " +
        "if a task already does this, use update_scheduled_task instead. Before calling it, ask the user what it should " +
        "do and what the result should be, how often and when it runs (times are " +
        `${zone} unless they say otherwise), and how to be told when it finishes; ask where it runs (this computer or ` +
        "Cloud), the project folder and the connectors only when they matter, and 'Ask me' or \"Don't ask\" " +
        "whenever the task runs commands. The user sees the proposal on a card and creates it with Schedule, or " +
        "cancels; this tool waits for that answer. It never creates a task by itself. If the user cancels, ask what to " +
        "change.",
      input: Proposal,
      options: { codemode: false },
      execute: (input: Proposal, context: Context) =>
        waits({ id: context.id, session: context.sessionID, kind: "propose", proposal: input }),
    },
    update: {
      name: "update_scheduled_task",
      description:
        "When the user wants to change, rename, reschedule or edit a " +
        `${aka({ es: "cambiar, renombrar", fr: "modifier, renommer", nl: "wijzigen, hernoemen" })}; ` +
        "never create a new task to change one. Changes a Dynwork scheduled task: its id plus only the fields to " +
        "change, in create_scheduled_task's terms (a " +
        "rename is just `name`; a new time is `time`, with `repeat` only when how often changes). Fields left out stay " +
        "as they are. The user sees each change as before → after on a card and saves it, or cancels; this tool waits " +
        "for that answer and changes nothing by itself. Where a task runs cannot change.",
      input: Schema.Struct({ id: Task, ...Changes.fields }),
      options: { codemode: false },
      execute: (input: Changes & { readonly id: string }, context: Context) => {
        const { id, ...changes } = input
        return waits({ id: context.id, session: context.sessionID, kind: "update", routine: id, changes })
      },
    },
    delete: {
      name: "delete_scheduled_task",
      description:
        `When the user wants to delete or remove a ${aka({ es: "borrar, eliminar", fr: "supprimer", nl: "verwijderen" })}. ` +
        "Deletes a Dynwork scheduled task. The user confirms it on a card; this tool waits for that answer and deletes " +
        "nothing by itself. Prefer pause_scheduled_task when the user may want it back.",
      input: target,
      options: { codemode: false },
      execute: (input: { readonly id: string }, context: Context) =>
        waits({ id: context.id, session: context.sessionID, kind: "delete", routine: input.id }),
    },
    pause: {
      name: "pause_scheduled_task",
      description:
        "When the user wants to pause, stop for now or turn off a " +
        `${aka({ es: "pausar, desactivar", fr: "mettre en pause", nl: "pauzeren" })}. ` +
        "Pauses a Dynwork scheduled task at once: it does not run on its schedule until it is resumed.",
      input: target,
      options: { codemode: false },
      execute: (input: { readonly id: string }, context: Context) =>
        quick({ id: context.id, session: context.sessionID, kind: "pause", routine: input.id }),
    },
    resume: {
      name: "resume_scheduled_task",
      description:
        `When the user wants to resume or turn back on a ${aka({ es: "reanudar, reactivar", fr: "reprendre", nl: "hervatten" })}. ` +
        "Resumes a paused Dynwork scheduled task at once: it runs on its schedule again.",
      input: target,
      options: { codemode: false },
      execute: (input: { readonly id: string }, context: Context) =>
        quick({ id: context.id, session: context.sessionID, kind: "resume", routine: input.id }),
    },
    run: {
      name: "run_scheduled_task",
      description:
        "When the user wants to run a " +
        `${aka({ es: "ejecutar ahora", fr: "lancer maintenant", nl: "nu uitvoeren" })} now, once, outside its ` +
        'schedule. Starts a run of a Dynwork scheduled task now, whatever its schedule. A "Don\'t ask" task starts ' +
        "only after the " +
        "user confirms it on a card; an 'Ask me' one starts at once, as its run asks before edits and commands anyway. " +
        "The run's result shows in Tasks, not here.",
      input: target,
      options: { codemode: false },
      execute: (input: { readonly id: string }, context: Context) =>
        waits({ id: context.id, session: context.sessionID, kind: "run", routine: input.id }),
    },
  }
}

// The agent reads the text either way; an `error` answer is still a result, so the agent can ask and propose again.
function result(answered: Answer) {
  return { content: answered.text, metadata: { error: answered.error } }
}
