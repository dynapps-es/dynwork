import { Agent, Model, Plugin, Rpc } from "@opencode/plugin/effect"
import { Effect, Exit, Schema } from "effect"
import { DynWorkSync } from "./contract"
import { DynWorkGateway } from "./gateway"
import { DynWorkMapping } from "./mapping"
import { DynWorkShell } from "./shell"

// DynWork's server plugin. Main pushes the active instance's manifest, gateway models and JWT over `dynwork.sync`, and
// the plugin adds its skills, agents, MCP servers, rules and `systemprompt` provider to the service in memory: nothing
// reaches the database or the config files, and `clear` (sign-out) or the next `apply` (switch) leaves nothing of the
// previous instance. Main pushes each renewed JWT with `token`, and answers the `refresh` event with one.

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
    token: {
      input: Schema.toStandardSchemaV1(DynWorkSync.Token),
      output: Schema.toStandardSchemaV1(DynWorkSync.TokenAccepted),
    },
  },
  events: {
    refresh: { schema: Schema.toStandardSchemaV1(DynWorkSync.Refresh) },
    rejected: { schema: Schema.toStandardSchemaV1(DynWorkSync.Rejected) },
  },
})

interface Store {
  current:
    | {
        readonly input: DynWorkSync.Apply
        mapped: DynWorkMapping.Mapped
        readonly provided: DynWorkGateway.Provided | undefined
      }
    | undefined
  /** The instance's JWT for model calls, held only here. */
  readonly tokens: DynWorkGateway.Tokens
  /** One per Location the plugin runs in: rebuilds that Location's skills, agents, MCP servers, providers and models. */
  readonly reloads: Set<Effect.Effect<void>>
  /** One per Location: reconnects only its MCP servers, for a renewed JWT. */
  readonly mcpReloads: Set<Effect.Effect<void>>
}

// The service activates the plugin once per Location, and each activation imports the module afresh (local plugin
// sources are re-read for hot reload), so module state is not shared. Main calls one Location; the synced content
// must reach all of them and survive a reload of the plugin, so it lives in one process-wide slot.
const slot = globalThis as typeof globalThis & { __dynworkSync?: Store }
// A slot left by an older build of the plugin in the same process gains the fields it lacks.
const store: Store = Object.assign(slot.__dynworkSync ?? {}, {
  current: slot.__dynworkSync?.current,
  tokens: slot.__dynworkSync?.tokens ?? DynWorkGateway.tokens(),
  reloads: slot.__dynworkSync?.reloads ?? new Set<Effect.Effect<void>>(),
  mcpReloads: slot.__dynworkSync?.mcpReloads ?? new Set<Effect.Effect<void>>(),
})
slot.__dynworkSync = store

const mapped = () => store.current?.mapped ?? DynWorkMapping.empty

// Every Location reloads, even when one fails; any failure then fails the call, so main never records a sync that did
// not land everywhere and tries again.
const everywhere = (reloads: Set<Effect.Effect<void>>) =>
  Effect.suspend(() =>
    Effect.forEach([...reloads], (reload) => Effect.exit(reload), { concurrency: "unbounded" }),
  ).pipe(
    Effect.flatMap((exits) => {
      const failed = exits.filter(Exit.isFailure).length
      return failed === 0 ? Effect.void : Effect.die(new Error(`${failed} Location(s) did not reload`))
    }),
  )
const reloadAll = everywhere(store.reloads)

export default Plugin.define({
  id: "dynwork",
  effect: Effect.fn("DynWorkPlugin")(function* (ctx) {
    // Models are built from providers, so the model reload follows the provider one.
    const reload = Effect.all(
      [
        ctx.skill.reload(),
        ctx.agent.reload(),
        ctx.mcp.reload(),
        ctx.provider.reload().pipe(Effect.andThen(ctx.model.reload())),
      ],
      { discard: true, concurrency: "unbounded" },
    )
    const mcpReload = ctx.mcp.reload()
    store.reloads.add(reload)
    store.mcpReloads.add(mcpReload)
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        store.reloads.delete(reload)
        store.mcpReloads.delete(mcpReload)
      }),
    )

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
          if (agent.model) info.model = { providerID: DynWorkGateway.providerID, id: Model.ID.make(agent.model) }
        })
      const id = mapped().defaults.agent
      if (id) editor.default(id)
    })
    yield* ctx.mcp.transform((editor) => {
      for (const [name, config] of mapped().mcp) editor.set(name, config)
    })
    yield* ctx.provider.transform((editor) => {
      const provided = store.current?.provided
      if (provided) editor.add({ info: provided.info, models: provided.models })
    })
    yield* ctx.model.transform((editor) => {
      const model = mapped().defaults.model
      if (model && editor.get(model.providerID, model.modelID)) editor.default.set(model.providerID, model.modelID)
      // The gateway's suggestion only fills an empty choice: a configured default model or `cli_defaults` wins.
      const suggested = store.current?.provided?.default
      if (suggested && !editor.default.get() && editor.get(DynWorkGateway.providerID, suggested))
        editor.default.set(DynWorkGateway.providerID, suggested)
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

    const rpc = yield* ctx.rpc
      .register(Definition, {
        apply: (input) =>
          Effect.gen(function* () {
            const next = DynWorkMapping.map(input)
            store.current = { input, mapped: next, provided: DynWorkGateway.provider(input) }
            DynWorkGateway.push(store.tokens, { jwt: input.jwt, expiresAt: input.expiresAt })
            yield* reloadAll
            return { skills: next.skills.length, agents: next.agents.length, mcp: next.mcp.length, rules: next.rules }
          }),
        clear: () =>
          Effect.gen(function* () {
            store.current = undefined
            DynWorkGateway.push(store.tokens, undefined)
            yield* reloadAll
            return {}
          }),
        token: (input) =>
          Effect.gen(function* () {
            const current = store.current
            // A token minted for an instance that is no longer the active one, or before a sign-out, is dropped.
            if (current?.input.instance.key !== input.instance.key || current.input.instance.url !== input.instance.url)
              return { accepted: false }
            // Renewals can arrive out of order: one that expires before the held JWT is older, and dropped.
            const held = store.tokens.current
            if (held !== undefined && input.expiresAt < held.expiresAt) return { accepted: false }
            DynWorkGateway.push(store.tokens, { jwt: input.jwt, expiresAt: input.expiresAt })
            // MCP servers on the instance's origin carry the JWT in their headers: they reconnect with the new one.
            const next = DynWorkMapping.map({ ...current.input, jwt: input.jwt, expiresAt: input.expiresAt })
            const reconnect = next.mcp.some((entry) => JSON.stringify(entry[1]).includes(input.jwt))
            current.mapped = next
            if (reconnect) yield* everywhere(store.mcpReloads)
            return { accepted: true }
          }),
      })
      .pipe(Effect.orDie)

    // Main follows these events to renew or sign out; when it does not answer, the call just waits less long.
    const events: DynWorkGateway.Events = {
      refresh: (reason) =>
        rpc.events
          .emit("refresh", { instance: store.current?.input.instance.key ?? "", reason })
          .pipe(Effect.catchCause(() => Effect.logWarning("dynwork: could not ask main for a JWT"))),
      rejected: () =>
        rpc.events
          .emit("rejected", { instance: store.current?.input.instance.key ?? "" })
          .pipe(Effect.catchCause(() => Effect.logWarning("dynwork: could not report a refused JWT"))),
    }

    // Every call to the gateway carries the JWT held now and the declared client kind, and goes to the instance's own
    // gateway: a provider base URL changed by the user's config never receives the JWT.
    yield* ctx.session.hook(
      "model.request",
      (event) =>
        Effect.gen(function* () {
          const provided = store.current?.provided
          if (!provided) return
          const jwt = yield* DynWorkGateway.authorize(store.tokens, events, event.sessionID)
          Object.keys(event.headers)
            .filter((name) => ["authorization", "x-api-key", "x-systemprompt-client"].includes(name.toLowerCase()))
            .forEach((name) => delete event.headers[name])
          // authorize may wait for main: a switch or sign-out meanwhile leaves a JWT that is not this gateway's, so the
          // call goes without one and the retry hook picks up the instance that is current then.
          if (jwt && store.current?.provided === provided) event.headers.authorization = `Bearer ${jwt}`
          event.headers["x-systemprompt-client"] = DynWorkGateway.client
          event.baseURL = provided.baseURL
        }),
      { providerID: DynWorkGateway.providerID },
    )
    // A refused call (401) runs once more with a newer JWT instead of failing the step.
    yield* ctx.session.hook(
      "retry",
      (event) =>
        Effect.gen(function* () {
          if (event.error.status !== 401 || !store.current?.provided) return
          // A step's retry policy starts at attempt 1, so its first failure asks for attempt 2.
          event.decision = (yield* DynWorkGateway.refused(store.tokens, events, event.sessionID, event.attempt <= 2))
            ? { retry: true, delay: 0 }
            : { retry: false }
        }),
      { providerID: DynWorkGateway.providerID },
    )
  }),
})
