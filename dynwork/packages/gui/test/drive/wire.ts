import { Schema } from "effect"
import type { Caller, IpcClient } from "@opencode/plugin/gui"
import { Drive, State } from "../../src/drive/contract"
import type { DriveIpc } from "../../src/drive/ipc"

type Client = IpcClient<(typeof Drive)["spec"]>

// What the Ipc bridge does to a value on its way over: encode with the schema, structured-clone, decode.
export function crossing<A>(schema: Schema.ConstraintCodec<A, unknown>, value: unknown): A {
  return Schema.decodeUnknownSync(schema)(structuredClone(Schema.encodeUnknownSync(schema)(value)))
}

/**
 * A window's client for the Drive Ipc over `service`, with every input and output crossing the way the bridge makes
 * it cross. `call` answers the method with a signal the test can abort (for `watch`).
 */
export function connect(service: DriveIpc.Service) {
  // SAFETY: `IpcImpl` types each method by its own input and output; the bridge calls them all alike, by name.
  const methods = service.ipc as unknown as Record<string, (input: unknown, caller: Caller) => unknown>
  const never = new AbortController().signal
  const calls = Object.fromEntries(
    Object.entries(Drive.spec.methods).map(([name, method]) => [
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
  return { ...calls, state: () => crossing(State, service.ipc.state(1)) } as unknown as Client
}

// Lets the promise chains of in-memory backends run to their end.
export const flush = async () => {
  for (const _ of Array.from({ length: 5 })) await new Promise<void>((resolve) => setImmediate(resolve))
}

/** Timers the test fires by hand: each armed one is kept with its delay until fired or cancelled. */
export function manualTimers() {
  const armed: Array<{ fire: () => unknown; ms: number; cancelled: boolean }> = []
  return {
    armed,
    /** The delay of the one timer still armed. */
    pending: () => armed.filter((timer) => !timer.cancelled).map((timer) => timer.ms),
    /** Fires every armed timer once. */
    fire: () =>
      armed
        .filter((timer) => !timer.cancelled)
        .forEach((timer) => {
          timer.cancelled = true
          timer.fire()
        }),
    set: (fire: () => unknown, ms: number) => {
      const timer = { fire, ms, cancelled: false }
      armed.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
  }
}
