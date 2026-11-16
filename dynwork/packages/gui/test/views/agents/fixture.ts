import { createRoot } from "solid-js"
import { RoutinesBackend } from "../../../src/routines/backend"
import type { Ref, Routine } from "../../../src/routines/contract"
import { RoutinesDemo } from "../../../src/routines/demo"
import { createAgentsModel } from "../../../src/views/agents/model"
import type { Where } from "../../../src/views/agents/routine"
import en from "../../../src/views/en"
import { clock } from "../../routines/fixture"
import { connect } from "../../routines/wire"

/** The views' English table, as the plugin's `t` reads it: `{{name}}` placeholders, the key itself when missing. */
export function t(key: string, params?: Record<string, string | number>) {
  const table: Record<string, string> = en
  return (table[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(params?.[name] ?? ""))
}

/**
 * The Agents view's model over the two demo backends, through a window's client that crosses values as the Ipc bridge
 * does. The state has arrived when it returns.
 */
export async function setup(where?: Where) {
  const time = clock()
  const registry = RoutinesBackend.make()
  const local = RoutinesDemo.local(time.now)
  const farm = RoutinesDemo.remote(time.now)
  registry.register(local)
  registry.register(farm)
  const wire = connect(registry)
  await wire.client.refresh()
  const model = createRoot(() => createAgentsModel({ client: () => wire.client, where }))
  const find = (name: string) => {
    const routine = model.routines().find((candidate) => candidate.definition.name === name)
    if (!routine) throw new Error(`No routine ${name}`)
    return routine
  }
  return { time, registry, local, farm, wire, model, find }
}

export const names = (routines: readonly Routine[]) => routines.map((routine) => routine.definition.name)
export const ids = (items: readonly { ref: Ref }[]) => items.map((item) => item.ref.id)
