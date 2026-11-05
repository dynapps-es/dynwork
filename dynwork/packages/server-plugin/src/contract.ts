export * as DynWorkSync from "./contract"

import { Schema } from "effect"

// The wire contract between DynWork's main process and its server plugin. Main verifies the manifest's signature and
// decodes it with `@dynwork/sp-client` first; this is the subset the plugin reads, so any decoded manifest is
// accepted here and unknown keys are dropped. Only `effect` is imported: main bundles this file, and the service
// loads the plugin from a directory that ships without dependencies.

/** The RPC the plugin registers, called at `/api/rpc/<id>/<method>`. */
export const id = "dynwork.sync"

const Strings = Schema.Array(Schema.String)

const Rule = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  instructions: Schema.optional(Schema.String),
  hosts: Schema.optional(Strings),
})

const Skill = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  instructions: Schema.optional(Schema.String),
  hosts: Schema.optional(Strings),
  /** The author's front matter keys; the platform's own (`name`, `description`, `tags`...) are not written back. */
  frontmatter: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  /** The plugins that ship the skill; the first owns its `skill_ref` in governance events. */
  plugins: Schema.optional(Strings),
})

const Agent = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  display_name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
  /** The instance's model id for the agent; it runs on the gateway when the gateway serves that model. */
  model: Schema.optional(Schema.String),
  system_prompt: Schema.optional(Schema.String),
})

const McpServer = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  url: Schema.String,
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})

const Marketplace = Schema.Struct({
  id: Schema.String,
  opencode: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

/** A plugin bundle: each file with the SHA-256 the signed manifest gives it. */
const Plugin = Schema.Struct({
  id: Schema.String,
  /** With `governance`, the plugin's id is the `plugin_id` of the governance events (`DynWorkTelemetry`). */
  hooks: Schema.optional(Schema.Struct({ governance: Schema.optional(Schema.Boolean) })),
  files: Schema.optional(Schema.Array(Schema.Struct({ path: Schema.String, sha256: Schema.String }))),
})

export const Manifest = Schema.Struct({
  enabled_hosts: Schema.optional(Strings),
  rules: Schema.Array(Rule),
  skills: Schema.Array(Skill),
  agents: Schema.Array(Agent),
  managed_mcp_servers: Schema.Array(McpServer),
  plugins: Schema.optional(Schema.Array(Plugin)),
  marketplaces: Schema.optional(Schema.Array(Marketplace)),
  /** Per host, the client families (`claude`, `openai`, `gemini`) whose gateway models it lists. */
  host_model_protocols: Schema.optional(Schema.Record(Schema.String, Strings)),
})
export type Manifest = typeof Manifest.Type

export const Instance = Schema.Struct({
  /**
   * Prefix of every synced id, so instance content never replaces a local skill, agent or MCP server of the same
   * name. Short, because it lands in MCP tool names, which providers cap at 64 characters.
   */
  key: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,23}$/)),
  /** The instance base URL. Only MCP servers on its origin receive the JWT. */
  url: Schema.String.check(Schema.isPattern(/^https?:\/\/[^\s]+$/)),
})
export type Instance = typeof Instance.Type

export const GatewayModel = Schema.Struct({
  /** The instance's model id, kept as is so a user's model choice survives syncs. */
  id: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)),
  name: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  /** The gateway route the model speaks: Anthropic `/v1/messages` or OpenAI `/v1/chat/completions`. */
  api: Schema.Literals(["messages", "chat"]),
  /** The client families the gateway serves the model's provider to, which `host_model_protocols` filters on. */
  clients: Schema.optional(Strings),
  context: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  output: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
})

/** The instance gateway's models, from the user's `profile` and the `models` catalog. */
export const Gateway = Schema.Struct({
  /** The provider's name in the model picker: the instance's label. */
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  models: Schema.Array(GatewayModel),
  /** The model the instance suggests, one of `models`. */
  default: Schema.optional(Schema.String),
})
export type Gateway = typeof Gateway.Type

/**
 * A plugin bundle file main fetched for `DynWorkBundles.wanted`, its bytes in base64. Main does not vouch for them: the
 * plugin writes only bytes whose SHA-256 is the manifest's for that file.
 */
export const BundleFile = Schema.Struct({
  plugin: Schema.String,
  path: Schema.String,
  content: Schema.String,
})
export type BundleFile = typeof BundleFile.Type

// A token68 (RFC 7235) value: it goes into an Authorization header, so no whitespace or line breaks.
const Jwt = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._~+/-]+=*$/), Schema.isMaxLength(16_384))
/** Epoch milliseconds. */
const ExpiresAt = Schema.Number.check(Schema.isGreaterThan(0))

export const Apply = Schema.Struct({
  instance: Instance,
  manifest: Manifest,
  jwt: Jwt,
  expiresAt: ExpiresAt,
  /** Without it the service gets no `systemprompt` provider. */
  gateway: Schema.optional(Gateway),
  files: Schema.optional(Schema.Array(BundleFile)),
})
export type Apply = typeof Apply.Type

/** A renewed JWT for the instance last applied; refused for any other. */
export const Token = Schema.Struct({
  instance: Instance,
  jwt: Jwt,
  expiresAt: ExpiresAt,
})
export type Token = typeof Token.Type

export const TokenAccepted = Schema.Struct({ accepted: Schema.Boolean })

/**
 * The device credential main enrolled for the instance last applied (`POST /v1/bridge/device`), for the governance
 * events' device evidence; without `credential` the plugin drops the one it holds. Refused for any other instance.
 */
export const Device = Schema.Struct({
  instance: Instance,
  credential: Schema.optional(Schema.String.check(Schema.isPattern(/^sp_device_[A-Za-z0-9._~+/=-]{1,246}$/))),
})
export type Device = typeof Device.Type

/**
 * Events the plugin publishes for main. `refresh`: a model call needs a newer JWT than the plugin holds (it expired,
 * or the gateway refused it), so main mints one and pushes it with `token`. `rejected`: the gateway refused the JWT
 * main minted in answer to a refusal, so the plugin stopped sending it and main signs the instance out.
 */
export const Refresh = Schema.Struct({
  instance: Schema.String,
  reason: Schema.Literals(["expired", "rejected"]),
})
export type Refresh = typeof Refresh.Type

export const Rejected = Schema.Struct({ instance: Schema.String })
export type Rejected = typeof Rejected.Type

/**
 * `session`: a governance event of this Session went out with the device evidence, so main binds it to the device's
 * receipts, as the bridge's proxy queues each hook's session (`session_id`, the v5 UUID). Once per Session.
 */
export const Session = Schema.Struct({ instance: Schema.String, session: Schema.String })
export type Session = typeof Session.Type

/** What the service now holds for the instance. */
export const Applied = Schema.Struct({
  skills: Schema.Number,
  agents: Schema.Number,
  mcp: Schema.Number,
  rules: Schema.Number,
  /** What was left out, such as a bundle file that does not match the manifest. Absent when nothing was. */
  warnings: Schema.optional(Strings),
})
export type Applied = typeof Applied.Type

export const Empty = Schema.Struct({})

/** One file of a skill publication's bundle (`ConsumerInstallationPlan.runtime_files`), its bytes in base64. */
export const RuntimeFile = Schema.Struct({
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  content: Schema.String,
  executable: Schema.Boolean,
})
export type RuntimeFile = typeof RuntimeFile.Type

/** The runtime files of one skill of the instance applied, written beside its `SKILL.md`. */
export const Materialize = Schema.Struct({
  instance: Instance,
  /** The skill's manifest id; its directory is the projection's. */
  skill: Schema.String,
  files: Schema.Array(RuntimeFile),
})
export type Materialize = typeof Materialize.Type

const Check = Schema.Literals(["verified", "mismatch", "unavailable"])

/** A file as it was read back from disk after writing: what the instance's receipt reports. */
export const Readback = Schema.Struct({
  path: Schema.String,
  /** SHA-256 of the bytes read, lowercase hex. */
  digest: Schema.String,
  bytes: Schema.Number,
  executable: Schema.Boolean,
  content: Check,
  mode: Check,
})
export type Readback = typeof Readback.Type

/**
 * `written` with every file read back; `unsupported` when the service has no config dir of its own (nothing is
 * written there); `missing` when the skill is not one the plugin wrote for the instance applied; `invalid` when the
 * files are not a plan the bridge would install (no `SKILL.md`, a path leaving the directory, a duplicate, a link).
 */
export const Materialized = Schema.Struct({
  outcome: Schema.Literals(["written", "unsupported", "missing", "invalid"]),
  files: Schema.Array(Readback),
})
export type Materialized = typeof Materialized.Type

/** A runtime file a receipt recorded. */
export const Recorded = Schema.Struct({
  path: Schema.String,
  digest: Schema.String,
  bytes: Schema.Number,
  executable: Schema.Boolean,
})
export type Recorded = typeof Recorded.Type

/** Whether the files a receipt recorded for a skill are still on disk as written. */
export const Inspect = Schema.Struct({
  instance: Instance,
  skill: Schema.String,
  files: Schema.Array(Recorded),
})
export type Inspect = typeof Inspect.Type

export const Inspected = Schema.Struct({ intact: Schema.Boolean })

/** Asks for what the service counted for the instance applied. */
export const UsageOf = Schema.Struct({ instance: Instance })
export type UsageOf = typeof UsageOf.Type

/**
 * What the service counted since the instance was applied, the totals of the bridge proxy's heartbeat: `forwarded`
 * calls to the instance's gateway, `tokens_in` (every prompt token: uncached, cache reads and writes) and `tokens_out`
 * (output and reasoning) of their steps, and `last_activity` (ms since the epoch) of the last call the gateway
 * answered with success. All zero, without `last_activity`, for any other instance.
 */
export const Usage = Schema.Struct({
  forwarded: Schema.Number,
  tokens_in: Schema.Number,
  tokens_out: Schema.Number,
  last_activity: Schema.optional(Schema.Number),
})
export type Usage = typeof Usage.Type
