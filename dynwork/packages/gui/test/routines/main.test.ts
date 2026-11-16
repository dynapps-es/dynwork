import { afterEach, describe, expect, jest, setSystemTime, test } from "bun:test"
import type { Schema } from "effect"
import type { Caller } from "@opencode/plugin/gui"
import type { MainContext } from "@opencode/plugin/gui/main"
import { isFailure, Routines, type Run } from "../../src/routines/contract"
import { RoutinesFarm } from "../../src/routines/farm/backend"
import { RoutinesMain } from "../../src/routines/main"
import { MINUTE, storage } from "./fixture"

afterEach(() => {
  jest.useRealTimers()
  setSystemTime()
})

// The part of main's context the routines use: `provide` keeps the implementation and answers a provider that counts,
// `storage` keeps values as the plugin's storage does, and no service is running yet.
function stand(stored = new Map<string, unknown>(), options: Partial<RoutinesMain.Options> = {}) {
  const provided: { token?: unknown; impl?: Record<string, (input: unknown, caller: Caller) => unknown> } = {}
  const cleanups: Array<() => void> = []
  const pushed = { changed: 0, runs: [] as Run[] }
  const ctx = {
    provide: (token: unknown, impl: Record<string, (input: unknown, caller: Caller) => unknown>) => {
      provided.token = token
      provided.impl = impl
      return {
        changed: () => void pushed.changed++,
        emit: (_: string, run: Run) => void pushed.runs.push(run),
      }
    },
    onCleanup: (cleanup: () => void) => void cleanups.push(cleanup),
    storage: {
      store: (key: string, options: { schema: Schema.Codec<unknown, unknown>; initial: unknown }) => {
        if (!stored.has(key)) stored.set(key, storage(options.schema, options.initial))
        return stored.get(key)
      },
    },
    serverEndpoints: { get: () => undefined },
  }
  // SAFETY: the routines' setup reads only `provide`, `onCleanup`, `storage` and `serverEndpoints`, which the stand-in
  // provides.
  const registry = RoutinesMain.setup(ctx as unknown as MainContext, { label: "Test Mac", ...options })
  const caller: Caller = { window: 1, signal: new AbortController().signal }
  const call = (name: string, input?: unknown) => provided.impl?.[name]?.(input, caller)
  return { provided, cleanups, pushed, registry, call, stored }
}

describe("main", () => {
  test("provides the routines Ipc over the real local backend, with a demo only for the farm", async () => {
    const main = stand()
    expect(main.provided.token).toBe(Routines)
    expect(main.registry.list().map((backend) => backend.id)).toEqual(["local", "farm"])
    await main.call("refresh")
    const state = main.call("state", 1) as {
      backends: Array<{ backend: string; label: string; status: string }>
      routines: Array<{ ref: { backend: string } }>
    }
    expect(state.backends.find((backend) => backend.backend === "local")).toMatchObject({
      label: "Test Mac",
      status: "unreachable",
    })
    // The demo seeds only the farm: this computer's list starts empty.
    expect(state.routines.filter((routine) => routine.ref.backend === "local")).toHaveLength(0)
    expect(state.routines.filter((routine) => routine.ref.backend === "farm")).toHaveLength(4)
    expect(main.pushed.changed).toBeGreaterThan(0)
    main.cleanups.forEach((cleanup) => cleanup())
  })

  test("local routines are kept in the plugin's storage and are there at the next start", async () => {
    const first = stand()
    const created = (await first.call("create", {
      backend: "local",
      definition: {
        name: "Kept",
        instructions: { kind: "prompt", text: "Do it." },
        enabled: true,
        options: {},
      },
    })) as { ref: { id: string } }
    expect(isFailure(created)).toBe(false)
    first.cleanups.forEach((cleanup) => cleanup())

    const second = stand(first.stored)
    const list = await second.call("list", { backend: "local" })
    expect((list as Array<{ ref: { id: string } }>).map((routine) => routine.ref.id)).toEqual([created.ref.id])
    second.cleanups.forEach((cleanup) => cleanup())
  })

  test("the farm skeleton takes the demo's place only when the development switch is on, and says it is disabled", async () => {
    const off = stand()
    expect((await off.registry.get("farm")?.capabilities())?.status).toBe("ready")
    off.cleanups.forEach((cleanup) => cleanup())

    const on = stand(undefined, { farm: true })
    expect(on.registry.list().map((backend) => backend.id)).toEqual(["local", "farm"])
    await on.call("refresh")
    const state = on.call("state", 1) as {
      backends: Array<{ backend: string; status: string; detail?: string }>
      routines: Array<{ ref: { backend: string } }>
    }
    expect(state.backends.find((backend) => backend.backend === "farm")?.status).toBe("disabled")
    expect(state.routines.filter((routine) => routine.ref.backend === "farm")).toHaveLength(0)
    expect(RoutinesFarm.isNotImplemented(await on.call("list", { backend: "farm" }))).toBe(true)
    on.cleanups.forEach((cleanup) => cleanup())
  })

  test("a backend registered afterwards takes the demo's id, and the windows are told", async () => {
    const main = stand()
    await main.call("refresh")
    const before = main.pushed.changed
    const real = main.registry.get("farm")
    if (!real) throw new Error("the demo farm is missing")
    main.registry.register({
      ...real,
      capabilities: async () => ({ ...(await real.capabilities()), label: "Real farm" }),
    })
    await main.call("refresh")
    const state = main.call("state", 1) as { backends: Array<{ backend: string; label: string }> }
    expect(state.backends.find((backend) => backend.backend === "farm")?.label).toBe("Real farm")
    expect(main.pushed.changed).toBeGreaterThan(before)
    main.cleanups.forEach((cleanup) => cleanup())
  })

  test("the demo backends finish their runs by themselves, a minute after they start", async () => {
    jest.useFakeTimers()
    setSystemTime(new Date(Date.UTC(2026, 10, 16, 9, 0)))
    const main = stand()
    await main.call("refresh")
    const list = await main.call("list", { backend: "farm" })
    if (isFailure(list) || !Array.isArray(list)) throw new Error("no routines")
    const started = (await main.call("start", { backend: "farm", id: list[0].ref.id })) as Run
    expect(started.state).toBe("running")

    setSystemTime(new Date(Date.UTC(2026, 10, 16, 9, 0) + 2 * MINUTE))
    jest.advanceTimersByTime(5_000)
    const page = (await main.call("runs", { backend: "farm", routine: list[0].ref.id })) as { items: Run[] }
    expect(page.items[0]).toMatchObject({ ref: started.ref, state: "ok" })

    main.cleanups.forEach((cleanup) => cleanup())
    setSystemTime(new Date(Date.UTC(2026, 10, 16, 9, 0) + 4 * MINUTE))
    const second = (await main.call("start", { backend: "farm", id: list[0].ref.id })) as Run
    setSystemTime(new Date(Date.UTC(2026, 10, 16, 9, 0) + 10 * MINUTE))
    jest.advanceTimersByTime(60_000)
    const after = (await main.call("runs", { backend: "farm", routine: list[0].ref.id })) as { items: Run[] }
    // The cleanup stopped the timer: nothing settles the second run.
    expect(after.items[0]).toMatchObject({ ref: second.ref, state: "running" })
  })
})
