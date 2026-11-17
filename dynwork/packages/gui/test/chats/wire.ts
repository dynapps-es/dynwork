import { Schema } from "effect"
import type { Caller } from "@opencode/plugin/gui"
import type { ChatsBackend } from "../../src/chats/backend"
import { Chats, Event, State } from "../../src/chats/contract"
import { ChatsIpc } from "../../src/chats/ipc"
import { ChatsSync } from "../../src/chats/sync"
import { instance, timers } from "./fixture"

// What the Ipc bridge does to a value on its way over: encode with the schema, structured-clone, decode.
function crossing<A>(schema: Schema.ConstraintCodec<A, unknown>, value: unknown): A {
  return Schema.decodeUnknownSync(schema)(structuredClone(Schema.encodeUnknownSync(schema)(value)))
}

/**
 * A fake instance, main's side of the chats over it, and a window's client of the `dynwork.chats` Ipc, with every value
 * crossing the way the bridge makes it cross. `crossed` holds, as JSON, everything that reached the window.
 */
export function connect() {
  const world = instance()
  const crossed: string[] = []
  const listeners = new Set<(event: Event) => void>()
  const sync = ChatsSync.make({
    client: world.client,
    account: () => world.active.current?.id,
    changed: () => {},
    focused: true,
    timers: timers(),
  })
  const impl = ChatsIpc.implementation(world.client, sync, {
    event: (event) => {
      const value = crossing(Event, event)
      crossed.push(JSON.stringify(value))
      listeners.forEach((listener) => listener(value))
    },
  })
  // SAFETY: `IpcImpl` types each method by its own input and output; the bridge calls them all alike, by name.
  const methods = impl as unknown as Record<string, (input: unknown, caller: Caller) => unknown>
  const never = new AbortController().signal
  const calls = Object.fromEntries(
    Object.entries(Chats.spec.methods).map(([name, method]) => [
      name,
      async (first?: unknown, second?: { signal?: AbortSignal }) => {
        const options = "input" in method ? second : (first as { signal?: AbortSignal } | undefined)
        const sent = "input" in method ? crossing<unknown>(method.input, first) : undefined
        const result = await methods[name]?.(sent, { window: 1, signal: options?.signal ?? never })
        if (!("output" in method)) return undefined
        const value = crossing<unknown>(method.output, result)
        crossed.push(JSON.stringify(value ?? null))
        return value
      },
    ]),
  )
  const client = {
    ...calls,
    state: () => {
      const value = crossing(State, impl.state(1))
      crossed.push(JSON.stringify(value))
      return value
    },
    on: (_: "event", listener: (event: Event) => void) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  } as unknown as ChatsBackend.Client
  return { ...world, sync, client, crossed }
}
