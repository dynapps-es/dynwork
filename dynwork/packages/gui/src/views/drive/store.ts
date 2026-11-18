import { createRoot, createSignal } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { DriveClient } from "../../drive/client"
import {
  isFailure,
  type Access,
  type Act,
  type AgentCap,
  type Conversation,
  type Detail,
  type Document,
  type Failure,
  type Listing,
  type Page,
  type Proposal,
  type Query,
  type Revision,
} from "../../drive/contract"
import {
  me,
  mimeOf,
  sorts,
  visibleDocs,
  visibleFolders,
  type Anchor,
  type Scope,
  type Sort,
  type Thread,
  type TypeFilter,
} from "./model"

export type DocTab = "details" | "comments" | "versions" | "proposals" | "share"

/** The floating card in a document: a thread's, or the composer of a new comment on an anchor. */
export type Card =
  | { readonly kind: "thread"; readonly id: string }
  | { readonly kind: "new"; readonly anchor: Anchor; readonly quote: string }

/** What the open document's drawer reads, each part as the Drive answers it; `failure` when the document is not there. */
export interface Opened {
  detail?: Detail
  revisions?: readonly Revision[]
  proposals?: readonly Proposal[]
  access?: Access
  cap?: AgentCap
  page?: Page | Failure
  failure?: Failure
}

/** A file to upload: what a file input or a drop gives, read into bytes. */
export interface Upload {
  readonly name: string
  readonly bytes: Uint8Array
  readonly mime?: string
}

const blankDoc = {
  tab: "details" as DocTab,
  thread: undefined as string | undefined,
  sheet: 0,
  slide: 0,
  cell: "A1",
  range: undefined as string | undefined,
  filter: "open" as "open" | "resolved",
  source: false,
  commenting: false,
  card: undefined as Card | undefined,
  agentCells: false,
}

// One listing page; the browser asks for the next one on demand.
const PAGE = 100

/**
 * The Drive as the window shows it, over the `dynwork.drive` Ipc (`client`): the browser's choices and what the Drive
 * answered for them, the open document's drawer, and the comments layer's state. Every read and write goes through
 * the Ipc; nothing the user does stays only here.
 * - Recent is the service's snapshot, polled in main; Home, Mine, Shared and a search are read when chosen.
 * - From my chats is the conversation ↔ document index the service keeps; a document it names that no listing
 *   holds is read by id.
 * - A read that answers after the user moved on is dropped.
 */
export function createDriveStore(options: { client: () => DriveClient.Client | undefined }) {
  const [state, setState] = createStore({
    browse: {
      scope: "home" as Scope,
      folder: undefined as string | undefined,
      query: "",
      type: "all" as TypeFilter,
      sort: "updated" as Sort,
      view: "list" as "list" | "grid",
      selected: undefined as string | undefined,
    },
    listing: {
      documents: [] as Document[],
      next: undefined as string | undefined,
      status: "idle" as "idle" | "loading" | "ready" | "failed",
      failure: undefined as Failure | undefined,
    },
    /** Documents read by id: the conversations' that no listing holds, and the open one. */
    known: {} as Record<string, Document>,
    /** The document open in the view, over the browser. */
    open: undefined as string | undefined,
    opened: {} as Opened,
    doc: { ...blankDoc },
    /** The comments layer's threads by document: none until the Drive's comments reach it (phase 06). */
    threads: {} as Record<string, Thread[]>,
    /** A paper document's HTML once a comment marked it. */
    paper: {} as Record<string, string>,
  })
  // The newest listing and the newest open document asked for, so a late answer for an older one is dropped.
  const asked = { listing: 0, open: 0 }

  const remote = () => options.client()?.state()
  const folders = () => remote()?.folders ?? []
  const folder = (id: string | undefined) => folders().find((item) => item.id === id)
  const links = () => remote()?.links ?? []
  const capabilities = () => remote()?.capabilities

  // Every document the window has heard of, the freshest answer last.
  const doc = (id: string | undefined): Document | undefined => {
    if (id === undefined) return undefined
    const opened = state.opened.detail?.document
    if (opened?.id === id) return opened
    return (
      state.listing.documents.find((item) => item.id === id) ??
      remote()?.documents.find((item) => item.id === id) ??
      state.known[id]
    )
  }

  // What the browser lists before its filters: the snapshot, the conversations' documents, or the listing read.
  const documents = () => {
    const browse = state.browse
    if (!browse.query.trim() && browse.scope === "recent") return remote()?.documents ?? []
    if (!browse.query.trim() && browse.scope === "chats")
      return [...new Set(links().map((link) => link.document))].flatMap((id) => doc(id) ?? [])
    return state.listing.documents
  }

  async function reload() {
    const read = ++asked.listing
    const client = options.client()
    const queries = queriesOf(state.browse)
    if (!client || queries.length === 0) {
      setState("listing", { documents: [], next: undefined, status: client ? "ready" : "idle", failure: undefined })
      if (client && state.browse.scope === "chats") await learn(links().map((link) => link.document))
      return
    }
    setState("listing", { status: "loading", failure: undefined })
    const answers = await Promise.all(queries.map((query) => client.list(query)))
    if (read !== asked.listing) return
    const failure = answers.find(isFailure)
    if (failure) return setState("listing", { documents: [], next: undefined, status: "failed", failure })
    const pages = answers.filter((answer): answer is Listing => !isFailure(answer))
    setState("listing", {
      documents: unique(pages.flatMap((page) => page.documents)),
      // A search reads two scopes at once: their pages do not continue together.
      next: pages.length === 1 ? pages[0].next : undefined,
      status: "ready",
      failure: undefined,
    })
  }

  // Reads by id the documents no listing holds, for From my chats.
  async function learn(ids: readonly string[]) {
    const client = options.client()
    const missing = [...new Set(ids)].filter((id) => !doc(id))
    if (!client || missing.length === 0) return
    const details = await Promise.all(missing.map((id) => client.get({ id })))
    details.forEach((detail) => {
      if (!isFailure(detail)) setState("known", detail.document.id, detail.document)
    })
  }

  const store = {
    state,
    /** The live Ipc client, while the window entry is connected. */
    client: options.client,
    remote,
    folders,
    folder,
    doc,
    links,
    /** The Drive's status for the view: `none` until the Ipc connects. */
    status: () => remote()?.status ?? "none",
    /** What DynWork may do as the person (P1); off, it acts as an agent and the person's actions go to Governance. */
    person: () => capabilities()?.personActions === true,
    /** The documents and folders the browser shows. */
    shown: () => visibleDocs(documents(), state.browse),
    shownFolders: () => visibleFolders(folders(), state.browse),
    /** The open document. */
    current: () => doc(state.open),
    /** What one conversation did, newest first. */
    linksOf: (conversation: string) => links().filter((link) => link.conversation === conversation),
    threadsOf: (id: string) => state.threads[id] ?? [],
    thread: (id: string) =>
      Object.values(state.threads)
        .flat()
        .find((item) => item.id === id),

    // The browser.
    reload,
    learn,
    setScope(scope: Scope) {
      setState("browse", { scope, folder: undefined })
      return reload()
    },
    goFolder(id: string | undefined) {
      setState("browse", { scope: "home", folder: id, query: "" })
      return reload()
    },
    setQuery(query: string) {
      const searched = state.browse.query.trim()
      setState("browse", "query", query)
      if (query.trim() !== searched) return reload()
      return Promise.resolve()
    },
    setType(type: TypeFilter) {
      setState("browse", "type", type)
    },
    nextSort() {
      setState("browse", "sort", (sort) => sorts[(sorts.indexOf(sort) + 1) % sorts.length])
    },
    setView(view: "list" | "grid") {
      setState("browse", "view", view)
    },
    select(id: string | undefined) {
      setState("browse", "selected", id)
    },
    /** The listing's next page, appended. */
    async more() {
      const client = options.client()
      const cursor = state.listing.next
      const query = queriesOf(state.browse)[0]
      if (!client || cursor === undefined || !query) return
      const read = asked.listing
      const page = await client.list({ ...query, cursor })
      if (read !== asked.listing) return
      if (isFailure(page)) return setState("listing", { status: "failed", failure: page })
      setState("listing", {
        documents: unique([...state.listing.documents, ...page.documents]),
        next: page.next,
      })
    },

    // Writes. Each answers what the Drive did, or why not, and the browser reads its listing again.
    /** The folder a new document or folder lands in: the one open at Home, else the root. */
    target: () => (state.browse.scope === "home" ? state.browse.folder : undefined),
    /**
     * Creates a document from a file in the open folder, or, for a file a conversation made, at the root with that
     * conversation's attribution and `x-context-id` (D2, D3).
     */
    async upload(file: Upload, conversation?: Conversation) {
      const client = options.client()
      if (!client) return disconnected
      const created = await client.upload({
        name: file.name,
        bytes: file.bytes,
        mime: file.mime || mimeOf(file.name),
        folder: conversation ? undefined : store.target(),
        conversation,
      })
      if (!isFailure(created)) setState("browse", "selected", created.document.id)
      await reload()
      return created
    },
    /** A document from one of the instance's templates in the open folder, or for a conversation at the root. */
    async create(template: string, name: string, conversation?: Conversation) {
      const client = options.client()
      if (!client) return disconnected
      const created = await client.create({
        template,
        name,
        folder: conversation ? undefined : store.target(),
        conversation,
      })
      if (!isFailure(created)) setState("browse", "selected", created.document.id)
      await reload()
      return created
    },
    async createFolder(name: string) {
      const client = options.client()
      if (!client) return disconnected
      const created = await client.createFolder({ name, parent: store.target() })
      await reload()
      return created
    },
    /** Records that a conversation used a document: the composer's attachment, the panel's Add from the Drive. */
    async link(conversation: string, document: string, act: Act) {
      const client = options.client()
      if (!client) return disconnected
      return client.link({ conversation, document, act, via: "rest" })
    },

    // The open document.
    /** Opens a document over the browser and reads its drawer: details, versions, proposals, access and the agent's cap. */
    async openDoc(id: string, tab?: DocTab) {
      const read = ++asked.open
      setState("open", id)
      setState("browse", "selected", id)
      setState("opened", reconcile({}))
      setState("doc", { ...blankDoc, tab: tab ?? "details" })
      const client = options.client()
      if (!client) return setState("opened", { failure: disconnected })
      const keep = (part: Opened) => {
        if (read === asked.open) setState("opened", part)
      }
      await Promise.all([
        client.get({ id }).then((detail) => keep(isFailure(detail) ? { failure: detail } : { detail })),
        client.revisions({ id }).then((answer) => keep(isFailure(answer) ? {} : { revisions: answer })),
        client.proposals({ id }).then((answer) => keep(isFailure(answer) ? {} : { proposals: answer })),
        client.access({ id }).then((answer) => keep(isFailure(answer) ? {} : { access: answer })),
        client.agentCap({ kind: "document", id }).then((answer) => keep(isFailure(answer) ? {} : { cap: answer })),
        client.preview({ id }).then((page) => keep({ page })),
      ])
    },
    closeDoc() {
      asked.open++
      setState("open", undefined)
      setState("opened", reconcile({}))
    },
    setTab(tab: DocTab) {
      setState("doc", "tab", tab)
    },

    // The comments layer's state (`comments.tsx`, `canvas.tsx`): where the user is in the document and what they point at.
    setFilter(filter: "open" | "resolved") {
      setState("doc", "filter", filter)
    },
    setSheet(sheet: number) {
      setState("doc", { sheet, range: undefined, card: undefined })
    },
    setSlide(slide: number) {
      setState("doc", { slide, card: undefined })
    },
    /** The selected cell and, when two corners differ, the range between them. */
    setCells(cell: string, range: string | undefined) {
      setState("doc", { cell, range })
    },
    toggleSource() {
      setState("doc", "source", (source) => !source)
    },
    toggleAgentCells() {
      setState("doc", "agentCells", (shown) => !shown)
    },
    setCommenting(on: boolean) {
      setState("doc", { commenting: on, card: undefined })
    },
    setCard(card: Card | undefined) {
      setState("doc", "card", card)
    },
    /** Shows where a thread lives (its sheet, slide or cell), selects it in the drawer and opens its card. */
    focusThread(id: string) {
      const item = store.thread(id)
      if (!item) return
      const anchor = item.anchor
      setState("doc", {
        thread: id,
        tab: "comments",
        filter: item.open ? "open" : "resolved",
        card: { kind: "thread", id },
        ...(anchor.kind === "cell" || anchor.kind === "range"
          ? { sheet: anchor.sheet, cell: anchor.kind === "cell" ? anchor.cell : anchor.from, range: undefined }
          : {}),
        ...(anchor.kind === "shape" ? { slide: anchor.slide } : {}),
      })
    },
    setPaper(id: string, html: string) {
      setState("paper", id, html)
    },
    /** A new thread on the open document, kept in this window until comments reach the Drive (phase 06). */
    comment(anchor: Anchor, quote: string, text: string) {
      const id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      const key = state.open
      if (!key) return id
      const created: Thread = {
        id,
        quote,
        anchor,
        open: true,
        messages: [{ by: me, text, age: 0, dynwork: !store.person() }],
      }
      setState("threads", key, (list) => [created, ...(list ?? [])])
      return id
    },
    reply(id: string, text: string) {
      editThread(id, (item) => ({
        messages: [...item.messages, { by: me, text, age: 0, dynwork: !store.person() }],
      }))
    },
    resolve(id: string) {
      editThread(id, () => ({ open: false }))
      if (state.doc.card?.kind === "thread" && state.doc.card.id === id) setState("doc", "card", undefined)
    },
    reopen(id: string) {
      editThread(id, () => ({ open: true }))
      setState("doc", "filter", "open")
    },
  }

  function editThread(id: string, change: (thread: Thread) => Partial<Thread>) {
    const key = Object.keys(state.threads).find((doc) => store.threadsOf(doc).some((item) => item.id === id))
    if (key)
      setState(
        "threads",
        key,
        (item) => item.id === id,
        (item) => ({ ...item, ...change(item) }),
      )
  }

  return store
}

export type DriveStore = ReturnType<typeof createDriveStore>

/** Without a connection to main, the store answers as the service does without an account. */
const disconnected: Failure = { code: "signed-out", message: "The Drive is not connected.", retryable: false }

/** What the browser asks the Drive for; none when the snapshot or the index already holds it. */
export function queriesOf(browse: { scope: Scope; folder: string | undefined; query: string }): Query[] {
  const query = browse.query.trim()
  if (query)
    return [
      { scope: "mine", query, limit: PAGE },
      { scope: "shared", query, limit: PAGE },
    ]
  if (browse.scope === "home" && browse.folder !== undefined)
    return [{ scope: "folder", folder: browse.folder, limit: PAGE }]
  if (browse.scope === "home" || browse.scope === "mine") return [{ scope: "mine", limit: PAGE }]
  if (browse.scope === "shared") return [{ scope: "shared", limit: PAGE }]
  return []
}

const unique = (documents: readonly Document[]) => [...new Map(documents.map((item) => [item.id, item])).values()]

// The active account as the window entry follows it (`./register.tsx`): Governance's address and the user's name,
// which the Drive's state does not carry.
const [active, setActive] = createSignal<{ url: string; user?: string }>()

/** The active account's Governance address and user; undefined without one. */
export const account = active
export const follow = setActive

/** A document's page in Governance's Drive, or the Drive itself; undefined without an active account. */
export function governance(id?: string) {
  const url = active()?.url.replace(/\/+$/, "")
  if (!url) return undefined
  return id === undefined ? `${url}/drive` : `${url}/drive/${encodeURIComponent(id)}`
}

/** The window's one Drive store, over the window entry's live connection (`DriveClient.attach`). */
export const drive = createRoot(() =>
  createDriveStore({
    client: () => {
      const live = DriveClient.connection()
      return live?.status === "active" ? live.value : undefined
    },
  }),
)
