import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import {
  docs,
  folders,
  me,
  proposals,
  sampleChanges,
  shares,
  threads,
  versions,
  type Anchor,
  type Change,
  type Doc,
  type Folder,
  type Format,
  type Message,
  type Thread,
} from "./demo"
import { sorts, type Scope, type Sort, type TypeFilter } from "./model"

export type DocTab = "details" | "comments" | "versions" | "proposals" | "share"
/** How Dynwork edits: as an agent (the first release) or as the person (later). */
export type Mode = "mvp" | "v2"

/** The floating card in a document: a thread's, or the composer of a new comment on an anchor. */
export type Card =
  | { readonly kind: "thread"; readonly id: string }
  | { readonly kind: "new"; readonly anchor: Anchor; readonly quote: string }

/** What one chat shows in its side panel: the changes its agent made, the version picked per document, the dock. */
export interface ChatState {
  readonly changes: readonly Change[]
  readonly version: Record<string, number>
  readonly dock: boolean
}

const blankDoc = {
  tab: "comments" as DocTab,
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

/**
 * The Drive's demo state, one for the window: the browser, the open document and each chat's side panel read and
 * change the same documents, so a comment made in the view shows in the panel. Nothing leaves memory.
 */
function createDriveStore() {
  const [state, setState] = createStore({
    docs: docs.map((doc) => ({ ...doc })) as Doc[],
    folders: folders.map((folder) => ({ ...folder })) as Folder[],
    threads: structuredClone(threads) as Record<string, Thread[]>,
    proposals: structuredClone(proposals),
    versions: structuredClone(versions),
    shares: structuredClone(shares),
    /** A paper document's HTML once a comment marked it. */
    paper: {} as Record<string, string>,
    /** Text the agent added to a document in answer to a comment. */
    added: {} as Record<string, string>,
    mode: "mvp" as Mode,
    browse: {
      scope: "home" as Scope,
      folder: undefined as string | undefined,
      query: "",
      type: "all" as TypeFilter,
      sort: "updated" as Sort,
      view: "list" as "list" | "grid",
      selected: "d1" as string | undefined,
    },
    /** The document open in the view, over the browser. */
    open: undefined as string | undefined,
    doc: { ...blankDoc },
    /** The thread the agent is answering. */
    typing: undefined as string | undefined,
    chats: {} as Record<string, ChatState>,
  })

  const doc = (id: string | undefined) => state.docs.find((item) => item.id === id)
  const folder = (id: string | undefined) => state.folders.find((item) => item.id === id)
  const threadsOf = (id: string) => state.threads[id] ?? []
  const thread = (id: string) =>
    Object.values(state.threads)
      .flat()
      .find((item) => item.id === id)
  const docOfThread = (id: string) => Object.keys(state.threads).find((key) => threadsOf(key).some((t) => t.id === id))
  const update = (id: string, change: (doc: Doc) => Partial<Doc>) =>
    setState(
      "docs",
      (item) => item.id === id,
      (item) => ({ ...item, ...change(item) }),
    )
  const editThread = (id: string, change: (thread: Thread) => Partial<Thread>) => {
    const key = docOfThread(id)
    if (key)
      setState(
        "threads",
        key,
        (item) => item.id === id,
        (item) => ({ ...item, ...change(item) }),
      )
  }
  const nextID = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

  const store = {
    state,
    doc,
    folder,
    threadsOf,
    thread,
    current: () => doc(state.open),
    setMode(mode: Mode) {
      setState("mode", mode)
    },

    // The browser.
    setScope(scope: Scope) {
      setState("browse", { scope, folder: undefined })
    },
    goFolder(id: string | undefined) {
      setState("browse", { scope: "home", folder: id, query: "" })
    },
    setQuery(query: string) {
      setState("browse", "query", query)
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
    /** A file lands in the open folder after a moment, as a resumable upload would. */
    upload(name: string, format: Format) {
      const target = folder(state.browse.folder)
      const created: Doc = {
        id: nextID("u"),
        name,
        format,
        folder: target?.id,
        owner: me,
        cls: target?.cls ?? "internal",
        age: 0,
        rev: 1,
        size: "320 KB",
        editing: [],
        agent: false,
        access: "own",
        chats: [],
        text: name.toLowerCase(),
      }
      setState("docs", (list) => [created, ...list])
      setState("browse", "selected", created.id)
      return created
    },
    /** A new document or folder in the open folder, from a template. */
    create(kind: Format | "folder", name: string) {
      const target = folder(state.browse.folder)
      const cls = target?.cls ?? "internal"
      if (kind === "folder") {
        setState("folders", (list) => [...list, { id: nextID("f"), name, parent: target?.id, cls, owner: me, age: 0 }])
        return undefined
      }
      const created: Doc = {
        id: nextID("n"),
        name: `${name}.${{ docx: "docx", xlsx: "xlsx", pptx: "pptx", html: "html", markdown: "md", pdf: "pdf" }[kind]}`,
        format: kind,
        folder: target?.id,
        owner: me,
        cls,
        age: 0,
        rev: 1,
        size: "12 KB",
        editing: [],
        agent: false,
        access: "own",
        chats: [],
        text: name.toLowerCase(),
      }
      setState("docs", (list) => [created, ...list])
      return created.id
    },

    // The open document.
    openDoc(id: string, tab?: DocTab) {
      const target = doc(id)
      if (!target) return
      const first = threadsOf(id).find((item) => item.open)
      setState("open", id)
      setState("browse", "selected", id)
      setState("doc", {
        ...blankDoc,
        tab: tab ?? (first ? "comments" : "details"),
        thread: first?.id,
        slide: id === "d4" ? 2 : 0,
        cell: id === "d2" ? "F7" : "A1",
      })
    },
    closeDoc() {
      setState("open", undefined)
    },
    setTab(tab: DocTab) {
      setState("doc", "tab", tab)
    },
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
      const item = thread(id)
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
    /** A new thread on the open document; returns its id. */
    comment(anchor: Anchor, quote: string, text: string) {
      const id = nextID("t")
      const key = state.open
      if (!key) return id
      const created: Thread = {
        id,
        quote,
        anchor,
        open: true,
        messages: [{ by: me, text, age: 0, dynwork: state.mode === "mvp" }],
      }
      setState("threads", key, (list) => [created, ...(list ?? [])])
      return id
    },
    reply(id: string, text: string) {
      const message: Message = { by: me, text, age: 0, dynwork: state.mode === "mvp" }
      editThread(id, (item) => ({ messages: [...item.messages, message] }))
    },
    resolve(id: string) {
      editThread(id, () => ({ open: false }))
      if (state.doc.card?.kind === "thread" && state.doc.card.id === id) setState("doc", "card", undefined)
    },
    reopen(id: string) {
      editThread(id, () => ({ open: true }))
      setState("doc", "filter", "open")
    },
    /**
     * The agent picks up a thread that mentions it: after a moment it answers there, edits the document when its
     * class lets it (a new revision), and the change shows in every chat that has the document in its panel.
     */
    answer(id: string, text: string | undefined, done: (doc: Doc) => void) {
      const key = docOfThread(id)
      const target = doc(key)
      if (!key || !target) return
      setState("typing", id)
      setTimeout(() => {
        setState("typing", undefined)
        const editable = target.format !== "pdf" && (target.cls === "agent-workspace" || target.cls === "internal")
        const rev = editable ? target.rev + 1 : target.rev
        const via = target.chats[0]?.chat ?? "c1"
        if (editable) update(key, () => ({ rev, age: 0 }))
        const said =
          text ??
          (target.format === "pdf" ? "drive.agent.pdf" : editable ? "drive.agent.edited" : "drive.agent.proposed")
        editThread(id, (item) => ({ messages: [...item.messages, { by: "AI", text: said, age: 0, via }] }))
        if (key === "d1" && id === "t2") setState("added", "d1", "drive.agent.added")
        if (editable)
          setState("versions", key, (list) => [
            { rev, by: "AI", via, what: "drive.agent.version", age: 0 },
            ...(list ?? []),
          ])
        if (editable)
          Object.entries(state.chats)
            .filter(([, chat]) => chat.changes.some((change) => change.doc === key))
            .forEach(([chat, value]) =>
              setState("chats", chat, {
                ...value,
                changes: [...value.changes, { doc: key, act: "edited", rev, from: rev - 1 }],
              }),
            )
        done(target)
      }, 1600)
    },
    /** People accept or reject a proposal; Dynwork as an agent cannot. */
    decide(id: string, accept: boolean) {
      const key = state.open
      if (!key) return
      setState("proposals", key, (list) =>
        (list ?? []).map((item) => (item.id === id ? { ...item, state: accept ? "accepted" : "rejected" } : item)),
      )
    },

    // The side panel of each chat, by session key.
    chat(key: string): ChatState {
      return state.chats[key] ?? { changes: [], version: {}, dock: false }
    },
    /** Loads the sample conversation's documents into a chat, with the agent's pending overwrite. */
    loadSample(key: string) {
      setState("chats", key, { changes: [...sampleChanges], version: {}, dock: true })
    },
    /** Attaches a document to a chat, as the composer's + from the Drive does. */
    attach(key: string, id: string) {
      const target = doc(id)
      if (!target) return
      const chat = store.chat(key)
      if (chat.changes.some((change) => change.doc === id)) return
      setState("chats", key, { ...chat, changes: [...chat.changes, { doc: id, act: "attached", rev: target.rev }] })
    },
    setVersion(key: string, id: string, rev: number | undefined) {
      const chat = store.chat(key)
      const version = { ...chat.version }
      if (rev === undefined) delete version[id]
      else version[id] = rev
      setState("chats", key, { ...chat, version })
    },
    /** The agent's pending overwrite of the spreadsheet: allowed, it writes a new revision; denied, nothing changes. */
    settleDock(key: string, allow: boolean) {
      const chat = store.chat(key)
      setState("chats", key, { ...chat, dock: false })
      if (!allow) return
      const target = doc("d2")
      if (!target) return
      const rev = target.rev + 1
      update("d2", () => ({ rev, age: 0 }))
      setState("versions", "d2", (list) => [
        { rev, by: "AI", via: "c1", what: "drive.dock.version", age: 0 },
        ...(list ?? []),
      ])
      setState("chats", key, {
        ...chat,
        dock: false,
        changes: [...chat.changes, { doc: "d2", act: "edited", rev, from: rev - 1 }],
      })
    },
  }
  return store
}

export type DriveStore = ReturnType<typeof createDriveStore>

/** The window's one Drive store. */
export const drive = createRoot(() => createDriveStore())
