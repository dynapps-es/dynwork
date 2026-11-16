export * as RoutinesBackend from "./backend"

import type { Capabilities, Change, Choice, Definition, Failure, Routine, Run, RunPage, Transcript } from "./contract"

/**
 * A place routines run: this computer, the Agent Farm, or a fake. It lives in the main process, where its credentials
 * never reach a window. Backends answer failures as data and never reject: the Ipc turns a rejection it did not expect
 * into a `failed` failure, which tells the user nothing useful.
 *
 * `routines/conformance.ts` (in `test/`) is the suite every backend passes before it is registered.
 */
// JESÚS: the Agent Farm's backend implements this interface in `routines/farm/`, over a farm HTTP client that lives in
// main (the farm token never reaches a window). Each method's farm endpoint is in the table of `docs/04-ui.md` §B.4,
// and `routines/farm/README.md` lists them again. It is done when `test/routines/conformance.ts` passes against it.
export interface Backend {
  /** Stable for the life of the backend; a routine's `ref.backend` is this. */
  readonly id: string
  /** Always answers, even signed out or offline: the status says why it cannot serve. */
  capabilities(): Promise<Capabilities>
  /** Choices for a `Field.lookup` or the shared selects (`agents`, `models`, `skills`). */
  options(lookup: string, query?: string): Promise<readonly Choice[] | Failure>
  /** Checks a definition against what the backend takes; `invalid` carries one message per field. */
  validate(definition: Definition): Promise<Failure | undefined>
  list(): Promise<readonly Routine[] | Failure>
  get(id: string): Promise<Routine | Failure>
  create(definition: Definition): Promise<Routine | Failure>
  /** May answer a routine with a new ref: where `edit` is `replace`, the new routine replaces the old one. */
  update(id: string, definition: Definition): Promise<Routine | Failure>
  remove(id: string): Promise<Failure | undefined>
  pause(id: string): Promise<Failure | undefined>
  resume(id: string): Promise<Failure | undefined>
  /** Starts a run now, whatever the schedule says. */
  start(id: string): Promise<Run | Failure>
  /** `conflict` for a run that already finished; `unsupported` where `actions.cancel` is false. */
  cancel(run: string): Promise<Failure | undefined>
  /** Newest first. Without `routine`: every run the backend knows ("Activity"). */
  runs(input: { routine?: string; cursor?: string }): Promise<RunPage | Failure>
  /** The read-only conversation of a run whose `conversation` is `transcript`; `unsupported` for any other. */
  transcript(run: string): Promise<Transcript | Failure>
  /** The user opened the run: it stops counting as unread. */
  viewed(run: string): Promise<void>
  /**
   * JESÚS: the farm has no push, so poll `GET /tasks?updated_since=<last cursor minus 30 s>` inside, only while this is
   * subscribed, and answer each task that changed as a `Change` with its `Run`.
   *
   * Pushes changes until the returned function is called. A backend without push polls inside, and only while watched
   * (the farm: `GET /tasks?updated_since`). Several subscriptions never happen at once: the Ipc shares one.
   */
  watch(changed: (change: Change) => void): () => void
}

export interface Registry {
  list(): readonly Backend[]
  get(id: string): Backend | undefined
  /**
   * Adds a backend. One with the same id replaces the earlier one, which is how a real backend takes the place of its
   * fake. The returned function removes it, unless it was replaced since.
   */
  register(backend: Backend): () => void
  /** Calls `listener` after every `register` and removal. Returns its own removal. */
  subscribe(listener: () => void): () => void
}

export function make(): Registry {
  const backends = new Map<string, Backend>()
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach((listener) => listener())
  return {
    list: () => [...backends.values()],
    get: (id) => backends.get(id),
    register: (backend) => {
      backends.set(backend.id, backend)
      notify()
      return () => {
        if (backends.get(backend.id) !== backend) return
        backends.delete(backend.id)
        notify()
      }
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
}

/** A failure. It is retryable only when `unreachable`, the one code that clears up by itself; build the rest by hand. */
export function fail(code: Failure["code"], message: string, fields?: Record<string, string>): Failure {
  return {
    code,
    message,
    retryable: code === "unreachable",
    ...(fields ? { fields } : {}),
  }
}
