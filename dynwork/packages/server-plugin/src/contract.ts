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
})

const Agent = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  display_name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
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

export const Manifest = Schema.Struct({
  enabled_hosts: Schema.optional(Strings),
  rules: Schema.Array(Rule),
  skills: Schema.Array(Skill),
  agents: Schema.Array(Agent),
  managed_mcp_servers: Schema.Array(McpServer),
  marketplaces: Schema.optional(Schema.Array(Marketplace)),
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

export const Apply = Schema.Struct({
  instance: Instance,
  manifest: Manifest,
  // A token68 (RFC 7235) value: it goes into an Authorization header, so no whitespace or line breaks.
  jwt: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._~+/-]+=*$/), Schema.isMaxLength(16_384)),
  /** Epoch milliseconds. */
  expiresAt: Schema.Number.check(Schema.isGreaterThan(0)),
})
export type Apply = typeof Apply.Type

/** What the service now holds for the instance. */
export const Applied = Schema.Struct({
  skills: Schema.Number,
  agents: Schema.Number,
  mcp: Schema.Number,
  rules: Schema.Number,
})
export type Applied = typeof Applied.Type

export const Empty = Schema.Struct({})
