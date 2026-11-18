export * as DriveFake from "./fake"

import { createHash, randomUUID } from "node:crypto"
import { fail, type Backend } from "./backend"
import type { Comment, Document, Failure, Folder, Proposal, Revision } from "./contract"

export interface Options {
  /** The signed-in user's id: what the fake writes as owner and author. */
  user?: string
  now?: () => number
  /** Lists by conversation (`byContext`), as an instance with P3 will. */
  contexts?: boolean
}

export interface Fake extends Backend {
  /** Answers every call with this failure until it is set back to undefined: signed out, offline. */
  down(failure: Failure | undefined): void
  /** Caps agents at `suggest`: a write that does not propose answers `suggest`. */
  suggestOnly(on: boolean): void
  /** How many calls reached the backend, by method. */
  readonly calls: Readonly<Record<string, number>>
}

type Entry = {
  document: Document
  bytes: Uint8Array
  revisions: Revision[]
  comments: Comment[]
  proposals: Proposal[]
  contexts: string[]
}

/**
 * An in-memory Drive that behaves as the instance (0.83) does where DynWork can tell: a document created by upload
 * has an unnamed first revision, a comment anchors to a node of the outline only, an agent capped at `suggest` may
 * only propose, and a cell range or PDF point is refused. For the conformance suite, the service's tests and the
 * views' tests.
 */
export function make(options: Options = {}): Fake {
  const user = options.user ?? "user-1"
  const now = options.now ?? Date.now
  const folders = new Map<string, Folder>()
  const entries = new Map<string, Entry>()
  const switches: { down?: Failure; suggestOnly: boolean } = { suggestOnly: false }
  const calls: Record<string, number> = {}

  const revise = (entry: Entry, bytes: Uint8Array, attribution: { message?: string; contextId?: string }) => {
    const revision: Revision = {
      id: randomUUID(),
      document: entry.document.id,
      parent: entry.revisions[0]?.id,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      author: user,
      actor: "agent",
      origin: "api",
      message: attribution.message,
      created: now(),
    }
    entry.revisions.unshift(revision)
    entry.bytes = bytes
    entry.document = { ...entry.document, revision: revision.id, updated: revision.created, size: bytes.length }
    if (attribution.contextId !== undefined) entry.contexts.push(attribution.contextId)
    return revision
  }
  const found = (id: string) => entries.get(id) ?? fail("not-found", "It is not in the Drive.")
  const nodes = (entry: Entry) =>
    new TextDecoder()
      .decode(entry.bytes)
      .split("\n")
      .filter((line) => line.trim())
      .map((text, index) => ({ id: `n${index + 1}`, hash: hash(text), text }))
  const page = (entry: Entry, html: string, revision?: string) => {
    if (revision !== undefined && !entry.revisions.some((item) => item.id === revision))
      return fail("not-found", "No such revision.")
    return {
      html,
      csp: "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      revision: revision ?? entry.document.revision,
      sha256: entry.revisions[0]?.sha256,
    }
  }
  // A new document and its first revision, which 0.83 leaves unnamed whether it comes from a file or a template.
  const add = (input: {
    name: string
    bytes: Uint8Array
    mime: string
    format: string
    folder?: string
    template?: string
    contextId?: string
  }) => {
    const id = randomUUID()
    const entry: Entry = {
      document: {
        id,
        name: input.name,
        format: input.format,
        mime: input.mime,
        folder: input.folder,
        owner: user,
        mine: true,
        access: "own",
        size: 0,
        revision: "",
        template: input.template,
        created: now(),
        updated: now(),
      },
      bytes: new Uint8Array(),
      revisions: [],
      comments: [],
      proposals: [],
      contexts: [],
    }
    entries.set(id, entry)
    const revision = revise(entry, input.bytes, { contextId: input.contextId })
    return { document: entry.document, revision }
  }
  const writable = (mode?: "land" | "propose") =>
    switches.suggestOnly && mode !== "propose" ? fail("suggest", "Agents may only suggest here.") : undefined

  // Every method goes through here: counted, and answering the `down` failure while one is set.
  function method<A extends unknown[], R>(name: string, body: (...args: A) => R | Failure) {
    return async (...args: A): Promise<R | Failure> => {
      calls[name] = (calls[name] ?? 0) + 1
      return switches.down ?? body(...args)
    }
  }

  const backend: Backend = {
    list: method("list", (query) => {
      const scope = query.scope ?? "mine"
      const text = query.query?.toLowerCase()
      const matching = [...entries.values()]
        .map((entry) => entry.document)
        .filter((document) => {
          if (scope === "folder") return document.folder === query.folder
          if (scope === "mine") return document.mine
          if (scope === "shared") return !document.mine
          return true
        })
        .filter((document) => text === undefined || document.name.toLowerCase().includes(text))
        .toSorted((a, b) => (query.sort === "name" ? a.name.localeCompare(b.name) : b.updated - a.updated))
      const start = Number(query.cursor ?? 0)
      const end = start + (query.limit ?? 50)
      return {
        folders: scope === "folder" ? [...folders.values()].filter((folder) => folder.parent === query.folder) : [],
        documents: matching.slice(start, end),
        next: end < matching.length ? String(end) : undefined,
      }
    }),
    folders: method("folders", () => [...folders.values()]),
    get: method("get", (id) => {
      const entry = found(id)
      if (!("document" in entry)) return entry
      const head = entry.revisions[0]
      if (!head) return fail("failed", "A document without revisions.")
      return {
        document: entry.document,
        head,
        access: "own",
        path: entry.document.folder === undefined ? undefined : folders.get(entry.document.folder)?.name,
      }
    }),
    rendered: method("rendered", (id, revision) => {
      const entry = found(id)
      if (!("document" in entry)) return entry
      if (entry.document.format !== "html") return fail("unsupported", "Only an HTML document renders as designed.")
      return page(entry, new TextDecoder().decode(entry.bytes), revision)
    }),
    preview: method("preview", (id, revision) => {
      const entry = found(id)
      if (!("document" in entry)) return entry
      return page(entry, `<p>${new TextDecoder().decode(entry.bytes)}</p>`, revision)
    }),
    pdf: method("pdf", (id) => {
      const entry = found(id)
      if (!("document" in entry)) return entry
      return { bytes: new TextEncoder().encode(`%PDF-1.7 ${entry.document.name}`), revision: entry.document.revision }
    }),
    outline: method("outline", (id) => {
      const entry = found(id)
      if (!("document" in entry)) return entry
      return { revision: entry.document.revision, format: entry.document.format, nodes: nodes(entry) }
    }),
    revisions: method("revisions", (id) => {
      const entry = found(id)
      return "document" in entry ? [...entry.revisions] : entry
    }),
    proposals: method("proposals", (id) => {
      const entry = found(id)
      return "document" in entry ? [...entry.proposals] : entry
    }),
    comments: method("comments", (id) => {
      const entry = found(id)
      return "document" in entry ? [...entry.comments] : entry
    }),
    access: method("access", (id) => {
      const entry = found(id)
      if (!("document" in entry)) return entry
      return { owner: entry.document.owner, access: "own", grants: [], inherited: [] }
    }),
    agentCap: method("agentCap", (target) => {
      const known = target.kind === "document" ? entries.has(target.id) : folders.has(target.id)
      if (!known) return fail("not-found", "It is not in the Drive.")
      const cap = switches.suggestOnly ? "suggest" : "edit"
      return { cap, policy: cap, unattended: "suggest" }
    }),
    createFolder: method("createFolder", (input) => {
      if (input.parent !== undefined && !folders.has(input.parent)) return fail("not-found", "No such folder.")
      const blocked = writable()
      if (blocked) return blocked
      const folder: Folder = {
        id: randomUUID(),
        name: input.name,
        parent: input.parent,
        owner: user,
        mine: true,
        created: now(),
        updated: now(),
      }
      folders.set(folder.id, folder)
      return folder
    }),
    upload: method("upload", (input) => {
      if (input.folder !== undefined && !folders.has(input.folder)) return fail("not-found", "No such folder.")
      const blocked = writable()
      if (blocked) return blocked
      const mime = input.mime ?? "application/octet-stream"
      return add({ ...input, mime, format: formatOf(input.name, mime) })
    }),
    create: method("create", (input) => {
      if (input.folder !== undefined && !folders.has(input.folder)) return fail("not-found", "No such folder.")
      const blocked = writable()
      if (blocked) return blocked
      const made = templates[input.template]
      if (!made) return fail("invalid", "No such template.")
      return add({ ...input, ...made, bytes: new TextEncoder().encode(`${input.name}\n`) })
    }),
    edit: method("edit", (id, input) => {
      const entry = found(id)
      if (!("document" in entry)) return entry
      const blocked = writable(input.mode)
      if (blocked) return blocked
      const added = input.ops.map((op) => (typeof op.markdown === "string" ? op.markdown : "")).join("\n")
      const bytes = new TextEncoder().encode(`${new TextDecoder().decode(entry.bytes)}\n${added}`)
      const head = entry.document.revision
      if (input.mode === "propose") {
        const revision: Revision = { ...entry.revisions[0]!, id: randomUUID(), parent: head, message: input.message }
        const proposal: Proposal = {
          id: randomUUID(),
          document: id,
          base: head,
          proposed: revision.id,
          proposer: user,
          actor: "agent",
          status: "open",
          message: input.message,
          created: now(),
        }
        entry.proposals.push(proposal)
        if (input.contextId !== undefined) entry.contexts.push(input.contextId)
        return { kind: "proposed" as const, proposal, revision }
      }
      const merged = input.base !== undefined && input.base !== head ? head : undefined
      return { kind: "landed" as const, revision: revise(entry, bytes, input), merged }
    }),
    comment: method("comment", (id, input) => {
      const entry = found(id)
      if (!("document" in entry)) return entry
      if (input.anchor.kind !== "node") return fail("unsupported", "This kind of comment is not available yet.")
      const anchor = { node: input.anchor.node, find: input.anchor.find }
      if (!nodes(entry).some((node) => node.id === anchor.node))
        return fail("conflict", "The commented text is gone.", entry.document.revision)
      const comment: Comment = { id: randomUUID(), anchor, author: user, body: input.body, created: now() }
      entry.comments.push(comment)
      return comment
    }),
    reply: method("reply", (id, input) => {
      const entry = found(id)
      if (!("document" in entry)) return entry
      const parent = entry.comments.find((comment) => comment.id === input.parent)
      if (!parent) return fail("not-found", "No such comment.")
      const comment: Comment = {
        id: randomUUID(),
        anchor: parent.anchor,
        author: user,
        body: input.body,
        parent: parent.id,
        created: now(),
      }
      entry.comments.push(comment)
      return comment
    }),
    resolve: method("resolve", (id, target) => {
      const entry = found(id)
      if (!("document" in entry)) return entry
      const index = entry.comments.findIndex((comment) => comment.id === target)
      const comment = entry.comments[index]
      if (!comment) return fail("not-found", "No such comment.")
      const resolved = { ...comment, resolved: comment.resolved ?? now(), resolver: comment.resolver ?? user }
      entry.comments[index] = resolved
      return resolved
    }),
  }

  return {
    ...backend,
    ...(options.contexts
      ? {
          byContext: method("byContext", (context: string) =>
            [...entries.values()]
              .filter((entry) => entry.contexts.includes(context))
              .map((entry) => entry.document)
              .toSorted((a, b) => b.updated - a.updated),
          ),
        }
      : {}),
    down: (failure) => {
      switches.down = failure
    },
    suggestOnly: (on) => {
      switches.suggestOnly = on
    },
    calls,
  }
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 8)

// The format the instance gives a file, from its type and then its name.
function formatOf(name: string, mime: string) {
  const bare = mime.split(";")[0]
  if (bare === "text/html") return "html"
  if (bare === "text/markdown") return "markdown"
  if (bare === "application/pdf") return "pdf"
  return name.split(".").pop()?.toLowerCase() ?? "binary"
}

// The templates the fake makes documents from: Dynapps' and the core's blank Markdown (C9).
const templates: Record<string, { format: string; mime: string }> = {
  "dynapps-word": { format: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  "dynapps-sheet": { format: "xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  "dynapps-deck": { format: "pptx", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
  "dynapps-html": { format: "html", mime: "text/html" },
  "blank-markdown": { format: "markdown", mime: "text/markdown" },
}
