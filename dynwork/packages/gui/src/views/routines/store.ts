import { onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { demoRoutines } from "./demo"
import { draftSchedule, nextRunText, type Draft, type Schedule } from "./schedule"

export type RunState = "running" | "succeeded" | "failed" | "missed"

export interface Run {
  readonly id: string
  readonly state: RunState
  readonly when: string
  readonly note: string
}

export interface Routine {
  readonly id: string
  readonly name: string
  readonly prompt: string
  /** The skill the routine runs; without one it runs the prompt. */
  readonly skill?: string
  /** The project folder; empty for none. */
  readonly folder: string
  readonly agent: string
  readonly model: string
  readonly schedule: Schedule
  /** The label of the next run, such as "Tomorrow 08:45". */
  readonly next: string
  readonly enabled: boolean
  /** Newest first. */
  readonly history: readonly Run[]
}

/** The one line a list row shows under a routine's name: its skill, or the start of its prompt. */
export function summary(routine: Pick<Routine, "skill" | "prompt">) {
  return routine.skill ? `Skill ${routine.skill}` : `Prompt: ${routine.prompt}`
}

export function isRunning(routine: Pick<Routine, "history">) {
  return routine.history[0]?.state === "running"
}

/** The state of a routine's latest run, which is its last result; none before its first run. */
export function lastState(routine: Pick<Routine, "history">) {
  return routine.history[0]?.state
}

/** The routine the detail pane shows: the one picked, or on a wide window the first, so the pane is never empty. */
export function pickSelected(picked: string | undefined, ids: readonly string[], wide: boolean) {
  if (picked && ids.includes(picked)) return picked
  return wide ? ids[0] : undefined
}

/**
 * The routines the view lists, in memory and seeded from the demo data. Call it inside a component or root: its Run
 * now timers are cleared when the owner is disposed.
 *
 * @param options.runMs - How long a Run now stays running before it is done.
 * @param options.now - The clock, for the time of runs and the next run of a new routine.
 */
export function createRoutines(options: { runMs?: number; now?: () => Date } = {}) {
  const runMs = options.runMs ?? 3000
  const now = options.now ?? (() => new Date())
  const [state, setState] = createStore({ routines: [...demoRoutines] })
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let runs = 0
  let added = 0

  onCleanup(() => timers.forEach(clearTimeout))

  const update = (id: string, change: (routine: Routine) => Routine) =>
    setState("routines", (list) => list.map((routine) => (routine.id === id ? change(routine) : routine)))
  const clock = () => now().toTimeString().slice(0, 5)

  return {
    list: () => state.routines,
    enabledCount: () => state.routines.filter((routine) => routine.enabled).length,

    /** Pauses an enabled routine and resumes a paused one, with its next run counted from now. */
    toggle: (id: string) =>
      update(id, (routine) =>
        routine.enabled
          ? { ...routine, enabled: false, next: "Off" }
          : { ...routine, enabled: true, next: nextRunText(routine.schedule, now()) },
      ),

    /** Starts a run now: it shows as running, and is done after `runMs`. A routine already running is left alone. */
    run(id: string) {
      const routine = state.routines.find((item) => item.id === id)
      if (!routine || isRunning(routine)) return
      const run = { id: `${id}-run-${++runs}`, state: "running" as const, when: `Today ${clock()}`, note: "Running" }
      update(id, (item) => ({ ...item, history: [run, ...item.history] }))
      const timer = setTimeout(() => {
        timers.delete(timer)
        const done = { ...run, state: "succeeded" as const, note: `${Math.max(1, Math.round(runMs / 1000))} s` }
        update(id, (item) => ({
          ...item,
          history: item.history.map((entry) => (entry.id === run.id ? done : entry)),
        }))
      }, runMs)
      timers.add(timer)
    },

    /** Adds a routine from a valid draft, as the first in the list, and returns its id. */
    add(draft: Draft) {
      const schedule = draftSchedule(draft)
      const routine: Routine = {
        id: `new-${++added}`,
        name: draft.name.trim(),
        prompt: draft.prompt.trim(),
        folder: draft.folder.trim(),
        agent: "build",
        model: "Claude Sonnet",
        schedule,
        next: nextRunText(schedule, now()),
        enabled: true,
        history: [],
      }
      setState("routines", (list) => [routine, ...list])
      return routine.id
    },

    remove: (id: string) => setState("routines", (list) => list.filter((routine) => routine.id !== id)),
  }
}
