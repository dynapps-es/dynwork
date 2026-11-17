export * as RoutinesTemplates from "./templates"

import { fail } from "./backend"
import type { Definition, Failure, Personal, Template } from "./contract"

// The rules a routine activated from a template follows, as the plan's `docs/contract.md` §1 fixes them and Governance
// enforces them: pure, for the form, the chat tools and the merge of a new revision alike.
//
// A path names a field of a `Definition`: a common key (`instructions`, `agent`, `model`), `options.<key>`, or
// `schedule.<cron field>` (`minute`, `hour`, `day`, `month`, `weekday`). `where` is the backend the routine lives on,
// which no edit of a definition changes.

const ALWAYS = ["instructions", "agent", "where", "options.connectors", "options.permissions"]
const CRON = ["minute", "hour", "day", "month", "weekday"]

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

// The template's own task, in `timezone`: undefined options are left out, as a `Definition`'s are JSON. A time limit
// with a ceiling and no default starts at the ceiling.
function defaults(template: Template, timezone: string): Definition {
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

function refusals(template: Template, personal: Personal, definition: Definition) {
  return {
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
