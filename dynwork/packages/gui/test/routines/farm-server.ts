import { randomUUID } from "node:crypto"
import { DynWorkAccounts } from "../../src/accounts/accounts"
import { RoutinesFarm } from "../../src/routines/farm/backend"
import { FarmClient } from "../../src/routines/farm/client"
import { FarmCloud } from "../../src/routines/farm/cloud"
import { setup, type Fake } from "../accounts/fixture"

/**
 * A stand-in for the Agent Farm as Dynwork reaches it: the farm's MCP server behind the Governance MCP proxy
 * (`POST /api/v1/mcp/dynapps-farm/mcp`, stateless `tools/call`), plus the farm's one route Dynwork calls directly, the
 * one-time credential upload (`PUT /farm/api/v1/credential-uploads/<ticket>`). Over real HTTP, as `service.ts` stands
 * in for DynWork's service.
 *
 * Each tool answers what the farm's tool answers: the REST body as `structuredContent` (and the same JSON as text), or
 * `isError` with the farm's `{ error: { code, message, retryable, details } }`. The shapes follow the farm's
 * `docs/farm-api.md`: schedules with `name`, `metadata`, an optional `recurrence` (manual routines), `PATCH` semantics
 * (a field sent replaces the stored one; `null` clears `name`, resets `metadata`, makes `recurrence` manual), a quota
 * that counts only schedules with a recurrence, tasks with `model`, `permission_mode` under the tenant's and the agent's ceiling, `gateway_identity: user` that needs the
 * caller's `gateway_pat`, the caller's quotas in `whoami`, tasks marked `viewed`, a paged `transcript`, and questions
 * answered with `farm_answer_task`.
 *
 * `authorize` says whether a bearer is a session the proxy accepts; the proxy answers `401` otherwise. The switches in
 * `state` make it misbehave: `unauthorized` (every call `401`), `unavailable` (`503 service_not_running`: Governance
 * does not give this account the farm) and `down` (`502`: the farm does not answer behind the proxy).
 */

export interface Agent {
  slug: string
  description?: string
  requires_workspace?: boolean
  /** The agent's own ceiling; the one its tasks get is the lower of this and the tenant's. */
  ceiling?: "ask"
  credentials?: string[]
}

export interface Credential {
  name: string
  type: string
  scope?: "personal" | "shared"
}

type Json = Record<string, unknown>

export interface Schedule {
  schedule_id: string
  owner: string
  task: Json
  name: string | null
  metadata: Json
  recurrence: Json | null
  overlap: string
  state: "active" | "paused" | "finished"
  runs_count: number
  missed_runs: number
  last_fired_at: string | null
  created_at: string
  updated_at: string
}

export interface Task {
  task_id: string
  owner: string
  schedule_id: string | null
  trigger: "schedule" | "manual" | null
  agent_id: string | null
  prompt: string | null
  input: string | null
  model: string | null
  state: "pending" | "queued" | "running" | "succeeded" | "failed" | "cancelled" | "expired"
  failure_reason: string | null
  origin: "api" | "schedule"
  origin_context: Json | null
  workspace: Json | null
  question: Question | null
  answer: string | null
  viewed: boolean
  session_ref: string | null
  transcript: Message[]
  /** The agent's final answer, as the result document holds it; `null` until there is a result. */
  result: string | null
  usage: { input_tokens: number | null; output_tokens: number | null; duration_s: number | null } | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  updated_at: string
}

/** A question as the farm shows it: `ask` is answered in free text, `permission` with one of `options`. */
export interface Question {
  seq: number
  text: string
  asked_at: string
  kind: "ask" | "permission"
  options: string[] | null
}

/** One message of a task's conversation, as `GET /tasks/{id}/transcript` pages it. */
export interface Message {
  seq: number
  role: "user" | "assistant" | "tool"
  text: string
  tool_uses: { name: string | null; input_summary: string | null; result_summary: string | null; is_error: boolean }[]
  at: string | null
  truncated: boolean
}

export interface FarmState {
  subject: string
  tenant: string
  admin: boolean
  freePrompt: boolean
  /** The tenant's ceiling on `permission_mode`. */
  ceiling: "ask" | "bypass"
  /** Whether the caller's `gateway_pat` (`sp-gateway`) is stored. */
  userCredential: boolean
  /** What the last upload stored; tests check it, never anything else does. */
  uploaded?: string
  /** `null`: the tenant sets no per-person cap. */
  maxPerUser: number | null
  maxTenant: number
  /** The model ids the tenant's gateway lists. */
  catalogue: string[]
  agents: Agent[]
  plugins: { name: string; version: string | null }[]
  credentials: Credential[]
  schedules: Map<string, Schedule>
  tasks: Map<string, Task>
  tickets: Set<string>
  /** Result documents served at `result.url`, by key; a download consumes nothing. */
  documents: Map<string, Json>
  /** Where `result.url` points instead of this server, to hand out a link the backend must not follow. */
  resultBase?: string
  /** Every tool call, in order, with its arguments as they arrived. */
  calls: { name: string; args: Json }[]
  unauthorized: boolean
  unavailable: boolean
  down: boolean
}

const PATH = "/api/v1/mcp/dynapps-farm/mcp"
const UPLOAD = "/farm/api/v1/credential-uploads/"
const RESULTS = "/results/"

export function fakeFarm(input: { authorize?: (bearer: string) => boolean; now?: () => number } = {}) {
  const now = input.now ?? Date.now
  const iso = (ms = now()) => new Date(ms).toISOString()
  const state: FarmState = {
    subject: "ana@dynapps.es",
    tenant: "dynapps",
    admin: false,
    freePrompt: true,
    ceiling: "bypass",
    userCredential: true,
    maxPerUser: 20,
    maxTenant: 500,
    catalogue: [],
    agents: [],
    plugins: [],
    credentials: [],
    schedules: new Map(),
    tasks: new Map(),
    tickets: new Set(),
    documents: new Map(),
    calls: [],
    unauthorized: false,
    unavailable: false,
    down: false,
  }

  const error = (code: string, message: string, details: Json = {}, retryable = false) => ({
    error: { code, message, retryable, details },
  })
  const notFound = () => error("not_found", "That does not exist, or it is not yours.")
  const mine = <A extends { owner: string }>(item: A | undefined) =>
    item !== undefined && (item.owner === state.subject || state.admin) ? item : undefined

  // The quota counts the schedules that recur: one that runs only by hand uses nothing until it is fired.
  const live = (owner?: string) =>
    [...state.schedules.values()].filter(
      (schedule) =>
        schedule.state !== "finished" &&
        schedule.recurrence !== null &&
        (owner === undefined || schedule.owner === owner),
    ).length

  const quotaProblem = () => {
    if (state.maxPerUser !== null && live(state.subject) >= state.maxPerUser)
      return error("quota_exceeded", `You already have ${state.maxPerUser} schedules.`, { limit: "max_per_user" })
    if (live() >= state.maxTenant)
      return error("quota_exceeded", `The team already has ${state.maxTenant} schedules.`, { limit: "max_tenant" })
    return undefined
  }

  // An hour after its last change: stable between reads, which is all the backend needs of it.
  const nextFire = (schedule: Schedule) =>
    schedule.state === "active" && schedule.recurrence !== null
      ? iso(Date.parse(schedule.updated_at) + 3_600_000)
      : null

  const scheduleWire = (schedule: Schedule) => ({
    ...schedule,
    tenant: state.tenant,
    task: structuredClone(schedule.task),
    metadata: structuredClone(schedule.metadata),
    recurrence:
      schedule.recurrence === null
        ? null
        : { starts_at: null, ends_at: null, max_runs: null, ...structuredClone(schedule.recurrence) },
    next_fire_at: nextFire(schedule),
    last_fire_state: schedule.last_fired_at === null ? null : "ok",
    last_fire_error: null,
  })

  const terminal = (task: Task) => ["succeeded", "failed", "cancelled", "expired"].includes(task.state)

  // A task as the farm's `TaskOut`: no `schedule_id` (the farm does not show it on a task), `trigger` only on a
  // schedule's own list, the result as a descriptor without a link.
  const taskWire = (task: Task, trigger = false) => {
    const { transcript: _, answer: __, result: ___, schedule_id: ____, trigger: _____, ...rest } = task
    return {
      ...rest,
      tenant: state.tenant,
      ...(trigger ? { trigger: task.trigger } : {}),
      waiting_input: task.question !== null,
      // Known once the task has finished: null while it goes.
      resumable: terminal(task) ? task.session_ref !== null && task.state !== "cancelled" : null,
      ...(task.result === null
        ? {}
        : { result: { s3_key: `results/${task.task_id}.json`, sha256: null, size_bytes: null } }),
    }
  }

  // The rules of `POST /tasks` that a schedule's task is held to when it is created or edited.
  const taskProblem = (task: unknown) => {
    if (typeof task !== "object" || task === null || Array.isArray(task)) return error("task_invalid", "No task.")
    const body = task as Json
    if ((body.agent_id === undefined) === (body.prompt === undefined))
      return error("task_invalid", "Send exactly one of agent_id or prompt.")
    if (body.prompt !== undefined && !state.freePrompt)
      return error("prompt_not_enabled_for_tenant", "Free prompts are not enabled for this tenant.")
    const agent = state.agents.find((item) => item.slug === body.agent_id)
    if (body.agent_id !== undefined && agent === undefined)
      return error("agent_unknown", "No such agent.", { field: "agent_id" })
    if (body.model !== undefined && !state.catalogue.includes(String(body.model)))
      return error("model_unknown", "The tenant's gateway does not list this model.", { model: body.model })
    if (body.permission_mode === "bypass" && (state.ceiling === "ask" || agent?.ceiling === "ask"))
      return error("limits_exceed_tenant_policy", "This task may only ask before running tools.", {
        ceiling_from: state.ceiling === "ask" ? "tenant" : "agent",
      })
    if (body.gateway_identity === "user" && !state.userCredential)
      return error("user_gateway_credential_missing", "Your gateway key is not stored in the farm.")
    return undefined
  }

  const recurrenceProblem = (recurrence: unknown) => {
    if (recurrence === undefined || recurrence === null) return undefined
    const value = recurrence as Json
    if (typeof value.cron !== "string" || value.cron.trim().split(/\s+/).length !== 5)
      return error("cron_invalid", "A cron has five fields.")
    if (typeof value.timezone !== "string" || value.timezone === "")
      return error("timezone_invalid", "Unknown time zone.")
    return undefined
  }

  const newTask = (fields: Partial<Task> & Pick<Task, "owner">): Task => {
    const task: Task = {
      task_id: randomUUID(),
      schedule_id: null,
      trigger: null,
      agent_id: null,
      prompt: null,
      input: null,
      model: null,
      state: "queued",
      failure_reason: null,
      origin: "api",
      origin_context: null,
      workspace: null,
      question: null,
      answer: null,
      viewed: false,
      session_ref: `sess_${randomUUID().slice(0, 8)}`,
      transcript: [],
      result: null,
      usage: null,
      created_at: iso(),
      started_at: null,
      finished_at: null,
      updated_at: iso(),
      ...fields,
    }
    state.tasks.set(task.task_id, task)
    return task
  }

  const fromTask = (body: Json) => ({
    agent_id: (body.agent_id as string | undefined) ?? null,
    prompt: (body.prompt as string | undefined) ?? null,
    input: (body.input as string | undefined) ?? null,
    model: (body.model as string | undefined) ?? null,
    origin_context: (body.origin_context as Json | undefined) ?? null,
    workspace: (body.workspace as Json | undefined) ?? null,
  })

  const tools: Record<string, (args: Json) => Json> = {
    farm_whoami: () => ({
      subject: state.subject,
      tenant: state.tenant,
      scopes: ["farm:tasks:write", "farm:schedules:write", "farm:credentials:write"],
      is_admin: state.admin,
      expires_at: iso(now() + 300_000),
      free_prompt: state.freePrompt,
      permission_ceiling: state.ceiling,
      gateway_identity: { user_credential: state.userCredential },
      gateway_identity_default: "user",
      schedules: { used: live(state.subject), max_per_user: state.maxPerUser, max_tenant: state.maxTenant },
    }),
    farm_list_agents: () => ({
      items: state.agents.map((agent) => ({
        slug: agent.slug,
        scope: "platform",
        owner: null,
        description: agent.description ?? null,
        instructions: null,
        plugin_agent: null,
        mcp_servers: [],
        env_credentials: {},
        harness: "claude-code",
        requires_workspace: agent.requires_workspace ?? false,
        capabilities: {
          credentials: agent.credentials ?? [],
          egress: [],
          denied_tools: [],
          permission_ceiling: agent.ceiling === "ask" || state.ceiling === "ask" ? "ask" : "bypass",
        },
        default_limits: {},
        model_alias: null,
        permission_ceiling: agent.ceiling ?? null,
      })),
    }),
    farm_list_plugins: () => ({
      items: state.plugins.map((plugin) => ({ ...plugin, commit: null, agents: [] })),
    }),
    farm_list_credentials: (args) => ({
      items: state.credentials
        .filter((credential) => (credential.scope ?? "personal") === (args.scope ?? "personal"))
        .map((credential) => ({
          name: credential.name,
          scope: credential.scope ?? "personal",
          type: credential.type,
          tenant: state.tenant,
          fingerprint: "sha256:0000",
          metadata: {},
          expires_at: null,
          description: null,
          created_at: iso(),
          updated_at: iso(),
        })),
    }),
    farm_request_credential_upload: (args) => {
      if (args.type !== "gateway_pat") return error("credential_type_invalid", "Only gateway_pat.")
      const ticket = randomUUID()
      state.tickets.add(ticket)
      return {
        upload_url: `${url()}${UPLOAD}${ticket}`,
        method: "PUT",
        expires_at: iso(now() + 60_000),
        type: "gateway_pat",
        name: "sp-gateway",
      }
    },
    farm_list_schedules: (args) => ({
      items: [...state.schedules.values()]
        .filter((schedule) => mine(schedule) !== undefined)
        .filter((schedule) => args.owner !== "me" || schedule.owner === state.subject)
        .toSorted((a, b) => b.created_at.localeCompare(a.created_at))
        .map(scheduleWire),
    }),
    farm_get_schedule: (args) => {
      const schedule = mine(state.schedules.get(String(args.schedule_id)))
      return schedule === undefined ? notFound() : scheduleWire(schedule)
    },
    farm_create_schedule: (args) => {
      const problem = taskProblem(args.task) ?? recurrenceProblem(args.recurrence)
      if (problem) return problem
      if (args.name !== undefined && (typeof args.name !== "string" || args.name.trim() === ""))
        return error("name_invalid", "A name is plain text.")
      // Only a schedule with a recurrence takes a place in the quota.
      const full = args.recurrence === undefined || args.recurrence === null ? undefined : quotaProblem()
      if (full) return full
      const schedule: Schedule = {
        schedule_id: randomUUID(),
        owner: state.subject,
        task: structuredClone(args.task as Json),
        name: (args.name as string | undefined) ?? null,
        metadata: structuredClone((args.metadata as Json | undefined) ?? {}),
        recurrence: (args.recurrence as Json | undefined) ?? null,
        overlap: (args.overlap as string | undefined) ?? "skip",
        state: "active",
        runs_count: 0,
        missed_runs: 0,
        last_fired_at: null,
        created_at: iso(),
        updated_at: iso(),
      }
      state.schedules.set(schedule.schedule_id, schedule)
      return { status: 201, ...scheduleWire(schedule) }
    },
    farm_update_schedule: (args) => {
      const schedule = mine(state.schedules.get(String(args.schedule_id)))
      if (schedule === undefined) return notFound()
      const changes = (args.changes ?? {}) as Json
      if ("task" in changes) {
        const problem = taskProblem(changes.task)
        if (problem) return problem
      }
      const recurrence = recurrenceProblem(changes.recurrence)
      if (recurrence) return recurrence
      if ("recurrence" in changes && schedule.state === "finished")
        return error("schedule_finished", "A finished schedule cannot change its recurrence.")
      if ("overlap" in changes && changes.overlap === null) return error("overlap_invalid", "Overlap cannot be null.")
      // Adding a recurrence to a routine that runs by hand takes a place in the quota; removing it gives the place back.
      if (schedule.recurrence === null && changes.recurrence !== undefined && changes.recurrence !== null) {
        const full = schedule.state === "finished" ? undefined : quotaProblem()
        if (full) return full
      }
      if ("task" in changes) schedule.task = structuredClone(changes.task as Json)
      if ("name" in changes) schedule.name = (changes.name as string | null) ?? null
      if ("metadata" in changes) schedule.metadata = structuredClone((changes.metadata as Json | null) ?? {})
      if ("recurrence" in changes) schedule.recurrence = (changes.recurrence as Json | null) ?? null
      if ("overlap" in changes) schedule.overlap = String(changes.overlap)
      schedule.updated_at = iso()
      return scheduleWire(schedule)
    },
    farm_delete_schedule: (args) => {
      const schedule = mine(state.schedules.get(String(args.schedule_id)))
      if (schedule === undefined) return notFound()
      state.schedules.delete(schedule.schedule_id)
      return { deleted: true, schedule_id: schedule.schedule_id }
    },
    farm_pause_schedule: (args) => {
      const schedule = mine(state.schedules.get(String(args.schedule_id)))
      if (schedule === undefined) return notFound()
      if (schedule.state === "finished") return error("schedule_finished", "A finished schedule cannot be paused.")
      schedule.state = "paused"
      schedule.updated_at = iso()
      return scheduleWire(schedule)
    },
    farm_resume_schedule: (args) => {
      const schedule = mine(state.schedules.get(String(args.schedule_id)))
      if (schedule === undefined) return notFound()
      if (schedule.state === "finished") return error("schedule_finished", "A finished schedule cannot be resumed.")
      schedule.state = "active"
      schedule.updated_at = iso()
      return scheduleWire(schedule)
    },
    farm_fire_schedule: (args) => {
      const schedule = mine(state.schedules.get(String(args.schedule_id)))
      if (schedule === undefined) return notFound()
      if (schedule.state !== "active") return error("schedule_not_active", "The schedule is not active.")
      const going = [...state.tasks.values()].some(
        (task) => task.schedule_id === schedule.schedule_id && ["pending", "queued", "running"].includes(task.state),
      )
      if (schedule.overlap === "skip" && going)
        return error("schedule_overlap", "The previous task of this schedule is still running.")
      const task = newTask({
        owner: schedule.owner,
        schedule_id: schedule.schedule_id,
        trigger: "manual",
        ...fromTask(schedule.task),
        origin: "schedule",
      })
      schedule.runs_count += 1
      schedule.last_fired_at = task.created_at
      return { status: 201, ...taskWire(task) }
    },
    farm_list_schedule_runs: (args) => {
      const schedule = mine(state.schedules.get(String(args.schedule_id)))
      if (schedule === undefined) return notFound()
      return {
        items: [...state.tasks.values()]
          .filter((task) => task.schedule_id === schedule.schedule_id)
          .toReversed()
          .map((task) => taskWire(task, true)),
      }
    },
    // Newest first, or oldest change first with `updated_since`; pages of `limit` (25, at most 100) with an opaque
    // `next_cursor`.
    farm_list_tasks: (args) => {
      const limit = Math.min(typeof args.limit === "number" ? args.limit : 25, 100)
      const from = typeof args.cursor === "string" ? Number(args.cursor.replace(/^c/, "")) : 0
      const all = [...state.tasks.values()]
        .filter((task) => mine(task) !== undefined)
        .filter((task) => args.owner !== "me" || task.owner === state.subject)
        .filter((task) => args.session_ref === undefined || task.session_ref === args.session_ref)
        .filter((task) => args.updated_since === undefined || task.updated_at >= String(args.updated_since))
      const ordered =
        args.updated_since === undefined
          ? all.toReversed()
          : all.toSorted((a, b) => a.updated_at.localeCompare(b.updated_at))
      return {
        items: ordered.slice(from, from + limit).map((task) => taskWire(task)),
        next_cursor: from + limit < ordered.length ? `c${from + limit}` : null,
      }
    },
    farm_get_task: (args) => {
      const task = mine(state.tasks.get(String(args.task_id)))
      return task === undefined ? notFound() : taskWire(task)
    },
    // The result's descriptor and a link to its document, as `GET /tasks/{id}/result`; only for a finished task.
    farm_get_task_result: (args) => {
      const task = mine(state.tasks.get(String(args.task_id)))
      if (task === undefined) return notFound()
      if (!terminal(task)) return error("task_not_terminal", "The task has not finished yet.")
      if (task.result === null) return error("result_not_found", "The task left no result.")
      const key = randomUUID()
      state.documents.set(key, {
        task_id: task.task_id,
        state: task.state,
        result: task.result,
        session_ref: task.session_ref ?? "",
        usage: { input_tokens: 10, output_tokens: 20, duration_s: task.usage?.duration_s ?? 0, num_turns: 3 },
      })
      return {
        task_id: task.task_id,
        tenant: state.tenant,
        scope: null,
        state: task.state,
        result: {
          s3_key: `results/${task.task_id}.json`,
          sha256: null,
          size_bytes: null,
          content_type: "application/json",
          url: `${state.resultBase ?? url()}${RESULTS}${key}`,
          expires_at: iso(now() + 300_000),
        },
        summary: task.result.slice(0, 200),
        usage: task.usage ?? { input_tokens: null, output_tokens: null, duration_s: null },
        session_ref: task.session_ref,
        resumable: task.session_ref !== null,
      }
    },
    farm_launch_task: (args) => {
      const problem = taskProblem({ ...args })
      if (problem) return problem
      const parent = [...state.tasks.values()].findLast((task) => task.session_ref === args.session_ref)
      if (args.session_ref !== undefined && mine(parent) === undefined) return error("session_not_found", "No session.")
      if (parent?.workspace && args.workspace === undefined)
        return error("workspace_required_for_resume", "Send the workspace again.", { field: "workspace" })
      const fields = fromTask(args)
      const task = newTask({
        owner: state.subject,
        ...fields,
        origin_context: fields.origin_context ?? parent?.origin_context ?? null,
        ...(parent === undefined ? {} : { session_ref: parent.session_ref }),
      })
      return {
        status: 201,
        task_id: task.task_id,
        tenant: state.tenant,
        scope: null,
        state: task.state,
        correlation_id: `mcp-${task.task_id}`,
        created_at: task.created_at,
        ...(parent === undefined ? {} : { parent_task_id: parent.task_id, session_agent_changed: false }),
      }
    },
    farm_cancel_task: (args) => {
      const task = mine(state.tasks.get(String(args.task_id)))
      if (task === undefined) return notFound()
      if (!["pending", "queued", "running"].includes(task.state))
        return error("task_not_cancellable", "The task already finished.")
      Object.assign(task, { state: "cancelled", finished_at: iso(), updated_at: iso(), viewed: false })
      return { task_id: task.task_id, state: task.state }
    },
    farm_mark_task_viewed: (args) => {
      const task = mine(state.tasks.get(String(args.task_id)))
      if (task === undefined) return notFound()
      if (task.owner !== state.subject) return notFound()
      task.viewed = true
      return { task_id: task.task_id, viewed: true }
    },
    // Pages of `limit` messages (50, at most 200) after the `seq` in `cursor`. While the task runs, `next_cursor` is
    // where to resume later even when there is nothing more yet.
    farm_get_task_transcript: (args) => {
      const task = mine(state.tasks.get(String(args.task_id)))
      if (task === undefined) return notFound()
      const limit = Math.min(typeof args.limit === "number" ? args.limit : 50, 200)
      const after = typeof args.cursor === "string" ? Number(args.cursor) : 0
      const rest = task.transcript.filter((message) => message.seq > after)
      const messages = rest.slice(0, limit)
      const complete = terminal(task) && messages.length === rest.length
      const last = messages.at(-1)?.seq ?? after
      return {
        task_id: task.task_id,
        tenant: state.tenant,
        scope: null,
        state: task.state,
        messages,
        next_cursor: complete ? null : String(last),
        complete,
      }
    },
    farm_answer_task: (args) => {
      const task = mine(state.tasks.get(String(args.task_id)))
      if (task === undefined) return notFound()
      if (task.question === null || (args.seq !== undefined && args.seq !== task.question.seq))
        return error("no_open_question", "The task is not waiting for an answer.")
      if (
        task.question.kind === "permission" &&
        (args.seq === undefined || !task.question.options?.includes(String(args.answer)))
      )
        return error("answer_invalid", "A permission question takes Allow or Deny, with its seq.")
      const seq = task.question.seq
      task.answer = String(args.answer)
      task.question = null
      task.updated_at = iso()
      return { seq, answered_at: iso() }
    },
  }

  const result = (id: unknown, structured: Json, isError: boolean) =>
    Response.json({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured, isError },
    })

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname
      if (request.method === "PUT" && path.startsWith(UPLOAD)) {
        if (request.headers.get("authorization") !== null) return new Response(null, { status: 400 })
        if (!state.tickets.delete(path.slice(UPLOAD.length)))
          return Response.json(error("not_found", "No such link."), { status: 404 })
        state.uploaded = (JSON.parse(await request.text()) as { value: string }).value
        state.userCredential = true
        return new Response(null, { status: 204 })
      }
      if (request.method === "GET" && path.startsWith(RESULTS)) {
        const document = state.documents.get(path.slice(RESULTS.length))
        return document === undefined ? new Response("expired", { status: 403 }) : Response.json(document)
      }
      if (request.method !== "POST" || path !== PATH) return new Response("not found", { status: 404 })
      const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? ""
      if (state.unauthorized || !(input.authorize?.(bearer) ?? bearer !== ""))
        return Response.json({ error: "invalid_token" }, { status: 401 })
      if (state.unavailable) return Response.json({ error: "service_not_running" }, { status: 503 })
      if (state.down) return new Response("Bad Gateway", { status: 502 })
      const body = (await request.json()) as { id: unknown; params: { name: string; arguments?: Json } }
      const args = body.params.arguments ?? {}
      state.calls.push({ name: body.params.name, args: structuredClone(args) })
      const tool = tools[body.params.name]
      if (tool === undefined) return result(body.id, error("tool_unknown", `No tool ${body.params.name}.`), true)
      const { status: _, ...answer } = tool(args)
      return result(body.id, answer, "error" in answer && typeof answer.error === "object")
    },
  })
  const url = () => `http://127.0.0.1:${server.port}`

  /** Moves a task on, as the farm would while it runs. */
  const advance = (id: string, change: Partial<Task>) => {
    const task = state.tasks.get(id)
    if (task === undefined) throw new Error(`no task ${id}`)
    const was = terminal(task)
    Object.assign(task, { updated_at: iso() }, change)
    // Finishing makes the task new to its owner again, as the farm's trigger does.
    if (terminal(task) && !was)
      Object.assign(task, { finished_at: task.finished_at ?? iso(), viewed: change.viewed ?? false })
    return task
  }

  return {
    get url() {
      return url()
    },
    state,
    advance,
    /** The tool calls made so far, by name. */
    called: () => state.calls.map((call) => call.name),
    reset: () => {
      state.calls.length = 0
    },
    stop: () => server.stop(true),
  }
}

export type FakeFarm = ReturnType<typeof fakeFarm>

/**
 * The farm backend as main will build it, against `farm`: a signed-in account of the sp-client fake `sp` (real JWT
 * mint), the real `FarmClient.viaSp` and the real `FarmCloud`, with the account's instance URL pointed at the fake
 * proxy. `interval` is the poll of `watch`, short in tests.
 */
export async function signedIn(
  sp: Fake,
  farm: FakeFarm,
  options: { models?: () => Promise<readonly string[] | undefined>; interval?: number; fetch?: typeof fetch } = {},
) {
  const context = setup(sp)
  const pat = sp.issuePat()
  await context.accounts.signInToken({ url: sp.url, token: pat })
  const accounts = {
    active: context.accounts.active,
    session: context.accounts.session,
    stored: (key: string) => {
      const stored = context.accounts.stored(key)
      return stored && { ...stored, url: farm.url }
    },
  }
  const client = FarmClient.viaSp({ accounts })
  const cloud = FarmCloud.make({
    transport: client,
    accounts: {
      active: context.accounts.active,
      withPat: async (key, use) => {
        if (context.accounts.list().find((account) => account.id === key)?.status !== "signedIn")
          throw new DynWorkAccounts.NotSignedIn({ id: key })
        return use(pat)
      },
    },
  })
  const backend = RoutinesFarm.make({
    client,
    cloud,
    models: options.models ?? (async () => ["claude-sonnet-5-5", "claude-opus-5-5"]),
    interval: options.interval ?? 5,
    fetch: options.fetch,
  })
  return { ...context, pat, backend, client, cloud }
}
