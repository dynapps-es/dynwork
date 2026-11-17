import type { Capabilities, Instructions, Run, Schedule } from "../../routines/contract"
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
