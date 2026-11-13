import { Plugin, Rpc } from "@opencode/plugin/effect"
import { Effect, Exit, Schema, Stream } from "effect"
import { DynWorkBundles } from "./bundles"
import { DynWorkConfig } from "./config"
import { DynWorkSync } from "./contract"
import { DynWorkGateway } from "./gateway"
import { DynWorkInstructions } from "./instructions"
import { DynWorkMapping } from "./mapping"
import { DynWorkShell } from "./shell"
import { DynWorkSkills } from "./skills"
import { DynWorkTelemetry } from "./telemetry"
import { DynWorkUsage } from "./usage"

// DynWork's server plugin. Main pushes the active instance's manifest, gateway models, plugin bundle files and JWT over
// `dynwork.sync`, and the plugin adds its MCP servers and `systemprompt` provider to the service in memory, and writes
// into the service's config dir the files the systemprompt bridge writes for OpenCode: its skills, its rules in the
// managed block of the global `AGENTS.md`, its bundle agents, plugins and themes, and its `policies` and
// `cli_defaults` in `opencode.json`. Nothing reaches the database, and `clear` (sign-out) or the
// next `apply` (switch) leaves nothing of the previous instance. Main pushes each renewed JWT with `token`, and answers
// the `refresh` event with one. While a manifest plugin owns governance, the bridge's hook events go to the instance.

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
    materialize: {
      input: Schema.toStandardSchemaV1(DynWorkSync.Materialize),
      output: Schema.toStandardSchemaV1(DynWorkSync.Materialized),
    },
    inspect: {
      input: Schema.toStandardSchemaV1(DynWorkSync.Inspect),
      output: Schema.toStandardSchemaV1(DynWorkSync.Inspected),
    },
    device: {
      input: Schema.toStandardSchemaV1(DynWorkSync.Device),
      output: Schema.toStandardSchemaV1(DynWorkSync.TokenAccepted),
    },
    usage: {
      input: Schema.toStandardSchemaV1(DynWorkSync.UsageOf),
      output: Schema.toStandardSchemaV1(DynWorkSync.Usage),
    },
  },
  events: {
    refresh: { schema: Schema.toStandardSchemaV1(DynWorkSync.Refresh) },
    rejected: { schema: Schema.toStandardSchemaV1(DynWorkSync.Rejected) },
    session: { schema: Schema.toStandardSchemaV1(DynWorkSync.Session) },
  },
})

interface Store {
  current:
    | {
        readonly input: DynWorkSync.Apply
        mapped: DynWorkMapping.Mapped
        readonly provided: DynWorkGateway.Provided | undefined
        /** Where governance events go, when a manifest plugin owns them (`DynWorkTelemetry.target`). */
        readonly telemetry: DynWorkTelemetry.Target | undefined
      }
    | undefined
  /** The instance's JWT for model calls, held only here. */
  readonly tokens: DynWorkGateway.Tokens
  /** One per Location the plugin runs in: rebuilds that Location's skills, agents, MCP servers, providers and models. */
  readonly reloads: Set<Effect.Effect<void>>
  /** One per Location: reconnects only its MCP servers, for a renewed JWT. */
  readonly mcpReloads: Set<Effect.Effect<void>>
  /** The instance's hook client and tokens for governance events, held only here. */
  readonly hooks: DynWorkTelemetry.Hooks
  /** Per Session: its directory and the prompt last reported, like the bridge's plugin keeps them. */
  readonly sessions: { readonly directories: Map<string, string>; readonly prompts: Map<string, string> }
  /** Lifecycle events already reported: every Location's activation sees the same service events. */
  readonly reported: Set<string>
  /** The device credential main enrolled for the instance applied, held only here, for the events' device evidence. */
  device: string | undefined
  /** Sessions already reported to main for binding, by instance. */
  readonly bound: Set<string>
  /** Publishes `session` for main; set by the Location that registered the RPC last. */
  emit: ((session: string) => void) | undefined
  /** The gateway calls and tokens counted for the instance applied, which main reports in its heartbeat. */
  usage: DynWorkUsage.Usage | undefined
  /** Usage events already counted: every Location's activation sees the same service events. */
  readonly counted: Set<string>
  /** The integrations of the providers the instance blocks, recorded by the provider transform. */
  blocked: ReadonlySet<string>
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
  hooks: slot.__dynworkSync?.hooks ?? DynWorkTelemetry.hooks(),
  sessions: slot.__dynworkSync?.sessions ?? {
    directories: new Map<string, string>(),
    prompts: new Map<string, string>(),
  },
  reported: slot.__dynworkSync?.reported ?? new Set<string>(),
  device: slot.__dynworkSync?.device,
  bound: slot.__dynworkSync?.bound ?? new Set<string>(),
  emit: slot.__dynworkSync?.emit,
  usage: slot.__dynworkSync?.usage,
  counted: slot.__dynworkSync?.counted ?? new Set<string>(),
  blocked: slot.__dynworkSync?.blocked ?? new Set<string>(),
})
slot.__dynworkSync = store

const mapped = () => store.current?.mapped ?? DynWorkMapping.empty

// Set only for DynWork's own service (the packaged prod build), whose config dir is DynWork's alone: the rules go to its
// global `AGENTS.md` and the skills to its `skills` directory, which OpenCode watches and reloads by itself. A service
// without it keeps the user's config dir, which the plugin never writes to: the rules go into each step's system
// context and the skills into the service in memory instead.
const configDir = process.env.OPENCODE_CONFIG_DIR || undefined

// While an instance is applied, its gateway is the only provider: with a config dir of its own the bridge's `policies`
// block the others even without gateway models.
const locked = () => store.current !== undefined && (configDir !== undefined || store.current.provided !== undefined)

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

// One governance event, sent in the background: like the bridge's plugin, it never holds up or fails a step.
const report = (body: Record<string, unknown> | undefined) =>
  Effect.sync(() => {
    const telemetry = store.current?.telemetry
    const jwt = store.tokens.current?.jwt
    const device = store.device
    if (!body || !telemetry || !jwt) return
    void DynWorkTelemetry.send(store.hooks, telemetry, jwt, body, device)
    // Like the bridge's proxy, only an enrolled device queues the Session for binding to its receipts.
    const session = typeof body.session_id === "string" ? body.session_id : undefined
    const key = `${store.current?.input.instance.key}\u001f${session}`
    if (!device || !session || store.bound.has(key)) return
    store.bound.add(key)
    bounded(store.bound)
    store.emit?.(session)
  })

const directory = (sessionID: string) => store.sessions.directories.get(sessionID) ?? process.cwd()

// Sessions that never end would keep their entries: only the most recent ones are kept.
function bounded<T>(collection: Map<string, T> | Set<string>) {
  if (collection.size > 1024) collection.delete(collection.keys().next().value ?? "")
}

export default Plugin.define({
  id: "dynwork",
  effect: Effect.fn("DynWorkPlugin")(function* (ctx) {
    // Models are built from providers, so the model reload follows the provider one.
    const reload = Effect.all(
      [
        ctx.skill.reload(),
        ctx.agent.reload(),
        ctx.mcp.reload(),
        // The integration transform hides what the provider transform blocked.
        ctx.provider.reload().pipe(Effect.andThen(ctx.integration.reload()), Effect.andThen(ctx.model.reload())),
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
    if (!configDir)
      yield* ctx.skill.transform((editor) => {
        for (const skill of mapped().skills) editor.add(skill)
      })
    yield* ctx.mcp.transform((editor) => {
      for (const [name, config] of mapped().mcp) editor.set(name, config)
    })
    // Like the bridge's `policies` (deny `provider.use *`, allow `systemprompt`), the instance's gateway is the only
    // provider while it is applied. Every provider reload runs this again, so one connected later is removed too.
    // Providers declared in a config file's `providers` are added after external plugins: with a config dir of its own
    // the service gets the bridge's `policies` in `opencode.json`, which remove those too.
    // Claude Agent stays while the gateway is applied: each of its calls goes to the gateway (the hooks below).
    yield* ctx.provider.transform((editor) => {
      const provided = store.current?.provided
      const records = editor.list().filter((record) => !(provided && record.provider.id === DynWorkGateway.agentID))
      store.blocked = new Set(records.map((record) => record.provider.integrationID ?? record.provider.id))
      if (!provided) return
      for (const record of records) editor.remove(record.provider.id)
      editor.add({ info: provided.info, models: provided.models })
    })
    // Nor does the connect dialog offer a provider that would vanish once connected. Only providers name the
    // integration they use, so the provider transform records them; MCP servers' and other integrations stay.
    yield* ctx.integration.transform((editor) => {
      if (!locked()) return
      for (const id of store.blocked) editor.remove(id)
    })
    yield* ctx.model.transform((editor) => {
      // With a config dir of its own, `cli_defaults` sets `model` in `opencode.json` only where the user has not.
      const model = configDir ? undefined : mapped().defaults.model
      if (model && editor.get(model.providerID, model.modelID)) editor.default.set(model.providerID, model.modelID)
      // The gateway's suggestion only fills an empty choice: a configured default model or `cli_defaults` wins.
      const suggested = store.current?.provided?.default
      if (suggested && !editor.default.get() && editor.get(DynWorkGateway.providerID, suggested))
        editor.default.set(DynWorkGateway.providerID, suggested)
    })

    // Without a config dir of its own, the rules go into the system part of each model call: it is rebuilt for every
    // call, so it never piles up across steps and a switch or sign-out takes effect on the next step of every Session.
    // The same hook reports each new prompt while governance telemetry is on.
    yield* ctx.session.hook("context", (event) =>
      Effect.suspend(() => {
        const instructions = configDir ? undefined : mapped().instructions
        if (instructions) event.system.push({ type: "text", text: instructions })
        if (!store.current?.telemetry) return Effect.void
        const body = DynWorkTelemetry.prompt(
          event.messages,
          event.sessionID,
          directory(event.sessionID),
          store.sessions.prompts,
        )
        bounded(store.sessions.prompts)
        return report(body)
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
            const provided = DynWorkGateway.provider(input)
            // Like the bridge, the block is written in full and only reported: OpenCode never reads rules past it.
            const over = DynWorkInstructions.overBudget(next.instructions)
            if (over)
              yield* Effect.logWarning(
                `dynwork: the rules block of AGENTS.md is ${over} characters, over OpenCode's ${DynWorkInstructions.budget}`,
              )
            if (next.skillFiles?.skipped.length)
              yield* Effect.logWarning(
                `dynwork: skills without a directory of their own, not written: ${next.skillFiles.skipped.join(", ")}`,
              )
            const warnings = configDir ? (next.owned?.warnings ?? []) : []
            yield* Effect.forEach(warnings, (warning) => Effect.logWarning(`dynwork: ${warning}`), { discard: true })
            // A failed write fails the call before anything changes, so main tries again.
            if (configDir) {
              yield* Effect.promise(() => DynWorkInstructions.write(configDir, next.instructions))
              yield* Effect.promise(() => DynWorkSkills.write(configDir, next.skillFiles))
              yield* Effect.promise(() => DynWorkBundles.write(configDir, next.owned))
              yield* Effect.promise(() =>
                DynWorkConfig.write(configDir, {
                  locked: true,
                  agent: provided !== undefined,
                  settings: next.settings,
                }),
              )
            }
            const telemetry = DynWorkTelemetry.target(input)
            // The device credential belongs to the instance it was enrolled with: another one never receives it.
            if (
              store.current?.input.instance.key !== input.instance.key ||
              store.current.input.instance.url !== input.instance.url
            )
              store.device = undefined
            // A hook client and tokens of another instance are never sent to this one.
            if (store.current?.telemetry?.base !== telemetry?.base) Object.assign(store.hooks, DynWorkTelemetry.hooks())
            // Another instance starts its totals at zero, as a new bridge session does.
            if (store.usage?.instance !== DynWorkUsage.id(input.instance))
              store.usage = DynWorkUsage.start(input.instance)
            store.current = { input, mapped: next, provided, telemetry }
            DynWorkGateway.push(store.tokens, { jwt: input.jwt, expiresAt: input.expiresAt })
            yield* reloadAll
            return {
              skills: configDir ? (next.skillFiles?.files.length ?? 0) : next.skills.length,
              agents: configDir ? (next.owned?.files.filter((file) => file.path.startsWith("agents/")).length ?? 0) : 0,
              mcp: next.mcp.length,
              rules: next.rules,
              ...(warnings.length > 0 ? { warnings } : {}),
            }
          }),
        clear: () =>
          Effect.gen(function* () {
            store.current = undefined
            DynWorkGateway.push(store.tokens, undefined)
            Object.assign(store.hooks, DynWorkTelemetry.hooks())
            store.device = undefined
            store.usage = undefined
            if (configDir) {
              yield* Effect.promise(() => DynWorkInstructions.write(configDir, undefined))
              yield* Effect.promise(() => DynWorkSkills.write(configDir, undefined))
              yield* Effect.promise(() => DynWorkBundles.write(configDir, undefined))
              yield* Effect.promise(() => DynWorkConfig.write(configDir, { locked: false }))
            }
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
        // A skill's runtime files, which main reads from its publication bundle, go beside the SKILL.md `apply` wrote.
        // Only for the instance applied, and only in a config dir of the service's own.
        materialize: (input) =>
          Effect.gen(function* () {
            const current = store.current
            if (!configDir) return { outcome: "unsupported" as const, files: [] }
            if (current?.input.instance.key !== input.instance.key || current.input.instance.url !== input.instance.url)
              return { outcome: "missing" as const, files: [] }
            return yield* Effect.promise(() =>
              DynWorkSkills.install(configDir, current.mapped.skillFiles, input.skill, input.files),
            )
          }),
        device: (input) =>
          Effect.sync(() => {
            const current = store.current
            if (current?.input.instance.key !== input.instance.key || current.input.instance.url !== input.instance.url)
              return { accepted: false }
            store.device = input.credential
            return { accepted: true }
          }),
        usage: (input) => Effect.sync(() => DynWorkUsage.report(store.usage, input.instance)),
        inspect: (input) =>
          Effect.gen(function* () {
            const current = store.current
            if (
              !configDir ||
              current?.input.instance.key !== input.instance.key ||
              current.input.instance.url !== input.instance.url
            )
              return { intact: false }
            return {
              intact: yield* Effect.promise(() =>
                DynWorkSkills.inspect(configDir, current.mapped.skillFiles, input.skill, input.files),
              ),
            }
          }),
      })
      .pipe(Effect.orDie)

    const emit = (session: string) =>
      Effect.runFork(
        rpc.events
          .emit("session", { instance: store.current?.input.instance.key ?? "", session })
          .pipe(Effect.catchCause(() => Effect.logWarning("dynwork: could not report a Session for binding"))),
      )
    store.emit = emit
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (store.emit === emit) store.emit = undefined
      }),
    )

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
            .filter((name) =>
              ["authorization", "x-api-key", "x-systemprompt-client", "x-inference-protocol"].includes(
                name.toLowerCase(),
              ),
            )
            .forEach((name) => delete event.headers[name])
          // authorize may wait for main: a switch or sign-out meanwhile leaves a JWT that is not this gateway's, so the
          // call goes without one and the retry hook picks up the instance that is current then.
          if (jwt && store.current?.provided === provided) event.headers.authorization = `Bearer ${jwt}`
          event.headers["x-systemprompt-client"] = DynWorkGateway.client
          event.headers["x-inference-protocol"] = provided.protocols
          event.baseURL = provided.baseURL
        }),
      { providerID: DynWorkGateway.providerID },
    )
    // Claude Agent's calls go to the instance's gateway with the systemprompt identity in a header of their own, so
    // Claude Code keeps the user's claude.ai login and the instance serves them with the user's own subscription where
    // its catalog says so. The connection is the call's own, never the provider's: a base URL set in the user's config
    // never receives the JWT. Claude Code holds the JWT for the whole turn, so one that runs out sooner is renewed first.
    yield* Effect.forEach(
      ["context", "compaction", "generate", "title"] as const,
      (kind) =>
        ctx.session.hook(
          kind,
          (event) =>
            Effect.gen(function* () {
              const provided = store.current?.provided
              if (!provided) return
              const jwt = yield* DynWorkGateway.authorize(store.tokens, events, event.sessionID, true)
              event.options[DynWorkGateway.connectionOption] = {
                settings: { baseURL: provided.baseURL },
                // A switch or sign-out while authorize waited leaves a JWT that is not this gateway's
                headers:
                  jwt && store.current?.provided === provided
                    ? { [DynWorkGateway.identityHeader]: `Bearer ${jwt}` }
                    : {},
              }
            }),
          { providerID: DynWorkGateway.agentID },
        ),
      { discard: true },
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

    // The governance events of the bridge's `systemprompt-hooks.js` (`DynWorkTelemetry`), only while a manifest plugin
    // owns governance: Session start and end, every tool result, and the end of each assistant turn (prompts are
    // reported by the context hook above).
    yield* ctx.event.subscribe({ types: ["session.created", "session.deleted"] }).pipe(
      Stream.runForEach((event) =>
        Effect.suspend(() => {
          const sessionID = event.data.sessionID
          const id = event.id ?? `${sessionID}:${event.type}`
          if (store.reported.has(id)) return Effect.void
          store.reported.add(id)
          bounded(store.reported)
          if (event.type === "session.created") {
            store.sessions.directories.set(sessionID, event.data.location.directory)
            bounded(store.sessions.directories)
          }
          const body = DynWorkTelemetry.lifecycle(event.type, sessionID, directory(sessionID), id)
          if (event.type === "session.deleted") {
            store.sessions.directories.delete(sessionID)
            store.sessions.prompts.delete(sessionID)
          }
          return report(body)
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
    // OpenCode 2 publishes no `session.idle`, which the bridge's plugin listens to; this hook runs at the same point,
    // when a Session finishes model work with no pending input.
    yield* ctx.session.hook("experimental.idle", (event) =>
      report(
        DynWorkTelemetry.lifecycle(
          "session.idle",
          event.sessionID,
          directory(event.sessionID),
          `${event.sessionID}:session.idle:${Date.now()}`,
        ),
      ),
    )
    yield* ctx.tool.hook("execute.after", (event) =>
      Effect.suspend(() =>
        store.current?.telemetry
          ? report(DynWorkTelemetry.tool(event, store.current.telemetry.skills, directory(event.sessionID)))
          : Effect.void,
      ),
    )
    // The session on each gateway call, where the bridge's proxy puts it, so the call lands on the events' context.
    yield* ctx.session.hook(
      "http.request",
      (event) =>
        Effect.gen(function* () {
          if (!store.current?.telemetry) return
          const request = event.request
          event.request = yield* Effect.promise(() =>
            DynWorkTelemetry.stamp(request, event.sessionID).catch(() => request),
          )
        }),
      { providerID: DynWorkGateway.providerID },
    )

    // What the bridge's proxy counts for its heartbeat (`DynWorkUsage`): each answer of the instance's gateway, and the
    // tokens of every step. While an instance is applied its gateway is the only provider, so every step is its own.
    // Title and compaction calls count as calls; OpenCode keeps their tokens in an event plugins do not receive.
    yield* ctx.session.hook(
      "http.response",
      (event) =>
        Effect.sync(() => {
          if (store.usage && store.current?.provided) DynWorkUsage.call(store.usage, event.response.ok, Date.now())
        }),
      { providerID: DynWorkGateway.providerID },
    )
    yield* ctx.event.subscribe({ types: ["session.step.ended", "session.step.failed"] }).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          const tokens = event.data.tokens
          const id = event.id ?? `${event.data.sessionID}:${event.data.assistantMessageID}:${event.type}`
          if (!tokens || store.counted.has(id)) return
          store.counted.add(id)
          bounded(store.counted)
          if (store.usage && store.current?.provided) DynWorkUsage.tokens(store.usage, tokens)
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})
