import type { Capabilities, Choice, Field, Routine, Run, RunState } from "../../routines/contract"
import { shown, valueOf } from "./fields"
import type { Words } from "./schedule"

// What the Agents view reads off one routine and its backend's capabilities, as data: the status tag, the filters it
// matches, which actions it allows and why not, and the facts of its detail. Everything here is synchronous and
// backend-agnostic: a backend changes what the view shows only through `Capabilities`.

export type Where = "all" | "local" | "remote"
export type Status = "all" | "active" | "paused" | "failing" | "running"

export const wheres: readonly Where[] = ["all", "local", "remote"]
export const statuses: readonly Status[] = ["all", "active", "paused", "failing", "running"]

export type Tone = "success" | "warning" | "danger" | "info"

const live: readonly RunState[] = ["queued", "running"]
const broken: readonly RunState[] = ["failed", "blocked"]

export const isLive = (run?: Run) => !!run && live.includes(run.state)

/**
 * A run that waits for the user: for the answer to a permission request (`permission`) or to a question it asks
 * (`question`, with `Run.question`). It runs, and will not go on alone.
 */
export const waiting = (run: Pick<Run, "state" | "reason">) =>
  run.state === "running" && (run.reason === "permission" || run.reason === "question")

/** The message key of a run's state: "Waiting for your permission" or "...your answer" while it waits, else its state's. */
export const stateKey = (run: Pick<Run, "state" | "reason">) =>
  waiting(run) ? (run.reason === "question" ? "agents.run.asking" : "agents.run.waiting") : `agents.run.${run.state}`

/** The tone a run's state is drawn in. */
export function runTone(state: RunState, reason?: string): Tone | undefined {
  if (waiting({ state, reason })) return "warning"
  if (state === "ok") return "success"
  if (state === "late") return "warning"
  if (broken.includes(state)) return "danger"
  if (live.includes(state)) return "info"
  return undefined
}

/** The card's and the detail's status tag. The first that applies wins. */
export function routineStatus(routine: Routine, capabilities?: Capabilities): Words & { tone?: Tone } {
  if (capabilities && capabilities.status !== "ready")
    return { key: `agents.backend.${capabilities.status}`, params: {}, tone: "warning" }
  if (routine.state === "error") return { key: "agents.status.error", params: {}, tone: "danger" }
  if (routine.state === "finished") return { key: "agents.status.finished", params: {} }
  if (routine.state === "paused") return { key: "agents.status.paused", params: {} }
  if (routine.owner?.unclaimed) return { key: "agents.status.unclaimed", params: {} }
  if (routine.owner && !routine.owner.here)
    return { key: "agents.status.elsewhere", params: { device: routine.owner.label } }
  if (isLive(routine.last)) return { key: "agents.status.running", params: {}, tone: "info" }
  if (routine.last && broken.includes(routine.last.state))
    return { key: "agents.status.failing", params: {}, tone: "danger" }
  if (!routine.definition.schedule) return { key: "agents.status.manual", params: {} }
  return { key: "agents.status.active", params: {}, tone: "success" }
}

export function matchesStatus(status: Status, routine: Routine) {
  if (status === "all") return true
  if (status === "active" || status === "paused") return routine.state === status
  if (status === "running") return isLive(routine.last)
  return !!routine.last && broken.includes(routine.last.state)
}

export function matchesWhere(where: Where, capabilities?: Capabilities) {
  return where === "all" || capabilities?.kind === where
}

/** Whether an action is allowed and, when not, why: a message key for `ctx.t`. */
export interface Allowed {
  readonly enabled: boolean
  readonly reason?: Words
}

const yes: Allowed = { enabled: true }

/**
 * The actions of a routine, as its backend allows them. A backend that cannot serve disables all of them with its own
 * reason. `edit` stays enabled where it replaces the routine, with a note that says so.
 */
export function actions(routine: Routine, capabilities?: Capabilities) {
  const blocked = unavailable(capabilities)
  const finished = routine.state === "finished" || routine.state === "error"
  return {
    start: blocked ?? owned(routine) ?? yes,
    /** "Move to this computer": the detail offers it only for a routine another device runs. */
    move: blocked ?? yes,
    toggle: blocked ?? (finished ? no("agents.reason.finished") : yes),
    edit:
      blocked ??
      (capabilities?.actions.edit === "replace" ? { enabled: true, reason: words("agents.reason.replace") } : yes),
    remove: blocked ?? yes,
    cancel: blocked ?? (capabilities?.actions.cancel ? yes : no("agents.reason.cancel")),
    open: blocked ?? (routine.conversation.kind !== "none" || routine.last ? yes : no("agents.reason.empty")),
  }
}

/** Whether a run can be opened from a list: a run that never started has nothing to read. */
export function openable(run: Run) {
  return run.conversation.kind !== "none"
}

/** One read-only fact of the detail, from a backend field and the routine's value for it. */
export interface Fact {
  readonly key: string
  readonly label: string
  readonly kind: Field["kind"]
  /** A string for most kinds; a list for `multiselect` and `list`; a boolean for `toggle`. */
  readonly value: string | boolean | readonly string[]
}

/**
 * The backend fields of the detail, grouped where the detail shows them: `where` (workspace, plugins and limits),
 * `permissions`, `notifications`, and `options` for every other section, which the detail draws as the backend's own
 * block. A field hidden by its `when`, or without a value or default, is left out. `choices` names a lookup's labels.
 */
export function facts(routine: Routine, capabilities: Capabilities | undefined, choices: (lookup: string) => Choice[]) {
  const options = routine.definition.options
  const fields = capabilities?.fields ?? []
  const all = fields
    .filter((field) => shown(field, fields, options))
    .flatMap((field): Fact[] => {
      const value = present(
        field,
        valueOf(field, options),
        field.choices ?? (field.lookup ? choices(field.lookup) : []),
      )
      return value === undefined ? [] : [{ key: field.key, label: field.label, kind: field.kind, value }]
    })
  const section = (key: string) => fields.find((field) => field.key === key)?.section ?? ""
  const where = ["workspace", "plugins", "limits"]
  return {
    where: all.filter((fact) => where.includes(section(fact.key))),
    permissions: all.filter((fact) => section(fact.key) === "permissions"),
    notifications: all.filter((fact) => section(fact.key) === "notifications"),
    options: all.filter((fact) => ![...where, "permissions", "notifications"].includes(section(fact.key))),
  }
}

// The value as the detail shows it: choices by their label, absent for nothing to show.
function present(field: Field, value: unknown, choices: readonly Choice[]) {
  const label = (item: unknown) => {
    const text = String(item)
    return choices.find((choice) => choice.value === text)?.label ?? text
  }
  if (value === undefined || value === null || value === "") return undefined
  if (field.kind === "toggle") return value === true
  if (Array.isArray(value)) return value.length === 0 ? undefined : value.map(label)
  if (typeof value === "object") return undefined
  return label(value)
}

function unavailable(capabilities?: Capabilities): Allowed | undefined {
  if (!capabilities) return no("agents.reason.missing")
  if (capabilities.status === "ready") return undefined
  if (capabilities.detail)
    return { enabled: false, reason: words("agents.reason.detail", { detail: capabilities.detail }) }
  return no(`agents.backend.${capabilities.status}`)
}

// A routine of another device runs only there; one no device has claimed yet runs nowhere.
function owned(routine: Routine): Allowed | undefined {
  if (!routine.owner || routine.owner.here) return undefined
  if (routine.owner.unclaimed) return no("agents.reason.unclaimed")
  return { enabled: false, reason: words("agents.reason.owner", { device: routine.owner.label }) }
}

const words = (key: string, params: Record<string, string> = {}): Words => ({ key, params })
const no = (key: string): Allowed => ({ enabled: false, reason: words(key) })
