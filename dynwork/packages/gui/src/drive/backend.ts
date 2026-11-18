export * as DriveBackend from "./backend"

import { Effect } from "effect"
import { SpClient, SpDrive } from "@dynwork/sp-client"
import { DynWorkAccounts } from "../accounts/accounts"
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
  Proposal,
  Query,
  Revision,
} from "./contract"

/** Where a write is attributed: the revision message and the conversation's `x-context-id`. */
export type Attribution = { readonly message?: string; readonly contextId?: string }

/**
 * One account's Drive: the instance's document store, or a fake. It lives in the main process, where the account's
 * credential never reaches a window. Every method answers a failure as data and never rejects.
 *
 * `test/drive/conformance.ts` is the suite every backend passes.
 */
export interface Backend {
  list(query: Query): Promise<Listing | Failure>
  folders(): Promise<readonly Folder[] | Failure>
  get(id: string): Promise<Detail | Failure>
  /** An HTML document as designed, scripts included where the instance allows them. */
  rendered(id: string, revision?: string): Promise<Page | Failure>
  /** A sanitised HTML view of any format. */
  preview(id: string, revision?: string): Promise<Page | Failure>
  pdf(id: string): Promise<Pdf | Failure>
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
  edit(
    id: string,
    input: Attribution & {
      ops: ReadonlyArray<Readonly<Record<string, unknown>>>
      base?: string
      mode?: "land" | "propose"
    },
  ): Promise<Edited | Failure>
  /** `unsupported` for an anchor the instance does not take. */
  comment(id: string, input: { body: string; anchor: Anchor; contextId?: string }): Promise<Comment | Failure>
  reply(id: string, input: { body: string; parent: string; contextId?: string }): Promise<Comment | Failure>
  resolve(id: string, comment: string): Promise<Comment | Failure>
  /** The documents written with `contextId`, newest first: only where the instance lists by conversation (P3). */
  byContext?(contextId: string): Promise<readonly Document[] | Failure>
}

/** A failure. It is retryable only when `unreachable`, the one code that clears up by itself. */
export function fail(code: Failure["code"], message: string, head?: string): Failure {
  return { code, message, retryable: code === "unreachable", ...(head === undefined ? {} : { head }) }
}

export interface Remote {
  /** The instance base URL. */
  url: string
  /** The signed-in user's id, which tells the user's own documents from those shared with them. */
  user?: string
  /** Runs `use` with the account's JWT: `DynWorkAccounts.withJwt`, which mints once more when the instance refuses one. */
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
    format: wire.format,
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
  const page = (wire: SpDrive.Page): Page => ({
    html: wire.html,
    csp: wire.csp,
    revision: wire.revision,
    sha256: wire.sha256,
  })
  return {
    list: (query) =>
      call(
        (jwt) => SpDrive.list(url, jwt, query),
        (listing) => ({
          folders: listing.folders.map(folder),
          documents: listing.documents.map(document),
          next: listing.next_cursor ?? undefined,
        }),
      ),
    folders: () =>
      call(
        (jwt) => SpDrive.folders(url, jwt),
        (folders) => folders.map(folder),
      ),
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
    pdf: (id) =>
      call(
        (jwt) => SpDrive.pdf(url, jwt, id),
        (answer) => ({
          bytes: new Uint8Array(answer.bytes),
          revision: answer.revision,
          sha256: answer.sha256 ?? undefined,
        }),
      ),
    outline: (id) =>
      call(
        (jwt) => SpDrive.outline(url, jwt, id),
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
    access: (id) =>
      call(
        (jwt) => SpDrive.access(url, jwt, id),
        (access) => ({
          owner: access.owner,
          access: access.my_access,
          grants: access.grants.map(grant),
          inherited: access.inherited.map(grant),
        }),
      ),
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
      // 0.83 anchors to a node only; the other kinds wait for P10.
      if (input.anchor.kind !== "node") return fail("unsupported", "This kind of comment is not available yet.")
      const anchor = { node: input.anchor.node, find: input.anchor.find }
      return call(
        (jwt) => SpDrive.createComment(url, jwt, id, { body: input.body, anchor, contextId: input.contextId }),
        comment,
      )
    },
    reply: (id, input) =>
      call(
        (jwt) =>
          SpDrive.replyComment(url, jwt, id, { body: input.body, parentId: input.parent, contextId: input.contextId }),
        comment,
      ),
    resolve: (id, target) => call((jwt) => SpDrive.resolveComment(url, jwt, id, target), comment),
  }
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

function comment(wire: SpDriveComment): Comment {
  return {
    id: wire.id,
    anchor: wire.anchor,
    author: wire.author_user_id,
    body: wire.body,
    parent: wire.parent_id ?? undefined,
    created: Date.parse(wire.created_at),
    resolved: wire.resolved_at ? Date.parse(wire.resolved_at) : undefined,
    resolver: wire.resolved_by ?? undefined,
  }
}

function grant(wire: SpDriveGrant) {
  return {
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
  if (error instanceof SpClient.Protocol && error.errorKey === "unsupported_op")
    return fail("unsupported", "Governance does not do this for this document.")
  if (error instanceof SpClient.Protocol && error.status === 400)
    return fail("invalid", "Governance did not accept it.")
  return fail("failed", "The Drive did not answer as expected.")
}
