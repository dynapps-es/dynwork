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

export const Publication = Schema.Struct({
  publication_id: Schema.String,
  resource_id: Schema.String,
  revision_id: Schema.String,
  generation: Schema.Int,
  bundle_digest: Schema.String,
})
export type Publication = typeof Publication.Type

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
  // The signed publication whose bundle carries the skill's runtime files (`references/*`, `config.yaml`)
  publication: Schema.optional(Publication),
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
  /** Which hook families the plugin owns; DynWork's server plugin reports governance events for `governance`. */
  hooks: Schema.optional(
    Schema.Struct({
      governance: Schema.optional(Schema.Boolean),
      judge: Schema.optional(Schema.Boolean),
      comms: Schema.optional(Schema.Boolean),
    }),
  ),
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
  host_model_protocols: Schema.optional(Schema.Record(Schema.String, Strings)),
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
        // The client kinds the gateway serves the provider's models to: `claude` (`/v1/messages`), `openai`.
        clients: Schema.optional(Strings),
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

export type Catalog = (typeof Models.Type)["data"]

export const Whoami = Schema.Struct({
  user_id: Schema.String,
  email: Schema.optional(Schema.String),
  display_name: Schema.optional(Schema.String),
  roles: Schema.optional(Strings),
})
export type Whoami = typeof Whoami.Type

// The Drive: wire shapes of `/api/v1/documents`, `/api/v1/document-folders` and `/api/v1/uploads` as sp-local 0.83 and
// production answer them (`docs/06-live-checks.md` of the Drive plan). A key the instance omits and one it sends as
// `null` mean the same, so both are accepted; fields DynWork does not read are left out.

const Nullable = <S extends Schema.Top>(schema: S) => Schema.optional(Schema.NullOr(schema))

export const DriveDocument = Schema.Struct({
  id: Schema.String,
  // null for a document at the root
  folder_id: Nullable(Schema.String),
  name: Schema.String,
  format: Schema.String,
  mime_type: Schema.String,
  head_revision_id: Schema.String,
  template_id: Nullable(Schema.String),
  owner_user_id: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
  // Only the listing carries these two
  size_bytes: Schema.optional(Schema.Number),
  my_access: Schema.optional(Schema.String),
})
export type DriveDocument = typeof DriveDocument.Type

export const DriveFolder = Schema.Struct({
  id: Schema.String,
  parent_id: Nullable(Schema.String),
  name: Schema.String,
  owner_user_id: Schema.String,
  agent_edit_policy: Schema.optional(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
})
export type DriveFolder = typeof DriveFolder.Type

export const DriveListing = Schema.Struct({
  folders: Schema.Array(DriveFolder),
  documents: Schema.Array(DriveDocument),
  // Opaque; pass it back as `cursor` for the next page
  next_cursor: Nullable(Schema.String),
})
export type DriveListing = typeof DriveListing.Type

export const DriveRevision = Schema.Struct({
  id: Schema.String,
  document_id: Schema.String,
  parent_revision_id: Nullable(Schema.String),
  content_sha256: Schema.String,
  author_user_id: Schema.String,
  // `agent` for every write DynWork makes with its JWT
  actor_kind: Schema.String,
  origin_kind: Schema.String,
  message: Nullable(Schema.String),
  created_at: Schema.String,
})
export type DriveRevision = typeof DriveRevision.Type

export const DriveDetail = Schema.Struct({
  document: DriveDocument,
  head: DriveRevision,
  my_access: Schema.String,
  folder_path: Nullable(Schema.String),
})
export type DriveDetail = typeof DriveDetail.Type

export const DriveCreated = Schema.Struct({ document: DriveDocument, revision: DriveRevision })
export type DriveCreated = typeof DriveCreated.Type

export const DriveRevisions = Schema.Struct({ revisions: Schema.Array(DriveRevision) })

export const DriveProposal = Schema.Struct({
  id: Schema.String,
  document_id: Schema.String,
  base_revision_id: Schema.String,
  proposed_revision_id: Schema.String,
  proposer: Schema.String,
  actor_kind: Schema.String,
  // `open` until a person reviews it
  status: Schema.String,
  message: Nullable(Schema.String),
  reviewer: Nullable(Schema.String),
  reviewed_at: Nullable(Schema.String),
  note: Nullable(Schema.String),
  landed_revision_id: Nullable(Schema.String),
  created_at: Schema.String,
})
export type DriveProposal = typeof DriveProposal.Type

export const DriveProposals = Schema.Struct({ proposals: Schema.Array(DriveProposal) })

// `mode: land` answers 200 with the new revision (`merged_from` when the base was behind and the edit merged on the
// head); `mode: propose` answers 201 with the proposal and the revision it points at.
export const DriveLanded = Schema.Struct({ revision: DriveRevision, merged_from: Nullable(Schema.String) })
export const DriveProposed = Schema.Struct({
  proposal: DriveProposal,
  revision: DriveRevision,
  superseded: Schema.optional(Schema.Array(Schema.String)),
})

// The node id and the quoted text a comment is pinned to; a range anchor is not offered by 0.83 (the server keeps the node)
export const DriveAnchor = Schema.Struct({ node: Schema.String, find: Schema.optional(Schema.String) })
export type DriveAnchor = typeof DriveAnchor.Type

// `GET /{id}/read?view=outline`: one line per node, `<node id>:<hash8>| <text>`
export const DriveOutline = Schema.Struct({
  revision_id: Schema.String,
  format: Schema.String,
  lines: Schema.Array(Schema.String),
})

export const DriveComment = Schema.Struct({
  id: Schema.String,
  anchor: Schema.optional(DriveAnchor),
  author_user_id: Schema.String,
  body: Schema.String,
  parent_id: Nullable(Schema.String),
  created_at: Schema.String,
  resolved_at: Nullable(Schema.String),
  resolved_by: Nullable(Schema.String),
})
export type DriveComment = typeof DriveComment.Type

export const DriveComments = Schema.Struct({ comments: Schema.Array(DriveComment) })

const DriveGrant = Schema.Struct({
  grant_id: Schema.String,
  subject_kind: Schema.String,
  subject_value: Schema.String,
  display_name: Nullable(Schema.String),
  level: Schema.String,
  granted_by: Schema.String,
  granted_at: Schema.String,
  folder_id: Nullable(Schema.String),
  inherited_from: Schema.optional(Schema.Struct({ folder_id: Schema.String, name: Schema.String })),
})

// Who can see a document and at which level (the read side of sharing; granting is the person's)
export const DriveAccess = Schema.Struct({
  document_id: Schema.String,
  owner: Schema.String,
  my_access: Schema.String,
  grants: Schema.Array(DriveGrant),
  // 0.83 leaves it out when no folder above grants anything (`skip_serializing_if = "Vec::is_empty"`)
  inherited: Schema.optional(Schema.Array(DriveGrant)),
  agent_cap: Schema.optional(
    Schema.Struct({ cap: Schema.String, policy_cap: Schema.String, reason: Nullable(Schema.String) }),
  ),
})
export type DriveAccess = typeof DriveAccess.Type

// A grant the instance made or changed (`POST /documents/{id}/grants`): its id is what revoking it takes
export const DriveGrantMade = Schema.Struct({ id: Schema.String, subject_kind: Schema.String, subject_value: Schema.String })

const CapSource = Schema.Struct({ kind: Schema.String, policy: Schema.optional(Schema.String) })
const CapReading = Schema.Struct({
  agent_cap: Schema.String,
  policy_cap: Schema.String,
  source: CapSource,
  reason: Nullable(Schema.String),
})

// What an agent may do on a document or folder: `none`, `read`, `suggest` or `edit`. DynWork signs in as an attended
// agent, so `attended.agent_cap` is the one that applies to it.
export const DriveAgentCap = Schema.Struct({
  target_kind: Schema.String,
  target_id: Schema.String,
  override: Nullable(Schema.String),
  agent_cap: Schema.String,
  policy_cap: Schema.String,
  source: CapSource,
  reason: Nullable(Schema.String),
  attended: CapReading,
  unattended: CapReading,
})
export type DriveAgentCap = typeof DriveAgentCap.Type

export const DriveUpload = Schema.Struct({
  upload_id: Schema.String,
  name: Schema.String,
  mime: Schema.String,
  size: Schema.Number,
  sha256: Schema.String,
  part_size: Schema.Number,
  part_count: Schema.Number,
  // `open` until completed
  status: Schema.String,
  received_bytes: Schema.Number,
  // Parts are numbered from 1
  received_parts: Schema.Array(Schema.Number),
  missing_parts: Schema.Array(Schema.Number),
  blob_ref: Nullable(Schema.String),
  expires_at: Schema.String,
})
export type DriveUpload = typeof DriveUpload.Type

export const DriveUploadPart = Schema.Struct({
  part_number: Schema.Number,
  size_bytes: Schema.Number,
  sha256: Schema.String,
})

export const DriveBlob = Schema.Struct({
  upload_id: Schema.String,
  blob_ref: Schema.String,
  size_bytes: Schema.Number,
  mime: Schema.String,
  deduplicated: Schema.optional(Schema.Boolean),
})
export type DriveBlob = typeof DriveBlob.Type

// A conversation registered in the instance (`/api/v1/core/contexts`), inside the platform's `data` envelope, as
// sp-local 0.83 answers it. Its id is what a write's `x-context-id` names.
export const DriveContext = Schema.Struct({
  data: Schema.Struct({ context_id: Schema.String, name: Schema.String }),
})

// The people of `GET /api/v1/documents/people` (0.84, the `documents_people` tool's fields): `access` only when the
// search named a document.
export const DrivePeople = Schema.Struct({
  people: Schema.Array(
    Schema.Struct({
      user_id: Schema.String,
      name: Nullable(Schema.String),
      email: Nullable(Schema.String),
      access: Nullable(Schema.String),
    }),
  ),
})
export type DrivePerson = (typeof DrivePeople.Type)["people"][number]

// The Drive's error body: the platform envelope, plus the head the instance reports on a `409`
export const DriveErrorBody = Schema.Struct({
  message: Schema.optional(Schema.String),
  error_key: Schema.optional(Schema.String),
  head_revision_id: Schema.optional(Schema.String),
  head_content_sha256: Schema.optional(Schema.String),
  base_revision_id: Schema.optional(Schema.String),
  detail: Schema.optional(
    Schema.Struct({
      code: Schema.optional(Schema.String),
      head_revision_id: Schema.optional(Schema.String),
      head_content_sha256: Schema.optional(Schema.String),
      base_revision_id: Schema.optional(Schema.String),
    }),
  ),
})
