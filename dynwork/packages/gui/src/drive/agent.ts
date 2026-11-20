export * as DriveAgent from "./agent"

import { DynWorkDocuments } from "@dynwork/server-plugin/documents"
import type { OpenCodeClient } from "@opencode/client/promise"
import type { MainContext } from "@opencode/plugin/gui/main"
import { Schema } from "effect"
import { basename } from "node:path"
import type { Backend } from "./backend"
import { DriveCapabilities } from "./capabilities"
import { isFailure, type Created, type Failure } from "./contract"
import type { DriveIpc } from "./ipc"

// What the agent does with the instance's `documents` MCP server, on the Drive's side (D4, D8). The server plugin
// watches the tools' calls (`@dynwork/server-plugin/documents`) and tells main: before a write, so that a new document
// lands in the conversation's folder and its revision names the conversation, and so that an edit by ops of an HTML
// page, which would strip its scripts, is refused (D21); after one, so that the document enters the conversation's
// index and a page the agent uploaded is imported with its scripts (C7).
//
// On 0.84 the agent does it through the MCP:
// - `mcpFolders`: it makes the conversation's folders with `documents_folder` and imports its upload with
//   `documents_import`; DynWork makes no folder and imports nothing. It names the project's and the conversation's
//   folders as it does itself before 0.84 (`folderName`), keeps the conversation's once made, fills it in when the
//   agent leaves it out, and tells the agent which folder a `name_taken` refusal meant.
// - `rawHtmlByMcp`: it rewrites a page whole with `documents_edit {content_blob_ref}`, an edit of that document like any
//   other, and an edit by ops of a page goes to the instance, which refuses one that would strip it.
// - `contextByMcp`: each write carries the context DynWork registered for its conversation, the one its own session
//   maps to, never another's.

/** The conversation as the Drive's folders name it. */
export interface Session {
  /** The session's directory: its project is named after it. */
  directory: string
  title?: string
}

export interface Options {
  /** The service's `using`, `changing`, `record`, `folder`, `author`, `attributed`, `message`, `stale` and `capabilities`. */
  service: Pick<
    DriveIpc.Service,
    "using" | "changing" | "record" | "folder" | "author" | "attributed" | "message" | "stale" | "capabilities"
  >
  /** A conversation's session, or undefined when the service does not know it. */
  session: (id: string) => Promise<Session | undefined>
  /** What a conversation without a title is called. */
  untitled: string
  /** Sends the plugin what to add to the write it asked about. */
  answer: (answer: DynWorkDocuments.Answer) => Promise<unknown>
}

/** The root folder every conversation's files live under (D8): `Artifacts/<project>/<conversation>`. */
export const root = "Artifacts"

/** How many names an import tries when the folder already holds the page's own. */
const attempts = 9

/** What the agent is told when DynWork refuses its edit of an HTML page (D21). */
export const htmlRefused = [
  "Dynwork did not send this edit: the document is an HTML page, and an edit by ops would strip its scripts and styles.",
  "Upload the whole changed page with documents_upload (mime text/html, a name ending in .html) instead: Dynwork",
  "imports it as a document of this conversation, scripts kept.",
].join(" ")

export function make(options: Options) {
  const service = options.service
  // Folders are made one conversation at a time: two writes of a program run together must find one folder, not make two.
  const folders = { tail: Promise.resolve() as Promise<unknown> }
  const serial = <A>(work: () => Promise<A>) => {
    const done = folders.tail.then(work, work)
    folders.tail = done.catch(() => undefined)
    return done
  }
  // What was imported, so that a call seen twice is not imported twice.
  const imported = new Set<string>()
  // The project's folder name: the session directory's.
  const projectOf = (session: Session) => clean(basename(session.directory)) ?? options.untitled
  // The agent's `documents_folder` creates named as a conversation's folder (0.84), by call id, with that conversation:
  // the folder it makes, or the one of that name a `name_taken` refusal points to, becomes the conversation's.
  const naming = new Map<string, string>()

  /** What to add to the write the plugin is about to run: where a new document goes, what its revision says, whose it is. */
  async function ask(request: DynWorkDocuments.Ask) {
    const answer = await answered(request).catch(() => ({}))
    await options.answer({ id: request.id, ...answer })
  }

  async function answered(request: DynWorkDocuments.Ask): Promise<Omit<DynWorkDocuments.Answer, "id">> {
    if (request.verb === "folder") return request.making ? named(request) : taken(request)
    if (await refused(request)) return { refuse: htmlRefused }
    const session = await options.session(request.session)
    if (!session) return {}
    const conversation = { id: request.session, name: clean(session.title) ?? options.untitled }
    const capabilities = service.capabilities()
    const placed = request.verb === "create" || request.verb === "import"
    // Before 0.84 DynWork makes the conversation's folder (an import is 0.84's, but the switch may not be read yet).
    const filing = placed ? DriveCapabilities.agentFiling(capabilities) : undefined
    const signed = request.verb === "create" || request.verb === "edit" || request.verb === "import"
    const answer = await service.using(async (backend, account) => {
      // With the conversation in the call (0.84), it is registered on the way, like for DynWork's own writes.
      const author = capabilities.contextByMcp
        ? await service.author(backend, account, conversation)
        : { contextId: undefined, message: service.message(account, conversation) }
      const folder =
        filing === "rest"
          ? await serial(() => place(backend, account.id, conversation, session))
          : filing === "mcp"
            ? service.folder.get(account.id, conversation.id)
            : undefined
      return {
        ...(signed && author.message !== undefined ? { message: author.message } : {}),
        ...(author.contextId === undefined ? {} : { context: author.contextId }),
        ...(folder === undefined || isFailure(folder) ? {} : { folder }),
      }
    })
    return isFailure(answer) ? {} : answer
  }

  /**
   * The folder of that name already there, where the agent's `documents_folder` was refused as `name_taken` (0.84). When
   * the refused folder was the conversation's (`named`), the one there becomes it.
   */
  async function taken(request: DynWorkDocuments.Ask) {
    const name = request.name
    if (name === undefined) return {}
    const answer = await service.using(async (backend, account) => {
      const found = await find(backend, request.parent, name)
      if (isFailure(found) || found === undefined) return {}
      const conversation = naming.get(request.id.replace(/:taken$/, ""))
      if (conversation !== undefined) service.folder.set(account.id, conversation, found.id)
      return { folder: found.id }
    })
    return isFailure(answer) ? {} : answer
  }

  /**
   * The name a folder the agent is about to make takes, when it is one of the conversation's (0.84, `mcpFolders`): in
   * `Artifacts`, the project's; in a project's folder there, the conversation's (`folderName`). These are the names
   * DynWork gives the folders it makes itself before 0.84 (`place`), so old and new conversations look the same. Any
   * other folder keeps the agent's name. The Drive is read for it: `Artifacts`, and its folders when the parent is not
   * `Artifacts` itself.
   */
  async function named(request: DynWorkDocuments.Ask) {
    const parent = request.parent
    if (parent === undefined) return {}
    const session = await options.session(request.session)
    if (!session) return {}
    const conversation = { id: request.session, name: clean(session.title) ?? options.untitled }
    const answer = await service.using(async (backend, account) => {
      const top = await find(backend, undefined, root)
      if (isFailure(top) || top === undefined) return {}
      if (parent === top.id) return { name: projectOf(session) }
      const projects = await backend.children(top.id)
      if (isFailure(projects) || !projects.some((folder) => folder.id === parent)) return {}
      const name = await folderName(backend, account.id, conversation, parent)
      if (isFailure(name)) return {}
      naming.set(request.id, conversation.id)
      return { name }
    })
    return isFailure(answer) ? {} : answer
  }

  /**
   * The name of a conversation's folder in its project's folder (D8): its title, or, when another conversation of the
   * account already holds a folder of that title there, its title and the end of its session id.
   */
  async function folderName(
    backend: Backend,
    account: string,
    conversation: { id: string; name: string },
    project: string,
  ) {
    const same = await find(backend, project, conversation.name)
    if (isFailure(same)) return same
    const others = Object.entries(service.folder.all(account)).filter((entry) => entry[0] !== conversation.id)
    return same !== undefined && others.some((entry) => entry[1] === same.id)
      ? `${conversation.name} (${conversation.id.slice(-6)})`
      : conversation.name
  }

  /**
   * Whether an edit must not reach the instance: one by ops of an HTML document (`DriveCapabilities.agentEdits`). The
   * document's format is read only when it decides; when it cannot be read, the edit goes and the instance answers it.
   */
  async function refused(request: DynWorkDocuments.Ask) {
    const document = request.document
    const replace = request.replace === true
    if (request.verb !== "edit" || document === undefined) return false
    // Allowed whatever the format: no need to read it.
    if (DriveCapabilities.agentEdits(service.capabilities(), { format: "html", replace })) return false
    const detail = await service.using((backend) => backend.get(document))
    if (isFailure(detail)) return false
    return !DriveCapabilities.agentEdits(service.capabilities(), { format: detail.document.format, replace })
  }

  /** The conversation's folder: kept from its first use; made under `Artifacts/<project>` when there is none. */
  async function place(
    backend: Backend,
    account: string,
    conversation: { id: string; name: string },
    session: Session,
  ): Promise<string | Failure> {
    const known = service.folder.get(account, conversation.id)
    if (known !== undefined) {
      const still = await backend.children(known)
      if (!isFailure(still)) return known
      // Gone (the user deleted it): made again below. Anything else says nothing about it.
      if (still.code !== "not-found") return still
    }
    const top = await folderIn(backend, undefined, root)
    if (isFailure(top)) return top
    const project = await folderIn(backend, top.id, projectOf(session))
    if (isFailure(project)) return project
    // A folder of that name another conversation holds is not this one's: its name says which it is.
    const name = await folderName(backend, account, conversation, project.id)
    if (isFailure(name)) return name
    const made = await folderIn(backend, project.id, name)
    if (isFailure(made)) return made
    service.folder.set(account, conversation.id, made.id)
    return made.id
  }

  /** What a write the agent made touched: its document enters the conversation's index, and an uploaded page is imported. */
  async function touched(touch: DynWorkDocuments.Touch) {
    if (touch.verb === "upload") return upload(touch)
    // A folder the agent made or moved: the Drive is read again for it, and nothing is indexed. The one made as the
    // conversation's (`named`) is kept as its folder.
    if (touch.verb === "folder")
      return void (await service.changing(async (_, account) => {
        const conversation = naming.get(touch.call)
        const folder = touch.output.folder_id
        if (conversation !== undefined && folder !== undefined) service.folder.set(account.id, conversation, folder)
        return undefined
      }))
    const made = touch.verb === "create" || touch.verb === "copy" || touch.verb === "import"
    const document = made ? touch.output.document_id : touch.input.document_id
    if (document === undefined) return
    const proposed = touch.verb === "edit" && (touch.output.proposal_id !== undefined || touch.input.mode === "propose")
    await service.changing(async (_, account) => {
      service.record(account.id, {
        conversation: touch.session,
        document,
        act: made ? "created" : proposed ? "proposed" : "edited",
        revision: touch.output.revision_id ?? touch.output.head_revision_id,
        via: "mcp",
      })
      return undefined
    })
  }

  // A page the agent uploaded is the one thing the MCP cannot make a document of with its scripts: DynWork imports its
  // blob (C7). Any other upload is a file for another document, an image for a Word file, and is left alone.
  async function upload(touch: DynWorkDocuments.Touch) {
    const blob = touch.output.blob_ref
    const name = touch.input.name
    const mime = touch.output.mime ?? touch.input.mime
    if (blob === undefined || name === undefined || !isHtml(mime)) return
    if (DriveCapabilities.agentFiling(service.capabilities()) !== "rest") return
    if (imported.has(`${touch.session}:${blob}`)) return
    imported.add(`${touch.session}:${blob}`)
    const session = await options.session(touch.session)
    await service.changing(async (backend, account) => {
      const conversation = { id: touch.session, name: clean(session?.title) ?? options.untitled }
      const folder = session ? await serial(() => place(backend, account.id, conversation, session)) : undefined
      if (folder !== undefined && isFailure(folder)) return folder
      const created = await service.attributed(backend, account, conversation, (signed) =>
        importing(backend, { ...signed, blob, name, folder }),
      )
      if (!isFailure(created))
        service.record(account.id, {
          conversation: touch.session,
          document: created.document.id,
          act: "created",
          revision: created.revision.id,
          via: "rest",
        })
      return created
    })
  }

  /** The instance refused a write for not knowing the conversation main gave it: the next write registers it again. */
  function stale(stale: DynWorkDocuments.Stale) {
    service.stale(stale.session, stale.context)
  }

  return { ask, touched, stale }
}

export type Agent = ReturnType<typeof make>

// A folder named `name` under `parent` (a root when none), made when it is not there. A folder of that name made
// meanwhile (in Governance, or by another of the user's computers) is refused as `name_taken` (409, 0.84): it is the one.
async function folderIn(backend: Backend, parent: string | undefined, name: string) {
  const found = await find(backend, parent, name)
  if (isFailure(found) || found) return found
  const made = await backend.createFolder({ name, parent })
  if (!isFailure(made) || made.code !== "conflict") return made
  return (await find(backend, parent, name)) ?? made
}

// The folder named `name` directly under `parent` (a root when none). The instance lists a folder's own folders, not its
// whole tree (0.83), so this is one read.
async function find(backend: Backend, parent: string | undefined, name: string) {
  const own = await backend.children(parent)
  return isFailure(own) ? own : own.find((folder) => folder.name === name)
}

// The page under its own name, or under `name (2).html` and on while the folder holds one of that name.
async function importing(
  backend: Backend,
  input: Parameters<Backend["importBlob"]>[0],
  attempt = 1,
): Promise<Created | Failure> {
  const dot = input.name.lastIndexOf(".")
  const stem = dot > 0 ? input.name.slice(0, dot) : input.name
  const name = attempt === 1 ? input.name : `${stem} (${attempt})${dot > 0 ? input.name.slice(dot) : ""}`
  const created = await backend.importBlob({ ...input, name })
  if (!isFailure(created) || created.code !== "conflict" || attempt >= attempts) return created
  return importing(backend, input, attempt + 1)
}

const isHtml = (mime: string | undefined) => mime?.split(";")[0]?.trim().toLowerCase() === "text/html"

// A name the Drive takes for a folder: no slashes, one line, not endless.
const clean = (name: string | undefined) =>
  name
    ?.replace(/[\\/\n\r]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || undefined

// The service's events main follows, and how long it waits before following them again after the stream ended.
const ASK = `rpc.${DynWorkDocuments.id}.ask` as const
const TOUCH = `rpc.${DynWorkDocuments.id}.touch` as const
const STALE = `rpc.${DynWorkDocuments.id}.stale` as const
const RETRY = 2_000
const decodeAsk = Schema.decodeUnknownOption(DynWorkDocuments.Ask)
const decodeTouch = Schema.decodeUnknownOption(DynWorkDocuments.Touch)
const decodeStale = Schema.decodeUnknownOption(DynWorkDocuments.Stale)

/**
 * Sets the agent's documents up in main: follows the server plugin's events on DynWork's service for as long as the
 * app runs, and answers the plugin's asks.
 */
export function setup(
  ctx: Pick<MainContext, "onCleanup">,
  input: {
    service: Options["service"]
    client: () => OpenCodeClient | undefined
    untitled: string
  },
) {
  const agent = make({
    service: input.service,
    untitled: input.untitled,
    session: async (id) => {
      const found = await input
        .client()
        ?.session.get({ sessionID: id })
        .catch(() => undefined)
      return found && { directory: found.location.directory, title: found.title }
    },
    answer: (answer) =>
      input.client()?.rpc.call({ rpcID: DynWorkDocuments.id, method: "answer", input: answer as never }) ??
      Promise.resolve(),
  })
  const life = new AbortController()
  ctx.onCleanup(() => life.abort())
  void (async () => {
    while (!life.signal.aborted) {
      const client = input.client()
      if (client) await follow(client, agent, life.signal).catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, RETRY))
    }
  })()
  return agent
}

async function follow(client: OpenCodeClient, agent: Agent, signal: AbortSignal) {
  for await (const event of client.event.subscribe({ types: [ASK, TOUCH, STALE], signal })) {
    if (event.type === ASK) {
      const request = decodeAsk(event.data)
      if (request._tag === "Some") void agent.ask(request.value)
    }
    if (event.type === TOUCH) {
      const touch = decodeTouch(event.data)
      if (touch._tag === "Some") void agent.touched(touch.value)
    }
    if (event.type === STALE) {
      const stale = decodeStale(event.data)
      if (stale._tag === "Some") agent.stale(stale.value)
    }
  }
}
