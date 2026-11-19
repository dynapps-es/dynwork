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

/** The conversation as the Drive's folders name it. */
export interface Session {
  /** The session's directory: its project is named after it. */
  directory: string
  title?: string
}

export interface Options {
  /** The service's `using`, `changing`, `record`, `folder`, `author`, `message` and `capabilities`. */
  service: Pick<DriveIpc.Service, "using" | "changing" | "record" | "folder" | "author" | "message" | "capabilities">
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

  /** What to add to the write the plugin is about to run: where a new document goes and what its revision says. */
  async function ask(request: DynWorkDocuments.Ask) {
    const answer = await answered(request).catch(() => ({}))
    await options.answer({ id: request.id, ...answer })
  }

  async function answered(request: DynWorkDocuments.Ask): Promise<Omit<DynWorkDocuments.Answer, "id">> {
    if (await refused(request)) return { refuse: htmlRefused }
    const session = await options.session(request.session)
    if (!session) return {}
    const conversation = { id: request.session, name: clean(session.title) ?? options.untitled }
    const filed =
      request.verb === "create" && DriveCapabilities.agentFiling(service.capabilities(), "markdown") === "rest"
    const answer = await service.using(async (backend, account) => {
      const message = service.message(account, conversation)
      if (!filed) return { message }
      const folder = await serial(() => place(backend, account.id, conversation, session))
      return { message, folder: isFailure(folder) ? undefined : folder }
    })
    return isFailure(answer) ? {} : answer
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
    const project = await folderIn(backend, top.id, clean(basename(session.directory)) ?? options.untitled)
    if (isFailure(project)) return project
    // A folder of that name another conversation holds is not this one's: its name says which it is.
    const same = await find(backend, project.id, conversation.name)
    if (isFailure(same)) return same
    const taken = same !== undefined && Object.values(service.folder.all(account)).includes(same.id)
    const made = await folderIn(
      backend,
      project.id,
      taken ? `${conversation.name} (${conversation.id.slice(-6)})` : conversation.name,
    )
    if (isFailure(made)) return made
    service.folder.set(account, conversation.id, made.id)
    return made.id
  }

  /** What a write the agent made touched: its document enters the conversation's index, and an uploaded page is imported. */
  async function touched(touch: DynWorkDocuments.Touch) {
    if (touch.verb === "upload") return upload(touch)
    const document =
      touch.verb === "create" || touch.verb === "copy" ? touch.output.document_id : touch.input.document_id
    if (document === undefined) return
    const proposed = touch.verb === "edit" && (touch.output.proposal_id !== undefined || touch.input.mode === "propose")
    await service.changing(async (_, account) => {
      service.record(account.id, {
        conversation: touch.session,
        document,
        act: touch.verb === "create" || touch.verb === "copy" ? "created" : proposed ? "proposed" : "edited",
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
    if (DriveCapabilities.agentFiling(service.capabilities(), "html") !== "rest") return
    if (imported.has(`${touch.session}:${blob}`)) return
    imported.add(`${touch.session}:${blob}`)
    const session = await options.session(touch.session)
    await service.changing(async (backend, account) => {
      const conversation = { id: touch.session, name: clean(session?.title) ?? options.untitled }
      const folder = session ? await serial(() => place(backend, account.id, conversation, session)) : undefined
      if (folder !== undefined && isFailure(folder)) return folder
      const created = await importing(backend, {
        ...(await service.author(backend, account, conversation)),
        blob,
        name,
        folder,
      })
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

  return { ask, touched }
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
const RETRY = 2_000
const decodeAsk = Schema.decodeUnknownOption(DynWorkDocuments.Ask)
const decodeTouch = Schema.decodeUnknownOption(DynWorkDocuments.Touch)

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
  for await (const event of client.event.subscribe({ types: [ASK, TOUCH], signal })) {
    if (event.type === ASK) {
      const request = decodeAsk(event.data)
      if (request._tag === "Some") void agent.ask(request.value)
    }
    if (event.type === TOUCH) {
      const touch = decodeTouch(event.data)
      if (touch._tag === "Some") void agent.touched(touch.value)
    }
  }
}
