import { Schema } from "effect"

// Wire shapes of the systemprompt 0.76 endpoints the client uses, as observed on the local instances (PROTOCOL.md).
// Decoding ignores unknown keys, so fields the instance adds later never break the client; only the fields DynWork
// reads are required.

const Strings = Schema.Array(Schema.String)

export const ErrorEnvelope = Schema.Struct({
  code: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  error_key: Schema.optional(Schema.String),
})

export const Discovery = Schema.Struct({
  contract: Schema.String,
  device_link_path: Schema.String,
  identity_path: Schema.optional(Schema.String),
  branding: Schema.optional(
    Schema.Struct({
      display_name: Schema.optional(Schema.String),
      logo_url: Schema.optional(Schema.String),
      sign_in_hint: Schema.optional(Schema.String),
      docs_url: Schema.optional(Schema.String),
      contact_email: Schema.optional(Schema.String),
    }),
  ),
  enabled_hosts: Schema.optional(Strings),
})

export const Capabilities = Schema.Struct({ modes: Strings })

export const Health = Schema.Struct({ version: Schema.optional(Schema.String) })

export const SessionPat = Schema.Struct({ pat: Schema.String.check(Schema.isNonEmpty()) })

export const PatSession = Schema.Struct({
  token: Schema.String.check(Schema.isNonEmpty()),
  ttl: Schema.Number.check(Schema.isGreaterThan(0)),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})

export const PublicKey = Schema.Struct({ pubkey: Schema.String })

export const Envelope = Schema.Struct({ payload: Schema.String, signature: Schema.String })

const Selection = Schema.Struct({ include: Schema.optional(Strings), source: Schema.optional(Schema.String) })

const Rule = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  instructions: Schema.optional(Schema.String),
  sha256: Schema.optional(Schema.String),
  hosts: Schema.optional(Strings),
  plugins: Schema.optional(Strings),
  tags: Schema.optional(Strings),
})

const Skill = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  // Inline body (schema 1); schema 2 points at a plugin file in `source` instead
  instructions: Schema.optional(Schema.String),
  source: Schema.optional(
    Schema.Struct({ plugin: Schema.optional(Schema.String), path: Schema.optional(Schema.String) }),
  ),
  sha256: Schema.optional(Schema.String),
  hosts: Schema.optional(Strings),
  plugins: Schema.optional(Strings),
  tags: Schema.optional(Strings),
  frontmatter: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

const Agent = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  display_name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
  provider: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  system_prompt: Schema.optional(Schema.String),
  mcp_servers: Schema.optional(Selection),
  skills: Schema.optional(Selection),
  tags: Schema.optional(Strings),
  version: Schema.optional(Schema.String),
})

const McpServer = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  url: Schema.String,
  transport: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  oauth: Schema.optional(Schema.Boolean),
  tool_policy: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})

const Plugin = Schema.Struct({
  id: Schema.String,
  version: Schema.optional(Schema.String),
  sha256: Schema.optional(Schema.String),
  files: Schema.optional(
    Schema.Array(Schema.Struct({ path: Schema.String, sha256: Schema.String, size: Schema.optional(Schema.Number) })),
  ),
})

const Marketplace = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  plugin_ids: Schema.optional(Strings),
  opencode: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

export const Manifest = Schema.Struct({
  min_schema_version: Schema.Number,
  min_bridge_version: Schema.optional(Schema.String),
  manifest_version: Schema.optional(Schema.String),
  issued_at: Schema.optional(Schema.String),
  not_before: Schema.optional(Schema.String),
  user_id: Schema.String,
  tenant_id: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.optional(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      name: Schema.optional(Schema.String),
      email: Schema.optional(Schema.String),
      display_name: Schema.optional(Schema.String),
      roles: Schema.optional(Strings),
    }),
  ),
  rules: Schema.Array(Rule),
  skills: Schema.Array(Skill),
  agents: Schema.Array(Agent),
  managed_mcp_servers: Schema.Array(McpServer),
  plugins: Schema.Array(Plugin),
  marketplaces: Schema.optional(Schema.Array(Marketplace)),
  enabled_hosts: Schema.optional(Strings),
  revocations: Schema.optional(Strings),
  branding: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  desktop_policy: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  bridge_versions: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})
export type Manifest = typeof Manifest.Type

export const Profile = Schema.Struct({
  inference_gateway_base_url: Schema.optional(Schema.String),
  auth_scheme: Schema.optional(Schema.String),
  models: Strings,
  default_model: Schema.optional(Schema.NullOr(Schema.String)),
  organization_uuid: Schema.optional(Schema.NullOr(Schema.String)),
  providers: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        display_name: Schema.optional(Schema.String),
        configured: Schema.optional(Schema.Boolean),
        models: Schema.optional(Strings),
      }),
    ),
  ),
  model_limits: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        context_window: Schema.optional(Schema.Number),
        max_output_tokens: Schema.optional(Schema.Number),
      }),
    ),
  ),
})
export type Profile = typeof Profile.Type

export const Models = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      display_name: Schema.optional(Schema.String),
      max_input_tokens: Schema.optional(Schema.Number),
      max_tokens: Schema.optional(Schema.Number),
    }),
  ),
})

export const Whoami = Schema.Struct({
  user_id: Schema.String,
  email: Schema.optional(Schema.String),
  display_name: Schema.optional(Schema.String),
  roles: Schema.optional(Strings),
})
export type Whoami = typeof Whoami.Type
