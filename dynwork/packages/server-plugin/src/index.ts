import { Agent, Plugin, Rpc } from "@opencode/plugin/effect"
import { Effect, Exit, Schema } from "effect"
import { DynWorkSync } from "./contract"
import { DynWorkMapping } from "./mapping"
import { DynWorkShell } from "./shell"

// DynWork's server plugin. Main pushes the active instance's manifest and JWT over `dynwork.sync`, and the plugin
// adds its skills, agents, MCP servers and rules to the service in memory: nothing reaches the database or the
// config files, and `clear` (sign-out) or the next `apply` (switch) leaves nothing of the previous instance.

export const Definition = Rpc.define({
  id: DynWorkSync.id,
  methods: {
    apply: {
      input: Schema.toStandardSchemaV1(DynWorkSync.Apply),
      output: Schema.toStandardSchemaV1(DynWorkSync.Applied),
    },
    clear: {
      input: Schema.toStandardSchemaV1(Schema.Unknown),
      output: Schema.toStandardSchemaV1(DynWorkSync.Empty),
    },
  },
  events: {},
})

interface Store {
  current: { readonly mapped: DynWorkMapping.Mapped; readonly expiresAt: number } | undefined
  /** One per Location the plugin runs in: rebuilds that Location's skills, agents, MCP servers and models. */
  readonly reloads: Set<Effect.Effect<void>>
}

// The service activates the plugin once per Location, and each activation imports the module afresh (local plugin
// sources are re-read for hot reload), so module state is not shared. Main calls one Location; the synced content
// must reach all of them and survive a reload of the plugin, so it lives in one process-wide slot.
const slot = globalThis as typeof globalThis & { __dynworkSync?: Store }
const store = (slot.__dynworkSync ??= { current: undefined, reloads: new Set() })

const mapped = () => store.current?.mapped ?? DynWorkMapping.empty

// Every Location reloads, even when one fails; any failure then fails the call, so main never records a sync that did
// not land everywhere and tries again.
const reloadAll = Effect.suspend(() =>
  Effect.forEach([...store.reloads], (reload) => Effect.exit(reload), { concurrency: "unbounded" }),
).pipe(
  Effect.flatMap((exits) => {
    const failed = exits.filter(Exit.isFailure).length
    return failed === 0 ? Effect.void : Effect.die(new Error(`${failed} Location(s) did not reload`))
  }),
)

export default Plugin.define({
  id: "dynwork",
  effect: Effect.fn("DynWorkPlugin")(function* (ctx) {
    const reload = Effect.all([ctx.skill.reload(), ctx.agent.reload(), ctx.mcp.reload(), ctx.model.reload()], {
      discard: true,
      concurrency: "unbounded",
    })
    store.reloads.add(reload)
    yield* Effect.addFinalizer(() => Effect.sync(() => store.reloads.delete(reload)))

    // Transforms only copy values the mapping already built and decoded: one that throws disables the plugin.
    yield* ctx.skill.transform((editor) => {
      for (const skill of mapped().skills) editor.add(skill)
    })
    yield* ctx.agent.transform((editor) => {
      for (const agent of mapped().agents)
        editor.update(agent.id, (info) => {
          info.name = Agent.Name.make(agent.name)
          info.description = agent.description
          info.system = agent.system
          info.mode = agent.mode
        })
      const id = mapped().defaults.agent
      if (id) editor.default(id)
    })
    yield* ctx.mcp.transform((editor) => {
      for (const [name, config] of mapped().mcp) editor.set(name, config)
    })
    yield* ctx.model.transform((editor) => {
      const model = mapped().defaults.model
      if (model && editor.get(model.providerID, model.modelID)) editor.default.set(model.providerID, model.modelID)
    })

    // Rules go into the system prompt of every step instead of the Session's instruction entries: the system part is
    // rebuilt for each model call, so it never piles up across steps, compaction cannot summarize it away, and a
    // switch or sign-out takes effect on the next step of every Session without touching stored history.
    yield* ctx.session.hook("context", (event) =>
      Effect.sync(() => {
        const system = mapped().system
        if (system) event.system.push({ type: "text", text: system })
      }),
    )

    const user = DynWorkShell.saved(process.env)
    if (user) {
      const service = { XDG_STATE_HOME: process.env.XDG_STATE_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME }
      yield* ctx.shell.hook("create.before", (event) =>
        Effect.sync(() => DynWorkShell.restore(event.env, user, service)),
      )
    }

    yield* ctx.rpc
      .register(Definition, {
        apply: (input) =>
          Effect.gen(function* () {
            const next = DynWorkMapping.map(input)
            store.current = { mapped: next, expiresAt: input.expiresAt }
            yield* reloadAll
            return { skills: next.skills.length, agents: next.agents.length, mcp: next.mcp.length, rules: next.rules }
          }),
        clear: () =>
          Effect.gen(function* () {
            store.current = undefined
            yield* reloadAll
            return {}
          }),
      })
      .pipe(Effect.orDie)
  }),
})
