import { Schema } from "effect"
import type { Persisted } from "@opencode/plugin/gui/main"

// A clock the test moves, for the fakes: nothing in the routines waits on real time.
export function clock(start = Date.UTC(2026, 10, 16, 9, 0)) {
  const time = { value: start }
  return {
    now: () => time.value,
    advance: (ms: number) => {
      time.value += ms
    },
  }
}

export const MINUTE = 60_000

// Lets the promise chains of in-memory backends run to their end.
export const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

/** The plugin's storage in main, as a backend sees it: the value is kept as the schema's JSON and read back decoded. */
export function storage<S extends Schema.Codec<unknown, unknown>>(
  schema: S,
  initial: S["Type"],
): Persisted<S["Type"], S["Type"]> {
  const codec = Schema.toCodecJson(schema)
  const encode = (value: S["Type"]) => JSON.stringify(Schema.encodeSync(codec)(value))
  const decode = (json: string): S["Type"] => Schema.decodeSync(codec)(JSON.parse(json))
  const saved = { json: encode(initial) }
  return {
    get value() {
      return decode(saved.json)
    },
    ready: () => true,
    set: (next) => {
      saved.json = encode(next)
    },
    update: (mutate) => {
      const draft = decode(saved.json)
      mutate(draft as never)
      saved.json = encode(draft)
    },
  }
}
