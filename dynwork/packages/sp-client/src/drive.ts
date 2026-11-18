import { createHash } from "node:crypto"
import { Clock, Duration, Effect, Schema, SchemaIssue } from "effect"
import { AgentRefused, Conflict, Forbidden, NotFound, Protocol, RateLimited, Unauthorized, Unreachable } from "./errors"
import {
  DriveAccess,
  DriveAgentCap,
  DriveBlob,
  DriveComment,
  DriveComments,
  DriveCreated,
  DriveDetail,
  DriveErrorBody,
  DriveFolder,
  DriveLanded,
  DriveListing,
  DriveOutline,
  DriveProposals,
  DriveProposed,
  DriveRevisions,
  DriveUpload,
  DriveUploadPart,
  type DriveAnchor,
  type DriveProposal,
  type DriveRevision,
} from "./schema"

// A client for the Drive of a systemprompt instance (core 0.83): the REST store of documents and folders that the
// instance's web Drive uses, called with the JWT of the signed-in account. Like the rest of the package, every function
// takes the instance base URL and the credential as plain values; nothing is stored, cached or logged here, and no error
// carries a credential. DynWork's JWT acts as an agent (`actor_kind: agent`): what the instance reserves to a person
// comes back as `AgentRefused`, not as something to retry.

const timeout = Duration.seconds(60)

// Above this size a file goes up as a resumable upload and is imported by its `blob_ref`; below it, as one multipart
// request. It is the instance's `part_size`: a file that fits one part needs no resumption.
export const inlineLimit = 8 * 1024 * 1024

const documents = "/api/v1/documents"

/** A structured edit, as the instance's `edits` route reads it: `{ op: "append_markdown", markdown }` and the like. */
export type Op = Readonly<Record<string, unknown>>

export type Scope = "mine" | "shared" | "recent" | "folder"

export type ListOptions = {
  readonly scope?: Scope
  /** The folder to list, for `scope: "folder"`; its sub-folders come back with its documents. */
  readonly folder?: string
  /** Matches document names. */
  readonly query?: string
  readonly sort?: string
  readonly limit?: number
  /** `next_cursor` of the previous page. */
  readonly cursor?: string
}

/** Documents (and, in a folder, its sub-folders) of one scope, a page at a time. */
export const list = Effect.fn("SpDrive.list")(function* (baseUrl: string, jwt: string, options?: ListOptions) {
  const query = new URLSearchParams({ scope: options?.scope ?? "mine" })
  if (options?.folder !== undefined) query.set("folder", options.folder)
  if (options?.query !== undefined) query.set("query", options.query)
  if (options?.sort !== undefined) query.set("sort", options.sort)
  if (options?.limit !== undefined) query.set("limit", String(options.limit))
  if (options?.cursor !== undefined) query.set("cursor", options.cursor)
  return yield* json(DriveListing, {
    method: "GET",
    path: documents,
    query,
    endpoint: "GET /api/v1/documents",
    baseUrl,
    jwt,
    limit: 8 * 1024 * 1024,
  })
})

/** Documents of `scope` (the user's own by default) whose name matches `query`. */
export const search = (baseUrl: string, jwt: string, query: string, options?: Omit<ListOptions, "query">) =>
  list(baseUrl, jwt, { ...options, query })

/** Every folder the user can see, flat; `parent_id` builds the tree. */
export const folders = Effect.fn("SpDrive.folders")(function* (baseUrl: string, jwt: string) {
  const listing = yield* json(DriveListing, {
    method: "GET",
    path: "/api/v1/document-folders",
    endpoint: "GET /api/v1/document-folders",
    baseUrl,
    jwt,
    limit: 8 * 1024 * 1024,
  })
  return listing.folders
})

/** Creates a folder at the root, or under `parentId`. */
export const createFolder = Effect.fn("SpDrive.createFolder")(function* (
  baseUrl: string,
  jwt: string,
  input: { readonly name: string; readonly parentId?: string },
) {
  return yield* json(
    DriveFolder,
    {
      method: "POST",
      path: "/api/v1/document-folders",
      endpoint: "POST /api/v1/document-folders",
      baseUrl,
      jwt,
      body: { name: input.name, ...(input.parentId === undefined ? {} : { parent_id: input.parentId }) },
      limit: 1024 * 1024,
    },
    [201],
  )
})

/** A document's metadata, its head revision, the user's access and the folder path. */
export const get = Effect.fn("SpDrive.get")(function* (baseUrl: string, jwt: string, id: string) {
  return yield* json(DriveDetail, {
    method: "GET",
    path: `${documents}/${encodeURIComponent(id)}`,
    endpoint: "GET /api/v1/documents/{id}",
    baseUrl,
    jwt,
    limit: 1024 * 1024,
  })
})

/** What `rendered` and `preview` answer: the page, the CSP header it came with and the revision it shows. */
export type Page = {
  readonly html: string
  /** The `Content-Security-Policy` of the answer. A viewer applies this one, not its own: it differs per instance. */
  readonly csp: string | undefined
  /** The revision shown (the answer's `ETag`, unquoted). */
  readonly revision: string | undefined
  readonly sha256: string | undefined
}

/**
 * An HTML document as designed (`GET /{id}/rendered`): its stored bytes, scripts included when the instance allows
 * them. The page is meant for a sandboxed frame without DynWork's origin, under the CSP the instance sent.
 */
export const rendered = Effect.fn("SpDrive.rendered")(function* (
  baseUrl: string,
  jwt: string,
  id: string,
  options?: { readonly revision?: string },
) {
  return yield* page("rendered", baseUrl, jwt, id, options?.revision)
})

/** A sanitised HTML view of any format (`GET /{id}/preview`): no scripts, whatever the document holds. */
export const preview = Effect.fn("SpDrive.preview")(function* (
  baseUrl: string,
  jwt: string,
  id: string,
  options?: { readonly revision?: string },
) {
  return yield* page("preview", baseUrl, jwt, id, options?.revision)
})

/**
 * A document's stored bytes (`GET /{id}/content`), at `revision` or at its head: the Markdown source or the uploaded PDF
 * a viewer draws itself.
 */
export const content = Effect.fn("SpDrive.content")(function* (
  baseUrl: string,
  jwt: string,
  id: string,
  options?: { readonly revision?: string },
) {
  const answer = yield* send({
    method: "GET",
    path: `${documents}/${encodeURIComponent(id)}/content`,
    query: options?.revision === undefined ? undefined : new URLSearchParams({ revision: options.revision }),
    endpoint: "GET /api/v1/documents/{id}/content",
    baseUrl,
    jwt,
    limit: 64 * 1024 * 1024,
  })
  return {
    bytes: answer.body,
    revision: revisionOf(answer.headers),
    sha256: answer.headers.get("x-document-content-sha256") ?? undefined,
  }
})

/**
 * The document rendered as a PDF (`GET /{id}/content?format=pdf`), at `revision` or at its head. Only the instance's own
 * formats render; an uploaded file (format `file`) does not.
 */
export const pdf = Effect.fn("SpDrive.pdf")(function* (
  baseUrl: string,
  jwt: string,
  id: string,
  options?: { readonly revision?: string },
) {
  const answer = yield* send({
    method: "GET",
    path: `${documents}/${encodeURIComponent(id)}/content`,
    query: new URLSearchParams({
      format: "pdf",
      ...(options?.revision === undefined ? {} : { revision: options.revision }),
    }),
    endpoint: "GET /api/v1/documents/{id}/content",
    baseUrl,
    jwt,
    limit: 64 * 1024 * 1024,
  })
  return {
    bytes: answer.body,
    revision: revisionOf(answer.headers),
    sha256: answer.headers.get("x-document-content-sha256"),
  }
})

/**
 * The nodes of a document at its head (`GET /{id}/read`): the ids a comment is anchored to, and the text of each. A line
 * that is not a node (a gap marker, say) is left out. The `outline` view keeps the headings and list items and gaps
 * over the rest; `text` lists every node in reading order, which is what a comment on a paragraph or a cell needs.
 */
export const outline = Effect.fn("SpDrive.outline")(function* (
  baseUrl: string,
  jwt: string,
  id: string,
  view: "outline" | "text" = "outline",
) {
  const answer = yield* json(DriveOutline, {
    method: "GET",
    path: `${documents}/${encodeURIComponent(id)}/read`,
    query: new URLSearchParams({ view }),
    endpoint: "GET /api/v1/documents/{id}/read",
    baseUrl,
    jwt,
    limit: 4 * 1024 * 1024,
  })
  return {
    revision: answer.revision_id,
    format: answer.format,
    nodes: answer.lines.flatMap((line) => {
      const match = /^([^:|\s]+):([0-9a-f]+)\| ?(.*)$/.exec(line)
      return match?.[1] === undefined ? [] : [{ id: match[1], hash: match[2] ?? "", text: match[3] ?? "" }]
    }),
  }
})

/** The revisions of a document, newest first. The listing does not say which conversation wrote each. */
export const revisions = Effect.fn("SpDrive.revisions")(function* (baseUrl: string, jwt: string, id: string) {
  return (yield* json(DriveRevisions, {
    method: "GET",
    path: `${documents}/${encodeURIComponent(id)}/revisions`,
    endpoint: "GET /api/v1/documents/{id}/revisions",
    baseUrl,
    jwt,
    limit: 4 * 1024 * 1024,
  })).revisions
})

/** The open and decided proposals on a document (edits an agent made where it may only suggest). */
export const proposals = Effect.fn("SpDrive.proposals")(function* (baseUrl: string, jwt: string, id: string) {
  return (yield* json(DriveProposals, {
    method: "GET",
    path: `${documents}/${encodeURIComponent(id)}/proposals`,
    endpoint: "GET /api/v1/documents/{id}/proposals",
    baseUrl,
    jwt,
    limit: 4 * 1024 * 1024,
  })).proposals
})

/** Who has access to a document and which cap applies to agents. Granting access is the person's, not DynWork's. */
export const access = Effect.fn("SpDrive.access")(function* (baseUrl: string, jwt: string, id: string) {
  return yield* json(DriveAccess, {
    method: "GET",
    path: `${documents}/${encodeURIComponent(id)}/access`,
    endpoint: "GET /api/v1/documents/{id}/access",
    baseUrl,
    jwt,
    limit: 1024 * 1024,
  })
})

/**
 * What an agent may do on a document or folder. DynWork is an attended agent: `attended.agent_cap` is the cap that
 * applies, `agent_cap` is the unattended one.
 */
export const agentCap = Effect.fn("SpDrive.agentCap")(function* (
  baseUrl: string,
  jwt: string,
  target: { readonly kind: "document" | "folder"; readonly id: string },
) {
  return yield* json(DriveAgentCap, {
    method: "GET",
    path: `${target.kind === "document" ? documents : "/api/v1/document-folders"}/${encodeURIComponent(target.id)}/agent-cap`,
    endpoint: `GET /api/v1/${target.kind === "document" ? "documents" : "document-folders"}/{id}/agent-cap`,
    baseUrl,
    jwt,
    limit: 1024 * 1024,
  })
})

/** Where a write is attributed: the revision `message` ("... by DynWork") and the conversation (`x-context-id`). */
export type Attribution = {
  readonly message?: string
  readonly contextId?: string
}

export type Import = Attribution & {
  readonly name: string
  readonly bytes: Uint8Array
  readonly mime?: string
  /** Omitted, the document goes to the root. */
  readonly folderId?: string
}

/**
 * Creates a document from a local file: one multipart request up to `inlineLimit`, a resumable upload and an import of
 * its blob above it. The format is the instance's call, from the file's type and name. 0.83 does not record `message`
 * on a document it creates this way (the first revision stays unnamed).
 */
export const importFile = Effect.fn("SpDrive.importFile")(function* (baseUrl: string, jwt: string, input: Import) {
  const mime = input.mime ?? "application/octet-stream"
  if (input.bytes.length > inlineLimit) {
    const opened = yield* openUpload(baseUrl, jwt, { name: input.name, mime, bytes: input.bytes })
    const blob = yield* finishUpload(baseUrl, jwt, opened, input.bytes)
    return yield* importBlob(baseUrl, jwt, {
      blobRef: blob.blob_ref,
      name: input.name,
      folderId: input.folderId,
      message: input.message,
      contextId: input.contextId,
    })
  }
  const form = new FormData()
  form.set("file", new File([input.bytes.slice()], input.name, { type: mime }))
  form.set("name", input.name)
  if (input.folderId !== undefined) form.set("folder_id", input.folderId)
  if (input.message !== undefined) form.set("message", input.message)
  return yield* json(
    DriveCreated,
    {
      method: "POST",
      path: documents,
      endpoint: "POST /api/v1/documents",
      baseUrl,
      jwt,
      form,
      headers: context(input.contextId),
      limit: 1024 * 1024,
    },
    [201],
  )
})

/**
 * Creates a document from one of the instance's templates (`dynapps-word`, `blank-markdown`, ...). The instance has no
 * route that lists them. 0.83 ignores a `message` here (the first revision stays unnamed), so none is sent.
 */
export const create = Effect.fn("SpDrive.create")(function* (
  baseUrl: string,
  jwt: string,
  input: Pick<Attribution, "contextId"> & {
    readonly templateId: string
    readonly name: string
    readonly folderId?: string
  },
) {
  return yield* json(
    DriveCreated,
    {
      method: "POST",
      path: documents,
      endpoint: "POST /api/v1/documents",
      baseUrl,
      jwt,
      body: {
        template_id: input.templateId,
        name: input.name,
        ...(input.folderId === undefined ? {} : { folder_id: input.folderId }),
      },
      headers: context(input.contextId),
      limit: 1024 * 1024,
    },
    [201],
  )
})

/**
 * Creates a document from a blob the instance already holds: the `blob_ref` of an upload completed here, or one the
 * agent produced with the `documents_upload` tool. Only the user who uploaded a blob can import it.
 */
export const importBlob = Effect.fn("SpDrive.importBlob")(function* (
  baseUrl: string,
  jwt: string,
  input: Attribution & { readonly blobRef: string; readonly name: string; readonly folderId?: string },
) {
  return yield* json(
    DriveCreated,
    {
      method: "POST",
      path: `${documents}/import`,
      endpoint: "POST /api/v1/documents/import",
      baseUrl,
      jwt,
      body: {
        blob_ref: input.blobRef,
        name: input.name,
        ...(input.folderId === undefined ? {} : { folder_id: input.folderId }),
        ...(input.message === undefined ? {} : { message: input.message }),
      },
      headers: context(input.contextId),
      limit: 1024 * 1024,
    },
    [201],
  )
})

/** Starts an upload of `bytes` (`POST /api/v1/uploads`). The instance names the part size; parts are numbered from 1. */
export const openUpload = Effect.fn("SpDrive.openUpload")(function* (
  baseUrl: string,
  jwt: string,
  input: { readonly name: string; readonly mime: string; readonly bytes: Uint8Array },
) {
  return yield* json(
    DriveUpload,
    {
      method: "POST",
      path: "/api/v1/uploads",
      endpoint: "POST /api/v1/uploads",
      baseUrl,
      jwt,
      body: {
        name: input.name,
        mime: input.mime,
        size: input.bytes.length,
        sha256: createHash("sha256").update(input.bytes).digest("hex"),
      },
      limit: 1024 * 1024,
    },
    [201],
  )
})

/** Where an upload stands: which parts the instance has and which are missing. Uploads expire after a day. */
export const uploadStatus = Effect.fn("SpDrive.uploadStatus")(function* (baseUrl: string, jwt: string, id: string) {
  return yield* json(DriveUpload, {
    method: "GET",
    path: `/api/v1/uploads/${encodeURIComponent(id)}`,
    endpoint: "GET /api/v1/uploads/{id}",
    baseUrl,
    jwt,
    limit: 1024 * 1024,
  })
})

/**
 * Sends the parts of `upload` the instance is missing and completes it, giving the blob. The same `bytes` the upload
 * was opened with must be passed; to resume after a failure, read `uploadStatus` first and pass what it answers.
 */
export const finishUpload = Effect.fn("SpDrive.finishUpload")(function* (
  baseUrl: string,
  jwt: string,
  upload: DriveUpload,
  bytes: Uint8Array,
) {
  const endpoint = "PUT /api/v1/uploads/{id}/parts/{n}"
  const id = encodeURIComponent(upload.upload_id)
  if (bytes.length !== upload.size)
    return yield* new Protocol({ endpoint, message: "the bytes are not the ones the upload was opened with" })
  yield* Effect.forEach(upload.missing_parts, (number) => {
    const part = bytes.subarray((number - 1) * upload.part_size, number * upload.part_size)
    return json(DriveUploadPart, {
      method: "PUT",
      path: `/api/v1/uploads/${id}/parts/${number}`,
      endpoint,
      baseUrl,
      jwt,
      body: part,
      headers: { "content-type": "application/octet-stream" },
      limit: 1024 * 1024,
    }).pipe(
      Effect.filterOrFail(
        (stored) => stored.sha256 === createHash("sha256").update(part).digest("hex"),
        () => new Protocol({ endpoint, message: `part ${number} reached the instance altered` }),
      ),
    )
  })
  return yield* json(DriveBlob, {
    method: "POST",
    path: `/api/v1/uploads/${id}/complete`,
    endpoint: "POST /api/v1/uploads/{id}/complete",
    baseUrl,
    jwt,
    body: {},
    limit: 1024 * 1024,
  })
})

export type Edit = Attribution & {
  readonly ops: ReadonlyArray<Op>
  /** The revision the ops were written against; behind the head, the instance merges them onto it when it can. */
  readonly baseRevision?: string
  /** `land` (the default) writes now; `propose` leaves a proposal for a person to review. */
  readonly mode?: "land" | "propose"
  /** Makes the call idempotent: the same id again answers the first result. */
  readonly opId?: string
}

export type Edited =
  | { readonly _tag: "Landed"; readonly revision: DriveRevision; readonly mergedFrom: string | undefined }
  | { readonly _tag: "Proposed"; readonly proposal: DriveProposal; readonly revision: DriveRevision }

/** Applies structured edits (`POST /{id}/edits`) as the agent, with the revision `message` and the conversation. */
export const edit = Effect.fn("SpDrive.edit")(function* (baseUrl: string, jwt: string, id: string, input: Edit) {
  const endpoint = "POST /api/v1/documents/{id}/edits"
  const answer = yield* send({
    method: "POST",
    path: `${documents}/${encodeURIComponent(id)}/edits`,
    endpoint,
    baseUrl,
    jwt,
    body: {
      ops: input.ops,
      ...(input.baseRevision === undefined ? {} : { base_revision: input.baseRevision }),
      ...(input.mode === undefined ? {} : { mode: input.mode }),
      ...(input.opId === undefined ? {} : { op_id: input.opId }),
      ...(input.message === undefined ? {} : { message: input.message }),
    },
    headers: context(input.contextId),
    expect: [200, 201],
    limit: 1024 * 1024,
  })
  if (answer.status === 201) {
    const proposed = yield* decode(endpoint, DriveProposed, answer.body, answer.status)
    return { _tag: "Proposed", proposal: proposed.proposal, revision: proposed.revision } satisfies Edited
  }
  const landed = yield* decode(endpoint, DriveLanded, answer.body, answer.status)
  return {
    _tag: "Landed",
    revision: landed.revision,
    mergedFrom: landed.merged_from ?? undefined,
  } satisfies Edited
})

/** The comments of a document, replies included (they carry `parent_id`), resolved ones too. */
export const comments = Effect.fn("SpDrive.comments")(function* (baseUrl: string, jwt: string, id: string) {
  return (yield* json(DriveComments, {
    method: "GET",
    path: `${documents}/${encodeURIComponent(id)}/comments`,
    endpoint: "GET /api/v1/documents/{id}/comments",
    baseUrl,
    jwt,
    limit: 4 * 1024 * 1024,
  })).comments
})

/**
 * A comment pinned to a node (`find` quotes the text inside it). A node that is not in the head revision is a
 * `Conflict` with `errorKey: "not_found"`: read the document's outline again.
 */
export const createComment = Effect.fn("SpDrive.createComment")(function* (
  baseUrl: string,
  jwt: string,
  id: string,
  input: Pick<Attribution, "contextId"> & { readonly body: string; readonly anchor: DriveAnchor },
) {
  return yield* postComment(baseUrl, jwt, id, { body: input.body, anchor: input.anchor }, input.contextId)
})

/** A reply in the thread of `parentId`. */
export const replyComment = Effect.fn("SpDrive.replyComment")(function* (
  baseUrl: string,
  jwt: string,
  id: string,
  input: Pick<Attribution, "contextId"> & { readonly body: string; readonly parentId: string },
) {
  return yield* postComment(baseUrl, jwt, id, { body: input.body, parent_id: input.parentId }, input.contextId)
})

/**
 * Marks a comment resolved. 0.83 has no route to reopen one, so this client has no reopen either; resolving again
 * leaves the first `resolved_at`.
 */
export const resolveComment = Effect.fn("SpDrive.resolveComment")(function* (
  baseUrl: string,
  jwt: string,
  id: string,
  commentId: string,
) {
  return yield* json(DriveComment, {
    method: "POST",
    path: `${documents}/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}/resolve`,
    endpoint: "POST /api/v1/documents/{id}/comments/{comment}/resolve",
    baseUrl,
    jwt,
    body: {},
    limit: 1024 * 1024,
  })
})

const postComment = (baseUrl: string, jwt: string, id: string, body: Record<string, unknown>, contextId?: string) =>
  json(
    DriveComment,
    {
      method: "POST",
      path: `${documents}/${encodeURIComponent(id)}/comments`,
      endpoint: "POST /api/v1/documents/{id}/comments",
      baseUrl,
      jwt,
      body,
      headers: context(contextId),
      limit: 1024 * 1024,
    },
    [201],
  )

const page = Effect.fnUntraced(function* (
  view: "rendered" | "preview",
  baseUrl: string,
  jwt: string,
  id: string,
  revision?: string,
) {
  const answer = yield* send({
    method: "GET",
    path: `${documents}/${encodeURIComponent(id)}/${view}`,
    query: revision === undefined ? undefined : new URLSearchParams({ revision }),
    endpoint: `GET /api/v1/documents/{id}/${view}`,
    baseUrl,
    jwt,
    limit: 16 * 1024 * 1024,
  })
  return {
    html: new TextDecoder().decode(answer.body),
    csp: answer.headers.get("content-security-policy") ?? undefined,
    revision: revisionOf(answer.headers),
    sha256: answer.headers.get("x-document-content-sha256") ?? undefined,
  } satisfies Page
})

// The `ETag` of a document answer is its head revision, quoted
function revisionOf(headers: Headers) {
  return headers.get("etag")?.replace(/^W\//, "").replaceAll('"', "") || undefined
}

function context(contextId: string | undefined) {
  return contextId === undefined ? undefined : { "x-context-id": contextId }
}

type Request = {
  readonly method: "GET" | "POST" | "PUT"
  readonly path: string
  readonly query?: URLSearchParams
  // Method and path template only, never ids, a query or a credential
  readonly endpoint: string
  readonly baseUrl: string
  readonly jwt: string
  readonly body?: unknown
  readonly form?: FormData
  readonly headers?: Record<string, string>
  readonly expect?: ReadonlyArray<number>
  readonly limit: number
}

const json = Effect.fnUntraced(function* <A>(
  schema: Schema.Decoder<A>,
  request: Request,
  expect: ReadonlyArray<number> = [200],
) {
  const answer = yield* send({ ...request, expect })
  return yield* decode(request.endpoint, schema, answer.body, answer.status)
})

const send = Effect.fnUntraced(function* (request: Request) {
  const endpoint = request.endpoint
  const unreachable = (message: string) => new Unreachable({ endpoint, message })
  const root = yield* base(request.baseUrl)
  const query = request.query === undefined ? "" : `?${request.query.toString()}`
  const answer = yield* Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(`${root}${request.path}${query}`, {
        method: request.method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${request.jwt}`,
          ...(request.body === undefined || request.body instanceof Uint8Array
            ? {}
            : { "content-type": "application/json" }),
          ...request.headers,
        },
        body:
          request.form ??
          (request.body === undefined || request.body instanceof Uint8Array
            ? request.body?.slice()
            : JSON.stringify(request.body)),
        // A redirect is never followed: it could carry the credential to another origin
        redirect: "manual",
        signal,
      })
      return { status: response.status, headers: response.headers, body: await bounded(response, request.limit) }
    },
    // A fixed message: a fetch error can quote request headers, and so the credential
    catch: () => unreachable("the request failed"),
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () => Effect.fail(unreachable(`no answer within ${Duration.format(timeout)}`)),
    }),
  )
  if (answer.body === undefined)
    return yield* new Protocol({ endpoint, message: "the answer is larger than allowed", status: answer.status })
  const received = { status: answer.status, headers: answer.headers, body: answer.body }
  if (!(request.expect ?? [200]).includes(answer.status)) return yield* failure(endpoint, received)
  return received
})

// The body, or undefined once it passes `limit` bytes
async function bounded(response: Response, limit: number) {
  if (Number(response.headers.get("content-length") ?? 0) > limit) return undefined
  const chunks: Uint8Array[] = []
  const total = { bytes: 0 }
  for await (const chunk of response.body ?? []) {
    total.bytes += chunk.length
    if (total.bytes > limit) return undefined
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

// The capability an `agent_*` refusal says was missing
const needed: Record<string, "edit" | "person"> = { agent_suggest_only: "edit", agent_forbidden: "person" }

const failure = Effect.fnUntraced(function* (
  endpoint: string,
  response: { status: number; headers: Headers; body: Uint8Array },
) {
  const body = Schema.decodeUnknownOption(Schema.fromJsonString(DriveErrorBody))(
    new TextDecoder().decode(response.body),
  )
  const found = body._tag === "Some" ? body.value : undefined
  const message = found?.message ?? `status ${response.status}`
  const errorKey = found?.error_key
  if (response.status === 401) return yield* new Unauthorized({ endpoint, message, errorKey })
  if (response.status === 429)
    return yield* new RateLimited({
      endpoint,
      message,
      retryAfterMs: retryAfter(response.headers, yield* Clock.currentTimeMillis),
    })
  if (response.status >= 500) return yield* new Unreachable({ endpoint, message, status: response.status })
  if (response.status === 404) return yield* new NotFound({ endpoint, message, errorKey })
  if (response.status === 403 && errorKey?.startsWith("agent_"))
    return yield* new AgentRefused({ endpoint, message, errorKey, capability: needed[errorKey] })
  if (response.status === 403) return yield* new Forbidden({ endpoint, message, errorKey })
  if (response.status === 409)
    return yield* new Conflict({
      endpoint,
      message,
      errorKey,
      headRevisionId: found?.head_revision_id ?? found?.detail?.head_revision_id,
      headContentSha256: found?.head_content_sha256 ?? found?.detail?.head_content_sha256,
      baseRevisionId: found?.base_revision_id ?? found?.detail?.base_revision_id,
    })
  return yield* new Protocol({ endpoint, message, status: response.status, errorKey })
})

const decode = <A>(endpoint: string, schema: Schema.Decoder<A>, body: Uint8Array, status: number) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(new TextDecoder().decode(body)).pipe(
    Effect.mapError((error) => {
      const first = SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues[0]
      const path = (first?.path ?? []).map((segment) => String(typeof segment === "object" ? segment.key : segment))
      return new Protocol({
        endpoint,
        message: first?.message ?? error.message,
        status,
        path: path.length === 0 ? undefined : path.join("."),
      })
    }),
  )

// `Retry-After` is either whole seconds or an HTTP date (always in GMT); anything else is unreadable, not "now".
function retryAfter(headers: Headers, now: number) {
  const value = headers.get("retry-after")?.trim()
  if (value === undefined) return undefined
  if (/^\d+$/.test(value)) return Number(value) * 1000
  if (!value.endsWith("GMT")) return undefined
  const at = Date.parse(value)
  return Number.isNaN(at) ? undefined : Math.max(0, at - now)
}

// The account's base URL as the rest of the package checks it: https, or http on loopback only.
const base = Effect.fnUntraced(function* (baseUrl: string) {
  const url = URL.canParse(baseUrl) ? new URL(baseUrl) : undefined
  const local = url !== undefined && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  if (
    url === undefined ||
    !(url.protocol === "https:" || (url.protocol === "http:" && local)) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  )
    return yield* new Protocol({ endpoint: "base URL", message: "the instance URL must use https unless it is local" })
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`
})
