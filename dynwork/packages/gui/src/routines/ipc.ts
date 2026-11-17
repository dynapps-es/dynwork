export * as RoutinesIpc from "./ipc"

import type { IpcImpl } from "@opencode/plugin/gui/main"
import { fail, type Backend, type Registry } from "./backend"
import {
  isFailure,
  type Capabilities,
  type Change,
  type Failure,
  type Routine,
  type Routines,
  type Run,
} from "./contract"

/** How main tells windows what changed: a new `state`, or a run that moved. */
export interface Notify {
  /** The state changed: the provider's `changed()`. */
  changed(): void
  /** A run changed state: the provider's `emit("run", run)`. */
  run(run: Run): void
}

/**
 * The `dynwork.routines` Ipc over a registry of backends.
 * - `state` is a snapshot of every backend's capabilities and routines, read when the Ipc starts, when a backend
 *   registers or leaves, after each method that changes something and while a window watches. It is a snapshot because
 *   `IpcImpl.state` is synchronous and a backend's answer is not.
 * - A call to a backend that is not registered, or that rejects, answers a `Failure`: the Ipc would turn a rejection
 *   into plain text (`accounts/ipc.ts`).
 * - `watch` holds a window's call open. While at least one is open, each backend's own `watch` is subscribed once.
 */
export function implementation(
  registry: Registry,
  notify: Notify,
  /** How long to wait before reading again a backend that answered `unreachable`. */
  retry = 5_000,
): IpcImpl<(typeof Routines)["spec"]> {
  const snapshot = new Map<string, { capabilities: Capabilities; routines: readonly Routine[] }>()
  // The newest read each backend has begun, so that one that answers late does not replace a newer one.
  const reads = new Map<string, number>()
  // JESÚS: one `Backend.watch` subscription per backend, shared by every window, so the farm's poll runs once however
  // many windows watch.
  const live = new Map<string, { backend: Backend; stop: () => void }>()
  const windows = { watching: 0 }
  // A backend that was unreachable when read, such as the local service still starting, says nothing when it comes up:
  // it is read again until it answers something else.
  const retrying = new Map<string, ReturnType<typeof setTimeout>>()

  async function load(backend: Backend) {
    const read = (reads.get(backend.id) ?? 0) + 1
    reads.set(backend.id, read)
    const [capabilities, routines] = await Promise.all([
      guard(() => backend.capabilities()),
      guard(() => backend.list()),
    ])
    if (reads.get(backend.id) !== read || isFailure(capabilities)) return
    // A list that failed keeps the last one: a window does not blank because a token expired.
    const kept = snapshot.get(backend.id)?.routines ?? []
    snapshot.set(backend.id, { capabilities, routines: isFailure(routines) ? kept : routines })
    if (capabilities.status !== "unreachable" || retrying.has(backend.id)) return
    const timer = setTimeout(() => {
      retrying.delete(backend.id)
      if (registry.get(backend.id) === backend) void load(backend).then(notify.changed)
    }, retry)
    timer.unref?.()
    retrying.set(backend.id, timer)
  }

  async function loadAll() {
    snapshot.forEach((_, id) => {
      if (!registry.get(id)) snapshot.delete(id)
    })
    await Promise.all(registry.list().map(load))
  }

  // Keeps one subscription per registered backend, and drops those of backends that left or were replaced.
  function follow() {
    live.forEach((entry, id) => {
      if (registry.get(id) === entry.backend) return
      entry.stop()
      live.delete(id)
    })
    registry.list().forEach((backend) => {
      if (live.has(backend.id)) return
      live.set(backend.id, { backend, stop: backend.watch((change) => changed(backend, change)) })
    })
  }

  function changed(backend: Backend, change: Change) {
    if (change.run) notify.run(change.run)
    void load(backend).then(notify.changed)
  }

  // A backend, or the failure that says there is none; whatever it rejects with becomes a failure too.
  function on<A>(id: string, call: (backend: Backend) => Promise<A>): Promise<A | Failure> {
    const backend = registry.get(id)
    if (!backend) return Promise.resolve(fail("not-found", `Tasks cannot run on ${id}: it is not available.`))
    return guard(() => call(backend))
  }

  // `on`, then the state catches up with what the call changed.
  async function changing<A>(id: string, call: (backend: Backend) => Promise<A>) {
    const answer = await on(id, call)
    const backend = registry.get(id)
    if (!backend) return answer
    await load(backend)
    notify.changed()
    return answer
  }

  registry.subscribe(() => {
    if (windows.watching > 0) follow()
    void loadAll().then(notify.changed)
  })
  void loadAll().then(notify.changed)

  return {
    state: () => {
      const entries = registry.list().flatMap((backend) => snapshot.get(backend.id) ?? [])
      return {
        backends: entries.map((entry) => entry.capabilities),
        routines: entries.flatMap((entry) => entry.routines),
      }
    },
    refresh: async () => {
      await loadAll()
      notify.changed()
    },
    watch: (_, caller) =>
      new Promise<void>((resolve) => {
        if (caller.signal.aborted) return resolve()
        windows.watching++
        follow()
        caller.signal.addEventListener(
          "abort",
          () => {
            windows.watching--
            if (windows.watching === 0) {
              live.forEach((entry) => entry.stop())
              live.clear()
            }
            resolve()
          },
          { once: true },
        )
      }),
    list: (input) => on(input.backend, (backend) => backend.list()),
    get: (input) => on(input.backend, (backend) => backend.get(input.id)),
    create: (input) => changing(input.backend, (backend) => backend.create(input.definition)),
    update: (input) => changing(input.backend, (backend) => backend.update(input.id, input.definition)),
    remove: (input) => changing(input.backend, (backend) => backend.remove(input.id)),
    pause: (input) => changing(input.backend, (backend) => backend.pause(input.id)),
    resume: (input) => changing(input.backend, (backend) => backend.resume(input.id)),
    start: (input) => changing(input.backend, (backend) => backend.start(input.id)),
    move: (input) =>
      changing(input.backend, async (backend) =>
        backend.move ? backend.move(input.id) : fail("unsupported", "Tasks here run in one place."),
      ),
    cancel: (input) => changing(input.backend, (backend) => backend.cancel(input.run)),
    runs: (input) => on(input.backend, (backend) => backend.runs({ routine: input.routine, cursor: input.cursor })),
    transcript: (input) => on(input.backend, (backend) => backend.transcript(input.run)),
    viewed: async (input) => {
      await changing(input.backend, (backend) => backend.viewed(input.run))
    },
    options: (input) => on(input.backend, (backend) => backend.options(input.lookup, input.query)),
    validate: (input) => on(input.backend, (backend) => backend.validate(input.definition)),
    templates: (input) =>
      on(
        input.backend,
        async (backend) => backend.templates?.() ?? fail("unsupported", "There are no templates here."),
      ),
    activate: (input) =>
      changing(input.backend, async (backend) =>
        backend.activate
          ? backend.activate(input.template, input.personal)
          : fail("unsupported", "There are no templates here."),
      ),
    answer: (input) =>
      changing(input.backend, async (backend) =>
        backend.answer ? backend.answer(input.id, input.apply) : fail("unsupported", "There are no templates here."),
      ),
  }
}

// The one place a backend's rejection is caught: backends answer failures as data, so a rejection is a bug in one, and
// its message may carry what no window should see. It is not passed on.
function guard<A>(call: () => Promise<A>): Promise<A | Failure> {
  return Promise.resolve()
    .then(call)
    .catch(() => fail("failed", "Where the task runs did not answer."))
}
