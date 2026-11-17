export * as RoutinesChat from "./chat"

import { Schema } from "effect"
import type { OpenCodeClient } from "@opencode/client/promise"
import type { MainContext } from "@opencode/plugin/gui/main"
import { DynWorkRoutines } from "@dynwork/server-plugin/routines"
import { fail, type Backend, type Registry } from "./backend"
import {
  Chat,
  chatPrompt,
  Definition,
  isFailure,
  type Card,
  type Failure,
  type Personal,
  type Ref,
  type Routine,
  type Run,
  type Template,
} from "./contract"
import { RoutinesFarm } from "./farm/backend"
import { RoutinesLocal } from "./local/backend"
import { RoutinesTemplates } from "./templates"
import en from "../views/agents/en"
import { cardChanges, cardRows, instructionsText, runTime, scheduleText } from "../views/agents/format"
import { stateKey } from "../views/agents/routine"
import { cronOf, presetOf, scheduleProblem, upcoming, type Preset } from "../views/agents/schedule"

// Tasks (routines) from a chat, main's side. The server plugin's tools (`@dynwork/server-plugin/routines`) publish
// requests on its RPC; main follows them and answers. Reads (`list`, `running`, `get`) and the reversible `pause` and
// `resume` are answered at once. A new task, a change, a deletion and a run of a "Don't ask" task are validated as the
// form validates (the `Definition` schema and the backend's own `validate`) and shown as a card in the windows (the
// `dynwork.routines.chat` Ipc): only the card's button does it, through the routines Ipc; Cancel, a refusal and a
// withdrawn request change nothing. The session's permissions ("Don't ask" too) and the app's auto-approve play no part,
// as the card is not a permission. Every change goes to the routine's own backend through the registry.
//
// A task made from a template (`Routine.template`) keeps what the template locks (`RoutinesTemplates`): an update that
// `violates` it is refused before any card, a mandatory one is not deleted, and `activate_task_template` shows the card
// of the task `RoutinesTemplates.activate` makes from the template and the user's personal part.

export interface Options {
  registry: Registry
  /** Whether the `farm` backend is the Agent Farm's (`RoutinesFarm.enabled`), not its demo. */
  farm: boolean
  /** Sends main's answer to the waiting tool. */
  answer: (answer: DynWorkRoutines.Answer) => Promise<unknown>
  /** The routines Ipc's own methods, so every window reads the change. */
  act: Act
  /** The cards changed. */
  changed: () => void
  now: () => number
}

export interface Act {
  create: (backend: string, definition: Definition) => Promise<Routine | Failure>
  update: (ref: Ref, definition: Definition) => Promise<Routine | Failure>
  remove: (ref: Ref) => Promise<Failure | undefined>
  pause: (ref: Ref) => Promise<Failure | undefined>
  resume: (ref: Ref) => Promise<Failure | undefined>
  start: (ref: Ref) => Promise<Run | Failure>
}

/** The chat's logic, with no service and no window: what `setup` wires, and what the tests drive. */
export function make(options: Options) {
  const cards = new Map<string, Card>()
  // Requests being handled or shown, so the same one arriving by event and by `pending` is handled once.
  const known = new Set<string>()

  const reply = (id: string, text: string, error: boolean) => options.answer({ id, text, error }).catch(() => undefined)
  const label = async (backend: Backend) => (await backend.capabilities()).label

  async function list(request: DynWorkRoutines.Request) {
    const lines = await Promise.all(
      backends().map(async (id) => {
        const backend = options.registry.get(id)
        if (!backend) return []
        const where = await label(backend)
        const routines = await backend.list()
        if (isFailure(routines)) return [`- ${where}: could not be read (${routines.message})`]
        return routines.map((routine) => describe(routine, where))
      }),
    )
    const all = lines.flat()
    // The connectors a local task may name, so the agent proposes real ones.
    const connectors = await options.registry.get(RoutinesLocal.id)?.options("connectors")
    const available =
      connectors && !isFailure(connectors)
        ? `\nConnectors available to tasks on this computer: ${connectors.map((choice) => choice.value).join(", ") || "none"}.`
        : ""
    await reply(request.id, (all.length === 0 ? "The user has no scheduled tasks yet." : all.join("\n")) + available, false)
  }

  // Every run going right now, on every backend: its task, where, since when, and whether it waits for the user.
  async function running(request: DynWorkRoutines.Request) {
    const lines = await Promise.all(
      backends().map(async (id) => {
        const backend = options.registry.get(id)
        if (!backend) return []
        const where = await label(backend)
        const page = await backend.runs({}).catch(() => fail("failed", "The runs could not be read."))
        if (isFailure(page)) return [`- ${where}: could not be read (${page.message})`]
        const names = await backend.list()
        const name = (run: Run) =>
          (isFailure(names) ? undefined : names.find((routine) => routine.ref.id === run.routine?.id))?.definition.name
        return page.items
          .filter((run) => run.state === "running" || run.state === "queued")
          .map((run) =>
            [
              `- ${name(run) ?? run.title}`,
              ...(run.routine ? [taskId(run.routine)] : []),
              where,
              words(stateKey(run)),
              ...(run.started === undefined ? [] : [`started ${stamp(run.started)}`]),
              ...(run.conversation.kind === "session" ? [`conversation ${run.conversation.session}`] : []),
            ].join(" · "),
          )
      }),
    )
    const all = lines.flat()
    await reply(request.id, all.length === 0 ? "Nothing is running right now." : all.join("\n"), false)
  }

  async function get(request: DynWorkRoutines.Request, found: Found) {
    const page = await found.backend.runs({ routine: found.routine.ref.id }).catch(() => fail("failed", "unreadable"))
    const runs = isFailure(page)
      ? [`Runs could not be read (${page.message}).`]
      : page.items.slice(0, 5).map((run) =>
          [
            `- ${words(stateKey(run))}`,
            ...(run.reason && run.reason !== "permission" ? [run.reason] : []),
            ...(runTime(run) === undefined ? [] : [stamp(runTime(run) ?? 0)]),
            ...(run.conversation.kind === "session" ? [`conversation ${run.conversation.session}`] : []),
          ].join(" · "),
        )
    const routine = found.routine
    await reply(
      request.id,
      [
        describe(routine, found.label).slice(2),
        `Definition, in create_scheduled_task's terms: ${JSON.stringify(proposalOf(routine))}`,
        runs.length === 0 ? "No runs yet." : `Last runs, newest first:\n${runs.join("\n")}`,
      ].join("\n"),
      false,
    )
  }

  // The templates the user sees, with what each sets and asks, and whether they already have it. They live on this computer.
  async function templates(request: DynWorkRoutines.Request) {
    const backend = options.registry.get(RoutinesLocal.id)
    const offered = await backend?.templates?.().catch(() => fail("failed", "The templates could not be read."))
    if (!backend || !offered) return reply(request.id, "No templates are available in this Dynwork.", true)
    if (isFailure(offered)) return reply(request.id, `Templates could not be read: ${offered.message}`, true)
    if (offered.templates.length === 0)
      return reply(request.id, "Dynapps offers the user no templates right now.", false)
    const tasks = await backend.list()
    const owned = (template: Template) =>
      isFailure(tasks) ? undefined : tasks.find((task) => task.template?.id === template.id)
    const linked = (template: Template) => offered.links.find((link) => link.id === template.id)
    await reply(
      request.id,
      offered.templates
        .map((template) => describeTemplate(template, owned(template), linked(template)?.state))
        .join("\n"),
      false,
    )
  }

  async function activate(request: DynWorkRoutines.Request, activation: DynWorkRoutines.Activation) {
    const backend = options.registry.get(RoutinesLocal.id)
    const offered = await backend?.templates?.().catch(() => fail("failed", "The templates could not be read."))
    if (!backend || !offered) return refuse(request, fail("unsupported", "No templates are available in this Dynwork."))
    if (isFailure(offered)) return refuse(request, offered)
    const template = offered.templates.find((candidate) => candidate.id === activation.id)
    if (!template)
      return refuse(
        request,
        fail("not-found", `No template has the id "${activation.id}". Call list_task_templates for the ids.`),
      )
    if (template.mandatory)
      return refuse(
        request,
        fail("conflict", "Dynapps assigns this template to the user: its task arrives on its own."),
      )
    const tasks = await backend.list()
    const twin = isFailure(tasks) ? undefined : tasks.find((task) => task.template?.id === template.id)
    if (twin || offered.links.some((link) => link.id === template.id))
      return refuse(
        request,
        fail(
          "conflict",
          `The user already has this template active${twin ? ` as ${taskId(twin.ref)}` : " on another computer"}.`,
        ),
      )
    const personal = personalOf(activation, template)
    if (isFailure(personal)) return refuse(request, personal)
    const built = RoutinesTemplates.activate(template, personal)
    if (isFailure(built)) return refuse(request, built)
    const checked = await check(backend, built)
    if (isFailure(checked)) return refuse(request, checked)
    // The card is the user's confirmation of a template that runs without asking: it shows the permissions row.
    show({
      id: request.id,
      session: request.session,
      kind: "create",
      backend: RoutinesLocal.id,
      label: await label(backend),
      definition: checked,
      input: JSON.stringify(activation, null, 2),
    })
  }

  async function propose(request: DynWorkRoutines.Request, proposal: DynWorkRoutines.Proposal) {
    const where = proposal.where ?? "local"
    const id = where === "farm" ? RoutinesFarm.id : RoutinesLocal.id
    const backend = options.registry.get(id)
    if (where === "farm" && !options.farm) return refuse(request, fail("unsupported", cloud))
    if (!backend) return refuse(request, fail("unreachable", "Dynwork cannot reach where this task would run."))
    const built = definitionOf(proposal, options.now())
    if (isFailure(built)) return refuse(request, built)
    // JESÚS: a farm proposal reaches your `validate` here and, once the user presses Schedule, your `create`.
    const checked = await check(backend, built)
    if (isFailure(checked)) return refuse(request, checked)
    show({ id: request.id, session: request.session, kind: "create", backend: id, label: await label(backend), definition: checked, input: JSON.stringify(proposal, null, 2) })
  }

  async function update(request: DynWorkRoutines.Request, found: Found, changes: DynWorkRoutines.Changes) {
    const built = changed(found.routine, changes, options.now())
    if (isFailure(built)) return refuse(request, built)
    const locked = await lockedBy(found, built)
    if (locked) return refuse(request, locked)
    // JESÚS: a change to a farm task reaches your `validate` here and, once the user presses Save, your `update`.
    const checked = await check(found.backend, built)
    if (isFailure(checked)) return refuse(request, checked)
    if (cardChanges(words, found.routine.definition, checked, found.label).length === 0)
      return refuse(request, fail("invalid", "These values are the ones the task already has."))
    show({ ...cardOf(request, found, "update"), definition: checked, before: found.routine.definition, input: JSON.stringify(changes, null, 2) })
  }

  async function run(request: DynWorkRoutines.Request, found: Found) {
    // "Ask me": the run asks before edits and commands anyway, so it starts at once.
    if (found.routine.definition.options.permissions === "bypass") return show(cardOf(request, found, "run"))
    known.delete(request.id)
    await started(request.id, subject(found.routine.definition, found.routine.ref, found.label), await options.act.start(found.routine.ref))
  }

  // Pause and resume are reversible and run nothing: they happen at once.
  async function toggle(request: DynWorkRoutines.Request, found: Found, on: boolean) {
    const failure = await (on ? options.act.resume : options.act.pause)(found.routine.ref)
    if (failure) return reply(request.id, `Not done: ${failure.message}\nNothing changed.`, true)
    const name = subject(found.routine.definition, found.routine.ref, found.label).name
    if (!on) return reply(request.id, `Paused ${name}: it does not run on its schedule until it is resumed.`, false)
    const now = await found.backend.get(found.routine.ref.id)
    const next = !isFailure(now) && now.next !== undefined ? ` Next run: ${stamp(now.next, now.definition.schedule?.timezone)}.` : ""
    return reply(request.id, `Resumed ${name}.${next}`, false)
  }

  function show(card: Card) {
    if (!known.has(card.id)) return
    cards.set(card.id, card)
    options.changed()
  }

  async function refuse(request: DynWorkRoutines.Request, failure: Failure) {
    known.delete(request.id)
    const fields = Object.entries(failure.fields ?? {}).map(([key, message]) => `\n- ${key}: ${message}`)
    const creating = request.kind === "propose" || request.kind === "activate"
    await reply(
      request.id,
      `${creating ? "Not proposed" : "Not done"}: ${failure.message}${fields.join("")}\n${creating ? "Nothing was created." : "Nothing changed."}`,
      true,
    )
  }

  // The routine a request names, on its own backend; `not-found` says how to find the ids.
  async function find(name: string | undefined): Promise<Found | Failure> {
    const ref = refOf(name ?? "")
    const unknown = fail("not-found", `No scheduled task has the id "${name ?? ""}". Call list_scheduled_tasks for the ids.`)
    if (!ref) return unknown
    if (ref.backend === RoutinesFarm.id && !options.farm) return fail("unsupported", cloud)
    const backend = options.registry.get(ref.backend)
    if (!backend) return unknown
    // JESÚS: every tool that names a farm task reaches your `get` first, then `update`, `remove`, `pause`, `resume` or
    // `start` on the routine's own backend. Until they are written, their "not implemented" is the tool's answer.
    const routine = await backend.get(ref.id).catch(() => fail("failed", "The task could not be read."))
    if (isFailure(routine)) return routine.code === "not-found" ? unknown : routine
    return { backend, routine, label: await label(backend) }
  }

  async function check(backend: Backend, built: Definition) {
    const decoded = Schema.decodeUnknownExit(Definition)(built)
    if (decoded._tag === "Failure") return fail("invalid", "This is not a task.")
    const invalid = await backend.validate(decoded.value).catch(() => fail("failed", "The task could not be checked."))
    return invalid ?? decoded.value
  }

  async function request(input: DynWorkRoutines.Request) {
    if (known.has(input.id)) return
    known.add(input.id)
    if (input.kind === "list") return list(input).finally(() => known.delete(input.id))
    if (input.kind === "running") return running(input).finally(() => known.delete(input.id))
    if (input.kind === "templates") return templates(input).finally(() => known.delete(input.id))
    if (input.kind === "activate") {
      if (!input.activation) return refuse(input, fail("invalid", "The template is missing."))
      return activate(input, input.activation)
    }
    if (input.kind === "propose") {
      if (!input.proposal) return refuse(input, fail("invalid", "The proposal is missing."))
      return propose(input, input.proposal)
    }
    const found = await find(input.routine)
    if (isFailure(found)) return refuse(input, found)
    if (input.kind === "get") return get(input, found).finally(() => known.delete(input.id))
    if (input.kind === "pause" || input.kind === "resume")
      return toggle(input, found, input.kind === "resume").finally(() => known.delete(input.id))
    if (input.kind === "update") return update(input, found, input.changes ?? {})
    if (input.kind === "run") return run(input, found)
    const template = found.routine.template
    if (template?.mandatory)
      return refuse(
        input,
        fail(
          "conflict",
          `${subject(found.routine.definition, found.routine.ref, found.label).name} is assigned by the Dynapps template "${template.name}" and cannot be deleted. pause_scheduled_task stops it.`,
        ),
      )
    return show(cardOf(input, found, "delete"))
  }

  async function started(id: string, task: Subject, outcome: Run | Failure) {
    if (isFailure(outcome)) return reply(id, `The run could not start: ${outcome.message}`, true)
    const conversation = outcome.conversation.kind === "session" ? ` Its conversation is ${outcome.conversation.session}.` : ""
    const asks = task.bypass ? "" : " It is set to Ask me: it waits for the user's approval before edits and commands."
    return reply(id, `Started a run of ${task.name}.${asks}${conversation} Its result shows in Tasks.`, false)
  }

  function withdraw(id: string) {
    known.delete(id)
    if (cards.delete(id)) options.changed()
  }

  // What the card's button does, and what the agent reads after it.
  async function accept(card: Card) {
    const ref = { backend: card.backend, id: card.routine ?? "" }
    const task = subject(card.definition, ref, card.label)
    if (card.kind === "create") {
      const created = await options.act.create(card.backend, card.definition)
      if (isFailure(created)) return reply(card.id, `The task could not be created: ${created.message}`, true).then(() => created)
      return reply(card.id, `Created the task. It is in Tasks.\n${describe(created, card.label)}`, false).then(() => undefined)
    }
    if (card.kind === "update") {
      const updated = await options.act.update(ref, card.definition)
      if (isFailure(updated)) return reply(card.id, `The task could not be changed: ${updated.message}`, true).then(() => updated)
      const lines = cardChanges(words, card.before ?? card.definition, card.definition, card.label).map((row) =>
        row.key === "instructions" ? `- ${row.label}: changed` : `- ${row.label}: ${row.before} → ${row.value}`,
      )
      return reply(card.id, `Changed "${updated.definition.name}" (${taskId(updated.ref)}) on ${card.label}:\n${lines.join("\n")}`, false).then(() => undefined)
    }
    if (card.kind === "delete") {
      const failure = await options.act.remove(ref)
      if (failure) return reply(card.id, `The task could not be deleted: ${failure.message}`, true).then(() => failure)
      // A task made from an optional template: deleting it deactivates the template, which can be activated again.
      const template = card.definition.template
      const deactivated = template
        ? ` It was made from the Dynapps template ${template.id}: that template is no longer active for the user, who can activate it again with activate_task_template.`
        : ""
      return reply(card.id, `Deleted ${task.name}. Its past runs stay in Tasks.${deactivated}`, false).then(
        () => undefined,
      )
    }
    const outcome = await options.act.start(ref)
    await started(card.id, task, outcome)
    return isFailure(outcome) ? outcome : undefined
  }

  return {
    request,
    withdraw,
    /** The requests still waiting in the service, read after (re)connecting: new ones are handled, gone ones dropped. */
    sync: async (waiting: readonly DynWorkRoutines.Request[]) => {
      const ids = new Set(waiting.map((item) => item.id))
      cards.forEach((card) => {
        if (!ids.has(card.id)) withdraw(card.id)
      })
      await Promise.all(waiting.map(request))
    },
    cards: () => [...cards.values()],
    /** The card's answer. The card leaves before anything changes, so a second answer (another window) finds none. */
    decide: async (id: string, yes: boolean) => {
      const card = cards.get(id)
      if (!card) return fail("not-found", "This request is no longer waiting.")
      cards.delete(id)
      known.delete(id)
      options.changed()
      if (yes) return accept(card)
      await reply(id, cancelled[card.kind], true)
      return undefined
    },
  }
}

interface Found {
  backend: Backend
  routine: Routine
  /** Where it runs, as its backend calls itself. */
  label: string
}

/** A task as a result names it: `"Name" (local:3f2a) on This Mac`, and whether it runs without asking. */
interface Subject {
  name: string
  bypass: boolean
}

function subject(definition: Definition, ref: Ref, label: string): Subject {
  return {
    name: `"${definition.name}" (${taskId(ref)}) on ${label}`,
    bypass: definition.options.permissions === "bypass",
  }
}

const cloud = "Cloud is not available in this Dynwork yet."

const cancelled: Record<Card["kind"], string> = {
  create: "The user cancelled: nothing was created. Ask what to change before proposing again.",
  update: "The user cancelled: the task was not changed. Ask what to change before proposing again.",
  delete: "The user cancelled: the task was not deleted.",
  run: "The user cancelled: the task did not run.",
}

function cardOf(request: DynWorkRoutines.Request, found: Found, kind: Card["kind"]): Card {
  return {
    id: request.id,
    session: request.session,
    kind,
    backend: found.routine.ref.backend,
    label: found.label,
    routine: found.routine.ref.id,
    definition: found.routine.definition,
    input: JSON.stringify({ id: request.routine, ...request.changes }, null, 2),
  }
}

/**
 * What the template of a task keeps an edit from changing, as a refusal the agent can act on, or undefined. The template
 * is read from the task's own backend; one the person no longer sees locks nothing here (Governance still checks).
 */
async function lockedBy(found: Found, built: Definition): Promise<Failure | undefined> {
  const link = found.routine.template
  if (!link) return undefined
  const offered = await found.backend.templates?.().catch(() => undefined)
  const template =
    offered && !isFailure(offered) ? offered.templates.find((candidate) => candidate.id === link.id) : undefined
  if (!template) return undefined
  const paths = RoutinesTemplates.violates(template, found.routine.definition, built)
  if (paths.length === 0) return undefined
  return fail(
    "conflict",
    `Set by the Dynapps template "${link.name}"; ask your administrator.`,
    Object.fromEntries(paths.map((path) => [changeKey(path), "Set by the template."])),
  )
}

// A locked path as the tools name the field: `update_scheduled_task`'s own terms.
function changeKey(path: string) {
  if (path === "schedule.minute" || path === "schedule.hour") return "time"
  if (path.startsWith("schedule.")) return "repeat"
  if (path === "options.timeLimit") return "time limit"
  return path.replace("options.", "")
}

/** What a template locks, in words for the agent: each once, the schedule apart from the time that stays the user's. */
function lockedWords(paths: readonly string[]) {
  const words = paths.flatMap((path) => {
    if (path === "where") return []
    if (path === "schedule.minute") return ["how often it runs and its time"]
    if (path === "schedule.day" && !paths.includes("schedule.minute"))
      return ["how often it runs (the time is the user's)"]
    if (path.startsWith("schedule.")) return []
    if (path === "options.timeLimit") return ["time limit"]
    return [path.replace("options.", "")]
  })
  return words.length === 0 ? "nothing" : words.join(", ")
}

/** One template for the agent: what it is, where the user stands with it, what it sets and what it asks. */
function describeTemplate(template: Template, task?: Routine, state?: string) {
  const cron = template.definition.schedule?.cron
  const asks = [
    ...(template.personal.folder === "required"
      ? [`a project folder${template.personal.hint ? ` (${template.personal.hint})` : ""}`]
      : []),
    ...(cron && template.locks.schedule !== "locked"
      ? [template.locks.schedule === "time" ? "the time of day" : "how often and when"]
      : []),
    ...(template.locks.model || template.definition.model === undefined
      ? []
      : ["a model, if the template's is not on this computer"]),
  ]
  const where = task ? `active as ${taskId(task.ref)}` : state ? "active on another computer" : "not active"
  return [
    `- ${template.id} · ${template.name} · ${template.mandatory ? "assigned by Dynapps" : "optional"} · ${
      cron ? scheduleText(words, { cron, timezone: DynWorkRoutines.zone }) : "manual"
    } · ${where}${state && state !== "published" ? ` (${state})` : ""}`,
    `  ${template.description}`,
    `  Set by the template: ${lockedWords(RoutinesTemplates.locked(template))}.`,
    `  The user gives: ${asks.length === 0 ? "nothing" : asks.join("; ")}.`,
  ].join("\n")
}

// The personal part of an activation: the zone, the folder and, where the template lets it, the schedule.
function personalOf(activation: DynWorkRoutines.Activation, template: Template): Personal | Failure {
  const cron = scheduleFor(activation, template)
  if (isFailure(cron)) return cron
  return {
    timezone: activation.timezone ?? DynWorkRoutines.zone,
    // The card is the user's confirmation of a template that runs without asking.
    approved: true,
    ...(activation.folder ? { folder: activation.folder } : {}),
    ...(cron ? { cron } : {}),
    ...(activation.model ? { model: activation.model } : {}),
  }
}

// `repeat` writes the schedule as the form's presets do; `time` alone keeps the template's cron and changes its minute and hour.
function scheduleFor(activation: DynWorkRoutines.Activation, template: Template): string | Failure | undefined {
  const own = template.definition.schedule?.cron
  if (activation.repeat !== undefined) {
    const preset = presetFrom({ ...activation, repeat: activation.repeat })
    if (!preset) return fail("invalid", "The template runs on a schedule: manual is not an option.")
    const problem = scheduleProblem(preset)
    if (problem) return fail("invalid", "The schedule is not complete.", { schedule: words(problem) })
    return cronOf(preset)
  }
  if (activation.time === undefined || own === undefined) return undefined
  const at = /^(\d{1,2}):(\d{2})$/.exec(activation.time.trim())
  const [hour, minute] = [Number(at?.[1]), Number(at?.[2])]
  if (!at || hour > 23 || minute > 59)
    return fail("invalid", "The schedule is not complete.", { schedule: "Choose a time, HH:MM." })
  return [String(minute), String(hour), ...own.trim().split(/\s+/).slice(2)].join(" ")
}

export type Logic = ReturnType<typeof make>

// The service's events main follows, and how long it waits before following them again after the stream ended.
const REQUEST = `rpc.${DynWorkRoutines.id}.request` as const
const WITHDRAW = `rpc.${DynWorkRoutines.id}.withdraw` as const
const RETRY = 2_000
const decodeRequest = Schema.decodeUnknownOption(DynWorkRoutines.Request)
const decodeWithdrawn = Schema.decodeUnknownOption(DynWorkRoutines.Withdrawn)
const decodePending = Schema.decodeUnknownOption(DynWorkRoutines.Pending)

/**
 * Sets the chat up in main, beside the routines (`RoutinesMain.setup`): the `dynwork.routines.chat` Ipc, and the
 * following of the server plugin's requests on DynWork's service for as long as the app runs.
 */
export function setup(
  ctx: MainContext,
  input: {
    registry: Registry
    farm: boolean
    client: () => OpenCodeClient | undefined
    act: Act
    server: string
    home: string
  },
) {
  const call = async (method: string, value: unknown) => {
    const client = input.client()
    if (!client) return undefined
    return (await client.rpc.call({ rpcID: DynWorkRoutines.id, method, input: value as never })).output
  }
  const provider = { changed: () => {} }
  const chat = make({
    registry: input.registry,
    farm: input.farm,
    answer: (answer) => call("answer", answer),
    act: input.act,
    changed: () => provider.changed(),
    now: Date.now,
  })
  const ipc = ctx.provide(Chat, {
    state: () => ({ cards: chat.cards() }),
    decide: (value) => chat.decide(value.id, value.accept),
    start: async () => {
      const client = input.client()
      if (!client) return fail("unreachable", "Dynwork's service is not running.")
      const session = await client.session
        .create({ title: ctx.t("agents.new"), location: { directory: input.home } })
        .catch(() => undefined)
      if (!session) return fail("failed", "The conversation could not be opened.")
      const sent = await client.session
        .prompt({ sessionID: session.id, text: chatPrompt })
        .then(() => true)
        .catch(() => false)
      if (!sent) return fail("failed", "The conversation could not be started.")
      return { server: input.server, session: session.id }
    },
  })
  provider.changed = () => ipc.changed()

  const life = new AbortController()
  ctx.onCleanup(() => life.abort())
  void (async () => {
    while (!life.signal.aborted) {
      const client = input.client()
      if (client) await follow(client, chat, call, life.signal).catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, RETRY))
    }
  })()
}

// One subscription: after each (re)connection the requests published while main was away are read with `pending`.
async function follow(
  client: OpenCodeClient,
  chat: Logic,
  call: (method: string, value: unknown) => Promise<unknown>,
  signal: AbortSignal,
) {
  for await (const event of client.event.subscribe({ types: [REQUEST, WITHDRAW], signal })) {
    if (event.type === "server.connected") {
      const pending = decodePending(await call("pending", {}).catch(() => undefined))
      if (pending._tag === "Some") void chat.sync(pending.value.requests)
    }
    if (event.type === REQUEST) {
      const request = decodeRequest(event.data)
      if (request._tag === "Some") void chat.request(request.value)
    }
    if (event.type === WITHDRAW) {
      const withdrawn = decodeWithdrawn(event.data)
      if (withdrawn._tag === "Some") chat.withdraw(withdrawn.value.id)
    }
  }
}

function backends() {
  return [RoutinesLocal.id, RoutinesFarm.id]
}

/** A proposal in the form's terms as a routine `Definition`, or what keeps it from being one. */
export function definitionOf(proposal: DynWorkRoutines.Proposal, now: number): Definition | Failure {
  const timezone = proposal.timezone ?? DynWorkRoutines.zone
  const preset = presetFrom(proposal)
  const problem = preset && scheduleProblem(preset)
  if (problem) return fail("invalid", "The schedule is not complete.", { schedule: words(problem) })
  const cron = preset && cronOf(preset)
  const schedule = cron ? { cron, timezone } : undefined
  if (schedule && upcoming(schedule, now, 1).length === 0)
    return fail("invalid", "The schedule cannot be read.", { schedule: `"${cron}" in ${timezone}` })
  return {
    name: proposal.name.trim(),
    instructions: { kind: "prompt", text: proposal.instructions },
    ...(schedule ? { schedule } : {}),
    enabled: true,
    options: {
      permissions: proposal.permissions ?? "ask",
      notify: proposal.notify ?? "failures",
      ...(proposal.folder ? { folder: proposal.folder } : {}),
      ...(proposal.connectors ? { connectors: [...proposal.connectors] } : {}),
    },
  }
}

/** A routine in the form's terms, as `get` shows it and `changed` starts from: the inverse of `definitionOf`. */
export function proposalOf(routine: Routine): DynWorkRoutines.Proposal {
  const definition = routine.definition
  const options = definition.options
  const preset = definition.schedule && presetOf(definition.schedule.cron)
  return {
    name: definition.name,
    instructions: instructionsText(words, definition.instructions),
    repeat: preset?.kind ?? "manual",
    ...(preset && preset.kind !== "cron" ? { time: preset.time } : {}),
    ...(preset?.kind === "weekly" ? { days: [...preset.days] } : {}),
    ...(preset?.kind === "monthly" ? { day: preset.day } : {}),
    ...(preset?.kind === "cron" ? { cron: preset.cron } : {}),
    ...(definition.schedule ? { timezone: definition.schedule.timezone } : {}),
    where: routine.ref.backend === RoutinesFarm.id ? "farm" : "local",
    permissions: options.permissions === "bypass" ? "bypass" : "ask",
    ...(typeof options.folder === "string" ? { folder: options.folder } : {}),
    ...(Array.isArray(options.connectors)
      ? { connectors: options.connectors.filter((item): item is string => typeof item === "string") }
      : {}),
    notify: options.notify === "every" || options.notify === "never" ? options.notify : "failures",
  }
}

/**
 * The routine with only the given fields changed. A schedule field rebuilds the schedule from the routine's own one
 * with the change on top (a new `time` keeps how often it runs); anything not given stays as it was, the backend's other
 * options, agent, model and a skill's instructions too. An empty `folder` takes the folder away.
 */
export function changed(routine: Routine, changes: DynWorkRoutines.Changes, now: number): Definition | Failure {
  const current = routine.definition
  // Changes cross as JSON, so a field not given is absent, never `undefined`.
  const built = definitionOf({ ...proposalOf(routine), ...changes }, now)
  if (isFailure(built)) return built
  const timing = (["repeat", "time", "days", "day", "cron", "timezone"] as const).some((key) => changes[key] !== undefined)
  const schedule = timing ? built.schedule && { ...current.schedule, ...built.schedule } : current.schedule
  const options = Object.fromEntries(
    Object.entries({
      ...current.options,
      ...Object.fromEntries(
        (["permissions", "notify", "folder", "connectors"] as const).flatMap((key) => {
          const value = changes[key]
          if (value === undefined) return []
          return [[key, Array.isArray(value) ? [...value] : value]]
        }),
      ),
    }).filter((entry) => !(entry[0] === "folder" && entry[1] === "")),
  )
  return {
    name: changes.name === undefined ? current.name : built.name,
    instructions: changes.instructions === undefined ? current.instructions : built.instructions,
    ...(current.agent === undefined ? {} : { agent: current.agent }),
    ...(current.model === undefined ? {} : { model: current.model }),
    ...(schedule ? { schedule } : {}),
    enabled: current.enabled,
    options,
    // The link to a template is not a field the agent changes: an edit keeps it.
    ...(current.template ? { template: current.template } : {}),
  }
}

function presetFrom(
  proposal: Pick<DynWorkRoutines.Proposal, "repeat" | "time" | "days" | "day" | "cron">,
): Preset | undefined {
  const time = proposal.time ?? ""
  if (proposal.repeat === "manual") return undefined
  if (proposal.repeat === "cron") return { kind: "cron", cron: proposal.cron ?? "" }
  if (proposal.repeat === "weekly") return { kind: "weekly", time, days: proposal.days ?? [] }
  if (proposal.repeat === "monthly") return { kind: "monthly", time, day: proposal.day ?? 0 }
  return { kind: proposal.repeat, time }
}

/** A task's id as the tools name it: `<backend>:<id>`. */
function taskId(ref: Ref) {
  return `${ref.backend}:${ref.id}`
}

function refOf(id: string): Ref | undefined {
  const at = id.indexOf(":")
  if (at < 1 || at === id.length - 1) return undefined
  return { backend: id.slice(0, at), id: id.slice(at + 1) }
}

/** A moment for the agent: "2026-11-18 08:00 Europe/Madrid". */
function stamp(at: number, zone = DynWorkRoutines.zone) {
  return `${new Intl.DateTimeFormat("sv-SE", { dateStyle: "short", timeStyle: "short", timeZone: zone }).format(at)} ${zone}`
}

/** One line of a task for the agent, in the Tasks view's own English words. */
function describe(routine: Routine, label: string) {
  const definition = routine.definition
  const rows = cardRows(words, definition, label)
  const row = (key: string) => rows.find((item) => item.key === key)?.value ?? ""
  const last = routine.last
  const what = instructionsText(words, definition.instructions).split("\n")[0]?.slice(0, 120) ?? ""
  return [
    `- ${taskId(routine.ref)}`,
    definition.name,
    label,
    row("schedule"),
    routine.state,
    `permissions: ${row("permissions")}`,
    `connectors: ${row("connectors")}`,
    ...(routine.next === undefined ? [] : [`next run: ${stamp(routine.next, definition.schedule?.timezone)}`]),
    last
      ? `last run: ${words(stateKey(last))}${last.reason && last.reason !== "permission" ? ` (${last.reason})` : ""}${runTime(last) === undefined ? "" : ` ${stamp(runTime(last) ?? 0, definition.schedule?.timezone)}`}`
      : "never run",
    ...(routine.template ? [fromTemplate(routine.template)] : []),
    ...(what ? [what] : []),
  ].join(" · ")
}

function fromTemplate(template: NonNullable<Routine["template"]>) {
  const kind = template.mandatory
    ? "assigned by Dynapps: it cannot be deleted, only paused"
    : "optional: deleting it deactivates the template"
  return `from Dynapps template "${template.name}" (${kind}; set by the template: ${lockedWords(template.locked)})`
}

// The English table of the Tasks view, read without a window.
function words(key: string, params: Record<string, string | number> = {}) {
  const table: Record<string, string> = en
  return (table[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(params[name] ?? ""))
}
