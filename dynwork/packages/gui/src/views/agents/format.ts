import type { Capabilities, Definition, Field, Instructions, Run, Schedule } from "../../routines/contract"
import main from "../../routines/i18n/en"
import { describe } from "./schedule"

// How the Agents view writes times, durations, costs and schedules. Every function takes the window's `t` and locale,
// so tests read the same copy the app shows.

export type Translate = (key: string, params?: Record<string, string | number>) => string

/** A moment as "Mon 16 Nov, 08:45", in `zone` or the system's. */
export function when(locale: string, at: number, zone?: string) {
  const parts = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: zone,
  }).formatToParts(at)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? ""
  return `${part("weekday")} ${part("day")} ${part("month")}, ${part("hour")}:${part("minute")}`
}

/** The moment a run is filed under: when it started, else when it was due, else when it finished. */
export function runTime(run: Run) {
  return run.started ?? run.due ?? run.finished
}

/** A run's time in words, or its title when it has none. */
export function runWhen(locale: string, run: Run) {
  const at = runTime(run)
  return at === undefined ? run.title : when(locale, at)
}

/** Why a run is in its state, in words: the copy of a reason the view knows, else the backend's code as it is. */
export function reasonText(t: Translate, reason: string) {
  const key = `agents.why.${reason}`
  const text = t(key)
  return text === key ? reason : text
}

/** "3 min", "1 h 5 min", "less than a minute"; undefined for a run that never started. */
export function duration(t: Translate, run: Run, now: number) {
  if (run.started === undefined) return undefined
  const minutes = Math.round(((run.finished ?? now) - run.started) / 60_000)
  if (minutes < 1) return t("agents.duration.short")
  if (minutes < 60) return t("agents.duration.minutes", { minutes })
  return t("agents.duration.hours", { hours: Math.floor(minutes / 60), minutes: minutes % 60 })
}

export function money(locale: string, cost: { amount: number; currency: string }) {
  return new Intl.NumberFormat(locale, { style: "currency", currency: cost.currency }).format(cost.amount)
}

/** The schedule in words: "Weekdays at 07:30", "Mon, Wed and Fri at 09:00", or "Only when you run it". */
export function scheduleText(t: Translate, schedule: Schedule | undefined) {
  if (!schedule) return t("agents.repeat.none")
  const words = describe(schedule)
  if (words.key !== "agents.repeat.days") return t(words.key, words.params)
  const names = words.params.days.split(",").map((day) => t(`agents.day.short.${day}`))
  const days = t("agents.list.and", { first: names.slice(0, -1).join(", "), last: names[names.length - 1] })
  return t(words.key, { ...words.params, days })
}

/** One line of what a routine does: its prompt, "Skill timesheet-report" or "Agent crm-sync: <input>". */
export function instructionsText(t: Translate, instructions: Instructions) {
  if (instructions.kind === "prompt") return instructions.text
  if (instructions.kind === "skill")
    return t("agents.instructions.skill", { skill: instructions.skill, text: instructions.text ?? "" }).trim()
  return t("agents.instructions.agent", { agent: instructions.agent, input: instructions.input })
}

/**
 * A backend's part of the status line: "Demo MacBook · online", "Agent Farm connected · 7 of 20 team schedules", and
 * "Demo MacBook · online · Not synced" while its routines cannot reach Governance.
 */
export function backendLine(t: Translate, capabilities: Capabilities) {
  if (capabilities.status !== "ready")
    return t("agents.backend.status", {
      label: capabilities.label,
      status: capabilities.detail ?? t(`agents.backend.${capabilities.status}`),
    })
  const ready = t(`agents.backend.${capabilities.kind}.ready`, { label: capabilities.label })
  const line = capabilities.synced === false ? `${ready} · ${t("agents.backend.unsynced")}` : ready
  const quota = capabilities.quota
  if (!quota) return line
  const usage = t(quota.shared ? "agents.backend.quota.shared" : "agents.backend.quota.own", {
    used: quota.used,
    max: quota.max,
  })
  return `${line} · ${usage}`
}

/**
 * The rows a task's docks show in a conversation (`proposal.tsx`), and the words main tells the agent what changed with
 * (`routines/chat.ts`): the same rows, so the agent and the user read one list. `where` is where the task runs.
 */
export function cardRows(t: Translate, definition: Definition, where: string) {
  const options = definition.options
  const connectors = Array.isArray(options.connectors)
    ? options.connectors.length === 0
      ? t("agents.chat.connectors.none")
      : options.connectors.join(", ")
    : t("agents.chat.connectors.all")
  const schedule = scheduleText(t, definition.schedule)
  const zone = definition.schedule?.timezone
  return [
    { key: "name", label: t("agents.chat.row.routine"), value: definition.name },
    { key: "instructions", label: t("agents.chat.prompt"), value: instructionsText(t, definition.instructions) },
    { key: "schedule", label: t("agents.chat.row.schedule"), value: zone ? `${schedule} (${zone})` : schedule },
    { key: "where", label: t("agents.chat.row.where"), value: where },
    {
      key: "permissions",
      label: t("agents.chat.row.permissions"),
      value: t(`agents.chat.permissions.${options.permissions === "bypass" ? "bypass" : "ask"}`),
    },
    {
      key: "folder",
      label: t("agents.chat.row.folder"),
      value: typeof options.folder === "string" ? options.folder : t("agents.chat.none"),
    },
    { key: "connectors", label: t("agents.chat.row.connectors"), value: connectors },
    {
      key: "notify",
      label: t("agents.chat.row.notify"),
      value: t(`agents.chat.notify.${typeof options.notify === "string" ? options.notify : "failures"}`),
    },
  ]
}

/** What an update changes, row by row, as before → after: the rows of `cardRows` whose words differ. */
export function cardChanges(t: Translate, before: Definition, after: Definition, where: string) {
  const old = cardRows(t, before, where)
  return cardRows(t, after, where).flatMap((row, index) =>
    old[index]?.value === row.value ? [] : [{ ...row, before: old[index]?.value ?? "" }],
  )
}

// Main writes its copy in English (`routines/i18n/en.ts`): its English text names the key the window translates.
const spoken = new Map(Object.entries(main).map(([key, text]) => [text, key]))

/** Text main wrote (a failure, a field's label), in the window's language when the table has it, else as written. */
export function fromMain(t: Translate, text: string) {
  const key = spoken.get(text)
  return key ? t(key) : text
}

/** A backend's field with its label, help, choices and warnings in the window's language. */
export function fieldSaid(t: Translate, field: Field): Field {
  return {
    ...field,
    label: fromMain(t, field.label),
    ...(field.help === undefined ? {} : { help: fromMain(t, field.help) }),
    ...(field.choices === undefined
      ? {}
      : {
          choices: field.choices.map((choice) => ({
            ...choice,
            label: fromMain(t, choice.label),
            ...(choice.warning === undefined ? {} : { warning: fromMain(t, choice.warning) }),
          })),
        }),
  }
}
