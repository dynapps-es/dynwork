export * as RoutinesMain from "./main"

import { homedir } from "node:os"
import path from "node:path"
import { OpenCode, type OpenCodeClient } from "@opencode/client/promise"
import type { MainContext } from "@opencode/plugin/gui/main"
import { RoutinesBackend } from "./backend"
import { Routines, type Definition, type Run } from "./contract"
import { RoutinesDemo } from "./demo"
import { RoutinesIpc } from "./ipc"
import { RoutinesLocal } from "./local/backend"

// How often the demo backends finish the runs whose minute has passed.
const SETTLE = 5_000
// DynWork's own service, as a window names it (`ServerRef.id`) and main reaches it (`ctx.serverEndpoints`).
const SERVER = "sidecar"

export interface Options {
  /** This device's name: the local routines' badge. */
  label: string
  /** A local run ended `failed`: main tells the user (an Electron notification, which needs no window). */
  failed?: (run: Run, routine: Definition) => void
}

// The routines' main side, set up by the `dynwork` built-in's main entry next to the accounts: the registry of backends
// and the `dynwork.routines` Ipc over it. Answers the registry, so that code that owns a backend can register it.
export function setup(ctx: MainContext, options: Options) {
  const registry = RoutinesBackend.make()

  // Real backends register here, before the demos, so that a demo is added only where no real backend took its id.
  // The local backend: definitions in the plugin's storage, runs as sessions of DynWork's service.
  const local = RoutinesLocal.make({
    label: options.label,
    store: ctx.storage.store("routines", { schema: RoutinesLocal.Saved, initial: RoutinesLocal.initial }),
    client: service(ctx),
    server: SERVER,
    home: path.join(homedir(), "Dynwork", "Routines"),
    now: Date.now,
    failed: options.failed,
  })
  ctx.onCleanup(local.dispose)
  registry.register(local)
  // JESÚS: the Agent Farm backend registers here under the id `farm`, as `registry.register(FarmBackend.make(...))`, once
  // its credential is in `safeStorage` and `routines/farm/` exists. It must pass `test/routines/conformance.ts`; the
  // Ipc, the registry and the views need nothing else. Registering later (after the user signs in) replaces the demo.
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
  return registry
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
