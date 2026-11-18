import { Schema } from "effect"
import { Ipc } from "@opencode/plugin/gui"
import { Capabilities } from "./capabilities"

// The Drive contract: what the Drive service in main answers a window, for the active account's Drive in Governance.
// All times are epoch milliseconds. The shapes are DynWork's own, read from the instance's answers by the backend
// (`./backend`), so a window never sees the wire.

export const Folder = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** Absent at the root. */
  parent: Schema.optional(Schema.String),
  /** The owner's user id. */
  owner: Schema.String,
  /** The owner is the signed-in user. */
  mine: Schema.Boolean,
  /** The folder's agent edit policy, as the instance names it. */
  policy: Schema.optional(Schema.String),
  created: Schema.Number,
  updated: Schema.Number,
})
export type Folder = typeof Folder.Type

export const Document = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** `html`, `markdown`, `docx`, `xlsx`, `pptx`, `pdf`, ... as the instance classifies the file. */
  format: Schema.String,
  mime: Schema.String,
  /** Absent at the root. */
  folder: Schema.optional(Schema.String),
  owner: Schema.String,
  mine: Schema.Boolean,
  /** The user's own access (`own`, `edit`, `comment`, `view`); only listings carry it. */
  access: Schema.optional(Schema.String),
  /** Bytes; only listings carry it. */
  size: Schema.optional(Schema.Number),
  /** The head revision. */
  revision: Schema.String,
  template: Schema.optional(Schema.String),
  created: Schema.Number,
  updated: Schema.Number,
})
export type Document = typeof Document.Type

export const Revision = Schema.Struct({
  id: Schema.String,
  document: Schema.String,
  parent: Schema.optional(Schema.String),
  sha256: Schema.String,
  /** The user the revision belongs to. */
  author: Schema.String,
  /** `agent` for every write DynWork makes; `human` for one made in Governance's own pages. */
  actor: Schema.String,
  origin: Schema.String,
  /** "<conversation> by DynWork", "<user> by DynWork", or what a person wrote. */
  message: Schema.optional(Schema.String),
  created: Schema.Number,
})
export type Revision = typeof Revision.Type

export const Detail = Schema.Struct({
  document: Document,
  head: Revision,
  access: Schema.String,
  /** The folder path, as the instance spells it. */
  path: Schema.optional(Schema.String),
})
export type Detail = typeof Detail.Type

/** One page of a listing. Pass `next` back as `cursor` for the following page; absent, there is none. */
export const Listing = Schema.Struct({
  folders: Schema.Array(Folder),
  documents: Schema.Array(Document),
  next: Schema.optional(Schema.String),
})
export type Listing = typeof Listing.Type

export const Scope = Schema.Literals(["mine", "shared", "recent", "folder"])
export type Scope = typeof Scope.Type

export const Query = Schema.Struct({
  /** `mine` when absent. */
  scope: Schema.optional(Scope),
  /** For `folder`: the folder whose documents and sub-folders to list. */
  folder: Schema.optional(Schema.String),
  /** Matches document names. */
  query: Schema.optional(Schema.String),
  sort: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
  cursor: Schema.optional(Schema.String),
})
export type Query = typeof Query.Type

/** An HTML view of a document and the Content-Security-Policy the instance served it with, which a viewer applies. */
export const Page = Schema.Struct({
  html: Schema.String,
  csp: Schema.optional(Schema.String),
  revision: Schema.optional(Schema.String),
  sha256: Schema.optional(Schema.String),
})
export type Page = typeof Page.Type

export const Pdf = Schema.Struct({
  bytes: Schema.Uint8Array,
  revision: Schema.optional(Schema.String),
  sha256: Schema.optional(Schema.String),
})
export type Pdf = typeof Pdf.Type

/** The nodes a comment anchors to, with their text, at `revision`. */
export const Outline = Schema.Struct({
  revision: Schema.String,
  format: Schema.String,
  nodes: Schema.Array(Schema.Struct({ id: Schema.String, hash: Schema.String, text: Schema.String })),
})
export type Outline = typeof Outline.Type

export const Proposal = Schema.Struct({
  id: Schema.String,
  document: Schema.String,
  base: Schema.String,
  /** The revision the proposal would land. */
  proposed: Schema.String,
  proposer: Schema.String,
  actor: Schema.String,
  /** `open` until a person reviews it in Governance. */
  status: Schema.String,
  message: Schema.optional(Schema.String),
  reviewer: Schema.optional(Schema.String),
  reviewed: Schema.optional(Schema.Number),
  note: Schema.optional(Schema.String),
  landed: Schema.optional(Schema.String),
  created: Schema.Number,
})
export type Proposal = typeof Proposal.Type

/**
 * What a comment points at. The instance anchors to a node and an optional quote inside it; a cell `range` and a point
 * on a PDF `page` have no node yet (P10) and are refused while `rangeComments` and `pdfComments` are off.
 */
export const Anchor = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("node"), node: Schema.String, find: Schema.optional(Schema.String) }),
  Schema.Struct({
    kind: Schema.Literal("range"),
    sheet: Schema.Number,
    from: Schema.String,
    to: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("page"), page: Schema.Number, x: Schema.Number, y: Schema.Number }),
])
export type Anchor = typeof Anchor.Type

export const Comment = Schema.Struct({
  id: Schema.String,
  /** A reply carries its thread's anchor. */
  anchor: Schema.optional(Schema.Struct({ node: Schema.String, find: Schema.optional(Schema.String) })),
  author: Schema.String,
  body: Schema.String,
  /** The comment a reply answers. */
  parent: Schema.optional(Schema.String),
  created: Schema.Number,
  resolved: Schema.optional(Schema.Number),
  resolver: Schema.optional(Schema.String),
})
export type Comment = typeof Comment.Type

const Grant = Schema.Struct({
  subject: Schema.String,
  value: Schema.String,
  name: Schema.optional(Schema.String),
  level: Schema.String,
  /** The folder a grant is inherited from. */
  from: Schema.optional(Schema.Struct({ folder: Schema.String, name: Schema.String })),
})

/** Who can see a document. Granting is the person's: DynWork reads it and sends the user to Governance to change it. */
export const Access = Schema.Struct({
  owner: Schema.String,
  access: Schema.String,
  grants: Schema.Array(Grant),
  inherited: Schema.Array(Grant),
})
export type Access = typeof Access.Type

/** What DynWork, an attended agent, may do on a document or folder: `none`, `read`, `suggest` or `edit`. */
export const AgentCap = Schema.Struct({
  cap: Schema.String,
  policy: Schema.String,
  reason: Schema.optional(Schema.String),
  /** The cap an unattended agent (a scheduled task) gets. */
  unattended: Schema.String,
})
export type AgentCap = typeof AgentCap.Type

export const Created = Schema.Struct({ document: Document, revision: Revision })
export type Created = typeof Created.Type

/** `landed` wrote a revision (merged onto the head when the base was behind); `proposed` left it for a person. */
export const Edited = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("landed"), revision: Revision, merged: Schema.optional(Schema.String) }),
  Schema.Struct({ kind: Schema.Literal("proposed"), proposal: Proposal, revision: Revision }),
])
export type Edited = typeof Edited.Type

/** The conversation a write comes from: its session id and its title. Absent, the user acted directly. */
export const Conversation = Schema.Struct({ id: Schema.String, name: Schema.String })
export type Conversation = typeof Conversation.Type

/** What a conversation did to a document. */
export const Act = Schema.Literals(["created", "edited", "proposed", "attached", "read"])
export type Act = typeof Act.Type

/**
 * One entry of the conversation ↔ document index: what the Drive cannot answer yet (P3, P5), kept per account on this
 * computer. `via` is how the write reached the Drive: DynWork's REST calls or the agent's `documents` MCP.
 */
export const Link = Schema.Struct({
  conversation: Schema.String,
  document: Schema.String,
  act: Act,
  revision: Schema.optional(Schema.String),
  via: Schema.Literals(["rest", "mcp", "server"]),
  at: Schema.Number,
})
export type Link = typeof Link.Type

/**
 * A failure, as data: an Ipc rejection reaches the window as plain text, so nothing is thrown.
 * - `signed-out`: no active signed-in account, or the instance refused it. `unreachable`: no answer, retry later.
 * - `not-found`: no such document, folder, revision or comment, or one hidden from the user.
 * - `forbidden`: the user lacks access. `person`: the instance keeps the action to a person (P1): do it in Governance.
 * - `suggest`: agents may only suggest there; write with `mode: "propose"`.
 * - `conflict`: the document moved on (`head` is the revision it lost to), or a comment's node is gone.
 * - `unsupported`: the instance or a capability that is off does not allow it. `invalid`: the input is wrong.
 * - `failed`: anything else.
 */
export const Failure = Schema.Struct({
  code: Schema.Literals([
    "signed-out",
    "unreachable",
    "not-found",
    "forbidden",
    "person",
    "suggest",
    "conflict",
    "unsupported",
    "invalid",
    "failed",
  ]),
  message: Schema.String,
  retryable: Schema.Boolean,
  head: Schema.optional(Schema.String),
})
export type Failure = typeof Failure.Type

export function isFailure(value: unknown): value is Failure {
  return typeof value === "object" && value !== null && "code" in value && "message" in value && "retryable" in value
}

/**
 * What main pushes to every window: the active account's Drive as last read. `none` without an active signed-in
 * account; `loading` from an account switch until the first read. A read that fails keeps the last folders and
 * documents and says why in `status`.
 */
export const State = Schema.Struct({
  account: Schema.optional(Schema.String),
  status: Schema.Literals(["none", "loading", "ready", "signed-out", "unreachable"]),
  capabilities: Capabilities,
  folders: Schema.Array(Folder),
  /** The `recent` listing's first page: what changed lately, polled for changes. */
  documents: Schema.Array(Document),
  /** The conversation ↔ document index of the account. */
  links: Schema.Array(Link),
  /** When the Drive was last read. */
  read: Schema.optional(Schema.Number),
})
export type State = typeof State.Type

const Outcome = <S extends Schema.Top>(success: S) => Schema.Union([Failure, success])
const Done = Schema.UndefinedOr(Failure)
const OnDocument = { id: Schema.String }
const From = { conversation: Schema.optional(Conversation) }

/**
 * The active account's Drive, held by the main process, where the account's credential stays. Every method answers a
 * `Failure` instead of rejecting. Writes carry "<conversation> by DynWork" or "<user> by DynWork" and, from a
 * conversation, its `x-context-id` (D2).
 */
export const Drive = Ipc.define({
  id: "dynwork.drive",
  state: State,
  methods: {
    /** Reads the Drive again and pushes `state`. */
    refresh: {},
    /** Holds until the window aborts the call; while one is held, the Drive is polled every 20 s instead of 5 min. */
    watch: {},
    list: { input: Query, output: Outcome(Listing) },
    folders: { output: Outcome(Schema.Array(Folder)) },
    get: { input: Schema.Struct(OnDocument), output: Outcome(Detail) },
    rendered: {
      input: Schema.Struct({ ...OnDocument, revision: Schema.optional(Schema.String) }),
      output: Outcome(Page),
    },
    preview: {
      input: Schema.Struct({ ...OnDocument, revision: Schema.optional(Schema.String) }),
      output: Outcome(Page),
    },
    pdf: { input: Schema.Struct(OnDocument), output: Outcome(Pdf) },
    outline: { input: Schema.Struct(OnDocument), output: Outcome(Outline) },
    revisions: { input: Schema.Struct(OnDocument), output: Outcome(Schema.Array(Revision)) },
    proposals: { input: Schema.Struct(OnDocument), output: Outcome(Schema.Array(Proposal)) },
    comments: { input: Schema.Struct(OnDocument), output: Outcome(Schema.Array(Comment)) },
    access: { input: Schema.Struct(OnDocument), output: Outcome(Access) },
    agentCap: {
      input: Schema.Struct({ kind: Schema.Literals(["document", "folder"]), id: Schema.String }),
      output: Outcome(AgentCap),
    },
    createFolder: {
      input: Schema.Struct({ name: Schema.String, parent: Schema.optional(Schema.String) }),
      output: Outcome(Folder),
    },
    /** Creates a document from a file; one generated in a conversation names it in `conversation`. */
    upload: {
      input: Schema.Struct({
        name: Schema.String,
        bytes: Schema.Uint8Array,
        mime: Schema.optional(Schema.String),
        folder: Schema.optional(Schema.String),
        ...From,
      }),
      output: Outcome(Created),
    },
    /** Creates a document from one of the instance's templates (`dynapps-word`, ...), which no route lists (C9). */
    create: {
      input: Schema.Struct({
        template: Schema.String,
        name: Schema.String,
        folder: Schema.optional(Schema.String),
        ...From,
      }),
      output: Outcome(Created),
    },
    edit: {
      input: Schema.Struct({
        ...OnDocument,
        ops: Schema.Array(Schema.Record(Schema.String, Schema.Json)),
        base: Schema.optional(Schema.String),
        mode: Schema.optional(Schema.Literals(["land", "propose"])),
        ...From,
      }),
      output: Outcome(Edited),
    },
    comment: {
      input: Schema.Struct({ ...OnDocument, body: Schema.String, anchor: Anchor, ...From }),
      output: Outcome(Comment),
    },
    reply: {
      input: Schema.Struct({ ...OnDocument, parent: Schema.String, body: Schema.String, ...From }),
      output: Outcome(Comment),
    },
    /** There is no reopen: the instance has no route for it (G12). */
    resolve: { input: Schema.Struct({ ...OnDocument, comment: Schema.String }), output: Outcome(Comment) },
    /**
     * Records in the index what a conversation did to a document, for what the Drive does not record itself: the
     * agent's MCP writes (phase 07) and a document attached to a chat.
     */
    link: {
      input: Schema.Struct({
        conversation: Schema.String,
        document: Schema.String,
        act: Act,
        revision: Schema.optional(Schema.String),
        via: Schema.Literals(["rest", "mcp"]),
      }),
      output: Done,
    },
    /** What a conversation did to which documents, newest first. */
    documentsOf: { input: Schema.Struct({ conversation: Schema.String }), output: Outcome(Schema.Array(Link)) },
  },
})
