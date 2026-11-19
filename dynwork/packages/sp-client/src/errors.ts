import { Schema } from "effect"

// Every failure the client reports. None of them carries a credential: requests are named by method and path, and the
// instance's own error envelope (code, message, error key) is the only server text kept.

const Request = {
  // `POST /v1/auth/bridge/pat`, never a full URL with a query
  endpoint: Schema.String,
  message: Schema.String,
}

// The credential was refused: a PAT revoked or unknown, a JWT expired or rejected, an exchange code invalid, expired or
// already used. With a JWT, mint a new one from the PAT once (`SpClient.withJwt`) before treating it as signed out.
export class Unauthorized extends Schema.TaggedError<Unauthorized>("SpClient.Unauthorized")("Unauthorized", {
  ...Request,
  errorKey: Schema.optional(Schema.String),
}) {}

export class RateLimited extends Schema.TaggedError<RateLimited>("SpClient.RateLimited")("RateLimited", {
  ...Request,
  // From `Retry-After`, absent when the instance sent none or an unreadable one
  retryAfterMs: Schema.optional(Schema.Number),
}) {}

// No answer (connection refused, DNS, timeout) or a 5xx from the instance or its proxy.
export class Unreachable extends Schema.TaggedError<Unreachable>("SpClient.Unreachable")("Unreachable", {
  ...Request,
  status: Schema.optional(Schema.Number),
}) {}

// The manifest signature does not verify against the pinned key, and the instance still serves that same key.
export class SignatureInvalid extends Schema.TaggedError<SignatureInvalid>("SpClient.SignatureInvalid")(
  "SignatureInvalid",
  Request,
) {}

// The instance now serves a different manifest key than the one pinned at sign-in (trust on first use).
export class KeyChanged extends Schema.TaggedError<KeyChanged>("SpClient.KeyChanged")("KeyChanged", {
  ...Request,
  pinned: Schema.String,
  served: Schema.String,
}) {}

// The instance speaks a contract or schema this client does not.
export class Incompatible extends Schema.TaggedError<Incompatible>("SpClient.Incompatible")("Incompatible", {
  ...Request,
  supported: Schema.String,
  found: Schema.String,
}) {}

// An answer that is not what the protocol says: an unexpected status, a body that does not decode (`path` names the
// field), or a value the client refuses to use.
export class Protocol extends Schema.TaggedError<Protocol>("SpClient.Protocol")("Protocol", {
  ...Request,
  status: Schema.optional(Schema.Number),
  path: Schema.optional(Schema.String),
  errorKey: Schema.optional(Schema.String),
}) {}

// The Drive's refusals, answered as data. They carry the instance's `error_key` and nothing else it said.

// The document or folder does not exist, was deleted, or is hidden from this user.
export class NotFound extends Schema.TaggedError<NotFound>("SpClient.NotFound")("NotFound", {
  ...Request,
  errorKey: Schema.optional(Schema.String),
}) {}

// The user has no access to what was asked: a share they lack, a lock held by someone else.
export class Forbidden extends Schema.TaggedError<Forbidden>("SpClient.Forbidden")("Forbidden", {
  ...Request,
  errorKey: Schema.optional(Schema.String),
}) {}

// The instance refused DynWork because it acts as an agent. `capability` is what the action needed and the agent did
// not have: `edit` when the folder or document caps agents at `suggest` (write with `mode: propose` instead), `person`
// when the action is reserved to a person (sharing, replacing content, restoring). It is absent for an `agent_*` key
// this client does not know.
export class AgentRefused extends Schema.TaggedError<AgentRefused>("SpClient.AgentRefused")("AgentRefused", {
  ...Request,
  errorKey: Schema.String,
  capability: Schema.optional(Schema.Literals(["edit", "person"])),
}) {}

// `409`: the document moved on or the request clashes with what is there (an anchor whose node is gone, an upload with
// parts missing). `headRevisionId`, `headContentSha256` and `baseRevisionId` come from the body when the instance
// reports the head the write lost to.
export class Conflict extends Schema.TaggedError<Conflict>("SpClient.Conflict")("Conflict", {
  ...Request,
  errorKey: Schema.optional(Schema.String),
  headRevisionId: Schema.optional(Schema.String),
  headContentSha256: Schema.optional(Schema.String),
  baseRevisionId: Schema.optional(Schema.String),
}) {}

export type SpError =
  | Unauthorized
  | RateLimited
  | Unreachable
  | SignatureInvalid
  | KeyChanged
  | Incompatible
  | Protocol
  | NotFound
  | Forbidden
  | AgentRefused
  | Conflict
