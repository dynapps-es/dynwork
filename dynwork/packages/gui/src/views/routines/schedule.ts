/** How often a routine repeats. */
export type Repeat = "daily" | "weekdays" | "weekly" | "custom"

/** When a routine runs: a repeat kind, the time of day and, for `weekly` and `custom`, the days (0 is Sunday). */
export interface Schedule {
  readonly repeat: Repeat
  /** 24-hour `HH:MM`. */
  readonly time: string
  readonly days: readonly number[]
}

/** What the New routine dialog collects. */
export interface Draft {
  name: string
  prompt: string
  folder: string
  repeat: Repeat
  time: string
  /** `weekly` uses the first day; `custom` uses all of them. */
  days: number[]
}

export const repeats: readonly Repeat[] = ["daily", "weekdays", "weekly", "custom"]

const short = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const plural = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"]
const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** The day's short name, for the day pickers. */
export function dayName(day: number) {
  return short[day]
}

export function emptyDraft(): Draft {
  return { name: "", prompt: "", folder: "", repeat: "weekdays", time: "09:00", days: [1] }
}

/** The schedule in words: "Weekdays at 08:45", "Fridays at 16:00", "Mon, Wed and Fri at 07:30". */
export function scheduleText(schedule: Schedule) {
  if (schedule.repeat === "daily") return `Every day at ${schedule.time}`
  if (schedule.repeat === "weekdays") return `Weekdays at ${schedule.time}`
  if (schedule.repeat === "weekly") return `${plural[schedule.days[0]]} at ${schedule.time}`
  const names = [...schedule.days].sort((a, b) => a - b).map(dayName)
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names.join("")
  return `${list} at ${schedule.time}`
}

/** The label of the next run after `now`: "Today 23:00", "Tomorrow 08:45", "Fri 7 Nov 16:00". */
export function nextRunText(schedule: Schedule, now: Date) {
  const next = nextRun(schedule, now)
  const day = Math.round((midnight(next) - midnight(now)) / 86_400_000)
  if (day === 0) return `Today ${schedule.time}`
  if (day === 1) return `Tomorrow ${schedule.time}`
  return `${short[next.getDay()]} ${next.getDate()} ${months[next.getMonth()]} ${schedule.time}`
}

/** The first time the schedule fires after `now`. */
export function nextRun(schedule: Schedule, now: Date) {
  const hours = Number(schedule.time.slice(0, 2))
  const minutes = Number(schedule.time.slice(3, 5))
  const days = daysOf(schedule)

  // A schedule with at least one day fires within a week.
  return Array.from(
    { length: 8 },
    (_, offset) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, hours, minutes),
  ).find((candidate) => candidate > now && days.includes(candidate.getDay()))!
}

/** The problems with a draft; empty when it can be added. */
export function draftErrors(draft: Draft) {
  return [
    draft.name.trim() ? undefined : ("name" as const),
    draft.prompt.trim() ? undefined : ("prompt" as const),
    /^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time) ? undefined : ("time" as const),
    draft.repeat === "custom" && draft.days.length === 0 ? ("days" as const) : undefined,
  ].filter((error) => error !== undefined)
}

export function draftSchedule(draft: Draft): Schedule {
  return {
    repeat: draft.repeat,
    time: draft.time,
    days: draft.repeat === "weekly" ? draft.days.slice(0, 1) : draft.days,
  }
}

function daysOf(schedule: Schedule) {
  if (schedule.repeat === "daily") return [0, 1, 2, 3, 4, 5, 6]
  if (schedule.repeat === "weekdays") return [1, 2, 3, 4, 5]
  return schedule.days
}

function midnight(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}
