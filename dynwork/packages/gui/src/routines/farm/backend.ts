export * as RoutinesFarm from "./backend"

import { Effect, Option, Schema } from "effect"
import { SpClient } from "@dynwork/sp-client"
import { fail, type Backend } from "../backend"
import type {
  Capabilities,
  Change,
  Choice,
  Definition,
  Failure,
  Field,
  Routine,
  Run,
  RunPage,
  Transcript,
} from "../contract"
import { RoutinesValidate } from "../validate"
import type { FarmClient } from "./client"
import { FarmCloud } from "./cloud"

/**
 * The Agent Farm's routines backend ("Cloud"). A routine is a farm schedule: its `name` and `metadata` are the farm's,
 * there is no table here. Every call goes through a `FarmTransport` (`client.ts`) as farm MCP tools, and every task it
 * creates runs as the user (`gateway_identity: user`) with the PAT `cloud.ts` gives the farm. A run is a farm task.
 * `README.md` next to this file maps each method to the farm.
 */

/** The id every `routine.ref.backend` of the farm carries, and the one the demo remote fake holds until this lands. */
export const id = "farm"

/** Set to `1` in the environment of the DynWork app to register this backend in place of the remote demo fake. */
export const flag = "DYNWORK_ROUTINES_FARM"

/** Without the flag the remote demo fake is the farm, as it has been since phase 01. */
export function enabled(env: Readonly<Record<string, string | undefined>>) {
  return env[flag] === "1"
}

/** What every method that is not written yet answers. `isNotImplemented` tells it from a real failure. */
const prefix = "Cloud is not implemented yet"

export function isNotImplemented(value: unknown): value is Failure {
  return (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string" &&
    value.message.startsWith(prefix)
  )
}

function notImplemented(method: string) {
  return fail("failed", `${prefix}: ${method}. See routines/farm/README.md.`)
}

const select = (key: string, section: string, label: string, choices: readonly Choice[], fallback?: string): Field => ({
  key,
  section,
  label,
  kind: "select",
  choices,
  default: fallback,
})

const overlap = select(
  "overlap",
  "schedule",
  "If the previous run is still going",
  [
    { value: "skip", label: "Skip this one" },
    { value: "allow", label: "Run anyway" },
  ],
  "skip",
)

/**
 * The fields of the remote demo fake and of the unconnected backend, as the mockup shows them. `capped` and `budget`
 * have no farm counterpart (a farm task has no cost limit), so the connected backend (`farmFields`) does not declare
 * them; they stay here only while the views' tests use them as their example of a field shown under `when`.
 */
export const fields: readonly Field[] = [
  { key: "repository", section: "workspace", label: "Repository", kind: "repo", required: true },
  { key: "branch", section: "workspace", label: "Branch or tag", kind: "text", default: "main" },
  {
    key: "access",
    section: "workspace",
    label: "Repository access",
    kind: "select",
    lookup: "credentials:git_token",
    help: "A stored credential the farm uses to clone.",
  },
  { key: "plugins", section: "plugins", label: "Plugins", kind: "multiselect", lookup: "plugins", max: 10 },
  { key: "timeLimit", section: "limits", label: "Time limit (minutes)", kind: "number", min: 1, max: 60, default: 15 },
  { key: "capped", section: "limits", label: "Cap the cost", kind: "toggle", default: false },
  {
    key: "budget",
    section: "limits",
    label: "Most to spend per run (EUR)",
    kind: "number",
    min: 0.1,
    max: 50,
    required: true,
    when: { key: "capped", equals: true },
  },
  overlap,
  select(
    "profile",
    "advanced",
    "Profile",
    [
      { value: "standard", label: "Standard" },
      { value: "large", label: "Large" },
    ],
    "standard",
  ),
  { key: "label", section: "advanced", label: "Label", kind: "text" },
]

/** What the farm can do, as the remote demo fake and the unconnected backend declare it. */
export const base: Omit<Capabilities, "backend" | "quota"> = {
  kind: "remote",
  label: "Cloud",
  status: "ready",
  instructions: ["prompt", "agent"],
  agent: "none",
  model: "agent",
  schedule: { window: true, minimum: 5 },
  actions: { edit: "replace", reply: "resume", cancel: true },
  fields,
}

/** The most MCP servers one farm task takes. */
const connectorsMax = 5

/**
 * The connected backend's fields, each one a part of the farm's task: the repository it clones (`workspace`), the
 * permission mode under the effective ceiling (no "Don't ask" when the tenant's is `ask`), the MCP servers whose
 * address is one of the user's `mcp_url` credentials, the time limit and the overlap policy. Plugins are not a choice:
 * every plugin of the image is loaded.
 */
export function farmFields(ceiling: "ask" | "bypass"): readonly Field[] {
  return [
    { key: "repository", section: "workspace", label: "Repository", kind: "repo" },
    { key: "branch", section: "workspace", label: "Branch or tag", kind: "text", default: "main" },
    {
      key: "access",
      section: "workspace",
      label: "Repository access",
      kind: "select",
      lookup: "credentials:git_token",
      help: "A stored credential the farm uses to clone.",
    },
    select(
      "permissions",
      "permissions",
      "Permissions",
      [{ value: "ask", label: "Ask me" }, ...(ceiling === "ask" ? [] : [{ value: "bypass", label: "Don't ask" }])],
      "ask",
    ),
    {
      key: "connectors",
      section: "connectors",
      label: "Connectors",
      kind: "multiselect",
      lookup: "credentials:mcp_url",
      max: connectorsMax,
      help: "MCP servers whose address is one of your stored credentials.",
    },
    {
      key: "timeLimit",
      section: "limits",
      label: "Time limit (minutes)",
      kind: "number",
      min: 1,
      max: 60,
      default: 15,
    },
    overlap,
  ]
}

export interface Options {
  /** The farm, as `FarmClient` reaches it for the active account. */
  client: FarmClient.FarmTransport
  /** Gives the farm the account's PAT (`FarmCloud.make`). */
  cloud?: Pick<FarmCloud.Cloud, "ensure" | "retry">
  /** The models Governance admits for the user (`profile.models`); `undefined` when they cannot be read. */
  models: () => Promise<readonly string[] | undefined>
  /** Milliseconds between two polls of `watch`. */
  interval?: number
  /** Downloads a result document from its short-lived link. */
  fetch?: typeof fetch
}

/** How often `watch` asks the farm what changed, while subscribed. The farm has no push. */
export const interval = 5_000

/** Each poll asks for what changed this long before the newest change already seen, so that nothing falls between. */
export const lookback = 30_000

/** Runs per page of a routine's runs, paged here: the farm lists a schedule's tasks whole. */
export const page = 25

/**
 * The key of `origin_context` that ties a reply to its routine. The farm does not say on a task which schedule fired it,
 * and a reply (`session_ref`) belongs to no schedule: Dynwork names the routine itself.
 */
export const context = "dynwork_routine"

// `last` is what the farm's task tools read as "the newest task": never a run id Dynwork passes on.
const last = "last"
// Most pages read for one answer, so a farm that keeps paging cannot hold a call forever.
const pages = 20
// The recent tasks read for the replies of the routines: the newest `scan` pages of 100.
const scan = 3
// The longest conversation kept in `Transcript.log`, from its end.
const longest = 200_000

/**
 * The backend. Without `options` it is the unconnected backend: it reports itself `disabled` and every method answers
 * `not implemented`, which is what main registers until the farm is wired (`RoutinesFarm.enabled`).
 */
export function make(options?: Options): Backend {
  if (options === undefined) return unconnected()
  const client = options.client

  const call = async (name: string, args?: FarmClient.Arguments) => {
    const answer = await client.callTool(name, args)
    return answer.ok ? answer.value : refused(answer)
  }

  // What the farm does not say on a task: the routine it belongs to and how it started, learned from the schedules'
  // own lists, from `start` and from `reply`; and each routine's name, the title of its runs.
  const known = new Map<string, { routine: string; trigger: Run["trigger"] }>()
  const names = new Map<string, string>()
  const learn = (schedule: Schedule) => {
    names.set(schedule.schedule_id, schedule.name ?? "")
    return schedule
  }

  const runOf = (task: Task, routine?: string): Run => {
    const seen = known.get(task.task_id)
    const linked = routine ?? seen?.routine ?? linkOf(task)
    const trigger =
      task.trigger === "schedule" || task.trigger === "manual"
        ? task.trigger
        : (seen?.trigger ?? (task.origin === "schedule" ? "schedule" : "manual"))
    if (linked !== undefined) known.set(task.task_id, { routine: linked, trigger })
    return toRun(task, linked, trigger, (linked === undefined ? undefined : names.get(linked)) || titleOf(task))
  }

  const whoami = async () => {
    const answer = await call("farm_whoami")
    if (isRefused(answer)) return answer
    return Option.getOrUndefined(decodeWhoami(answer)) ?? protocol()
  }

  const capabilities = async (): Promise<Capabilities> => {
    const access = await options.cloud?.ensure("capabilities")
    if (access !== undefined && !access.ok) return unavailable(access)
    const [me, models] = await Promise.all([whoami(), options.models()])
    if (isRefused(me)) return unavailable(me)
    const admitted = models ?? []
    return {
      ...base,
      backend: id,
      status: "ready",
      instructions: me.free_prompt ? ["prompt", "agent"] : ["agent"],
      model: admitted.length > 0 ? "choose" : "agent",
      actions: { edit: "in-place", reply: "resume", cancel: true },
      quota:
        me.schedules.max_per_user === null
          ? { max: me.schedules.max_tenant, used: me.schedules.used, shared: true }
          : { max: me.schedules.max_per_user, used: me.schedules.used, shared: false },
      fields: farmFields(me.permission_ceiling),
    }
  }

  const schedule = async (id: string) => {
    const answer = await call("farm_get_schedule", { schedule_id: id })
    if (isRefused(answer)) return answer
    const decoded = Option.getOrUndefined(decodeSchedule(answer))
    return decoded === undefined ? protocol() : learn(decoded)
  }

  // The replies Dynwork sent among the user's recent tasks: those whose `origin_context` names a routine.
  const replies = async (cursor?: string, read = 0): Promise<Task[] | Refused> => {
    const answer = await call("farm_list_tasks", {
      owner: "me",
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    })
    if (isRefused(answer)) return answer
    const list = tasksOf(answer)
    const linked = list.items.filter((task) => linkOf(task) !== undefined)
    if (list.next === undefined || read + 1 >= scan) return linked
    const more = await replies(list.next, read + 1)
    return isRefused(more) ? more : [...linked, ...more]
  }

  // A routine's runs, newest first: the tasks its schedule fired and the replies sent to them, which the farm keeps
  // outside the schedule. A reply goes first among runs of the same moment: it always follows the run it continues.
  const history = async (id: string, found: readonly Task[]): Promise<Run[] | Refused> => {
    const answer = await call("farm_list_schedule_runs", { schedule_id: id })
    if (isRefused(answer)) return answer
    const fired = tasksOf(answer).items
    const ids = new Set(fired.map((task) => task.task_id))
    return [...found.filter((task) => linkOf(task) === id && !ids.has(task.task_id)), ...fired]
      .toSorted((left, right) => (time(right.created_at) ?? 0) - (time(left.created_at) ?? 0))
      .map((task) => runOf(task, id))
  }

  const withRuns = (routine: Routine, runs: readonly Run[] | Refused): Routine =>
    isRefused(runs) || runs[0] === undefined
      ? routine
      : { ...routine, last: runs[0], unread: runs.filter((run) => run.unread).length }

  const activity = async (cursor?: string): Promise<RunPage | Failure> => {
    const answer = await call("farm_list_tasks", {
      owner: "me",
      limit: page,
      ...(cursor === undefined ? {} : { cursor }),
    })
    if (isRefused(answer)) return answer.failure
    const list = tasksOf(answer)
    return { items: list.items.map((task) => runOf(task)), ...(list.next === undefined ? {} : { next: list.next }) }
  }

  const task = async (run: string) => {
    if (run === last) return missing()
    const answer = await call("farm_get_task", { task_id: run })
    if (isRefused(answer)) return answer
    return Option.getOrUndefined(decodeTask(answer)) ?? protocol()
  }

  // The result document behind the short-lived `result.url`; the farm's summary when it cannot be read.
  const resultOf = async (run: string) => {
    const answer = await call("farm_get_task_result", { task_id: run })
    if (isRefused(answer)) return undefined
    const described = Option.getOrUndefined(decodeResult(answer))
    if (described === undefined) return undefined
    const document = await download(described.result.url, options.fetch ?? fetch)
    const text = document?.result ?? described.summary ?? undefined
    return { text, turns: document?.usage?.num_turns, duration: document?.usage?.duration_s }
  }

  // The whole conversation, page by page, as plain lines; a page shorter than asked for is the last one there is.
  const conversation = async (run: string, cursor?: string, read = 0, lines: string[] = []): Promise<string[]> => {
    const answer = await call("farm_get_task_transcript", {
      task_id: run,
      limit: 200,
      ...(cursor === undefined ? {} : { cursor }),
    })
    const page = isRefused(answer) ? undefined : Option.getOrUndefined(decodeTranscript(answer))
    if (page === undefined) return lines
    const next = [...lines, ...page.messages.flatMap(linesOf)]
    if (page.complete || !page.next_cursor || page.messages.length < 200 || read + 1 >= pages) return next
    return conversation(run, page.next_cursor, read + 1, next)
  }

  // `watch`: one poll for every subscriber, only while there is one. `generation` tells a poll still answering after
  // the last subscriber left (or a new one came) to say nothing.
  const watchers = new Set<(change: Change) => void>()
  const poll = {
    generation: 0,
    since: 0,
    /** Each task's run as last reported, and when it changed. */
    seen: new Map<string, { at: number; run: string }>(),
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
  }
  const every = options.interval ?? interval

  const tick = async (generation: number) => {
    await changes(generation).catch(() => undefined)
    if (generation !== poll.generation) return
    poll.timer = setTimeout(() => void tick(generation), every)
    poll.timer.unref?.()
  }

  // Each task that changed since the newest change seen (minus `lookback`), as its run, once for each way the run
  // reads: two changes within the same instant of `updated_at` are still two. A run that failed because the farm no
  // longer holds a PAT it can use gets Cloud the PAT again; the routine is left as it is.
  const changes = async (generation: number, cursor?: string, read = 0): Promise<void> => {
    const answer = await call("farm_list_tasks", {
      owner: "me",
      updated_since: new Date(poll.since - lookback).toISOString(),
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    })
    if (generation !== poll.generation || isRefused(answer)) return
    const list = tasksOf(answer)
    list.items.forEach((task) => {
      const at = time(task.updated_at) ?? poll.since
      const run = runOf(task)
      const read = JSON.stringify(run)
      if (poll.seen.get(task.task_id)?.run === read) return
      poll.seen.set(task.task_id, { at, run: read })
      poll.since = Math.max(poll.since, at)
      if (run.state === "failed" && FarmCloud.stale.some((code) => code === task.failure_reason))
        void options.cloud?.retry(task.failure_reason ?? undefined)
      watchers.forEach((changed) => changed({ ...(run.routine === undefined ? {} : { routine: run.routine }), run }))
    })
    poll.seen.forEach((seen, key) => {
      if (seen.at < poll.since - 2 * lookback) poll.seen.delete(key)
    })
    if (list.next !== undefined && read + 1 < pages) return changes(generation, list.next, read + 1)
  }

  const routine = (answer: Record<string, unknown> | Refused): Routine | Failure => {
    if (isRefused(answer)) return answer.failure
    const decoded = Option.getOrUndefined(decodeSchedule(answer))
    return decoded === undefined ? protocol().failure : toRoutine(decoded)
  }

  // A schedule's change answers the schedule: `undefined` for the methods that answer nothing.
  const done = (answer: Record<string, unknown> | Refused) => (isRefused(answer) ? answer.failure : undefined)

  // The farm refused a task because it holds no PAT for the user: it is given the PAT again, and the call is made once
  // more. A refusal before the farm stored anything (`422`) is safe to repeat.
  const withAccess = async (name: string, args: FarmClient.Arguments) => {
    const first = await call(name, args)
    if (!isRefused(first) || !FarmCloud.stale.some((code) => code === first.code) || options.cloud === undefined)
      return first
    const again = await options.cloud.retry(first.code)
    if (again?.ok === true) return call(name, args)
    return {
      ...first,
      failure: fail(
        "failed",
        `Cloud cannot run tasks with your Governance sign-in yet. ${again?.failure.message ?? ""}`.trim(),
      ),
    }
  }

  const switched = async (current: Schedule, want: boolean) => {
    learn(current)
    if (want === (current.state !== "paused") || current.state === "finished") return toRoutine(current)
    return routine(
      await call(want ? "farm_resume_schedule" : "farm_pause_schedule", { schedule_id: current.schedule_id }),
    )
  }

  const validate = async (definition: Definition) => {
    const known = await capabilities()
    if (known.status !== "ready")
      return fail(known.status === "disabled" ? "failed" : known.status, known.detail ?? "Cloud is not available.")
    const shared = RoutinesValidate.check(known, definition)?.fields ?? {}
    const farm = await farmProblems(definition)
    if (isRefused(farm)) return farm.failure
    const problems = { ...farm, ...shared }
    if (Object.keys(problems).length === 0) return undefined
    return fail("invalid", "Some fields need attention.", problems)
  }

  return {
    id,
    capabilities,
    options: async (lookup) => {
      if (lookup === "models") {
        const models = await options.models()
        if (models === undefined) return fail("unreachable", "Governance did not list your models.")
        return models.map((model) => ({ value: model, label: model }))
      }
      const read = reads[lookup] ?? (lookup.startsWith("credentials:") ? reads.credentials : undefined)
      if (read === undefined) return fail("not-found", `There is no ${lookup} list in Cloud.`)
      const answer = await call(read.tool)
      if (isRefused(answer)) return answer.failure
      return read.choices(answer, lookup.slice("credentials:".length))
    },
    validate,
    list: async () => {
      const [answer, found] = await Promise.all([call("farm_list_schedules", { owner: "me" }), replies()])
      if (isRefused(answer)) return answer.failure
      const schedules = (Option.getOrUndefined(decodeList(answer))?.items ?? []).flatMap((item) => {
        const decoded = Option.getOrUndefined(decodeSchedule(item))
        return decoded === undefined ? [] : [learn(decoded)]
      })
      const recent = isRefused(found) ? [] : found
      return Promise.all(
        schedules.map(async (item) => withRuns(toRoutine(item), await history(item.schedule_id, recent))),
      )
    },
    get: async (id) => {
      const [answer, found] = await Promise.all([schedule(id), replies()])
      if (isRefused(answer)) return answer.failure
      return withRuns(toRoutine(answer), await history(id, isRefused(found) ? [] : found))
    },
    // A definition is checked as `validate` checks it before the farm is asked: the farm takes a schedule without a
    // name, which a routine must have.
    create: async (definition) => {
      const problem = await validate(definition)
      if (problem !== undefined) return problem
      const created = await withAccess("farm_create_schedule", {
        task: toTask(definition, {}),
        ...(definition.name.trim() === "" ? {} : { name: definition.name }),
        metadata: toMetadata(definition, {}),
        ...(definition.schedule ? { recurrence: toRecurrence(definition.schedule) } : {}),
        ...(typeof definition.options.overlap === "string" ? { overlap: definition.options.overlap } : {}),
      })
      if (isRefused(created)) return fieldFailure(created)
      const decoded = Option.getOrUndefined(decodeSchedule(created))
      if (decoded === undefined) return protocol().failure
      return switched(decoded, definition.enabled)
    },
    update: async (id, definition) => {
      const current = await schedule(id)
      if (isRefused(current)) return current.failure
      const problem = await validate(definition)
      if (problem !== undefined) return problem
      const changed = await withAccess("farm_update_schedule", {
        schedule_id: id,
        changes: {
          task: toTask(definition, current.task),
          name: definition.name.trim() === "" ? null : definition.name,
          metadata: toMetadata(definition, current.metadata ?? {}),
          recurrence: definition.schedule ? toRecurrence(definition.schedule) : null,
          ...(typeof definition.options.overlap === "string" ? { overlap: definition.options.overlap } : {}),
        },
      })
      if (isRefused(changed)) return fieldFailure(changed)
      const decoded = Option.getOrUndefined(decodeSchedule(changed))
      if (decoded === undefined) return protocol().failure
      return switched(decoded, definition.enabled)
    },
    remove: async (id) => done(await call("farm_delete_schedule", { schedule_id: id })),
    pause: async (id) => done(await call("farm_pause_schedule", { schedule_id: id })),
    resume: async (id) => done(await call("farm_resume_schedule", { schedule_id: id })),
    start: async (id) => {
      const current = await schedule(id)
      if (isRefused(current)) return current.failure
      const fired = await withAccess("farm_fire_schedule", { schedule_id: id })
      if (isRefused(fired)) return fired.failure
      const task = Option.getOrUndefined(decodeTask(fired))
      if (task === undefined) return protocol().failure
      known.set(task.task_id, { routine: id, trigger: "manual" })
      return runOf(task, id)
    },
    cancel: async (run) => (run === last ? missing().failure : done(await call("farm_cancel_task", { task_id: run }))),
    reply: async (input) => {
      if (input.text.trim() === "") return fail("invalid", "Write how the run should go on.", { text: "Required." })
      const parent = await task(input.run)
      if (isRefused(parent)) return parent.failure
      if (going.includes(states[parent.state] ?? "running"))
        return fail("conflict", "This run is still going: answer it when it finishes.")
      if (!parent.session_ref || parent.resumable === false) return fail("conflict", "This run cannot be continued.")
      const routine = known.get(parent.task_id)?.routine ?? linkOf(parent)
      const current = routine === undefined ? undefined : await schedule(routine)
      const launched = await withAccess("farm_launch_task", {
        ...continuation(parent, current === undefined || isRefused(current) ? undefined : current.task, input.text),
        session_ref: parent.session_ref,
        gateway_identity: "user",
        ...(routine === undefined ? {} : { origin_context: { [context]: routine } }),
      })
      if (isRefused(launched)) return launched.failure
      const created = Option.getOrUndefined(decodeTask(launched))
      if (created === undefined) return protocol().failure
      if (routine !== undefined) known.set(created.task_id, { routine, trigger: "manual" })
      return runOf(created, routine)
    },
    answerQuestion: async (input) => {
      const current = await task(input.run)
      if (isRefused(current)) return current.failure
      const question = current.state === "running" ? current.question : undefined
      if (question === undefined || question === null || `q-${question.seq}` !== input.question)
        return fail("conflict", "The run is not waiting for that answer any more.")
      const choices = question.options ?? []
      if (choices.length > 0 ? !choices.includes(input.choice) : input.choice.trim() === "")
        return fail("invalid", "That is not one of the answers this question takes.")
      return done(await call("farm_answer_task", { task_id: input.run, answer: input.choice, seq: question.seq }))
    },
    runs: async (input) => {
      if (input.routine === undefined) return activity(input.cursor)
      const from = input.cursor === undefined ? 0 : Number(input.cursor)
      if (!Number.isSafeInteger(from) || from < 0 || input.cursor === "")
        return fail("invalid", "That page of runs does not exist.")
      const [current, found] = await Promise.all([
        names.has(input.routine) ? undefined : schedule(input.routine),
        replies(),
      ])
      if (current !== undefined && isRefused(current)) return current.failure
      const runs = await history(input.routine, isRefused(found) ? [] : found)
      if (isRefused(runs)) return runs.failure
      return {
        items: runs.slice(from, from + page),
        ...(from + page < runs.length ? { next: String(from + page) } : {}),
      }
    },
    transcript: async (run) => {
      const current = await task(run)
      if (isRefused(current)) return current.failure
      const finished = !going.includes(states[current.state] ?? "running")
      const [result, lines] = await Promise.all([finished ? resultOf(run) : undefined, conversation(run)])
      const log = lines.join("\n")
      const duration = current.usage?.duration_s ?? result?.duration
      const turns = result?.turns
      const answer: Transcript = {
        ...(result?.text === undefined ? {} : { result: result.text }),
        ...(log === "" ? {} : { log: log.length > longest ? log.slice(-longest) : log }),
        ...(duration === undefined && turns === undefined
          ? {}
          : {
              usage: {
                ...(duration === undefined || duration === null ? {} : { duration: duration * 1000 }),
                ...(turns === undefined ? {} : { turns }),
              },
            }),
      }
      return answer
    },
    viewed: async (run) => {
      if (run !== last) await call("farm_mark_task_viewed", { task_id: run })
    },
    watch: (changed) => {
      watchers.add(changed)
      if (watchers.size === 1) {
        poll.generation++
        poll.since = Date.now()
        poll.seen.clear()
        void tick(poll.generation)
      }
      return () => {
        if (!watchers.delete(changed) || watchers.size > 0) return
        poll.generation++
        clearTimeout(poll.timer)
      }
    },
  }

  // What only the farm knows: the models Governance admits for the user, the agents and each agent's ceiling.
  async function farmProblems(definition: Definition): Promise<Record<string, string> | Refused> {
    const problems: Record<string, string> = {}
    if (definition.model !== undefined && !((await options?.models()) ?? []).includes(definition.model))
      problems.model = "This model is not one of yours in Governance."
    if (definition.instructions.kind !== "agent") return problems
    const answer = await call("farm_list_agents")
    if (isRefused(answer)) return answer
    const agent = (Option.getOrUndefined(decodeAgents(answer))?.items ?? []).find(
      (item) => item.slug === (definition.instructions.kind === "agent" ? definition.instructions.agent : ""),
    )
    if (agent === undefined) return { ...problems, instructions: "Cloud has no such agent." }
    if (agent.capabilities?.permission_ceiling === "ask" && definition.options.permissions === "bypass")
      return { ...problems, permissions: "This agent always asks before running tools." }
    return problems
  }
}

/** Reads `profile.models` of the active account: the models Governance admits for the user, as it lists them. */
export function profileModels(accounts: FarmClient.Accounts) {
  return async () => {
    const id = accounts.active()
    const account = id === undefined ? undefined : accounts.stored(id)
    if (id === undefined || account === undefined) return undefined
    return accounts.session(id).then(
      (held) =>
        Effect.runPromise(SpClient.profile(account.url, held.token)).then(
          (profile): readonly string[] => [...new Set(profile.models)],
          () => undefined,
        ),
      () => undefined,
    )
  }
}

// The unconnected backend, as main registers it until the farm is wired: `disabled`, and `not implemented` elsewhere.
function unconnected(): Backend {
  return {
    id,
    capabilities: async () => ({
      ...base,
      backend: id,
      status: "disabled",
      detail: "Cloud is not connected yet (routines/farm/README.md).",
    }),
    options: async () => notImplemented("options"),
    validate: async () => notImplemented("validate"),
    list: async () => notImplemented("list"),
    get: async () => notImplemented("get"),
    create: async () => notImplemented("create"),
    update: async () => notImplemented("update"),
    remove: async () => notImplemented("remove"),
    pause: async () => notImplemented("pause"),
    resume: async () => notImplemented("resume"),
    start: async () => notImplemented("start"),
    cancel: async () => notImplemented("cancel"),
    runs: async () => notImplemented("runs"),
    transcript: async () => notImplemented("transcript"),
    viewed: async () => {},
    watch: () => () => {},
  }
}

// --- the farm's answers --------------------------------------------------------------------------------------------

const Json = Schema.Record(Schema.String, Schema.Unknown)
const Recurrence = Schema.Struct({
  cron: Schema.String,
  timezone: Schema.String,
  starts_at: Schema.optional(Schema.NullOr(Schema.String)),
  ends_at: Schema.optional(Schema.NullOr(Schema.String)),
  max_runs: Schema.optional(Schema.NullOr(Schema.Number)),
})
const ScheduleOut = Schema.Struct({
  schedule_id: Schema.String,
  task: Json,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  metadata: Schema.optional(Json),
  recurrence: Schema.NullOr(Recurrence),
  overlap: Schema.String,
  state: Schema.Literals(["active", "paused", "finished"]),
  next_fire_at: Schema.NullOr(Schema.String),
  updated_at: Schema.String,
})
type Schedule = typeof ScheduleOut.Type
const Text = Schema.optional(Schema.NullOr(Schema.String))
const TaskOut = Schema.Struct({
  task_id: Schema.String,
  state: Schema.String,
  failure_reason: Text,
  /** Only on a schedule's own list of tasks. */
  trigger: Text,
  origin: Text,
  origin_context: Schema.optional(Schema.NullOr(Json)),
  agent_id: Text,
  prompt: Text,
  question: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        seq: Schema.Number,
        text: Schema.String,
        options: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
      }),
    ),
  ),
  viewed: Schema.optional(Schema.NullOr(Schema.Boolean)),
  session_ref: Text,
  resumable: Schema.optional(Schema.NullOr(Schema.Boolean)),
  workspace: Schema.optional(Schema.NullOr(Json)),
  usage: Schema.optional(Schema.NullOr(Schema.Struct({ duration_s: Schema.optional(Schema.NullOr(Schema.Number)) }))),
  created_at: Schema.optional(Schema.String),
  started_at: Text,
  finished_at: Text,
  updated_at: Schema.optional(Schema.String),
})
type Task = typeof TaskOut.Type
const TaskPage = Schema.Struct({ items: Schema.Array(Schema.Unknown), next_cursor: Text })
const ResultOut = Schema.Struct({ result: Schema.Struct({ url: Schema.String }), summary: Text })
const ResultDocument = Schema.Struct({
  result: Schema.String,
  usage: Schema.optional(
    Schema.Struct({ num_turns: Schema.optional(Schema.Number), duration_s: Schema.optional(Schema.Number) }),
  ),
})
const TranscriptPage = Schema.Struct({
  messages: Schema.Array(
    Schema.Struct({
      role: Schema.String,
      text: Schema.String,
      tool_uses: Schema.optional(
        Schema.Array(Schema.Struct({ name: Text, is_error: Schema.optional(Schema.Boolean) })),
      ),
    }),
  ),
  next_cursor: Text,
  complete: Schema.Boolean,
})
const WhoAmI = Schema.Struct({
  free_prompt: Schema.Boolean,
  permission_ceiling: Schema.Literals(["ask", "bypass"]),
  schedules: Schema.Struct({
    used: Schema.Number,
    max_per_user: Schema.NullOr(Schema.Number),
    max_tenant: Schema.Number,
  }),
})
const Items = <S extends Schema.Top>(item: S) => Schema.Struct({ items: Schema.Array(item) })
const Agents = Items(
  Schema.Struct({
    slug: Schema.String,
    capabilities: Schema.optional(Schema.Struct({ permission_ceiling: Schema.optional(Schema.String) })),
  }),
)
const Plugins = Items(Schema.Struct({ name: Schema.String }))
const Credentials = Items(Schema.Struct({ name: Schema.String, type: Schema.String }))
const Template = Schema.Struct({ id: Schema.String, revision: Schema.Number })

const decodeSchedule = Schema.decodeUnknownOption(ScheduleOut)
const decodeList = Schema.decodeUnknownOption(Items(Schema.Unknown))
const decodeTask = Schema.decodeUnknownOption(TaskOut)
const decodeTaskPage = Schema.decodeUnknownOption(TaskPage)
const decodeResult = Schema.decodeUnknownOption(ResultOut)
const decodeDocument = Schema.decodeUnknownOption(Schema.fromJsonString(ResultDocument))
const decodeTranscript = Schema.decodeUnknownOption(TranscriptPage)
const decodeWhoami = Schema.decodeUnknownOption(WhoAmI)
const decodeAgents = Schema.decodeUnknownOption(Agents)
const decodeTemplate = Schema.decodeUnknownOption(Template)
const decodeOptions = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json))

// The lists `options` serves, by lookup. `credentials:<type>` keeps the user's own credentials of that type.
const reads: Record<string, { tool: string; choices: (answer: unknown, type: string) => Choice[] } | undefined> = {
  agents: {
    tool: "farm_list_agents",
    choices: (answer) =>
      (Option.getOrUndefined(decodeAgents(answer))?.items ?? []).map((item) => ({
        value: item.slug,
        label: item.slug,
      })),
  },
  plugins: {
    tool: "farm_list_plugins",
    choices: (answer) =>
      (Option.getOrUndefined(Schema.decodeUnknownOption(Plugins)(answer))?.items ?? []).map((item) => ({
        value: item.name,
        label: item.name,
      })),
  },
  credentials: {
    tool: "farm_list_credentials",
    choices: (answer, type) =>
      (Option.getOrUndefined(Schema.decodeUnknownOption(Credentials)(answer))?.items ?? [])
        .filter((item) => item.type === type)
        .map((item) => ({ value: item.name, label: item.name })),
  },
}

// --- a definition as a farm schedule, and back -----------------------------------------------------------------------

/** Where Dynwork keeps, in a schedule's `metadata`, the definition's options as they were sent. */
const own = "dynwork"

// The keys of a farm task that a definition writes. The rest of a stored task is kept on an edit, except `notify`,
// whose URLs the farm never returns, so it cannot be sent back whole.
const written = [
  "agent_id",
  "prompt",
  "input",
  "model",
  "permission_mode",
  "workspace",
  "mcp_servers",
  "gateway_identity",
  "correlation_id",
  "notify",
]

function toTask(definition: Definition, stored: Record<string, unknown>) {
  const options = definition.options
  const kept = Object.fromEntries(Object.entries(stored).filter(([key]) => !written.includes(key)))
  const limits = { ...(isObject(kept.limits) ? kept.limits : {}) }
  delete limits.timeout_s
  if (typeof options.timeLimit === "number") limits.timeout_s = Math.round(options.timeLimit * 60)
  const { limits: _, ...rest } = kept
  const connectors = Array.isArray(options.connectors)
    ? options.connectors.filter((item): item is string => typeof item === "string")
    : []
  const instructions = definition.instructions
  return {
    ...rest,
    ...(instructions.kind === "agent"
      ? { agent_id: instructions.agent, input: instructions.input }
      : { prompt: instructions.kind === "prompt" ? instructions.text : (instructions.text ?? "") }),
    ...(definition.model === undefined ? {} : { model: definition.model }),
    ...(typeof options.permissions === "string" ? { permission_mode: options.permissions } : {}),
    ...(typeof options.repository === "string" && options.repository !== ""
      ? {
          workspace: {
            repo: options.repository,
            ...(typeof options.branch === "string" && options.branch !== "" ? { ref: options.branch } : {}),
            ...(typeof options.access === "string" && options.access !== "" ? { credentials_ref: options.access } : {}),
          },
        }
      : {}),
    ...(connectors.length > 0
      ? { mcp_servers: connectors.map((credential) => ({ name: serverName(credential), credential })) }
      : {}),
    ...(Object.keys(limits).length > 0 ? { limits } : {}),
    gateway_identity: "user",
  }
}

// The keys of `metadata` that are not Dynwork's stay as they were.
function toMetadata(definition: Definition, stored: Record<string, unknown>) {
  const { template: _, [own]: __, ...rest } = stored
  return {
    ...rest,
    ...(definition.template ? { template: definition.template } : {}),
    [own]: { options: definition.options },
  }
}

function toRecurrence(schedule: NonNullable<Definition["schedule"]>) {
  return {
    cron: schedule.cron,
    timezone: schedule.timezone,
    ...(schedule.starts === undefined ? {} : { starts_at: new Date(schedule.starts).toISOString() }),
    ...(schedule.ends === undefined ? {} : { ends_at: new Date(schedule.ends).toISOString() }),
    ...(schedule.max === undefined ? {} : { max_runs: schedule.max }),
  }
}

function toRoutine(schedule: Schedule): Routine {
  const recurrence = schedule.recurrence
  const metadata = schedule.metadata ?? {}
  const template = Option.getOrUndefined(decodeTemplate(metadata.template))
  const next = time(schedule.next_fire_at)
  return {
    ref: { backend: id, id: schedule.schedule_id },
    definition: {
      name: schedule.name ?? "",
      instructions: instructionsOf(schedule.task),
      ...(typeof schedule.task.model === "string" ? { model: schedule.task.model } : {}),
      ...(recurrence === null
        ? {}
        : {
            schedule: {
              cron: recurrence.cron,
              timezone: recurrence.timezone,
              ...(time(recurrence.starts_at) === undefined ? {} : { starts: time(recurrence.starts_at) }),
              ...(time(recurrence.ends_at) === undefined ? {} : { ends: time(recurrence.ends_at) }),
              ...(typeof recurrence.max_runs === "number" ? { max: recurrence.max_runs } : {}),
            },
          }),
      enabled: schedule.state !== "paused",
      options: optionsOf(schedule, metadata),
      ...(template === undefined ? {} : { template }),
    },
    state: schedule.state,
    ...(next === undefined ? {} : { next }),
    unread: 0,
    conversation: { kind: "none" },
    updated: time(schedule.updated_at) ?? 0,
  }
}

function instructionsOf(task: Record<string, unknown>): Definition["instructions"] {
  if (typeof task.agent_id === "string")
    return { kind: "agent", agent: task.agent_id, input: typeof task.input === "string" ? task.input : "" }
  return { kind: "prompt", text: typeof task.prompt === "string" ? task.prompt : "" }
}

// The options sent with the definition, with what the task itself says over them: an edit made outside Dynwork shows.
function optionsOf(schedule: Schedule, metadata: Record<string, unknown>): Definition["options"] {
  const mine = isObject(metadata[own]) ? metadata[own] : {}
  const sent = Option.getOrUndefined(decodeOptions(mine.options)) ?? {}
  const task = schedule.task
  const workspace = isObject(task.workspace) ? task.workspace : {}
  const limits = isObject(task.limits) ? task.limits : {}
  const servers = Array.isArray(task.mcp_servers) ? task.mcp_servers.filter(isObject) : []
  const taken = {
    repository: typeof workspace.repo === "string" ? workspace.repo : undefined,
    branch: typeof workspace.ref === "string" ? workspace.ref : undefined,
    access: typeof workspace.credentials_ref === "string" ? workspace.credentials_ref : undefined,
    permissions: typeof task.permission_mode === "string" ? task.permission_mode : undefined,
    connectors: servers.length > 0 ? servers.map((server) => String(server.credential)) : undefined,
    timeLimit: typeof limits.timeout_s === "number" ? limits.timeout_s / 60 : undefined,
    // The farm always holds a policy; a definition that never chose one keeps having none while it is the default.
    overlap: "overlap" in sent || schedule.overlap !== "skip" ? schedule.overlap : undefined,
  }
  const rest = Object.fromEntries(Object.entries(sent).filter(([key]) => !(key in taken)))
  return {
    ...rest,
    ...Object.fromEntries(
      Object.entries(taken).filter((entry): entry is [string, string | number | string[]] => entry[1] !== undefined),
    ),
  }
}

// A farm task as the run it is. A task waiting for its owner's answer is `running` with the reason `question`; a
// finished one the owner has not seen is unread, as is one waiting for an answer.
function toRun(task: Task, routine: string | undefined, trigger: Run["trigger"], title: string): Run {
  const started = time(task.started_at)
  const finished = time(task.finished_at)
  const state = states[task.state] ?? "running"
  const asked = state === "running" ? task.question : undefined
  const question =
    asked === undefined || asked === null
      ? undefined
      : { id: `q-${asked.seq}`, text: asked.text, choices: [...(asked.options ?? [])] }
  const reason = question === undefined ? task.failure_reason : "question"
  return {
    ref: { backend: id, id: task.task_id },
    ...(routine === undefined ? {} : { routine: { backend: id, id: routine } }),
    state,
    ...(reason ? { reason } : {}),
    trigger,
    ...(started === undefined ? {} : { started }),
    ...(finished === undefined ? {} : { finished }),
    title,
    unread: question !== undefined || (!going.includes(state) && task.viewed === false),
    ...(question === undefined ? {} : { question }),
    conversation: { kind: "transcript" },
  }
}

const going: readonly Run["state"][] = ["queued", "running"]

// The routine a reply names; a task fired by a schedule names none (`runOf` learns it from the schedule's list).
function linkOf(task: Task) {
  const value = task.origin_context?.[context]
  return typeof value === "string" ? value : undefined
}

// A task of no known routine, as Activity titles it: its agent, or the first line of its prompt.
function titleOf(task: Task) {
  return task.agent_id ?? task.prompt?.split("\n")[0]?.slice(0, 80) ?? "Cloud task"
}

function tasksOf(answer: unknown) {
  const list = Option.getOrUndefined(decodeTaskPage(answer))
  return {
    items: (list?.items ?? []).flatMap((item) => Option.toArray(decodeTask(item))),
    ...(list?.next_cursor ? { next: list.next_cursor } : {}),
  }
}

// One message of the conversation as plain lines: who said it, and each tool it called.
function linesOf(message: (typeof TranscriptPage.Type)["messages"][number]) {
  return [
    `${message.role}: ${message.text}`,
    ...(message.tool_uses ?? []).map((use) => `  - ${use.name ?? "tool"}${use.is_error ? " (error)" : ""}`),
  ]
}

// A reply runs the routine's task again in the run's conversation, with the user's words as its prompt or, for an
// agent, its input. Without the routine, the run's own agent and workspace (the farm requires the workspace again).
function continuation(parent: Task, stored: Record<string, unknown> | undefined, text: string) {
  const kept =
    stored === undefined
      ? parent.workspace
        ? { workspace: Object.fromEntries(Object.entries(parent.workspace).filter((entry) => entry[1] !== null)) }
        : {}
      : Object.fromEntries(Object.entries(stored).filter(([key]) => carried.includes(key)))
  const agent = stored === undefined ? parent.agent_id : stored.agent_id
  return { ...kept, ...(typeof agent === "string" ? { agent_id: agent, input: text } : { prompt: text }) }
}

// What a reply takes from the routine's task: everything that shapes how it runs, nothing of how it started.
const carried = ["model", "permission_mode", "workspace", "mcp_servers", "limits"]

// The result document, from a short-lived link of the farm's storage: https, or http on this computer only, and no
// redirect. `undefined` when it cannot be read.
async function download(link: string, request: typeof fetch) {
  const url = URL.canParse(link) ? new URL(link) : undefined
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url?.hostname ?? "")
  if (url === undefined || url.username !== "" || url.password !== "") return undefined
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return undefined
  const response = await request(url, { redirect: "error", signal: AbortSignal.timeout(30_000) }).catch(() => undefined)
  if (response === undefined || !response.ok) return undefined
  return Option.getOrUndefined(decodeDocument(await response.text().catch(() => "")))
}

const states: Record<string, Run["state"]> = {
  pending: "queued",
  queued: "queued",
  running: "running",
  succeeded: "ok",
  failed: "failed",
  cancelled: "cancelled",
  expired: "failed",
}

// An MCP server name is a lowercase slug; the credential's name is the closest one.
function serverName(credential: string) {
  return (
    credential
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 63) || "server"
  )
}

function time(value: string | null | undefined) {
  if (value === null || value === undefined) return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// --- failures ------------------------------------------------------------------------------------------------------

type Refused = { refused: true; code: string; failure: Failure }

function refused(answer: FarmClient.Refusal): Refused {
  return { refused: true, code: answer.code, failure: answer.failure }
}

function isRefused(value: unknown): value is Refused {
  return isObject(value) && value.refused === true
}

function missing(): Refused {
  return { refused: true, code: "not_found", failure: fail("not-found", "There is no such run in Cloud.") }
}

function protocol(): Refused {
  return {
    refused: true,
    code: "protocol",
    failure: fail("failed", "Cloud answered in a way Dynwork does not understand."),
  }
}

// The farm's task errors, on the field of the form they are about.
const fieldOf: Record<string, string> = {
  model_unknown: "model",
  limits_exceed_tenant_policy: "permissions",
  prompt_not_enabled_for_tenant: "instructions",
  agent_unknown: "instructions",
  agent_not_found: "instructions",
  cron_invalid: "schedule",
  timezone_invalid: "schedule",
  name_invalid: "name",
}

function fieldFailure(answer: Refused): Failure {
  const field = fieldOf[answer.code]
  if (field === undefined) return answer.failure
  return fail("invalid", answer.failure.message, { [field]: answer.failure.message })
}

// Why Cloud cannot serve, as the views read it: signed out, unreachable, or not available with the reason.
function unavailable(answer: Refused | FarmClient.Refusal): Capabilities {
  const status =
    answer.failure.code === "signed-out"
      ? "signed-out"
      : answer.failure.code === "unreachable"
        ? "unreachable"
        : "disabled"
  return {
    ...base,
    backend: id,
    status,
    detail:
      answer.code === "unavailable"
        ? "Cloud is not available for this account in Governance."
        : status === "disabled"
          ? `Cloud cannot run tasks with your Governance sign-in yet. ${answer.failure.message}`
          : answer.failure.message,
  }
}
