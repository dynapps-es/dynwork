export * as RoutinesTemplates from "./templates"

import { fail } from "./backend"
import type { Definition, Failure, Personal, Template, TemplateChange } from "./contract"

// The rules a routine activated from a template follows, as the plan's `docs/contract.md` §1 fixes them and Governance
// enforces them: pure, for the form, the chat tools and the merge of a new revision alike.
//
// A path names a field of a `Definition`: a common key (`instructions`, `agent`, `model`), `options.<key>`, or
// `schedule.<cron field>` (`minute`, `hour`, `day`, `month`, `weekday`). `where` is the backend the routine lives on,
// which no edit of a definition changes.

const ALWAYS = ["instructions", "agent", "where", "options.connectors", "options.permissions"]
const CRON = ["minute", "hour", "day", "month", "weekday"]
// The options a template sets that stay the person's to change: merged three ways (`merge`).
const DEFAULTS = ["recover", "catchUp", "notify"]

type Value = Definition["options"][string] | undefined

/** The paths `template` locks on a routine activated from it. */
export function locked(template: Template) {
  const cron = { free: [], time: CRON.slice(2), locked: CRON }[template.locks.schedule]
  return [
    ...ALWAYS,
    ...(template.locks.model ? ["model"] : []),
    ...cron.map((field) => `schedule.${field}`),
    ...(template.locks.timeLimitMax === null ? [] : ["options.timeLimit"]),
  ]
}

/**
 * The locked paths an edit from `before` to `after` changes to something `template` does not allow. A path the edit
 * leaves alone is never its violation. `options.permissions` and `options.timeLimit` are ceilings: going from `bypass`
 * to `ask`, or lowering the time limit, is allowed.
 */
export function violates(template: Template, before: Definition, after: Definition) {
  const own = defaults(template, "")
  return locked(template).filter((path) => {
    const value = read(after, path)
    if (same(read(before, path), value)) return false
    if (path === "options.permissions")
      return value === "bypass" && template.definition.options.permissions !== "bypass"
    if (path === "options.timeLimit") return typeof value !== "number" || value > Number(template.locks.timeLimitMax)
    return !same(read(own, path), value)
  })
}

/**
 * The routine a person makes of `template`: its defaults, what `personal` gives where the template leaves it to them,
 * and the link to its revision. `invalid`, one message per field, for a Cloud template, a missing zone or folder, a
 * template that runs without asking that the person did not confirm, or a personal value the template locks.
 */
export function activate(template: Template, personal: Personal): Definition | Failure {
  const base = defaults(template, personal.timezone)
  const definition: Definition = {
    ...base,
    ...(personal.model === undefined ? {} : { model: personal.model }),
    ...(personal.cron === undefined ? {} : { schedule: { cron: personal.cron, timezone: personal.timezone } }),
    options: { ...base.options, ...(personal.folder === undefined ? {} : { folder: personal.folder }) },
  }
  const problems = {
    ...refusals(template, personal, definition),
    ...Object.fromEntries(violates(template, base, definition).map((path) => [fieldOf(path), "The template sets it."])),
  }
  if (Object.keys(problems).length === 0) return definition
  return fail("invalid", "Some fields need attention.", problems)
}

/**
 * The template's own task, in `timezone`: undefined options are left out, as a `Definition`'s are JSON. A time limit
 * with a ceiling and no default starts at the ceiling. The activation form starts from it.
 */
export function defaults(template: Template, timezone: string): Definition {
  const source = template.definition
  const options = Object.fromEntries(Object.entries(source.options).filter((entry) => entry[1] !== undefined))
  const limit = source.options.timeLimit ?? template.locks.timeLimitMax
  return {
    name: template.name,
    instructions: source.instructions,
    ...(source.agent === undefined ? {} : { agent: source.agent }),
    ...(source.model === undefined ? {} : { model: source.model }),
    ...(source.schedule ? { schedule: { cron: source.schedule.cron, timezone } } : {}),
    enabled: true,
    options: { ...options, ...(limit === null || limit === undefined ? {} : { timeLimit: limit }) },
    template: { id: template.id, revision: template.revision },
  }
}

/**
 * A template's new revision merged into the person's task of it, three ways: `base` is the revision the task follows,
 * `next` the new one. What `next` locks takes its value. A default the person left as `base` had it takes `next`'s; one
 * they changed keeps theirs, and when `next` changed it too it is listed in `changes` (`from` → `to`) for the person to
 * answer. A free schedule merges each cron field on its own. Permissions are a ceiling that never goes up to "Don't ask"
 * without the person (it is a change to answer); a time limit stays at or under the new ceiling. `previous` are changes
 * not answered yet: each stays, now towards `next`'s value, while the task still differs from it. A schedule the task
 * did not have is read in `zone`.
 */
export function merge(input: {
  base: Template
  next: Template
  task: Definition
  zone: string
  previous?: readonly TemplateChange[]
}) {
  const task = input.task
  const zone = task.schedule?.timezone ?? input.zone
  const base = defaults(input.base, zone)
  const next = defaults(input.next, zone)
  const fixed = locked(input.next)
  const changes: TemplateChange[] = []
  const pick = <A extends Value>(path: string, from: A, to: A, mine: A): A => {
    if (fixed.includes(path)) return to
    const merged = three(from, to, mine)
    if (merged.conflict) changes.push(change(path, from, to))
    return merged.value
  }
  const name = pick("name", base.name, next.name, task.name)
  const model = pick("model", base.model, next.model, task.model)
  const cron = schedule(fixed, base.schedule?.cron, next.schedule?.cron, task.schedule?.cron)
  if (cron.conflict) changes.push(change("schedule", base.schedule?.cron, next.schedule?.cron))
  const permissions = next.options.permissions === "bypass" && task.options.permissions === "bypass" ? "bypass" : "ask"
  if (next.options.permissions === "bypass" && permissions === "ask" && base.options.permissions !== "bypass")
    changes.push(change("options.permissions", base.options.permissions, next.options.permissions))
  const limit = three(base.options.timeLimit, next.options.timeLimit, task.options.timeLimit)
  const ceiling = input.next.locks.timeLimitMax
  const timeLimit = ceiling !== null && typeof limit.value === "number" && limit.value > ceiling ? ceiling : limit.value
  if (limit.conflict && !same(timeLimit, next.options.timeLimit))
    changes.push(change("options.timeLimit", base.options.timeLimit, next.options.timeLimit))
  const options = {
    ...task.options,
    connectors: next.options.connectors,
    permissions,
    timeLimit,
    ...Object.fromEntries(
      DEFAULTS.map((key) => [key, pick(`options.${key}`, base.options[key], next.options[key], task.options[key])]),
    ),
  }
  const definition: Definition = {
    name,
    instructions: next.instructions,
    ...(next.agent === undefined ? {} : { agent: next.agent }),
    ...(model === undefined ? {} : { model }),
    ...(cron.value === undefined ? {} : { schedule: { ...task.schedule, cron: cron.value, timezone: zone } }),
    enabled: task.enabled,
    options: Object.fromEntries(
      Object.entries(options).filter((entry): entry is [string, NonNullable<Value>] => entry[1] !== undefined),
    ),
    template: { id: input.next.id, revision: input.next.revision },
  }
  const pending = (input.previous ?? [])
    .filter((previous) => !changes.some((now) => now.path === previous.path))
    .flatMap((previous) => {
      const to = valueAt(next, previous.path)
      return same(valueAt(definition, previous.path), to) ? [] : [change(previous.path, previous.from, to)]
    })
  return { definition, changes: [...pending, ...changes] }
}

/** The task with the template's value of each change written in: what Apply does. A schedule keeps its time zone. */
export function apply(definition: Definition, changes: readonly TemplateChange[]) {
  return changes.reduce((result, change) => write(result, change.path, change.to), definition)
}

function refusals(template: Template, personal: Personal, definition: Definition) {
  return {
    // JESÚS: Cloud templates (`where: "cloud"`) are refused until the farm backend creates them: activating one will be
    // this same definition handed to the farm's `create`, with the locks and merge unchanged (`TEMPLATES.md`).
    ...(template.where === "local" ? {} : { where: "Only templates that run on this computer can be activated here." }),
    ...(definition.schedule && personal.timezone.trim() === "" ? { schedule: "A time zone is required." } : {}),
    ...(template.personal.folder === "required" && !personal.folder?.trim()
      ? { folder: "This template needs a project folder." }
      : {}),
    ...(template.definition.options.permissions === "bypass" && !personal.approved
      ? { permissions: "Confirm that it runs without asking." }
      : {}),
  }
}

function read(definition: Definition, path: string) {
  if (path.startsWith("options.")) return definition.options[path.slice("options.".length)]
  if (path.startsWith("schedule."))
    return definition.schedule?.cron.trim().split(/\s+/)[CRON.indexOf(path.slice("schedule.".length))]
  if (path === "instructions") return definition.instructions
  if (path === "agent") return definition.agent
  if (path === "model") return definition.model
  return undefined
}

// One value merged three ways: the template did not change it (the person's stays), the person did not (the template's
// new one), or both did (the person's stays, a conflict unless they agree).
function three<A>(from: A, to: A, mine: A) {
  if (same(from, to)) return { value: mine, conflict: false }
  if (same(mine, from)) return { value: to, conflict: false }
  return { value: mine, conflict: !same(mine, to) }
}

// The cron merged part by part: the time (minute and hour together), the day, the month and the weekday, each locked
// part taking the new revision's. A cron the task or a revision lacks merges whole (or is the new revision's, when any
// of its fields is locked).
function schedule(fixed: string[], from?: string, to?: string, mine?: string) {
  if (from === undefined || to === undefined || mine === undefined) {
    if (fixed.some((path) => path.startsWith("schedule."))) return { value: to, conflict: false }
    return three(from, to, mine)
  }
  const crons = [from, to, mine].map((cron) => cron.trim().split(/\s+/))
  const parts = [CRON.slice(0, 2), ...CRON.slice(2).map((field) => [field])].map((names) => {
    const [base, next, own] = crons.map((cron) => names.map((name) => cron[CRON.indexOf(name)]).join(" "))
    if (names.some((name) => fixed.includes(`schedule.${name}`))) return { value: next, conflict: false }
    return three(base, next, own)
  })
  return { value: parts.map((part) => part.value).join(" "), conflict: parts.some((part) => part.conflict) }
}

function change(path: string, from: Value, to: Value): TemplateChange {
  return { path, ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) }
}

// The value a change's path names: the whole cron for `schedule`.
function valueAt(definition: Definition, path: string): Value {
  if (path === "schedule") return definition.schedule?.cron
  if (path === "name") return definition.name
  if (path === "model") return definition.model
  return definition.options[path.slice("options.".length)]
}

function write(definition: Definition, path: string, value: Value): Definition {
  if (path === "name") return typeof value === "string" ? { ...definition, name: value } : definition
  if (path === "model") {
    const { model: _, ...rest } = definition
    return typeof value === "string" ? { ...rest, model: value } : rest
  }
  if (path === "schedule") {
    const { schedule: _, ...rest } = definition
    if (typeof value !== "string") return rest
    return { ...rest, schedule: { ...definition.schedule, cron: value, timezone: definition.schedule?.timezone ?? "" } }
  }
  const key = path.slice("options.".length)
  const { [key]: _, ...options } = definition.options
  return { ...definition, options: value === undefined ? options : { ...options, [key]: value } }
}

// The key of `Failure.fields` a path is reported under: the backend field's or the common one's.
function fieldOf(path: string) {
  if (path.startsWith("options.")) return path.slice("options.".length)
  return path.split(".")[0] ?? path
}

// Key order does not count: a definition read back from Governance's JSONB may list an object's keys differently.
function same(left: unknown, right: unknown) {
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right))
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map((entry) => [entry[0], sorted(entry[1])]),
  )
}
