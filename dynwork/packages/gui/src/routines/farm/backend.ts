export * as RoutinesFarm from "./backend"

import { Effect, Option, Schema } from "effect"
import { SpClient } from "@dynwork/sp-client"
import { fail, type Backend } from "../backend"
import type { Capabilities, Choice, Definition, Failure, Field, Routine, Run } from "../contract"
import { RoutinesValidate } from "../validate"
import type { FarmClient } from "./client"
import { FarmCloud } from "./cloud"

/**
 * The Agent Farm's routines backend ("Cloud"). A routine is a farm schedule: its `name` and `metadata` are the farm's,
 * there is no table here. Every call goes through a `FarmTransport` (`client.ts`) as farm MCP tools, and every task it
 * creates runs as the user (`gateway_identity: user`) with the PAT `cloud.ts` gives the farm. `README.md` next to this
 * file maps each method to the farm; the runs (`runs`, `cancel`, `transcript`, `viewed`, `watch`) are not written yet.
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
}

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
    return Option.getOrUndefined(decodeSchedule(answer)) ?? protocol()
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
    if (want === (current.state !== "paused") || current.state === "finished") return toRoutine(current)
    return routine(
      await call(want ? "farm_resume_schedule" : "farm_pause_schedule", { schedule_id: current.schedule_id }),
    )
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
    validate: async (definition) => {
      const known = await capabilities()
      if (known.status !== "ready")
        return fail(known.status === "disabled" ? "failed" : known.status, known.detail ?? "Cloud is not available.")
      const shared = RoutinesValidate.check(known, definition)?.fields ?? {}
      const farm = await farmProblems(definition)
      if (isRefused(farm)) return farm.failure
      const problems = { ...farm, ...shared }
      if (Object.keys(problems).length === 0) return undefined
      return fail("invalid", "Some fields need attention.", problems)
    },
    list: async () => {
      const answer = await call("farm_list_schedules", { owner: "me" })
      if (isRefused(answer)) return answer.failure
      return (Option.getOrUndefined(decodeList(answer))?.items ?? []).flatMap((item) => {
        const decoded = Option.getOrUndefined(decodeSchedule(item))
        return decoded === undefined ? [] : [toRoutine(decoded)]
      })
    },
    get: async (id) => {
      const answer = await schedule(id)
      return isRefused(answer) ? answer.failure : toRoutine(answer)
    },
    create: async (definition) => {
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
      return task === undefined ? protocol().failure : toRun(task, current)
    },
    // JESÚS: `cancel(run)` is `farm_cancel_task` on a task still going; a finished one is `Failure` `conflict`.
    cancel: async () => notImplemented("cancel"),
    // JESÚS: `runs({ routine, cursor })` is `farm_list_schedule_runs` (not paged by the farm, so paged here) and,
    // without `routine`, `farm_list_tasks` newest first for Activity. Map `Run.state` as README's table says.
    runs: async () => notImplemented("runs"),
    // JESÚS: `transcript(run)` is `farm_get_task_result` for `Transcript.result` and `farm_get_task_transcript` for
    // the conversation; `usage` comes from the task's `usage`.
    transcript: async () => notImplemented("transcript"),
    // JESÚS: `viewed(run)` is `farm_mark_task_viewed`: the farm keeps the read state per owner.
    viewed: async () => {},
    // JESÚS: `watch(changed)` polls `farm_list_tasks` with `updated_since=<cursor minus 30 s>` only while subscribed,
    // calling `changed` with each `Change` (the `Run`, and its `routine` when it is one of ours).
    watch: () => () => {},
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
const TaskOut = Schema.Struct({
  task_id: Schema.String,
  state: Schema.String,
  failure_reason: Schema.optional(Schema.NullOr(Schema.String)),
  trigger: Schema.optional(Schema.NullOr(Schema.String)),
  started_at: Schema.optional(Schema.NullOr(Schema.String)),
  finished_at: Schema.optional(Schema.NullOr(Schema.String)),
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

// A task the schedule fired, as the run it is. The run's own reading of a task (questions, unread) is `runs`'s.
function toRun(task: typeof TaskOut.Type, schedule: Schedule): Run {
  const started = time(task.started_at)
  const finished = time(task.finished_at)
  return {
    ref: { backend: id, id: task.task_id },
    routine: { backend: id, id: schedule.schedule_id },
    state: states[task.state] ?? "running",
    ...(task.failure_reason ? { reason: task.failure_reason } : {}),
    trigger: task.trigger === "schedule" ? "schedule" : "manual",
    ...(started === undefined ? {} : { started }),
    ...(finished === undefined ? {} : { finished }),
    title: schedule.name ?? "",
    unread: false,
    conversation: { kind: "transcript" },
  }
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
