import { afterEach, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import plugin, { Definition } from "../src/index"
import { DynWorkShell } from "../src/shell"
import { apply } from "./fixture"

// Runs the plugin against a recording context. It pins every public plugin API DynWork relies on (hook, transform
// and RPC names): if upstream renames one, the type check or this test fails instead of the content silently vanishing.
function record() {
  const used: string[] = []
  const transforms: Record<string, (editor: never) => void> = {}
  const hooks: Record<string, (event: never) => Effect.Effect<void>> = {}
  const handlers: { apply?: (input: unknown) => Effect.Effect<unknown>; clear?: () => Effect.Effect<unknown> } = {}
  const registration = Effect.succeed({ dispose: Effect.void })
  const domain = (name: string) => ({
    transform: (callback: (editor: never) => void) => {
      used.push(`${name}.transform`)
      transforms[name] = callback
      return registration
    },
    reload: () => Effect.sync(() => void used.push(`${name}.reload`)),
  })
  const hook = (name: string) => (event: string, callback: (event: never) => Effect.Effect<void>) => {
    used.push(`${name}.hook(${event})`)
    hooks[`${name}.${event}`] = callback
    return registration
  }
  const ctx = {
    skill: domain("skill"),
    agent: domain("agent"),
    mcp: domain("mcp"),
    provider: domain("provider"),
    model: domain("model"),
    session: { hook: hook("session") },
    shell: { hook: hook("shell") },
    rpc: {
      register: (definition: { id: string }, implementation: typeof handlers) => {
        used.push(`rpc.register(${definition.id})`)
        Object.assign(handlers, implementation)
        return Effect.succeed({ dispose: Effect.void, events: { emit: () => Effect.void } })
      },
    },
  }
  return { used, transforms, hooks, handlers, ctx: ctx as unknown as Plugin.Context }
}

const saved = process.env[DynWorkShell.variable]
afterEach(() => {
  if (saved === undefined) delete process.env[DynWorkShell.variable]
  else process.env[DynWorkShell.variable] = saved
})

test("the plugin registers the hooks, transforms and RPC it documents", async () => {
  process.env[DynWorkShell.variable] = '{"XDG_STATE_HOME":null}'
  const recorded = record()
  await Effect.runPromise(Effect.scoped(plugin.effect(recorded.ctx)))
  expect(plugin.id).toBe("dynwork")
  expect(Definition.id).toBe("dynwork.sync")
  expect(Object.keys(Definition.methods)).toEqual(["apply", "clear", "token", "materialize", "inspect"])
  expect(Object.keys(Definition.events)).toEqual(["refresh", "rejected"])
  expect(recorded.used).toEqual([
    "skill.transform",
    "mcp.transform",
    "provider.transform",
    "model.transform",
    "session.hook(context)",
    "shell.hook(create.before)",
    "rpc.register(dynwork.sync)",
    "session.hook(model.request)",
    "session.hook(retry)",
  ])
})

test("without saved shell values the plugin leaves shells alone", async () => {
  delete process.env[DynWorkShell.variable]
  const recorded = record()
  await Effect.runPromise(Effect.scoped(plugin.effect(recorded.ctx)))
  expect(recorded.used).not.toContain("shell.hook(create.before)")
})

test("apply fills every transform and the system prompt, and clear empties them", async () => {
  const recorded = record()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* plugin.effect(recorded.ctx)
        const run = () => {
          const added: unknown[] = []
          const mcp: Record<string, unknown> = {}
          recorded.transforms.skill?.({ add: (skill: unknown) => added.push(skill) } as never)
          recorded.transforms.mcp?.({ set: (name: string, config: unknown) => (mcp[name] = config) } as never)
          const event = { system: [] as unknown[] }
          return Effect.as(recorded.hooks["session.context"]?.(event as never) ?? Effect.void, {
            added,
            mcp,
            system: event.system,
          })
        }

        expect(yield* recorded.handlers.apply!(apply())).toEqual({ skills: 3, agents: 0, mcp: 1, rules: 1 })
        expect(recorded.used.filter((name) => name.endsWith(".reload"))).toEqual([
          "skill.reload",
          "agent.reload",
          "mcp.reload",
          "provider.reload",
          "model.reload",
        ])
        const filled = yield* run()
        expect(filled.added).toHaveLength(3)
        expect(Object.keys(filled.mcp)).toEqual(["alpha-docs"])
        expect(filled.system).toEqual([{ type: "text", text: expect.stringContaining("# Alpha conventions") }])

        expect(yield* recorded.handlers.clear!()).toEqual({})
        const cleared = yield* run()
        expect(cleared).toEqual({ added: [], mcp: {}, system: [] })
      }),
    ),
  )
})
