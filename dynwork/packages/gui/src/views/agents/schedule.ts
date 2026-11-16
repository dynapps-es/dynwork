import { Cron, DateTime, Result } from "effect"
import type { Schedule } from "../../routines/contract"

// A routine's schedule as the view shows it: in words and as its next runs. The contract carries a five-field cron in
// an IANA zone (`Schedule`); the form (phase 03) writes its presets as cron and previews them with `upcoming` too.

/** A message key and its parameters, for `ctx.t`. */
export interface Words {
  readonly key: string
  readonly params: Record<string, string>
}

/**
 * The schedule in words, for the presets the form writes: every day, weekdays, one or several days of the week, one
 * day of the month. Anything else reads as its cron.
 */
export function describe(schedule: Schedule): Words {
  const fields = schedule.cron.trim().split(/\s+/)
  const time = clock(fields[0], fields[1])
  if (fields.length !== 5 || !time) return { key: "agents.repeat.cron", params: { cron: schedule.cron } }
  const [, , day, month, week] = fields
  if (month !== "*") return { key: "agents.repeat.cron", params: { cron: schedule.cron } }
  if (day === "*" && week === "*") return { key: "agents.repeat.daily", params: { time } }
  if (day === "*" && week === "1-5") return { key: "agents.repeat.weekdays", params: { time } }
  if (day === "*" && /^[0-7](,[0-7])*$/.test(week)) {
    const days = [...new Set(week.split(",").map((value) => Number(value) % 7))].toSorted((a, b) => a - b)
    if (days.length === 1) return { key: `agents.repeat.weekly.${days[0]}`, params: { time } }
    return { key: "agents.repeat.days", params: { time, days: days.join(",") } }
  }
  if (week === "*" && /^\d{1,2}$/.test(day)) return { key: "agents.repeat.monthly", params: { time, day } }
  return { key: "agents.repeat.cron", params: { cron: schedule.cron } }
}

/** The next `count` runs after `from`, in epoch milliseconds; none for a cron or zone that cannot be read. */
export function upcoming(schedule: Schedule, from: number, count = 3): number[] {
  const zone = DateTime.zoneMakeNamed(schedule.timezone)
  if (zone._tag === "None") return []
  const parsed = Cron.parse(schedule.cron, zone.value)
  if (Result.isFailure(parsed)) return []
  const sequence = Cron.sequence(parsed.success, new Date(from))
  return Array.from({ length: count }, () => sequence.next().value.getTime())
}

// `HH:MM` for a fixed minute and hour; undefined for a range, a step or a list.
function clock(minute?: string, hour?: string) {
  if (!minute || !hour || !/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return undefined
  return `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`
}
