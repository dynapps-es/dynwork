import { Schema } from "effect"
import type { Caller, IpcClient } from "@opencode/plugin/gui"
import type { Registry } from "../../src/routines/backend"
import { Routines, Run, State } from "../../src/routines/contract"
import { RoutinesIpc } from "../../src/routines/ipc"

type Client = IpcClient<(typeof Routines)["spec"]>

// What the Ipc bridge does to a value on its way over: encode with the schema, structured-clone, decode.
export function crossing<A>(schema: Schema.ConstraintCodec<A, unknown>, value: unknown): A {
  return Schema.decodeUnknownSync(schema)(structuredClone(Schema.encodeUnknownSync(schema)(value)))
}

/**
 * A window's client for the routines Ipc over `registry`, with every input and output crossing the way the bridge makes
 * it cross. `pushes` counts the state pushes main made; `events` holds the `run` events the window received.
 */
export function connect(registry: Registry) {
  const pushes = { count: 0 }
  const events: Run[] = []
  const listeners = new Set<(run: Run) => void>()
  const impl = RoutinesIpc.implementation(registry, {
    changed: () => void pushes.count++,
    run: (run) => listeners.forEach((listener) => listener(crossing(Run, run))),
  })
  listeners.add((run) => events.push(run))

  const spec = Routines.spec
  // SAFETY: `IpcImpl` types each method by its own input and output; the bridge calls them all alike, by name.
  const methods = impl as unknown as Record<string, (input: unknown, caller: Caller) => unknown>
  const never = new AbortController().signal
  const calls = Object.fromEntries(
    Object.entries(spec.methods).map(([name, method]) => [
      name,
      async (first?: unknown, second?: { signal?: AbortSignal }) => {
        const input = "input" in method ? first : undefined
        const options = "input" in method ? second : (first as { signal?: AbortSignal } | undefined)
        const sent = "input" in method ? crossing<unknown>(method.input, input) : undefined
        const result = await methods[name]?.(sent, { window: 1, signal: options?.signal ?? never })
        return "output" in method ? crossing<unknown>(method.output, result) : undefined
      },
    ]),
  )
  const client = {
    ...calls,
    state: () => crossing(State, impl.state(1)),
    on: (name: string, listener: (run: Run) => void) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  } as unknown as Client
  return { client, impl, pushes, events }
}
