export * as RoutinesMain from "./main"

import { homedir } from "node:os"
import path from "node:path"
import { OpenCode, type OpenCodeClient } from "@opencode/client/promise"
import type { MainContext } from "@opencode/plugin/gui/main"
import { RoutinesBackend } from "./backend"
import { Routines, type Definition, type Ref, type Run } from "./contract"
import { RoutinesDemo } from "./demo"
import { RoutinesFarm } from "./farm/backend"
import { RoutinesIpc } from "./ipc"
import { RoutinesLocal } from "./local/backend"
import { RoutinesClock } from "./local/clock"
import { RoutinesSync } from "./local/sync"
import { RoutinesTemplatesReader } from "./local/templates"

// Main itself, as the caller of an Ipc method it runs on its own (a chat card's Schedule).
const main = { window: 0, signal: new AbortController().signal }
// How often the demo backends finish the runs whose minute has passed.
const SETTLE = 5_000
// DynWork's own service, as a window names it (`ServerRef.id`) and main reaches it (`ctx.serverEndpoints`).
export const SERVER = "sidecar"

export interface Options {
  /** This device's name: the local routines' badge. */
  label: string
  /**
   * Main tells the user about a local run that finished, failed or waits for a permission, as its routine's "Notify
   * me" says (an Electron notification, which needs no window). `open` is for the notification's click: it focuses a
   * window and has it show the run in place.
   */
  notify?: (notice: RoutinesLocal.Notice & { open: () => void }) => void
  /** A local run is going, or none is any longer: the app keeps the computer awake meanwhile. */
  busy?: (going: boolean) => void
  /** Registers the Agent Farm skeleton in place of the remote demo (`RoutinesFarm.enabled`). A development switch. */
  farm?: boolean
  /**
   * Seeds the remote demo (`demo.ts`, the farm's target behavior) while no farm is registered. Development builds only:
   * released builds would show its made-up Cloud tasks as real ones.
   */
  demo?: boolean
  /**
   * Whether a scheduled run may start as far as Governance goes: its provider is applied to the service, or there is
   * no account to wait for. A run started earlier fails with "No model is available". Absent: always.
   */
  ready?: () => boolean
  /**
   * What the local routines sync with: the Governance account (the active, signed-in one) and this computer (its
   * relay peer id and its name). Absent: they stay on this computer.
   */
  sync?: { account: () => RoutinesSync.Account | undefined; device: () => RoutinesLocal.Device | undefined }
}

// The routines' main side, set up by the `dynwork` built-in's main entry next to the accounts: the registry of backends
// and the `dynwork.routines` Ipc over it, and the clock of the local routines. Answers the registry, so that code that
// owns a backend can register it, the clock's `check`, to call when `ready` may have changed and on wake, `pull`,
// which syncs with Governance now: on the relay's `routines.changed` hint, a change of account and a wake, and
// `templates`, which reads Governance's templates now: on the relay's `templates.changed` hint.
export function setup(ctx: MainContext, options: Options) {
  const registry = RoutinesBackend.make()
  const provider = { changed: () => {}, run: (_: Run) => {}, open: (_: Run) => {} }

  // Real backends register here, before the demos, so that a demo is added only where no real backend took its id.
  // The local backend: definitions in the plugin's storage, runs as sessions of DynWork's service.
  const store = ctx.storage.store("routines", { schema: RoutinesLocal.Saved, initial: RoutinesLocal.initial })
  const client = service(ctx)
  const shared: { sync?: RoutinesSync.Sync } = {}
  // The templates Governance offers, read with the sync's account; a new answer is a change of the local backend.
  const templates =
    options.sync &&
    RoutinesTemplatesReader.make({
      account: options.sync.account,
      device: options.sync.device,
      changed: () => local.touched(),
    })
  const local = RoutinesLocal.make({
    label: options.label,
    store,
    client,
    server: SERVER,
    home: path.join(homedir(), "Dynwork", "Routines"),
    now: Date.now,
    busy: options.busy,
    device: options.sync?.device,
    account: options.sync ? () => options.sync?.account()?.id : undefined,
    synced: () => shared.sync?.synced(),
    queued: () => void shared.sync?.sync(),
    templates: templates && templates.current,
    notify: (notice) =>
      options.notify?.({
        ...notice,
        open: () => {
          const window = ctx.windows.focused() ?? ctx.windows.list()[0]
          if (!window) return
          if (window.isMinimized()) window.restore()
          window.show()
          window.focus()
          provider.open(notice.run)
        },
      }),
  })
  ctx.onCleanup(local.dispose)
  registry.register(local)
  if (options.sync) {
    const sync = RoutinesSync.make({
      store,
      local,
      account: options.sync.account,
      device: options.sync.device,
      now: Date.now,
      templates,
    })
    shared.sync = sync
    ctx.onCleanup(sync.dispose)
  }
  // Fires the local schedules once the service answers and the Governance provider is applied.
  const clock = RoutinesClock.make({
    local,
    store,
    now: Date.now,
    ready: () => (options.ready?.() ?? true) && client() !== undefined,
  })
  ctx.onCleanup(clock.dispose)
  // JESÚS: the real Agent Farm `Backend` registers here under the id `farm`, as
  // `registry.register(RoutinesFarm.make(...))`, with the farm's URL and a function that reads its token from
  // `safeStorage` in main. It must pass `test/routines/conformance.ts`; the `Routines` Ipc, the registry and the views
  // need nothing else. Registering it after the user signs in replaces whatever holds the id `farm`: the demo, or this
  // skeleton.
  if (options.farm) registry.register(RoutinesFarm.make())
  const demos = options.demo ? RoutinesDemo.register(registry, Date.now) : []
  const timer = setInterval(() => demos.forEach((demo) => demo.settle()), SETTLE)
  ctx.onCleanup(() => clearInterval(timer))

  const routines = RoutinesIpc.implementation(registry, {
    changed: () => provider.changed(),
    run: (run) => provider.run(run),
  })
  const ipc = ctx.provide(Routines, routines)
  provider.changed = () => ipc.changed()
  provider.run = (run) => ipc.emit("run", run)
  provider.open = (run) => ipc.emit("open", run)
  return {
    registry,
    check: () => void clock.check(),
    pull: () => void shared.sync?.sync(),
    templates: () => void templates?.read(),
    /** DynWork's service, while it runs. */
    client,
    /** Changes through the Ipc's own methods, so every window reads the change (the chat's cards, `RoutinesChat`). */
    act: {
      create: (backend: string, definition: Definition) =>
        Promise.resolve(routines.create({ backend, definition }, main)),
      update: (ref: Ref, definition: Definition) => Promise.resolve(routines.update({ ...ref, definition }, main)),
      remove: (ref: Ref) => Promise.resolve(routines.remove(ref, main)),
      pause: (ref: Ref) => Promise.resolve(routines.pause(ref, main)),
      resume: (ref: Ref) => Promise.resolve(routines.resume(ref, main)),
      start: (ref: Ref) => Promise.resolve(routines.start(ref, main)),
    },
  }
}

/** What a notification says, in the app's language (main's `t`): the routine's name and what happened to its run. */
export function words(notice: RoutinesLocal.Notice, t: MainContext["t"]) {
  return { title: t(`agents.notify.${notice.kind}`, { name: notice.routine.name }), body: notice.run.title }
}

// The service's client while it runs. The endpoint's credential changes when the service restarts: a new client then.
function service(ctx: MainContext) {
  const cached: { key?: string; client?: OpenCodeClient } = {}
  return () => {
    const endpoint = ctx.serverEndpoints.get(SERVER)
    if (!endpoint) return undefined
    const key = `${endpoint.url}\n${JSON.stringify(endpoint.headers)}`
    if (cached.key !== key || !cached.client) {
      cached.key = key
      cached.client = OpenCode.make({ baseUrl: endpoint.url, headers: endpoint.headers })
    }
    return cached.client
  }
}
