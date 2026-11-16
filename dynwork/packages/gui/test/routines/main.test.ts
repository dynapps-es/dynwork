import { afterEach, describe, expect, jest, setSystemTime, test } from "bun:test"
import type { Caller } from "@opencode/plugin/gui"
import type { MainContext } from "@opencode/plugin/gui/main"
import { isFailure, Routines, type Run } from "../../src/routines/contract"
import { RoutinesMain } from "../../src/routines/main"
import { MINUTE } from "./fixture"

afterEach(() => {
  jest.useRealTimers()
  setSystemTime()
})

// The part of main's context the routines use: `provide` keeps the implementation and answers a provider that counts.
function stand() {
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
  }
  // SAFETY: the routines' setup reads only `provide` and `onCleanup`, which the stand-in provides.
  const registry = RoutinesMain.setup(ctx as unknown as MainContext)
  const caller: Caller = { window: 1, signal: new AbortController().signal }
  const call = (name: string, input?: unknown) => provided.impl?.[name]?.(input, caller)
  return { provided, cleanups, pushed, registry, call }
}

describe("main", () => {
  test("provides the routines Ipc over the registry, with a demo backend for each id nothing else took", async () => {
    const main = stand()
    expect(main.provided.token).toBe(Routines)
    expect(main.registry.list().map((backend) => backend.id)).toEqual(["local", "farm"])
    await main.call("refresh")
    const state = main.call("state", 1) as { backends: unknown[]; routines: unknown[] }
    expect(state.backends).toHaveLength(2)
    expect(state.routines).toHaveLength(8)
    expect(main.pushed.changed).toBeGreaterThan(0)
    main.cleanups.forEach((cleanup) => cleanup())
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
    const list = await main.call("list", { backend: "local" })
    if (isFailure(list) || !Array.isArray(list)) throw new Error("no routines")
    const started = (await main.call("start", { backend: "local", id: list[0].ref.id })) as Run
    expect(started.state).toBe("running")

    setSystemTime(new Date(Date.UTC(2026, 10, 16, 9, 0) + 2 * MINUTE))
    jest.advanceTimersByTime(5_000)
    const page = (await main.call("runs", { backend: "local", routine: list[0].ref.id })) as { items: Run[] }
    expect(page.items[0]).toMatchObject({ ref: started.ref, state: "ok" })

    main.cleanups.forEach((cleanup) => cleanup())
    setSystemTime(new Date(Date.UTC(2026, 10, 16, 9, 0) + 4 * MINUTE))
    const second = (await main.call("start", { backend: "local", id: list[0].ref.id })) as Run
    setSystemTime(new Date(Date.UTC(2026, 10, 16, 9, 0) + 10 * MINUTE))
    jest.advanceTimersByTime(60_000)
    const after = (await main.call("runs", { backend: "local", routine: list[0].ref.id })) as { items: Run[] }
    // The cleanup stopped the timer: nothing settles the second run.
    expect(after.items[0]).toMatchObject({ ref: second.ref, state: "running" })
  })
})
