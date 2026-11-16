import { Cron, DateTime, Result } from "effect"
import type { Schedule } from "../../routines/contract"

// A routine's schedule as the view shows it: in words and as its next runs. The contract carries a five-field cron in
// an IANA zone (`Schedule`); the form writes its presets as cron and previews them with `upcoming` too.

/** A message key and its parameters, for `ctx.t`. */
export interface Words {
  readonly key: string
  readonly params: Record<string, string>
}

/**
 * The shapes the form writes a schedule in. Each is a cron: `cronOf` writes it, `presetOf` reads it back, and any cron
 * that is not one of these is `cron`, kept as it is. `time` is `HH:MM`; `days` are weekdays from 0 (Sunday) to 6.
 */
export type Preset =
  | { readonly kind: "daily" | "weekdays"; readonly time: string }
  | { readonly kind: "weekly"; readonly time: string; readonly days: readonly number[] }
  | { readonly kind: "monthly"; readonly time: string; readonly day: number }
  | { readonly kind: "cron"; readonly cron: string }

/** A cron as one of the form's presets: every day, weekdays, days of the week, a day of the month, else the cron. */
export function presetOf(cron: string): Preset {
  const fields = cron.trim().split(/\s+/)
  const time = clock(fields[0], fields[1])
  const custom: Preset = { kind: "cron", cron }
  if (fields.length !== 5 || !time) return custom
  const [, , day, month, week] = fields
  if (month !== "*") return custom
  if (day === "*" && week === "*") return { kind: "daily", time }
  if (day === "*" && week === "1-5") return { kind: "weekdays", time }
  if (day === "*" && /^[0-7](,[0-7])*$/.test(week))
    return {
      kind: "weekly",
      time,
      days: [...new Set(week.split(",").map((value) => Number(value) % 7))].toSorted((a, b) => a - b),
    }
  if (week === "*" && /^\d{1,2}$/.test(day)) return { kind: "monthly", time, day: Number(day) }
  return custom
}

/** The cron of a preset; undefined while it is incomplete, as `scheduleProblem` says. */
export function cronOf(preset: Preset): string | undefined {
  if (scheduleProblem(preset)) return undefined
  if (preset.kind === "cron") return preset.cron.trim().split(/\s+/).join(" ")
  const [hour, minute] = preset.time.split(":").map(Number)
  const at = `${minute} ${hour}`
  if (preset.kind === "monthly") return `${at} ${preset.day} * *`
  if (preset.kind === "weekly") return `${at} * * ${[...new Set(preset.days)].toSorted((a, b) => a - b).join(",")}`
  return `${at} * * ${preset.kind === "weekdays" ? "1-5" : "*"}`
}

/** The message key of what keeps a preset from being written, or undefined when it can be. */
export function scheduleProblem(preset: Preset): string | undefined {
  if (preset.kind === "cron") return preset.cron.trim() === "" ? "agents.form.error.cron" : undefined
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(preset.time)) return "agents.form.error.time"
  if (preset.kind === "weekly" && !preset.days.some((day) => Number.isInteger(day) && day >= 0 && day <= 6))
    return "agents.form.error.days"
  if (preset.kind === "monthly" && !(Number.isInteger(preset.day) && preset.day >= 1 && preset.day <= 31))
    return "agents.form.error.day"
  return undefined
}

/** Whether a cron fires at minute zero, when many schedules fire at once and a run can start a little late. */
export function onTheHour(cron: string) {
  return cron.trim().split(/\s+/)[0] === "0"
}

/**
 * The schedule in words, for the presets the form writes: every day, weekdays, one or several days of the week, one
 * day of the month. Anything else reads as its cron.
 */
export function describe(schedule: Schedule): Words {
  const preset = presetOf(schedule.cron)
  if (preset.kind === "daily") return { key: "agents.repeat.daily", params: { time: preset.time } }
  if (preset.kind === "weekdays") return { key: "agents.repeat.weekdays", params: { time: preset.time } }
  if (preset.kind === "monthly")
    return { key: "agents.repeat.monthly", params: { time: preset.time, day: String(preset.day) } }
  if (preset.kind === "weekly" && preset.days.length === 1)
    return { key: `agents.repeat.weekly.${preset.days[0]}`, params: { time: preset.time } }
  if (preset.kind === "weekly")
    return { key: "agents.repeat.days", params: { time: preset.time, days: preset.days.join(",") } }
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

/** The IANA zones to choose from: the system's, UTC and `current`, which a stored schedule may name unlisted. */
export function zones(current?: string) {
  return [...new Set([...Intl.supportedValuesOf("timeZone"), "UTC", ...(current ? [current] : [])])].toSorted()
}

/** The first moment of `day` (`YYYY-MM-DD`) in `zone`; undefined for a day or zone that cannot be read. */
export function dayStart(day: string, zone: string) {
  return moment(day, "T00:00:00", zone)
}

/** The last millisecond of `day` (`YYYY-MM-DD`) in `zone`. */
export function dayEnd(day: string, zone: string) {
  return moment(day, "T23:59:59.999", zone)
}

/** The day (`YYYY-MM-DD`) a moment falls on in `zone`. */
export function dayOf(at: number, zone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    at,
  )
}

function moment(day: string, time: string, zone: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined
  const zoned = DateTime.makeZoned(`${day}${time}`, { timeZone: zone, adjustForTimeZone: true })
  return zoned._tag === "Some" ? DateTime.toEpochMillis(zoned.value) : undefined
}

// `HH:MM` for a fixed minute and hour; undefined for a range, a step or a list.
function clock(minute?: string, hour?: string) {
  if (!minute || !hour || !/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return undefined
  return `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`
}
