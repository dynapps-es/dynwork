export * as RoutinesMain from "./main"

import { homedir } from "node:os"
import path from "node:path"
import { OpenCode, type OpenCodeClient } from "@opencode/client/promise"
import type { MainContext } from "@opencode/plugin/gui/main"
import { RoutinesBackend } from "./backend"
import { Routines, type Definition, type Run } from "./contract"
import { RoutinesDemo } from "./demo"
import { RoutinesFarm } from "./farm/backend"
import { RoutinesIpc } from "./ipc"
import { RoutinesLocal } from "./local/backend"
import { RoutinesClock } from "./local/clock"

// How often the demo backends finish the runs whose minute has passed.
const SETTLE = 5_000
// DynWork's own service, as a window names it (`ServerRef.id`) and main reaches it (`ctx.serverEndpoints`).
const SERVER = "sidecar"

export interface Options {
  /** This device's name: the local routines' badge. */
  label: string
  /** A local run ended `failed`: main tells the user (an Electron notification, which needs no window). */
  failed?: (run: Run, routine: Definition) => void
  /** Registers the Agent Farm skeleton in place of the remote demo (`RoutinesFarm.enabled`). A development switch. */
  farm?: boolean
  /**
   * Whether a scheduled run may start as far as Governance goes: its provider is applied to the service, or there is
   * no account to wait for. A run started earlier fails with "No model is available". Absent: always.
   */
  ready?: () => boolean
}

// The routines' main side, set up by the `dynwork` built-in's main entry next to the accounts: the registry of backends
// and the `dynwork.routines` Ipc over it, and the clock of the local routines. Answers the registry, so that code that
// owns a backend can register it, and the clock's `check`, to call when `ready` may have changed and on wake.
export function setup(ctx: MainContext, options: Options) {
  const registry = RoutinesBackend.make()

  // Real backends register here, before the demos, so that a demo is added only where no real backend took its id.
  // The local backend: definitions in the plugin's storage, runs as sessions of DynWork's service.
  const store = ctx.storage.store("routines", { schema: RoutinesLocal.Saved, initial: RoutinesLocal.initial })
  const client = service(ctx)
  const local = RoutinesLocal.make({
    label: options.label,
    store,
    client,
    server: SERVER,
    home: path.join(homedir(), "Dynwork", "Routines"),
    now: Date.now,
    failed: options.failed,
  })
  ctx.onCleanup(local.dispose)
  registry.register(local)
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
  const demos = RoutinesDemo.register(registry, Date.now)
  const timer = setInterval(() => demos.forEach((demo) => demo.settle()), SETTLE)
  ctx.onCleanup(() => clearInterval(timer))

  const provider = { changed: () => {}, run: (_: Run) => {} }
  const ipc = ctx.provide(
    Routines,
    RoutinesIpc.implementation(registry, { changed: () => provider.changed(), run: (run) => provider.run(run) }),
  )
  provider.changed = () => ipc.changed()
  provider.run = (run) => ipc.emit("run", run)
  return { registry, check: () => void clock.check() }
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
