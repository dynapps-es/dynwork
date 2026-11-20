export * as DriveBackend from "./backend"

import { Effect } from "effect"
import { SpClient, SpDrive } from "@dynwork/sp-client"
import { DynWorkAccounts } from "../accounts/accounts"
import { DynWorkPerson } from "../accounts/person"
import type { DriveCapabilities } from "./capabilities"
import { isFailure } from "./contract"
import { DriveMentions } from "./mentions"
import type {
  Access,
  AgentCap,
  Anchor,
  Comment,
  Created,
  Detail,
  Document,
  Edited,
  Failure,
  Folder,
  Listing,
  Outline,
  Page,
  Pdf,
  Person,
  Proposal,
  Query,
  Content,
  Revision,
} from "./contract"

/** How many folders `folders()` reads before it stops going down: a bound on one account's reads, not a limit of the Drive. */
const maxFolders = 1000

/** Where a write is attributed: the revision message and the conversation's `x-context-id`. */
export type Attribution = { readonly message?: string; readonly contextId?: string }

/**
 * One account's Drive: the instance's document store, or a fake. It lives in the main process, where the account's
 * credential never reaches a window. Every method answers a failure as data and never rejects.
 *
 * `test/drive/conformance.ts` is the suite every backend passes.
 */
export interface Backend {
  /**
   * What the instance says of itself in its discovery (`GET /api/v1`): whether it announces the Drive (0.84) and the
   * core's version. `DriveCapabilities.delivered` reads what it gives from this.
   */
  discovery(): Promise<Omit<DriveCapabilities.Instance, "people"> | Failure>
  list(query: Query): Promise<Listing | Failure>
  /** Every folder the user can see, flat: `parent` says where each sits. Read from the roots down (see `children`). */
  folders(): Promise<readonly Folder[] | Failure>
  /** The folders directly under `parent`, or the roots. One read: the instance lists a folder's own, not its whole tree. */
  children(parent?: string): Promise<readonly Folder[] | Failure>
  get(id: string): Promise<Detail | Failure>
  /** An HTML document as designed, scripts included where the instance allows them. */
  rendered(id: string, revision?: string): Promise<Page | Failure>
  /** A sanitised HTML view of any format. */
  preview(id: string, revision?: string): Promise<Page | Failure>
  /** A document's stored bytes. */
  content(id: string, revision?: string): Promise<Content | Failure>
  pdf(id: string, revision?: string): Promise<Pdf | Failure>
  outline(id: string): Promise<Outline | Failure>
  /** Newest first. */
  revisions(id: string): Promise<readonly Revision[] | Failure>
  proposals(id: string): Promise<readonly Proposal[] | Failure>
  comments(id: string): Promise<readonly Comment[] | Failure>
  access(id: string): Promise<Access | Failure>
  agentCap(target: { kind: "document" | "folder"; id: string }): Promise<AgentCap | Failure>
  createFolder(input: { name: string; parent?: string }): Promise<Folder | Failure>
  upload(
    input: Attribution & { name: string; bytes: Uint8Array; mime?: string; folder?: string },
  ): Promise<Created | Failure>
  /**
   * A document from a blob the instance already holds: the `blob_ref` the agent's `documents_upload` answered. The blob
   * keeps its scripts, which no other write of an HTML document does. Only the user who uploaded it may import it, and
   * a name taken in the folder answers `conflict`.
   */
  importBlob(input: Attribution & { blob: string; name: string; folder?: string }): Promise<Created | Failure>
  /** A document from one of the instance's templates; 0.84 keeps its message, 0.83 does not. */
  create(input: Attribution & { template: string; name: string; folder?: string }): Promise<Created | Failure>
  edit(
    id: string,
    input: Attribution & {
      ops: ReadonlyArray<Readonly<Record<string, unknown>>>
      base?: string
      mode?: "land" | "propose"
    },
  ): Promise<Edited | Failure>
  /**
   * `unsupported` for an anchor the instance does not take. With `agent`, the body mentions the user themself
   * (`DriveMentions.write`) and the instance is told to hand the mention to the user's agent.
   */
  comment(
    id: string,
    input: { body: string; anchor: Anchor; contextId?: string; agent?: boolean },
  ): Promise<Comment | Failure>
  reply(
    id: string,
    input: { body: string; parent: string; contextId?: string; agent?: boolean },
  ): Promise<Comment | Failure>
  resolve(id: string, comment: string): Promise<Comment | Failure>
  /** Opens a resolved comment again (0.84); an open one comes back as it is. */
  reopen(id: string, comment: string): Promise<Comment | Failure>
  /**
   * Registers a conversation under `name`, its title, and answers the id its writes carry as `x-context-id` (D20): the
   * instance's own, which it shows with the title and, from 0.84, is the only kind it accepts.
   */
  createContext(name: string): Promise<string | Failure>
  /** Gives a registered conversation its new title; `not-found` when the instance does not know the id. */
  renameContext(id: string, name: string): Promise<undefined | Failure>
  /** The people of `ids`, as the instance names them (0.84, `peopleByRest`); an id it does not know is left out. */
  people(ids: readonly string[]): Promise<readonly Person[] | Failure>
  /**
   * The active people whose name or email starts with `query`, at most `limit`, through the `documents` MCP server's
   * `documents_people` (0.83: its description says "or id", but 0.83.0 does not match ids).
   */
  findPeople(query: string, limit?: number): Promise<readonly Person[] | Failure>
  /**
   * The active people matching `query` word by word (name, email or id), at most `limit`, over REST
   * (`GET /documents/people?query=`, 0.84, `peopleByRest`): the directory search `findPeople` makes through the MCP.
   */
  searchPeople(query: string, limit?: number): Promise<readonly Person[] | Failure>
  /**
   * Gives a subject (`user` and a user id, or a role) `level` on a document, or changes the level it has (one grant per
   * subject), and answers who has access then. `person` when the instance's agent policy does not let DynWork share it.
   */
  share(id: string, input: { kind: string; value: string; level: string; until?: string }): Promise<Access | Failure>
  /** Takes one grant away, by its id, and answers who has access then. `person` as for `share`. */
  unshare(id: string, grant: string): Promise<Access | Failure>
  /**
   * The owner's actions (G01, 0.84), which the instance keeps from DynWork's agent (`person`) and lets the person's own
   * session do with a recent sign-in: takes every grant away (`revokeAll`), makes `to` the owner (`transfer`, the
   * previous owner keeps `edit`), and moves the document to the trash (`trash`).
   */
  revokeAll(id: string): Promise<Access | Failure>
  transfer(id: string, to: string): Promise<Document | Failure>
  trash(id: string): Promise<undefined | Failure>
  /** Makes an earlier revision the head again, as a new revision on the head: the person's (an agent meets a rule). */
  restore(id: string, revision: string): Promise<Revision | Failure>
  /** Accepts or rejects a proposal, with an optional note; answers it as it now stands. */
  review(id: string, proposal: string, input: { accept: boolean; note?: string }): Promise<Proposal | Failure>
  /**
   * The documents the conversation `contextId` wrote a revision or a comment on, newest first, as far as the user can
   * still see them: only where the instance lists by conversation (0.84 `scope=context`, `docsByContext`). A context
   * the instance does not hold for the user is `unknown-context`. The newest `byContextLimit`.
   */
  byContext?(contextId: string): Promise<readonly Document[] | Failure>
  /**
   * The bridge stream: the mentions of the user and, from 0.84, that the Drive changed, as the instance announces them
   * while it is open, until `signal` aborts. It keeps no history: what happened while it was closed is not delivered.
   */
  stream?(signal: AbortSignal): Promise<AsyncIterable<DriveMentions.Streamed> | Failure>
}

/** How many documents of one conversation the Drive lists for it (`byContext`): one page, the newest. */
export const byContextLimit = 100

/** A failure. It is retryable only when `unreachable`, the one code that clears up by itself. */
export function fail(code: Failure["code"], message: string, head?: string): Failure {
  return { code, message, retryable: code === "unreachable", ...(head === undefined ? {} : { head }) }
}

export interface Remote {
  /** The instance base URL. */
  url: string
  /** The signed-in user's id, which tells the user's own documents from those shared with them. */
  user?: string
  /**
   * Runs `use` with the account's JWT: `DynWorkAccounts.withJwt`, which mints once more when the instance refuses one.
   * For the person's backend, `DynWorkPerson.withPerson`: their UI token, refreshed or signed in again as it needs.
   */
  withJwt: <A>(use: (jwt: string) => Promise<A>) => Promise<A>
}

/** The account's Drive in Governance, over `SpDrive`. */
export function remote(options: Remote): Backend {
  const call = <A, B>(use: (jwt: string) => Effect.Effect<A, unknown>, read: (value: A) => B) =>
    options.withJwt((jwt) => Effect.runPromise(use(jwt))).then(read, failure)
  const url = options.url
  const mine = (owner: string) => owner === options.user
  const folder = (wire: SpDriveFolder): Folder => ({
    id: wire.id,
    name: wire.name,
    parent: wire.parent_id ?? undefined,
    owner: wire.owner_user_id,
    mine: mine(wire.owner_user_id),
    policy: wire.agent_edit_policy,
    created: Date.parse(wire.created_at),
    updated: Date.parse(wire.updated_at),
  })
  const document = (wire: SpDriveDocument): Document => ({
    id: wire.id,
    name: wire.name,
    // The instance keeps an uploaded PDF as a `file`; to the Drive it is a PDF, with its glyph, label and viewer.
    format: wire.format === "file" && wire.mime_type.split(";")[0]?.trim() === "application/pdf" ? "pdf" : wire.format,
    mime: wire.mime_type,
    folder: wire.folder_id ?? undefined,
    owner: wire.owner_user_id,
    mine: mine(wire.owner_user_id),
    access: wire.my_access,
    size: wire.size_bytes,
    revision: wire.head_revision_id,
    template: wire.template_id ?? undefined,
    created: Date.parse(wire.created_at),
    updated: Date.parse(wire.updated_at),
  })
  const comment = (wire: SpDriveComment): Comment => ({
    id: wire.id,
    anchor: wire.anchor && {
      node: wire.anchor.node,
      find: wire.anchor.find,
      ...(wire.anchor.cells ? { cells: wire.anchor.cells } : {}),
    },
    author: wire.author_user_id,
    mine: mine(wire.author_user_id),
    ...bodyOf(wire.body, options.user),
    parent: wire.parent_id ?? undefined,
    created: Date.parse(wire.created_at),
    resolved: wire.resolved_at ? Date.parse(wire.resolved_at) : undefined,
    resolver: wire.resolved_by ?? undefined,
    ...defined({
      reopened: wire.reopened_at ? Date.parse(wire.reopened_at) : undefined,
      reopener: wire.reopened_by,
      via: wire.via_agent,
      context: wire.context_id,
      conversation: wire.context_name,
      client: wire.client_id,
    }),
    ...(wire.reopened_at && wire.reopened_by && mine(wire.reopened_by) ? { reopenedMine: true } : {}),
  })
  const page = (wire: SpDrive.Page): Page => ({
    html: wire.html,
    csp: wire.csp,
    revision: wire.revision,
    sha256: wire.sha256,
  })
  const children = (parent?: string) =>
    call(
      (jwt) => SpDrive.folders(url, jwt, parent),
      (list) => list.map(folder),
    )
  // 0.83 answers the roots only, so the tree is read a level at a time: one read per folder, a level in parallel.
  const below = async (
    level: readonly Folder[],
    tree: readonly Folder[] = [],
  ): Promise<readonly Folder[] | Failure> => {
    const all = [...tree, ...level]
    if (level.length === 0 || all.length >= maxFolders) return all
    const next = await Promise.all(level.map((parent) => children(parent.id)))
    const failed = next.find(isFailure)
    if (failed) return failed
    return below(
      next.flatMap((own) => (isFailure(own) ? [] : own)),
      all,
    )
  }
  // Who has access, read again after a share or a revocation so the window shows what the instance keeps.
  const access = (id: string) =>
    call(
      (jwt) => SpDrive.access(url, jwt, id),
      (read): Access => ({
        owner: read.owner,
        access: read.my_access,
        grants: read.grants.map(grant),
        inherited: (read.inherited ?? []).map(grant),
      }),
    )
  return {
    discovery: () =>
      Effect.runPromise(SpDrive.discovery(url)).then(
        (found) => ({ version: found.version, documents: found.documents !== undefined }),
        failure,
      ),
    list: (query) =>
      call(
        (jwt) => SpDrive.list(url, jwt, query),
        (listing) => ({
          folders: listing.folders.map(folder),
          documents: listing.documents.map(document),
          next: listing.next_cursor ?? undefined,
        }),
      ),
    byContext: (contextId) =>
      call(
        (jwt) => SpDrive.list(url, jwt, { scope: "context", contextId, sort: "updated", limit: byContextLimit }),
        (listing) => listing.documents.map(document),
      ),
    children,
    folders: async () => {
      const roots = await children()
      return isFailure(roots) ? roots : below(roots)
    },
    get: (id) =>
      call(
        (jwt) => SpDrive.get(url, jwt, id),
        (detail) => ({
          document: document(detail.document),
          head: revision(detail.head),
          access: detail.my_access,
          path: detail.folder_path ?? undefined,
        }),
      ),
    rendered: (id, at) => call((jwt) => SpDrive.rendered(url, jwt, id, { revision: at }), page),
    preview: (id, at) => call((jwt) => SpDrive.preview(url, jwt, id, { revision: at }), page),
    content: (id, at) =>
      call(
        (jwt) => SpDrive.content(url, jwt, id, { revision: at }),
        (answer) => ({ bytes: new Uint8Array(answer.bytes), revision: answer.revision, sha256: answer.sha256 }),
      ),
    pdf: (id, at) =>
      call(
        (jwt) => SpDrive.pdf(url, jwt, id, { revision: at }),
        (answer) => ({
          bytes: new Uint8Array(answer.bytes),
          revision: answer.revision,
          sha256: answer.sha256 ?? undefined,
        }),
      ),
    // The text view: the outline one leaves paragraphs and cells behind a gap, and a comment may anchor to any node.
    outline: (id) =>
      call(
        (jwt) => SpDrive.outline(url, jwt, id, "text"),
        (outline) => outline,
      ),
    revisions: (id) =>
      call(
        (jwt) => SpDrive.revisions(url, jwt, id),
        (list) => list.map(revision),
      ),
    proposals: (id) =>
      call(
        (jwt) => SpDrive.proposals(url, jwt, id),
        (list) => list.map(proposal),
      ),
    comments: (id) =>
      call(
        (jwt) => SpDrive.comments(url, jwt, id),
        (list) => list.map(comment),
      ),
    access,
    agentCap: (target) =>
      call(
        (jwt) => SpDrive.agentCap(url, jwt, target),
        (cap) => ({
          cap: cap.attended.agent_cap,
          policy: cap.attended.policy_cap,
          reason: cap.attended.reason ?? undefined,
          unattended: cap.unattended.agent_cap,
        }),
      ),
    createFolder: (input) =>
      call((jwt) => SpDrive.createFolder(url, jwt, { name: input.name, parentId: input.parent }), folder),
    upload: (input) =>
      call(
        (jwt) =>
          SpDrive.importFile(url, jwt, {
            name: input.name,
            bytes: input.bytes,
            mime: input.mime,
            folderId: input.folder,
            message: input.message,
            contextId: input.contextId,
          }),
        (created) => ({ document: document(created.document), revision: revision(created.revision) }),
      ),
    importBlob: (input) =>
      call(
        (jwt) =>
          SpDrive.importBlob(url, jwt, {
            blobRef: input.blob,
            name: input.name,
            folderId: input.folder,
            message: input.message,
            contextId: input.contextId,
          }),
        (created) => ({ document: document(created.document), revision: revision(created.revision) }),
      ),
    create: (input) =>
      call(
        (jwt) =>
          SpDrive.create(url, jwt, {
            templateId: input.template,
            name: input.name,
            folderId: input.folder,
            message: input.message,
            contextId: input.contextId,
          }),
        (created) => ({ document: document(created.document), revision: revision(created.revision) }),
      ),
    edit: (id, input) =>
      call(
        (jwt) =>
          SpDrive.edit(url, jwt, id, {
            ops: input.ops,
            baseRevision: input.base,
            mode: input.mode,
            message: input.message,
            contextId: input.contextId,
          }),
        (edited): Edited =>
          edited._tag === "Landed"
            ? { kind: "landed", revision: revision(edited.revision), merged: edited.mergedFrom }
            : { kind: "proposed", proposal: proposal(edited.proposal), revision: revision(edited.revision) },
      ),
    comment: async (id, input) => {
      // A node and a quote in it, or a sheet node and a cell range of it (0.84).
      const anchor =
        input.anchor.kind === "range"
          ? { node: input.anchor.node, cells: input.anchor.cells }
          : { node: input.anchor.node, find: input.anchor.find }
      const mention = mentionOf(options.user, input.agent)
      if (isFailure(mention)) return mention
      return call(
        (jwt) => SpDrive.createComment(url, jwt, id, { body: input.body, anchor, contextId: input.contextId, mention }),
        comment,
      )
    },
    reply: async (id, input) => {
      const mention = mentionOf(options.user, input.agent)
      if (isFailure(mention)) return mention
      return call(
        (jwt) =>
          SpDrive.replyComment(url, jwt, id, {
            body: input.body,
            parentId: input.parent,
            contextId: input.contextId,
            mention,
          }),
        comment,
      )
    },
    resolve: (id, target) => call((jwt) => SpDrive.resolveComment(url, jwt, id, target), comment),
    reopen: (id, target) => call((jwt) => SpDrive.reopenComment(url, jwt, id, target), comment),
    createContext: (name) =>
      call(
        (jwt) => SpDrive.createContext(url, jwt, name),
        (id) => id,
      ),
    renameContext: (id, name) =>
      call(
        (jwt) => SpDrive.renameContext(url, jwt, id, name),
        () => undefined,
      ),
    people: (ids) =>
      call(
        (jwt) => SpDrive.people(url, jwt, ids),
        (list) => list.flatMap(personOf),
      ),
    share: (id, input) =>
      call(
        (jwt) => SpDrive.share(url, jwt, id, input),
        () => undefined,
      ).then((done) => done ?? access(id)),
    unshare: (id, grant) =>
      call(
        (jwt) => SpDrive.revoke(url, jwt, id, grant),
        () => undefined,
      ).then((done) => done ?? access(id)),
    revokeAll: (id) =>
      call(
        (jwt) => SpDrive.revokeAll(url, jwt, id),
        () => undefined,
      ).then((done) => done ?? access(id)),
    transfer: (id, to) => call((jwt) => SpDrive.transfer(url, jwt, id, to), document),
    trash: (id) =>
      call(
        (jwt) => SpDrive.trash(url, jwt, id),
        () => undefined,
      ),
    // `restore` applies only on the head, so it is read first: one credential for both, so one sign-in covers them.
    restore: (id, at) =>
      call(
        (jwt) =>
          SpDrive.get(url, jwt, id).pipe(
            Effect.flatMap((detail) =>
              SpDrive.edit(url, jwt, id, { ops: [{ op: "restore", revision_id: at }], baseRevision: detail.head.id }),
            ),
          ),
        (edited) => revision(edited.revision),
      ),
    review: (id, target, input) =>
      call(
        (jwt) => SpDrive.review(url, jwt, id, target, input),
        (reviewed) => proposal(reviewed.proposal),
      ),
    findPeople: (query, limit) =>
      call(
        (jwt) => SpDrive.lookupPeople(url, jwt, query, limit),
        (list) => list.flatMap(personOf),
      ),
    searchPeople: (query, limit) =>
      call(
        (jwt) => SpDrive.searchPeople(url, jwt, query, { limit }),
        (list) => list.flatMap(personOf),
      ),
    // The stream is opened with a JWT the account mints again when the instance refuses it; a stream that breaks later just ends.
    stream: (signal) => options.withJwt((jwt) => SpDrive.stream(url, jwt, signal)).catch(failure),
  }
}

// What a comment says to a reader (`DriveMentions.read`), and whether it hands the user's agent a job.
function bodyOf(wire: string, user: string | undefined) {
  const read = DriveMentions.read(wire, user)
  return { body: read.text, ...(read.agent ? { agent: true } : {}) }
}

// The mention a comment hands the user's own agent: the user themself, with `attention: agent`. A write that asks for it
// without knowing the user cannot be made.
function mentionOf(user: string | undefined, agent: boolean | undefined) {
  if (!agent) return undefined
  if (user === undefined) return fail("invalid", "Governance did not accept it.")
  return { userId: user, attention: "agent" } as const
}

type SpDriveFolder = Effect.Success<ReturnType<typeof SpDrive.createFolder>>
type SpDriveDocument = Effect.Success<ReturnType<typeof SpDrive.get>>["document"]
type SpDriveRevision = Effect.Success<ReturnType<typeof SpDrive.get>>["head"]
type SpDriveProposal = Effect.Success<ReturnType<typeof SpDrive.proposals>>[number]
type SpDriveComment = Effect.Success<ReturnType<typeof SpDrive.resolveComment>>
type SpDriveGrant = Effect.Success<ReturnType<typeof SpDrive.access>>["grants"][number]

function revision(wire: SpDriveRevision): Revision {
  return {
    id: wire.id,
    document: wire.document_id,
    parent: wire.parent_revision_id ?? undefined,
    sha256: wire.content_sha256,
    author: wire.author_user_id,
    actor: wire.actor_kind,
    origin: wire.origin_kind,
    message: wire.message ?? undefined,
    created: Date.parse(wire.created_at),
    ...defined({
      context: wire.context_id,
      conversation: wire.context_name,
      agent: wire.agent_name,
      client: wire.client_id,
    }),
  }
}

// The keys whose value the instance sent: 0.83 sends none of these, and a window gets no key it did not.
function defined<A extends Record<string, string | number | null | undefined>>(values: A) {
  return Object.fromEntries(Object.entries(values).filter((entry) => entry[1] !== undefined && entry[1] !== null)) as {
    [K in keyof A]?: Exclude<A[K], null>
  }
}

function proposal(wire: SpDriveProposal): Proposal {
  return {
    id: wire.id,
    document: wire.document_id,
    base: wire.base_revision_id,
    proposed: wire.proposed_revision_id,
    proposer: wire.proposer,
    actor: wire.actor_kind,
    status: wire.status,
    message: wire.message ?? undefined,
    reviewer: wire.reviewer ?? undefined,
    reviewed: wire.reviewed_at ? Date.parse(wire.reviewed_at) : undefined,
    note: wire.note ?? undefined,
    landed: wire.landed_revision_id ?? undefined,
    created: Date.parse(wire.created_at),
  }
}

function grant(wire: SpDriveGrant) {
  return {
    id: wire.grant_id,
    subject: wire.subject_kind,
    value: wire.subject_value,
    name: wire.display_name ?? undefined,
    level: wire.level,
    from:
      wire.inherited_from === undefined
        ? undefined
        : { folder: wire.inherited_from.folder_id, name: wire.inherited_from.name },
  }
}

// Where the client's errors (and the accounts' `NotSignedIn`) become failures. The instance's own message is not
// passed on: the window shows its own words for each code.
function failure(error: unknown): Failure {
  // The person's session (`DynWorkPerson.withPerson`): none, or a recent sign-in the person did not finish.
  if (
    error instanceof DynWorkPerson.SignedOut ||
    error instanceof DynWorkPerson.SignInFailed ||
    error instanceof SpClient.RecentSignIn
  )
    return fail("sign-in", "Sign in to act as you.")
  if (error instanceof SpClient.Unauthorized || error instanceof DynWorkAccounts.NotSignedIn)
    return fail("signed-out", "Sign in to Governance again.")
  if (error instanceof SpClient.Unreachable || error instanceof SpClient.RateLimited)
    return fail("unreachable", "Governance did not answer.")
  if (error instanceof SpClient.NotFound) return fail("not-found", "It is not in the Drive, or it is hidden from you.")
  if (error instanceof SpClient.Forbidden) return fail("forbidden", "You do not have access to it.")
  if (error instanceof SpClient.AgentRefused && error.capability === "edit")
    return fail("suggest", "DynWork may only suggest changes here.")
  if (error instanceof SpClient.AgentRefused) return fail("person", "Only you can do this, in Governance.")
  if (error instanceof SpClient.Conflict)
    return fail("conflict", "The document changed meanwhile.", error.headRevisionId)
  if (error instanceof SpClient.UnknownContext)
    return fail("unknown-context", "Governance does not know the conversation this write named.")
  if (error instanceof SpClient.Protocol && error.errorKey === "unsupported_op")
    return fail("unsupported", "Governance does not do this for this document.")
  if (error instanceof SpClient.Protocol && error.status === 400)
    return fail("invalid", "Governance did not accept it.")
  return fail("failed", "The Drive did not answer as expected.")
}

// Someone without a name is named by their email; someone with neither is left unnamed.
function personOf(person: { readonly user_id: string; readonly name?: string | null; readonly email?: string | null }) {
  const name = person.name || person.email
  return name ? [{ id: person.user_id, name, ...(person.email ? { email: person.email } : {}) }] : []
}
