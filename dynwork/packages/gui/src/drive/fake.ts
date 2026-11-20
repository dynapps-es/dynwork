export * as DriveFake from "./fake"

import { createHash, randomUUID } from "node:crypto"
import { fail, type Backend } from "./backend"
import {
  isFailure,
  type Access,
  type Comment,
  type Document,
  type Failure,
  type Folder,
  type Proposal,
  type Revision,
} from "./contract"
import { DriveCells } from "./cells"
import { DriveMentions } from "./mentions"

export interface Options {
  /** The signed-in user's id: what the fake writes as owner and author. */
  user?: string
  now?: () => number
  /** Lists by conversation (`byContext`) whatever its version, as 0.84 does (`scope=context`). */
  contexts?: boolean
  /** Refuses a folder whose name a sibling already has (`name_taken`), as 0.84 does; 0.83 makes a second one. */
  nameTaken?: boolean
  /** The people the instance names by id (`people`), by user id. */
  people?: Record<string, string>
  /**
   * The core it answers as: `0.83` (the default), or `0.84`, which announces the Drive in its discovery, keeps the
   * message of a document it creates, records each write's conversation and agent, refuses a conversation it did not
   * issue (`unknown-context`), reopens a resolved comment, takes a comment on a cell range of a sheet and lists what a
   * conversation wrote a revision or a comment on (`byContext`).
   */
  version?: "0.83" | "0.84"
}

/** The agent 0.84 records for a write of DynWork's token, which has no purpose: its OAuth client. */
export const agent = "sp_bridge"

/** The OAuth client 0.84 records for a write of the person's own session (G01). */
export const personClient = "dynwork-desktop"

export interface Fake extends Backend {
  /** Answers every call with this failure until it is set back to undefined: signed out, offline. */
  down(failure: Failure | undefined): void
  /** Caps agents at `suggest`: a write that does not propose answers `suggest`. */
  suggestOnly(on: boolean): void
  /**
   * Lets the attended agent share the documents it made, as the Dynapps extension does from 0.85; off (the start), a
   * share or a revocation answers `person`, as 0.83 does. Every document of the fake is the agent's.
   */
  agentShare(on: boolean): void
  /** Holds bytes as the instance holds what the agent's `documents_upload` sent, and answers the `blob_ref` to import. */
  stage(bytes: Uint8Array, mime: string): string
  /** Says to every open `stream` that someone was mentioned, as the instance does for a comment that mentions. */
  announce(heard: DriveMentions.Heard): void
  /** Says to every open `stream` that the Drive changed, as 0.84 does after a revision lands (`document.drive.changed`). */
  changed(): void
  /** The conversations registered (`createContext`): title by id. */
  readonly contexts: ReadonlyMap<string, string>
  /**
   * The same Drive through the person's own session (G01): what it writes is the person's (`actor: user`, no agent, the
   * client `dynwork-desktop`, as 0.84 records it),
   * the agent rules do not apply (`agentShare`, `suggestOnly`), and the owner's actions (`trash`, `transfer`,
   * `revokeAll`, `restore`) go through, which DynWork's agent is refused as `person`.
   */
  person(): Backend
  /** The methods the person's backend ran, in order. */
  readonly acted: readonly string[]
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
 * An in-memory Drive that behaves as the instance (0.83, or 0.84 with `version`) does where DynWork can tell: a document created by upload
 * has an unnamed first revision, a comment anchors to a node of the outline (and from 0.84 to a cell range of a sheet
 * node), and an agent capped at `suggest` may only propose. For the conformance suite, the service's tests and the
 * views' tests.
 */
export function make(options: Options = {}): Fake {
  const user = options.user ?? "user-1"
  const now = options.now ?? Date.now
  const at84 = options.version === "0.84"
  const folders = new Map<string, Folder>()
  const entries = new Map<string, Entry>()
  const switches: { down?: Failure; suggestOnly: boolean; agentShare: boolean } = {
    suggestOnly: false,
    agentShare: false,
  }
  // Set while a method of the person's backend runs (`person`): its bodies run before their first await, so the flag
  // covers exactly that call.
  const acting = { person: false }
  const acted: string[] = []
  const owners = () =>
    acting.person ? undefined : fail("person", "Governance keeps this to a person: do it in Governance.")
  // The grants of each document, by document id.
  const grants = new Map<string, Access["grants"][number][]>()
  const shareable = (id: string) => {
    const entry = found(id)
    if (!("document" in entry)) return entry
    if (!switches.agentShare && !acting.person)
      return fail("person", "Governance keeps this to a person: do it in Governance.")
    return undefined
  }
  const calls: Record<string, number> = {}
  // What 0.84 records of a comment: the agent of the token, the conversation and the client.
  const attributed = (contextId: string | undefined) =>
    at84
      ? {
          ...(acting.person ? { client: personClient } : { via: agent, client: agent }),
          ...(contextId === undefined ? {} : { context: contextId }),
        }
      : {}
  const blobs = new Map<string, { bytes: Uint8Array; mime: string }>()
  const contexts = new Map<string, string>()
  // The open streams: each a queue of what was announced and the way to wake its reader.
  const streams = new Set<{ queue: DriveMentions.Streamed[]; wake: () => void }>()
  const send = (event: DriveMentions.Streamed) =>
    streams.forEach((stream) => {
      stream.queue.push(event)
      stream.wake()
    })
  const announce = (heard: DriveMentions.Heard) => send({ kind: "mentioned", ...heard })
  // What the instance does with a comment: it keeps the body as written, and refuses a mention option for a user the
  // body does not mention; the reader sees `@Agent` for the user's own mention (`DriveMentions.read`).
  const spoken = (body: string, agent: boolean | undefined) =>
    agent && !body.includes(`](user:${user})`)
      ? fail("invalid", "Every mention must appear in the body.")
      : { stored: body, ...DriveMentions.read(body, user) }

  const revise = (entry: Entry, bytes: Uint8Array, attribution: { message?: string; contextId?: string }) => {
    const revision: Revision = {
      id: randomUUID(),
      document: entry.document.id,
      parent: entry.revisions[0]?.id,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      author: user,
      actor: acting.person ? "user" : "agent",
      origin: "api",
      message: attribution.message,
      created: now(),
      ...(at84
        ? {
            ...(acting.person ? { client: personClient } : { agent, client: agent }),
            ...(attribution.contextId === undefined ? {} : { context: attribution.contextId }),
          }
        : {}),
    }
    entry.revisions.unshift(revision)
    entry.bytes = bytes
    entry.document = { ...entry.document, revision: revision.id, updated: revision.created, size: bytes.length }
    if (attribution.contextId !== undefined) entry.contexts.push(attribution.contextId)
    return revision
  }
  const found = (id: string) => entries.get(id) ?? fail("not-found", "It is not in the Drive.")
  // 0.84 writes nothing for a conversation it did not issue to the user.
  const unknown = (contextId: string | undefined) =>
    at84 && contextId !== undefined && !contexts.has(contextId)
      ? fail("unknown-context", "Governance does not know the conversation this write named.")
      : undefined
  // What 0.84 tells its owner of a write's conversation: its title, as it is now.
  const told = <A extends { context?: string }>(item: A): A => {
    const name = item.context === undefined ? undefined : contexts.get(item.context)
    return name === undefined ? item : { ...item, conversation: name }
  }
  const accessOf = (id: string): Access | Failure => {
    const entry = found(id)
    if (!("document" in entry)) return entry
    return { owner: entry.document.owner, access: "own", grants: [...(grants.get(id) ?? [])], inherited: [] }
  }
  // A node per line that is not blank, `n1` first. A spreadsheet's lines are sheets and rows, as the core names them: a
  // line without a tab is a sheet (`sheet[<line>]`), each line with tabs a row of the sheet above it.
  const nodes = (entry: Entry) => {
    const lines = new TextDecoder()
      .decode(entry.bytes)
      .split("\n")
      .filter((line) => line.trim())
    if (!spreadsheet(entry.document.format))
      return lines.map((text, index) => ({ id: `n${index + 1}`, hash: hash(text), text }))
    const sheet = { id: "", rows: 0 }
    return lines.map((text) => {
      if (text.includes("\t")) {
        sheet.rows += 1
        return { id: `${sheet.id}/row[${sheet.rows}]`, hash: hash(text), text }
      }
      Object.assign(sheet, { id: `sheet[${text.replace(/]/g, "\\]")}]`, rows: 0 })
      return { id: sheet.id, hash: hash(text), text }
    })
  }
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
  // A new document and its first revision, which 0.83 leaves unnamed whether it comes from a file or a template; 0.84
  // keeps the message it is sent.
  const add = (input: {
    name: string
    bytes: Uint8Array
    mime: string
    format: string
    folder?: string
    template?: string
    contextId?: string
    message?: string
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
    const revision = revise(entry, input.bytes, {
      contextId: input.contextId,
      message: at84 ? input.message : undefined,
    })
    return { document: entry.document, revision: told(revision) }
  }
  const writable = (mode?: "land" | "propose") =>
    switches.suggestOnly && mode !== "propose" && !acting.person
      ? fail("suggest", "Agents may only suggest here.")
      : undefined

  // Every method goes through here: counted, and answering the `down` failure while one is set.
  function method<A extends unknown[], R>(name: string, body: (...args: A) => R | Failure) {
    return async (...args: A): Promise<R | Failure> => {
      calls[name] = (calls[name] ?? 0) + 1
      return switches.down ?? body(...args)
    }
  }

  const backend: Backend = {
    discovery: method("discovery", () =>
      at84 ? { version: "0.84.0", documents: true } : { version: "0.83.0", documents: false },
    ),
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
      if (scope === "folder" && query.folder !== undefined && !folders.has(query.folder))
        return fail("not-found", "No such folder.")
      const start = Number(query.cursor ?? 0)
      const end = start + (query.limit ?? 50)
      return {
        folders: scope === "folder" ? [...folders.values()].filter((folder) => folder.parent === query.folder) : [],
        documents: matching.slice(start, end),
        next: end < matching.length ? String(end) : undefined,
      }
    }),
    folders: method("folders", () => [...folders.values()]),
    children: method("children", (parent?: string) => {
      if (parent !== undefined && !folders.has(parent)) return fail("not-found", "No such folder.")
      return [...folders.values()].filter((folder) => folder.parent === parent)
    }),
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
    content: method("content", (id, revision) => {
      const entry = found(id)
      if (!("document" in entry)) return entry
      if (revision !== undefined && !entry.revisions.some((item) => item.id === revision))
        return fail("not-found", "No such revision.")
      return {
        bytes: entry.bytes,
        revision: revision ?? entry.document.revision,
        sha256: entry.revisions[0]?.sha256,
      }
    }),
    pdf: method("pdf", (id, revision) => {
      const entry = found(id)
      if (!("document" in entry)) return entry
      if (revision !== undefined && !entry.revisions.some((item) => item.id === revision))
        return fail("not-found", "No such revision.")
      return {
        bytes: new TextEncoder().encode(`%PDF-1.7 ${entry.document.name}`),
        revision: revision ?? entry.document.revision,
      }
    }),
    outline: method("outline", (id) => {
      const entry = found(id)
      if (!("document" in entry)) return entry
      return { revision: entry.document.revision, format: entry.document.format, nodes: nodes(entry) }
    }),
    revisions: method("revisions", (id) => {
      const entry = found(id)
      return "document" in entry ? entry.revisions.map(told) : entry
    }),
    proposals: method("proposals", (id) => {
      const entry = found(id)
      return "document" in entry ? [...entry.proposals] : entry
    }),
    comments: method("comments", (id) => {
      const entry = found(id)
      return "document" in entry ? entry.comments.map(told) : entry
    }),
    access: method("access", (id) => accessOf(id)),
    share: method("share", (id: string, input: { kind: string; value: string; level: string; until?: string }) => {
      const refused = shareable(id)
      if (refused) return refused
      const name = input.kind === "user" ? options.people?.[input.value] : input.value
      if (name === undefined) return fail("invalid", "No such person.")
      const list = grants.get(id) ?? []
      const kept = list.find((grant) => grant.subject === input.kind && grant.value === input.value)
      const made = { id: kept?.id ?? randomUUID(), subject: input.kind, value: input.value, name, level: input.level }
      grants.set(id, [...list.filter((grant) => grant !== kept), made])
      return accessOf(id)
    }),
    unshare: method("unshare", (id: string, grant: string) => {
      const refused = shareable(id)
      if (refused) return refused
      const list = grants.get(id) ?? []
      if (!list.some((item) => item.id === grant)) return fail("not-found", "No such grant.")
      grants.set(
        id,
        list.filter((item) => item.id !== grant),
      )
      return accessOf(id)
    }),
    revokeAll: method("revokeAll", (id: string) => {
      const refused = owners()
      if (refused) return refused
      const entry = found(id)
      if (!("document" in entry)) return entry
      grants.set(id, [])
      return accessOf(id)
    }),
    transfer: method("transfer", (id: string, to: string) => {
      const refused = owners()
      if (refused) return refused
      const entry = found(id)
      if (!("document" in entry)) return entry
      if (options.people?.[to] === undefined) return fail("invalid", "No such person.")
      entry.document = { ...entry.document, owner: to, mine: to === user, access: "edit" }
      return entry.document
    }),
    trash: method("trash", (id: string) => {
      const refused = owners()
      if (refused) return refused
      if (!entries.delete(id)) return fail("not-found", "It is not in the Drive.")
      return undefined
    }),
    restore: method("restore", (id: string, at: string) => {
      const refused = owners()
      if (refused) return refused
      const entry = found(id)
      if (!("document" in entry)) return entry
      if (!entry.revisions.some((item) => item.id === at)) return fail("not-found", "No such revision.")
      return told(revise(entry, entry.bytes, {}))
    }),
    review: method("review", (id: string, target: string, input: { accept: boolean; note?: string }) => {
      const entry = found(id)
      if (!("document" in entry)) return entry
      const index = entry.proposals.findIndex((item) => item.id === target)
      const open = entry.proposals[index]
      if (!open) return fail("not-found", "No such proposal.")
      if (open.status !== "open") return fail("conflict", "The proposal was already reviewed.")
      const landed = input.accept ? revise(entry, entry.bytes, { message: open.message }).id : undefined
      const reviewed: Proposal = {
        ...open,
        status: input.accept ? "accepted" : "rejected",
        reviewer: user,
        reviewed: now(),
        ...(input.note === undefined ? {} : { note: input.note }),
        ...(landed === undefined ? {} : { landed }),
      }
      entry.proposals[index] = reviewed
      return reviewed
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
      const taken = [...folders.values()].some((folder) => folder.parent === input.parent && folder.name === input.name)
      if (options.nameTaken && taken) return fail("conflict", "A folder of that name is already there.")
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
      const blocked = unknown(input.contextId) ?? writable()
      if (blocked) return blocked
      const mime = input.mime ?? "application/octet-stream"
      return add({ ...input, mime, format: formatOf(input.name, mime) })
    }),
    importBlob: method("importBlob", (input) => {
      if (input.folder !== undefined && !folders.has(input.folder)) return fail("not-found", "No such folder.")
      const blocked = unknown(input.contextId) ?? writable()
      if (blocked) return blocked
      const blob = blobs.get(input.blob)
      if (!blob) return fail("invalid", "No such upload.")
      // The instance keeps one document of a name in a folder.
      const taken = [...entries.values()].some(
        (entry) => entry.document.name === input.name && entry.document.folder === input.folder,
      )
      if (taken) return fail("conflict", "A document of that name is already there.")
      return add({ ...input, ...blob, format: formatOf(input.name, blob.mime) })
    }),
    create: method("create", (input) => {
      if (input.folder !== undefined && !folders.has(input.folder)) return fail("not-found", "No such folder.")
      const blocked = unknown(input.contextId) ?? writable()
      if (blocked) return blocked
      const made = templates[input.template]
      if (!made) return fail("invalid", "No such template.")
      return add({ ...input, ...made, bytes: new TextEncoder().encode(`${input.name}\n`) })
    }),
    edit: method("edit", (id, input) => {
      const entry = found(id)
      if (!("document" in entry)) return entry
      const blocked = unknown(input.contextId) ?? writable(input.mode)
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
      return { kind: "landed" as const, revision: told(revise(entry, bytes, input)), merged }
    }),
    comment: method("comment", (id, input) => {
      const entry = found(id)
      if (!("document" in entry)) return entry
      // 0.83 anchors to a node only; 0.84 also to an A1 range of a sheet node (G08).
      if (input.anchor.kind === "range" && !at84)
        return fail("unsupported", "This kind of comment is not available yet.")
      const refused = unknown(input.contextId)
      if (refused) return refused
      const cells = input.anchor.kind === "range" ? DriveCells.parse(input.anchor.cells) : undefined
      if (cells && "refused" in cells) return fail("invalid", "Governance did not accept it.")
      if (cells && DriveCells.sheetOf(input.anchor.node) === undefined)
        return fail("invalid", "Governance did not accept it.")
      const anchor = cells
        ? { node: input.anchor.node, cells: cells.cells }
        : { node: input.anchor.node, find: input.anchor.kind === "node" ? input.anchor.find : undefined }
      const target = nodes(entry).find((node) => node.id === anchor.node)
      // The instance checks a quote against the node's own text, markers and all
      if (!target || (anchor.find !== undefined && !target.text.includes(anchor.find)))
        return fail("conflict", "The commented text is gone.", entry.document.revision)
      const said = spoken(input.body, input.agent)
      if (isFailure(said)) return said
      const comment: Comment = {
        id: randomUUID(),
        anchor,
        author: user,
        mine: true,
        body: said.text,
        ...(said.agent ? { agent: true } : {}),
        created: now(),
        ...attributed(input.contextId),
      }
      entry.comments.push(comment)
      if (input.agent) announce({ document: id, comment: comment.id, user, author: user })
      return told(comment)
    }),
    reply: method("reply", (id, input) => {
      const entry = found(id)
      if (!("document" in entry)) return entry
      const parent = entry.comments.find((comment) => comment.id === input.parent)
      if (!parent) return fail("not-found", "No such comment.")
      const refused = unknown(input.contextId)
      if (refused) return refused
      const said = spoken(input.body, input.agent)
      if (isFailure(said)) return said
      const comment: Comment = {
        id: randomUUID(),
        anchor: parent.anchor,
        author: user,
        mine: true,
        body: said.text,
        ...(said.agent ? { agent: true } : {}),
        parent: parent.id,
        created: now(),
        ...attributed(input.contextId),
      }
      entry.comments.push(comment)
      if (input.agent) announce({ document: id, comment: comment.id, user, author: user })
      return told(comment)
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
    // 0.84 clears the resolution and records who reopened it; an open comment comes back as it is. 0.83 has no route.
    reopen: method("reopen", (id, target) => {
      if (!at84) return fail("not-found", "No such route.")
      const entry = found(id)
      if (!("document" in entry)) return entry
      const index = entry.comments.findIndex((comment) => comment.id === target)
      const comment = entry.comments[index]
      if (!comment) return fail("not-found", "No such comment.")
      if (comment.resolved === undefined) return comment
      const reopened = {
        ...comment,
        resolved: undefined,
        resolver: undefined,
        reopened: now(),
        reopener: user,
        reopenedMine: true,
      }
      entry.comments[index] = reopened
      return reopened
    }),
    createContext: method("createContext", (name: string) => {
      if (!name.trim()) return fail("invalid", "A conversation needs a name.")
      const id = randomUUID()
      contexts.set(id, name)
      return id
    }),
    renameContext: method("renameContext", (id: string, name: string) => {
      if (!contexts.has(id)) return fail("not-found", "No such conversation.")
      contexts.set(id, name)
      return undefined
    }),
    people: method("people", (ids: readonly string[]) =>
      ids.flatMap((id) => {
        const name = options.people?.[id]
        return name === undefined ? [] : [{ id, name }]
      }),
    ),
    // As 0.84: every word of the query starts a word of the name, or the id starts with it.
    searchPeople: method("searchPeople", (query: string, limit = 10) =>
      Object.entries(options.people ?? {})
        .filter(([id, name]) => {
          const words = name.toLowerCase().split(/\s+/)
          const asked = query.toLowerCase().split(/\s+/).filter(Boolean)
          return id.startsWith(query) || asked.every((part) => words.some((word) => word.startsWith(part)))
        })
        .slice(0, limit)
        .map(([id, name]) => ({ id, name })),
    ),
    findPeople: method("findPeople", (query: string, limit = 20) =>
      Object.entries(options.people ?? {})
        // As 0.83.0: by name, never by id.
        .filter((entry) => entry[1].toLowerCase().startsWith(query.toLowerCase()))
        .slice(0, limit)
        .map(([id, name]) => ({ id, name })),
    ),
  }

  // The person's session over the same Drive: each method runs with `acting.person` set for its body.
  const person = () =>
    Object.fromEntries(
      Object.entries(backend).map(([name, call]) => [
        name,
        (...args: unknown[]) => {
          acting.person = true
          acted.push(name)
          // SAFETY: `call` is this backend's own method under its own name, called with the arguments it was given.
          const answer = (call as (...input: unknown[]) => Promise<unknown>)(...args)
          acting.person = false
          return answer
        },
      ]),
    ) as unknown as Backend

  return {
    ...backend,
    person,
    acted,
    stream: method("stream", (signal: AbortSignal) => stream(streams, signal)),
    announce,
    changed: () => send({ kind: "changed" }),
    contexts,
    ...(options.contexts || at84
      ? {
          // As 0.84's `scope=context`: what the conversation wrote a revision or a comment on, newest first; a
          // conversation it did not issue to the user is `unknown-context`.
          byContext: method("byContext", (context: string) =>
            at84 && !contexts.has(context)
              ? fail("unknown-context", "Governance does not know this conversation.")
              : [...entries.values()]
                  .filter(
                    (entry) =>
                      entry.contexts.includes(context) || entry.comments.some((comment) => comment.context === context),
                  )
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
    agentShare: (on) => {
      switches.agentShare = on
    },
    stage: (bytes, mime) => {
      const ref = createHash("sha256").update(bytes).digest("hex")
      blobs.set(ref, { bytes, mime })
      return ref
    },
    calls,
  }
}

// A stream: what is announced while it is open, until `signal` aborts.
function stream(open: Set<{ queue: DriveMentions.Streamed[]; wake: () => void }>, signal: AbortSignal) {
  const state = { wake: () => {} }
  const mine = { queue: [] as DriveMentions.Streamed[], wake: () => state.wake() }
  open.add(mine)
  signal.addEventListener("abort", () => state.wake(), { once: true })
  return (async function* () {
    try {
      while (!signal.aborted) {
        const next = mine.queue.shift()
        if (next) yield next
        else await new Promise<void>((resolve) => (state.wake = resolve))
      }
    } finally {
      open.delete(mine)
    }
  })()
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 8)

// The formats the instance reads as sheets: a comment there may anchor to a cell range (0.84).
const spreadsheet = (format: string) => format === "xlsx" || format === "ods"

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
