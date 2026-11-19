export * as RoutinesFake from "./fake"

import { fail, type Backend } from "./backend"
import { isFailure } from "./contract"
import type {
  Capabilities,
  Change,
  Choice,
  Conversation,
  Definition,
  Failure,
  Owner,
  Question,
  Routine,
  Run,
  Transcript,
} from "./contract"
import { RoutinesValidate } from "./validate"

const DAY = 24 * 60 * 60 * 1000

export interface Options {
  /** The backend's id. */
  id: string
  capabilities: Omit<Capabilities, "backend" | "quota">
  /** Where the quota's `used` starts counting: `others` is what other people of a shared quota already hold. */
  quota?: { max: number; others: number; shared: boolean }
  routines?: readonly Routine[]
  /** Newest first. */
  runs?: readonly Run[]
  /** Read-only conversations by run id, for runs whose conversation is `transcript`. */
  transcripts?: Readonly<Record<string, Transcript>>
  /** The answers of `options(lookup)`. */
  choices?: Readonly<Record<string, readonly Choice[]>>
  /** The owner a new routine gets. */
  owner?: Owner
  /**
   * What a run started here reads from: a `session` (as the local backend will) or a `transcript` (as the farm's).
   * A `session` backend also removes a routine's runs with it, as removing the anchor session does.
   */
  conversation: "session" | "transcript"
  /** The clock. A run started at `t` finishes at `t + duration`, the next time `settle` runs. */
  now: () => number
  /** How long a run takes, in milliseconds. Default one minute. */
  duration?: number
  /** Runs per page. Default 20. */
  pageSize?: number
}

export interface Fake extends Backend {
  /** Finishes every run whose time has come by the fake's clock, and pushes what changed. */
  settle(): void
  /** Makes a running run wait on a question, as a farm task does when its agent asks the user, and pushes it. */
  ask(run: string, question: Question): void
  /** Makes the backend answer as if signed out or offline, or ready again. */
  setStatus(status: Capabilities["status"], detail?: string): void
}

/**
 * An in-memory backend with an injectable clock: for the conformance suite, for development while a real backend is
 * missing, and for the views' tests. It reads no cron: a scheduled, enabled routine's next run is a day after the last
 * change, and nothing runs by itself except through `start`.
 */
export function make(options: Options): Fake {
  const duration = options.duration ?? 60_000
  const pageSize = options.pageSize ?? 20
  const status = { value: options.capabilities.status, detail: options.capabilities.detail }
  const counter = { value: 0 }
  // `last` and `unread` of a stored routine are stale: `view` reads them off the runs.
  const routines = new Map<string, Routine>((options.routines ?? []).map((routine) => [routine.ref.id, routine]))
  const runs = [...(options.runs ?? [])]
  const watchers = new Set<(change: Change) => void>()
  const emit = (change: Change) => [...watchers].forEach((watcher) => watcher(change))
  const nextId = (prefix: string) => `${prefix}-${++counter.value}`

  const capabilities = async (): Promise<Capabilities> => ({
    ...options.capabilities,
    backend: options.id,
    status: status.value,
    detail: status.detail,
    quota: options.quota && {
      max: options.quota.max,
      used: options.quota.others + [...routines.values()].filter((stored) => stored.definition.schedule).length,
      shared: options.quota.shared,
    },
  })

  const view = (routine: Routine): Routine => {
    const own = runs.filter((run) => run.routine?.id === routine.ref.id)
    return { ...routine, last: own[0], unread: own.filter((run) => run.unread).length }
  }

  // A gate every call but `capabilities` goes through: a backend that cannot serve says why.
  const unavailable = (): Failure | undefined => {
    if (status.value === "ready") return undefined
    if (status.value === "signed-out") return fail("signed-out", status.detail ?? "Sign in to use this backend.")
    if (status.value === "unreachable") return fail("unreachable", status.detail ?? "It cannot be reached right now.")
    return fail("unsupported", status.detail ?? "This backend is switched off.")
  }

  const missing = (what: string, id: string) => fail("not-found", `No ${what} ${id}.`)

  const schedule = (definition: Definition) =>
    definition.schedule && definition.enabled ? options.now() + DAY : undefined

  const build = (ref: Routine["ref"], definition: Definition, conversation: Conversation): Routine => ({
    ref,
    definition,
    state: definition.enabled ? "active" : "paused",
    next: schedule(definition),
    unread: 0,
    owner: options.owner,
    conversation,
    updated: options.now(),
  })

  const findRoutine = (id: string) => unavailable() ?? routines.get(id) ?? missing("routine", id)
  const findRun = (id: string) => unavailable() ?? runs.find((run) => run.ref.id === id) ?? missing("run", id)

  const anchor = (id: string): Conversation =>
    options.conversation === "session"
      ? { kind: "session", server: "fake", session: `ses-${id}`, anchor: `ses-${id}` }
      : { kind: "none" }

  const patchRun = (run: Run, patch: Partial<Run>) => {
    const next = { ...run, ...patch }
    runs[runs.indexOf(run)] = next
    return next
  }

  const backend: Fake = {
    id: options.id,
    capabilities,
    ask: (id, question) => {
      const run = runs.find((candidate) => candidate.ref.id === id)
      if (!run || run.state !== "running") throw new Error(`No running run ${id} to ask on.`)
      emit({ routine: run.routine, run: patchRun(run, { question, reason: "question", unread: true }) })
    },
    setStatus: (value, detail) => {
      status.value = value
      status.detail = detail
    },
    options: async (lookup, query) => {
      const blocked = unavailable()
      if (blocked) return blocked
      const choices = options.choices?.[lookup]
      if (!choices) return missing("lookup", lookup)
      const needle = query?.trim().toLowerCase() ?? ""
      return choices.filter((choice) => `${choice.value} ${choice.label}`.toLowerCase().includes(needle))
    },
    validate: async (definition) => unavailable() ?? RoutinesValidate.check(await capabilities(), definition),
    list: async () => unavailable() ?? [...routines.values()].map(view),
    get: async (id) => {
      const routine = findRoutine(id)
      return isFailure(routine) ? routine : view(routine)
    },
    create: async (definition) => {
      const blocked = unavailable() ?? RoutinesValidate.check(await capabilities(), definition)
      if (blocked) return blocked
      const quota = (await capabilities()).quota
      if (definition.schedule && quota && quota.used >= quota.max)
        return fail("quota", `All ${quota.max} schedules are taken.`)
      const id = nextId("routine")
      const created = build({ backend: options.id, id }, definition, anchor(id))
      routines.set(id, created)
      emit({ routine: created.ref })
      return view(created)
    },
    update: async (id, definition) => {
      const previous = findRoutine(id)
      if (isFailure(previous)) return previous
      const invalid = RoutinesValidate.check(await capabilities(), definition)
      if (invalid) return invalid
      // `replace` makes a new routine and removes the old: the new ref is the answer, and the old history stays behind.
      // JESÚS: the farm's `update` does the same: `POST /schedules` with the new definition, then `DELETE` the old one, and
      // answers the new ref. Keep the chain of ids (old to new) in DynWork's own table so the history can be joined.
      const replaces = options.capabilities.actions.edit === "replace"
      const ref = replaces ? { backend: options.id, id: nextId("routine") } : previous.ref
      const updated = build(ref, definition, replaces ? anchor(ref.id) : previous.conversation)
      if (replaces) routines.delete(id)
      routines.set(ref.id, updated)
      emit({ routine: ref })
      return view(updated)
    },
    remove: async (id) => {
      const routine = findRoutine(id)
      if (isFailure(routine)) return routine
      routines.delete(id)
      if (options.conversation === "session")
        runs.splice(0, runs.length, ...runs.filter((run) => run.routine?.id !== id))
      emit({ routine: { backend: options.id, id } })
      return undefined
    },
    pause: async (id) => switchTo(id, false),
    resume: async (id) => switchTo(id, true),
    start: async (id) => {
      const routine = findRoutine(id)
      if (isFailure(routine)) return routine
      const ref = { backend: options.id, id: nextId("run") }
      const run: Run = {
        ref,
        routine: routine.ref,
        state: "running",
        trigger: "manual",
        started: options.now(),
        title: `Run of ${routine.definition.name}`,
        unread: false,
        conversation:
          options.conversation === "session"
            ? { kind: "session", server: "fake", session: `ses-${ref.id}`, anchor: `ses-${routine.ref.id}` }
            : { kind: "transcript" },
      }
      runs.unshift(run)
      emit({ routine: routine.ref, run })
      return run
    },
    cancel: async (id) => {
      const run = findRun(id)
      if (isFailure(run)) return run
      if (!options.capabilities.actions.cancel) return fail("unsupported", "This backend cannot cancel a run.")
      if (run.state !== "running" && run.state !== "queued") return fail("conflict", "The run has already finished.")
      const cancelled = patchRun(run, { state: "cancelled", reason: "user", finished: options.now() })
      emit({ routine: run.routine, run: cancelled })
      return undefined
    },
    reply: async (input) => {
      const previous = findRun(input.run)
      if (isFailure(previous)) return previous
      if (options.capabilities.actions.reply !== "resume")
        return fail("unsupported", "This backend continues a run in its own conversation.")
      if (!input.text.trim()) return fail("invalid", "Write what to ask next.", { text: "Write what to ask next." })
      if (previous.state === "running" || previous.state === "queued")
        return fail("conflict", previous.question ? "The run is waiting for your answer." : "The run is still going.")
      const ref = { backend: options.id, id: nextId("run") }
      const run: Run = {
        ref,
        routine: previous.routine,
        state: "running",
        trigger: "manual",
        started: options.now(),
        title: `Continuation of ${previous.title}`,
        unread: false,
        conversation:
          previous.conversation.kind === "session"
            ? { ...previous.conversation, session: `ses-${ref.id}` }
            : { kind: "transcript" },
      }
      runs.unshift(run)
      emit({ routine: run.routine, run })
      return run
    },
    answerQuestion: async (input) => {
      const run = findRun(input.run)
      if (isFailure(run)) return run
      const question = run.question
      if (!question || question.id !== input.question)
        return fail("conflict", "The run is not waiting for that question.")
      if (question.expires !== undefined && question.expires <= options.now())
        return fail("conflict", "The question expired.")
      if (!question.choices.includes(input.choice))
        return fail("invalid", "That is not one of the choices.", { choice: "Pick one of the choices." })
      const { question: _asked, reason: _why, ...answered } = run
      const next: Run = { ...answered, unread: false }
      runs[runs.indexOf(run)] = next
      emit({ routine: run.routine, run: next })
      return undefined
    },
    runs: async (input) => {
      const blocked = unavailable()
      if (blocked) return blocked
      const own = input.routine ? runs.filter((run) => run.routine?.id === input.routine) : runs
      if (input.routine && own.length === 0 && !routines.has(input.routine)) return missing("routine", input.routine)
      const start = input.cursor === undefined ? 0 : Number(input.cursor)
      if (!Number.isInteger(start) || start < 0) return fail("invalid", "That cursor is not one of this backend's.")
      const end = start + pageSize
      return { items: own.slice(start, end), next: end < own.length ? String(end) : undefined }
    },
    transcript: async (id) => {
      const run = findRun(id)
      if (isFailure(run)) return run
      if (run.conversation.kind !== "transcript") return fail("unsupported", "This run is read in its session.")
      return options.transcripts?.[id] ?? written(run)
    },
    viewed: async (id) => {
      const run = runs.find((candidate) => candidate.ref.id === id)
      if (!run?.unread) return
      emit({ routine: run.routine, run: patchRun(run, { unread: false }) })
    },
    watch: (changed) => {
      watchers.add(changed)
      return () => void watchers.delete(changed)
    },
    settle: () => {
      // A run that waits on a question does not go on by itself.
      const due = runs.filter(
        (run) => run.state === "running" && !run.question && (run.started ?? 0) + duration <= options.now(),
      )
      due.forEach((run) => {
        const finished = patchRun(run, {
          state: "ok",
          finished: (run.started ?? 0) + duration,
          summary: "Completed.",
          unread: true,
        })
        emit({ routine: run.routine, run: finished })
      })
    },
  }

  async function switchTo(id: string, enabled: boolean) {
    const routine = findRoutine(id)
    if (isFailure(routine)) return routine
    const definition = { ...routine.definition, enabled }
    routines.set(id, {
      ...routine,
      definition,
      state: enabled ? "active" : "paused",
      next: schedule(definition),
      updated: options.now(),
    })
    emit({ routine: routine.ref })
    return undefined
  }

  return backend
}

// What a run's result reads like when the seed did not write one.
function written(run: Run): Transcript {
  if (run.state === "running" || run.state === "queued") return { log: "Started." }
  return {
    result: run.summary ?? "Done.",
    log: "Started.\nFinished.",
    usage: { duration: (run.finished ?? 0) - (run.started ?? 0) },
  }
}
