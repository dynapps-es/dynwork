export * as RoutinesValidate from "./validate"

import { fail } from "./backend"
import type { Capabilities, Definition, Failure, Field } from "./contract"

/**
 * Checks a definition against what a backend declares in its capabilities, and nothing else: instruction kinds, the
 * common fields, the schedule's shape and every backend `Field`. A backend adds its own rules (a repository that does
 * not exist) on top. The keys of `fields` are the common ones (`name`, `instructions`, `agent`, `model`, `schedule`)
 * and each `Field.key`.
 */
// JESÚS: the farm's `validate()` runs this, then adds what only the farm knows (a repository that does not exist, a
// tenant limit lower than `Field.max`) and translates its own `422` details into the same `fields`.
export function check(capabilities: Capabilities, definition: Definition): Failure | undefined {
  const problems = {
    ...common(capabilities, definition),
    ...Object.fromEntries(
      capabilities.fields.flatMap((field) => {
        const problem = problemWith(field, definition.options, capabilities)
        return problem ? [[field.key, problem]] : []
      }),
    ),
  }
  if (Object.keys(problems).length === 0) return undefined
  return fail("invalid", "Some fields need attention.", problems)
}

function common(capabilities: Capabilities, definition: Definition) {
  const problems: Record<string, string> = {}
  if (definition.name.trim() === "") problems.name = "A name is required."
  const instructions = instructionProblem(capabilities, definition)
  if (instructions) problems.instructions = instructions
  if (capabilities.agent === "none" && definition.agent !== undefined) problems.agent = "This backend takes no agent."
  if (capabilities.agent === "required" && !definition.agent) problems.agent = "An agent is required."
  if (capabilities.model !== "choose" && definition.model !== undefined)
    problems.model = "The model is not chosen here."
  const schedule = scheduleProblem(capabilities, definition)
  if (schedule) problems.schedule = schedule
  return problems
}

function instructionProblem(capabilities: Capabilities, definition: Definition) {
  const instructions = definition.instructions
  if (!capabilities.instructions.includes(instructions.kind)) return `This backend does not take ${instructions.kind}.`
  if (instructions.kind === "prompt") return instructions.text.trim() === "" ? "The prompt is empty." : undefined
  if (instructions.kind === "skill") return instructions.skill.trim() === "" ? "Choose a skill." : undefined
  if (instructions.agent.trim() === "") return "Choose an agent."
  return instructions.input.trim() === "" ? "Tell the agent what to do." : undefined
}

function scheduleProblem(capabilities: Capabilities, definition: Definition) {
  const schedule = definition.schedule
  if (!schedule) return undefined
  if (schedule.cron.trim().split(/\s+/).length !== 5)
    return "A cron has five fields: minute, hour, day, month, weekday."
  if (schedule.timezone.trim() === "") return "A time zone is required."
  if (
    !capabilities.schedule.window &&
    (schedule.starts !== undefined || schedule.ends !== undefined || schedule.max !== undefined)
  )
    return "This backend does not take a start, an end or a limit of runs."
  if (schedule.starts !== undefined && schedule.ends !== undefined && schedule.ends <= schedule.starts)
    return "The end must come after the start."
  if (schedule.max !== undefined && (!Number.isInteger(schedule.max) || schedule.max < 1))
    return "The limit of runs is at least 1."
  return undefined
}

// A field that `when` hides is neither shown nor checked.
function problemWith(field: Field, options: Definition["options"], capabilities: Capabilities) {
  if (field.when && !sameJson(options[field.when.key] ?? defaultOf(capabilities, field.when.key), field.when.equals))
    return undefined
  const value = options[field.key]
  if (value === undefined || value === null || value === "")
    return field.required ? `${field.label} is required.` : undefined
  if (field.kind === "toggle") return typeof value === "boolean" ? undefined : `${field.label} is on or off.`
  if (field.kind === "number") return numberProblem(field, value)
  if (field.kind === "multiselect" || field.kind === "list") return listProblem(field, value)
  if (typeof value !== "string") return `${field.label} is text.`
  if (field.kind === "select") return choiceProblem(field, value)
  if (field.kind === "repo" && !/^https:\/\/[^\s/]+\/\S+$/.test(value)) return `${field.label} is an https address.`
  if (field.pattern !== undefined && !new RegExp(field.pattern).test(value))
    return `${field.label} is not in the expected form.`
  return undefined
}

function numberProblem(field: Field, value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return `${field.label} is a number.`
  if (field.min !== undefined && value < field.min) return `${field.label} is at least ${field.min}.`
  if (field.max !== undefined && value > field.max) return `${field.label} is at most ${field.max}.`
  return undefined
}

function listProblem(field: Field, value: unknown) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return `${field.label} is a list.`
  if (field.required && value.length === 0) return `${field.label} is required.`
  if (field.max !== undefined && value.length > field.max) return `${field.label} takes at most ${field.max}.`
  if (
    field.kind === "multiselect" &&
    field.choices &&
    value.some((item) => !field.choices?.some((c) => c.value === item))
  )
    return `${field.label} has a choice that does not exist.`
  return undefined
}

function choiceProblem(field: Field, value: string) {
  if (field.choices && !field.choices.some((choice) => choice.value === value))
    return `${field.label} has no such choice.`
  return undefined
}

function defaultOf(capabilities: Capabilities, key: string) {
  return capabilities.fields.find((field) => field.key === key)?.default
}

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}
