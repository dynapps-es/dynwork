export * as RoutinesMain from "./main"

import type { MainContext } from "@opencode/plugin/gui/main"
import { RoutinesBackend } from "./backend"
import { Routines, type Run } from "./contract"
import { RoutinesDemo } from "./demo"
import { RoutinesIpc } from "./ipc"

// How often the demo backends finish the runs whose minute has passed.
const SETTLE = 5_000

// The routines' main side, set up by the `dynwork` built-in's main entry next to the accounts: the registry of backends
// and the `dynwork.routines` Ipc over it. Answers the registry, so that code that owns a backend can register it.
export function setup(ctx: MainContext) {
  const registry = RoutinesBackend.make()

  // Real backends register here, before the demos, so that a demo is added only where no real backend took its id.
  // PHASE 04: the local backend (plugin storage and DynWork's service) registers here under the id `local`.
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
