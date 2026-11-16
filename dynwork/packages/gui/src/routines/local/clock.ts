export * as RoutinesClock from "./clock"

import { Cron, DateTime, Result } from "effect"
import type { Persisted } from "@opencode/plugin/gui/main"
import type { Definition } from "../contract"
import type { Local } from "./backend"
import type { Saved, SavedRoutine } from "./store"

// The clock of the local routines: it fires each scheduled, enabled routine at its time while Dynwork is open, and
// deals with the occurrences it could not fire (Dynwork closed, the computer asleep) by the routine's own "Recover
// missed runs". One timer waits for the nearest due time; any change of a routine, a wake, a change of the provider
// and the timer itself make it look again.
//
// Exactly once: the occurrence key, the newest due time a routine's clock took (`SavedRoutine.due`), is written to the
// plugin's storage before the run starts, in the same synchronous step that decides it. An occurrence at or before
// the key never starts again, whatever restarts or timers come after. There is no other lock.

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** An occurrence found this long after its time still runs as scheduled; later than that, it was missed. */
export const GRACE = 5 * MINUTE
/** No catch-up when the next regular run is closer than this: that one covers the gap. */
export const SOON = 15 * MINUTE
/** The longest the timer sleeps, so a change of the system clock is noticed within it. */
export const NAP = MINUTE
/** How long to wait before asking `ready` again when it said no. */
export const WAIT = 30_000
/** The most missed occurrences recorded at once; older ones are left out of the history. */
export const LIMIT = 100
/** "Recover missed runs" when the routine does not say: if recent, within this many hours. */
export const HOURS = 6

/** Timers the clock arms; `set` answers what cancels it. Tests pass their own, so nothing waits on real time. */
export interface Timers {
  set(fire: () => unknown, ms: number): () => void
}

export interface Options {
  local: Local
  /** The local backend's storage, read for the routines and their occurrence keys. */
  store: Persisted<Saved, Saved>
  now: () => number
  /**
   * Whether a run can start: DynWork's service answers and the Governance provider is applied to it. Until then
   * nothing fires; `check()` once it changes.
   */
  ready: () => boolean
  timers?: Timers
}

/** What the clock does with a routine's occurrences that came due. */
export interface Plan {
  /** The occurrence key to write: the newest occurrence taken. */
  due: number
  /** The occurrence that runs; `since`, the oldest missed one it covers. */
  run?: { due: number; trigger: "schedule" | "catch-up"; since?: number }
  /** The occurrences that do not run, for the history. */
  records: Array<{ due: number; state: "missed" | "skipped"; reason: Reason }>
}

/**
 * Why an occurrence did not run as scheduled, as `Run.reason`:
 * - `closed`: Dynwork was closed or asleep at its time, and the routine did not recover it.
 * - `grouped`: missed, and covered by the one catch-up run that started for it and the others.
 * - `overlap`: skipped, the routine's previous run was still running.
 * - `restart`: a run cut short when the service or the app stopped (`Local.interrupted`).
 * - `start`: the run could not start.
 */
export type Reason = "closed" | "grouped" | "overlap" | "restart" | "start"

const real: Timers = {
  set: (fire, ms) => {
    const timer = setTimeout(() => void fire(), ms)
    return () => clearTimeout(timer)
  },
}

export function make(options: Options) {
  const timers = options.timers ?? real
  const life: { cancel?: () => void; launch?: Promise<void>; disposed: boolean } = { disposed: false }

  // Looks at every routine: takes what came due, then sleeps until the nearest next one.
  async function check() {
    if (life.disposed) return
    if (!options.ready()) return arm(WAIT)
    // The runs a restart cut are told first, so that a routine whose run was cut is not taken for one still going.
    life.launch ??= options.local.interrupted()
    await life.launch
    for (const stored of options.store.value.routines) await take(stored.id)
    if (life.disposed) return
    const now = options.now()
    const soonest = Math.min(...options.store.value.routines.map((stored) => next(stored.definition, now) ?? Infinity))
    if (soonest !== Infinity) arm(Math.min(Math.max(soonest - now, 0), NAP))
  }

  function arm(ms: number) {
    life.cancel?.()
    life.cancel = life.disposed ? undefined : timers.set(check, ms)
  }

  async function take(routine: string) {
    if (pending(routine).length === 0) return
    const going = await options.local.going(routine)
    // Read again after the wait: another look may have taken these occurrences meanwhile. From here to the write of
    // the occurrence key nothing waits, so no occurrence is taken twice.
    const stored = options.store.value.routines.find((candidate) => candidate.id === routine)
    const past = pending(routine)
    if (!stored || past.length === 0 || life.disposed) return
    const now = options.now()
    const decided = plan(stored.definition, {
      past,
      oldest: oldest(stored),
      next: next(stored.definition, now),
      now,
      going,
    })
    options.local.take(routine, decided)
    if (decided.run) await options.local.fire(routine, decided.run)
  }

  // The occurrences of a routine that came due and its clock has not taken, oldest first.
  function pending(routine: string) {
    const stored = options.store.value.routines.find((candidate) => candidate.id === routine)
    if (!stored) return []
    return occurrences(stored.definition, floor(stored), options.now())
  }

  const unwatch = options.local.watch(() => void check())
  void check()

  return {
    /** Looks again now: call it when the provider changes and when the computer wakes. */
    check,
    dispose: () => {
      life.disposed = true
      unwatch()
      life.cancel?.()
      life.cancel = undefined
    },
  }
}

export type Clock = ReturnType<typeof make>

/**
 * What to do with the occurrences that came due (`past`, oldest first, never empty):
 * - The newest one, found within `GRACE` of its time, runs as scheduled. The older ones were missed.
 * - Missed ones are recovered by one run, never one per occurrence, when the routine recovers missed runs and the
 *   newest missed one is within its hours. When nothing runs on time, that run is a catch-up for the newest one, unless
 *   the next regular run is within `SOON`. The others are recorded as grouped into it, and the run says since when.
 * - A run whose routine's previous run is still `going` is skipped, not queued.
 * - Everything else is recorded as missed.
 */
export function plan(
  definition: Definition,
  input: { past: readonly number[]; oldest: number; next?: number; now: number; going: boolean },
): Plan {
  const due = input.past[input.past.length - 1]!
  const onTime = input.now - due <= GRACE
  const missed = onTime ? input.past.slice(0, -1) : input.past
  const newest = missed[missed.length - 1]
  const hours = recovery(definition)
  const soon = input.next !== undefined && input.next - input.now < SOON
  const recovered =
    newest !== undefined && hours !== undefined && input.now - newest <= hours * HOUR && (onTime || !soon)
  const runs = onTime || recovered
  const grouped = runs && recovered && !input.going
  const records = missed
    .filter((occurrence) => !runs || occurrence !== due)
    .map((occurrence) => ({
      due: occurrence,
      state: "missed" as const,
      reason: grouped ? ("grouped" as const) : ("closed" as const),
    }))
  if (!runs) return { due, records }
  if (input.going) return { due, records: [...records, { due, state: "skipped", reason: "overlap" }] }
  return {
    due,
    records,
    run: { due, trigger: onTime ? "schedule" : "catch-up", ...(recovered ? { since: input.oldest } : {}) },
  }
}

/** When a scheduled, enabled routine runs next after `now`. */
export function next(definition: Definition, now: number) {
  const cron = cronOf(definition)
  return cron && Cron.next(cron, new Date(now)).getTime()
}

/** The occurrences after `after` and up to `until`, oldest first: at most the newest `LIMIT`. */
export function occurrences(definition: Definition, after: number, until: number) {
  const cron = cronOf(definition)
  if (!cron || until <= after) return []
  const found: number[] = []
  // `prev` is strict: a millisecond past `until` finds an occurrence right at it.
  const cursor = { at: until + 1 }
  while (found.length < LIMIT) {
    const previous = Cron.prev(cron, new Date(cursor.at)).getTime()
    if (previous <= after) break
    found.push(previous)
    cursor.at = previous
  }
  return found.reverse()
}

// The hours within which a missed run is recovered, or undefined when the routine does not recover them.
function recovery(definition: Definition) {
  if (definition.options.recover === "none") return undefined
  const hours = Number(definition.options.catchUp ?? HOURS)
  return Number.isFinite(hours) && hours > 0 ? hours : undefined
}

// Occurrences after this are the clock's to take: after the occurrence key, and after the routine last changed (a
// routine created, resumed or edited has missed nothing before that).
function floor(stored: SavedRoutine) {
  return Math.max(stored.due ?? 0, stored.updated)
}

// The first occurrence after the floor: since when a catch-up covers, even past the `LIMIT` recorded.
function oldest(stored: SavedRoutine) {
  const cron = cronOf(stored.definition)
  return cron ? Cron.next(cron, new Date(floor(stored))).getTime() : floor(stored)
}

// The routine's schedule read in its zone. Repeated local times run once, at the earlier one (DST ends); a time the
// clocks skip runs right after the jump (DST starts).
function cronOf(definition: Definition) {
  if (!definition.schedule || !definition.enabled) return undefined
  const zone = DateTime.zoneMakeNamed(definition.schedule.timezone)
  if (zone._tag === "None") return undefined
  const parsed = Cron.parse(definition.schedule.cron, zone.value)
  if (Result.isFailure(parsed)) return undefined
  return parsed.success
}
