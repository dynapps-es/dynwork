import { createEffect, createRoot, createSignal } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { DriveArtifacts } from "../../drive/artifacts"
import { DriveClient } from "../../drive/client"
import {
  isFailure,
  type Access,
  type Act,
  type AgentCap,
  type Anchor,
  type Comment,
  type Conversation,
  type Detail,
  type Document,
  type Failure,
  type Listing,
  type Proposal,
  type Query,
  type Revision,
} from "../../drive/contract"
import {
  latest,
  mimeOf,
  sorts,
  threadsOf,
  visibleDocs,
  visibleFolders,
  type Node,
  type Scope,
  type Sort,
  type TypeFilter,
  type Acting,
} from "./model"

export type DocTab = "details" | "comments" | "versions" | "proposals"

/** The chat a document was opened from, beside it: where its Back returns. */
export interface FromChat {
  readonly server: string
  readonly id: string
  /** The chat's shell tab. */
  readonly tab: string
}

/** Where the browser was when a document opened over it: where its Back returns. */
interface FromDrive {
  readonly scope: Scope
  readonly folder: string | undefined
  readonly query: string
}

/** What the open document's drawer reads, each part as the Drive answers it; `failure` when the document is not there. */
export interface Opened {
  detail?: Detail
  revisions?: readonly Revision[]
  proposals?: readonly Proposal[]
  access?: Access
  cap?: AgentCap
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
  /** The thread the Comments tab has open, by its first comment's id. */
  thread: undefined as string | undefined,
  /**
   * The thread is open because the user just wrote it, not because they asked to see it: the view stays as it is, and
   * a hidden drawer stays hidden (`drive.comment`).
   */
  quiet: false,
  filter: "open" as "open" | "resolved",
  /** Where the comment being written points, before it is sent. */
  compose: undefined as Anchor | undefined,
  /** The user asked for a new comment and has not picked where it points yet. */
  choosing: false,
  /** The thread whose reply box is open: one at a time. */
  replying: undefined as string | undefined,
  /** Comment mode (C): a click on a block of a Markdown document opens a comment there. */
  commenting: false,
}

/**
 * What of a document's view state asks for the Comments drawer: a thread the user picked (not one they just wrote), a
 * comment started, or one waiting for where it points.
 */
export const drawerAsks = (doc: Pick<typeof blankDoc, "thread" | "quiet" | "compose" | "choosing">) =>
  [doc.quiet ? undefined : doc.thread, doc.compose, doc.choosing] as const

/** A document's comments as the Drive answered them, with the nodes they anchor to. */
interface Discussion {
  comments: Comment[]
  nodes: Node[]
  status: "loading" | "ready" | "failed"
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
 * - A chat's artifacts are its index merged with what the instance lists for the chat (`docsByContext`, G07), read
 *   while its header or its Artifacts tab is shown (`followChat`).
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
    /** Where the open document was opened from; none for a document opened from nowhere known, whose Back goes Home. */
    from: undefined as { chat: FromChat } | { drive: FromDrive } | undefined,
    doc: { ...blankDoc },
    /** The comments and the nodes of the documents opened in this window, by document. */
    discussion: {} as Record<string, Discussion>,
    /** The names of the people the window has seen, by user id: the grants of the documents it opened. */
    people: {} as Record<string, string>,
    /** What the instance listed for each chat the window shows (G07), by session id, and the account it was read for. */
    listed: {} as Record<string, { account: string; documents: Document[] }>,
  })
  // The newest listing, open document and comments read asked for, so a late answer for an older one is dropped; and,
  // by chat, the account and the Drive's read its instance listing was last asked for.
  const asked = { listing: 0, open: 0, discussion: new Map<string, number>(), chats: new Map<string, string>() }

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

  /**
   * Reads what the instance lists for a chat (G07), once per read of the Drive: the service reads it again after each
   * write and poll, and the snapshot's `read` says so. Nothing is asked without `docsByContext`. An answer for an older
   * read is dropped. The documents listed are known by id from then on: the instance names them.
   */
  async function readChat(conversation: string) {
    const client = options.client()
    const state = remote()
    if (!client || !state?.capabilities.docsByContext || state.account === undefined) return
    const account = state.account
    const key = `${account}:${state.read ?? 0}`
    if (asked.chats.get(conversation) === key) return
    asked.chats.set(conversation, key)
    const answer = await client.byContext({ conversation })
    if (asked.chats.get(conversation) !== key) return
    const documents = isFailure(answer) ? [] : [...answer]
    documents.forEach((document) => setState("known", document.id, document))
    setState("listed", conversation, { account, documents })
  }

  // What the instance listed for a chat, while it is for the active account and the capability is on.
  const listedOf = (conversation: string) => {
    const listed = state.listed[conversation]
    if (!listed || !capabilities()?.docsByContext || listed.account !== remote()?.account) return []
    return listed.documents
  }

  // Reads by id the documents no listing holds, for From my chats and restored tabs; answers why any could not be read.
  async function learn(ids: readonly string[]) {
    const client = options.client()
    const missing = [...new Set(ids)].filter((id) => !doc(id))
    if (!client || missing.length === 0) return new Map<string, Failure>()
    const details = await Promise.all(missing.map((id) => client.get({ id })))
    details.forEach((detail) => {
      if (!isFailure(detail)) setState("known", detail.document.id, detail.document)
    })
    return new Map(
      missing.flatMap((id, index) => {
        const detail = details[index]
        return detail && isFailure(detail) ? [[id, detail] as const] : []
      }),
    )
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
    /** How the person's own session stands (G01): `on`, `off` (they could sign in) or `unavailable`. */
    acting: (): Acting => remote()?.person ?? "unavailable",
    /** The documents and folders the browser shows. */
    shown: () => visibleDocs(documents(), state.browse),
    shownFolders: () => visibleFolders(folders(), state.browse),
    /** The open document. */
    current: () => doc(state.open),
    /** What became of a comment that asked for the agent (`@Agent`): which chat was woken, or why none was. */
    mentionOf: (comment: string) => remote()?.mentions.find((entry) => entry.comment === comment),
    /** What one conversation did, newest first. */
    linksOf: (conversation: string) => links().filter((link) => link.conversation === conversation),
    /**
     * A conversation's artifacts: one link per document, its latest, from the index and from what the instance lists
     * for the conversation (`DriveArtifacts.merge`). The chat header counts them.
     */
    artifactsOf: (conversation: string) =>
      latest(
        DriveArtifacts.merge(
          conversation,
          links().filter((link) => link.conversation === conversation),
          listedOf(conversation),
        ),
      ),
    /** The pages the chat's agent uploaded that DynWork could not import, newest first, with what stopped each. */
    unimportedOf: (conversation: string) =>
      (remote()?.unimported ?? []).filter((page) => page.conversation === conversation),
    readChat,
    /**
     * Keeps what the instance lists for a chat read while the calling component lives: now, and again after each read
     * of the Drive, of another account, or once the capability turns on (`readChat` reads all three before it waits).
     */
    followChat(conversation: () => string) {
      createEffect(() => void readChat(conversation()))
    },
    /** A document's comment threads, newest first. */
    threadsOf: (id: string) => threadsOf(state.discussion[id]?.comments ?? []),
    thread: (id: string) =>
      threadsOf(state.discussion[state.open ?? ""]?.comments ?? []).find((item) => item.id === id),
    /**
     * A person's name by user id, from the grants of the documents the window opened and, once the instance names
     * people by id (`peopleByRest`), from the instance for the authors of comments no grant names. Without it, someone
     * who was never granted anything is unnamed.
     */
    nameOf: (user: string) => state.people[user],
    /** The nodes of a document as last read, in reading order. */
    nodesOf: (id: string) => state.discussion[id]?.nodes ?? [],

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
    /**
     * Imports again a page of a chat's agent that DynWork could not import (`unimportedOf`); answers the failure when it
     * fails again, which keeps it with the new reason.
     */
    async reimport(conversation: string, call: string) {
      const client = options.client()
      if (!client) return disconnected
      const created = await client.reimport({ conversation, call })
      return isFailure(created) ? created : undefined
    },
    /** Records that a conversation used a document: the composer's attachment, the panel's Add from the Drive. */
    async link(conversation: string, document: string, act: Act) {
      const client = options.client()
      if (!client) return disconnected
      return client.link({ conversation, document, act, via: "rest" })
    },

    // The open document.
    /**
     * Opens a document over the browser and reads its drawer: details, versions, proposals, access and the agent's cap.
     * It remembers where it was opened from, for Back: the chat it was beside (`from`), else the browser as it was.
     */
    async openDoc(id: string, opening: { tab?: DocTab; from?: FromChat } = {}) {
      const read = ++asked.open
      const browse = state.browse
      setState(
        "from",
        reconcile(
          opening.from
            ? { chat: opening.from }
            : { drive: { scope: browse.scope, folder: browse.folder, query: browse.query } },
        ),
      )
      setState("open", id)
      setState("browse", "selected", id)
      setState("opened", reconcile({}))
      setState("doc", { ...blankDoc, tab: opening.tab ?? "details" })
      const client = options.client()
      if (!client) return setState("opened", { failure: disconnected })
      const keep = (part: Opened) => {
        if (read === asked.open) setState("opened", part)
      }
      // The document by id carries no size; the one the window already listed does.
      const size = doc(id)?.size
      await Promise.all([
        client
          .get({ id })
          .then((detail) =>
            keep(
              isFailure(detail)
                ? { failure: detail }
                : { detail: { ...detail, document: { ...detail.document, size: detail.document.size ?? size } } },
            ),
          ),
        client.revisions({ id }).then((answer) => keep(isFailure(answer) ? {} : { revisions: answer })),
        client.proposals({ id }).then((answer) => keep(isFailure(answer) ? {} : { proposals: answer })),
        client.access({ id }).then((answer) => {
          if (isFailure(answer)) return keep({})
          learnNames(answer)
          keep({ access: answer })
        }),
        client.agentCap({ kind: "document", id }).then((answer) => keep(isFailure(answer) ? {} : { cap: answer })),
        discuss(id),
      ])
    },
    /**
     * Closes the open document and goes back where it was opened from: the browser as it was then, or Home when that is
     * not known. Answers the chat to go back to when it was opened beside one; the browser stays as it is then.
     */
    closeDoc() {
      asked.open++
      const from = state.from
      const chat = from && "chat" in from ? { ...from.chat } : undefined
      const back =
        from && "drive" in from ? { ...from.drive } : { scope: "home" as Scope, folder: undefined, query: "" }
      setState("open", undefined)
      setState("opened", reconcile({}))
      setState("from", undefined)
      if (chat) return chat
      const browse = state.browse
      if (browse.scope === back.scope && browse.folder === back.folder && browse.query === back.query) return undefined
      setState("browse", { scope: back.scope, folder: back.folder, query: back.query })
      void reload()
      return undefined
    },
    setTab(tab: DocTab) {
      setState("doc", "tab", tab)
      // Others comment meanwhile: the tab reads them again each time it is opened.
      if (tab === "comments" && state.open) void discuss(state.open)
    },

    // Comments.
    discuss,
    setFilter(filter: "open" | "resolved") {
      setState("doc", "filter", filter)
    },
    /** Opens the Comments tab to write a comment: at `anchor`, or, without one, to pick where. */
    startComment(anchor?: Anchor) {
      setState("doc", { tab: "comments", thread: undefined, compose: anchor, choosing: anchor === undefined })
    },
    cancelComment() {
      setState("doc", { compose: undefined, choosing: false })
    },
    setCommenting(on: boolean) {
      setState("doc", "commenting", on)
    },
    /** Opens the reply box of a thread, and closes the one that was open. */
    startReply(thread: string) {
      setState("doc", "replying", thread)
    },
    cancelReply() {
      setState("doc", "replying", undefined)
    },
    /**
     * Opens a thread in the Comments tab, in the filter it belongs to. `quiet`, for a thread the user just wrote, opens
     * it there without bringing the tab into view.
     */
    focusThread(id: string, quiet = false) {
      const open = store.thread(id)?.open !== false
      setState("doc", {
        tab: "comments",
        thread: id,
        quiet,
        filter: open ? "open" : "resolved",
        compose: undefined,
        choosing: false,
      })
    },
    /**
     * A new thread on a document, at `anchor`, from a conversation when it comes from one. It opens in the Comments tab,
     * quietly: writing a comment asks for nothing to move.
     */
    async comment(id: string, anchor: Anchor, body: string, conversation?: Conversation) {
      const client = options.client()
      if (!client) return disconnected
      const created = await client.comment({ id, body, anchor, conversation })
      if (isFailure(created)) {
        // The node moved on: the nodes the window holds are old.
        if (created.code === "conflict") void discuss(id)
        return created
      }
      setState("doc", { compose: undefined, choosing: false })
      await discuss(id)
      store.focusThread(created.id, true)
      return created
    },
    async reply(id: string, thread: string, body: string, conversation?: Conversation) {
      const client = options.client()
      if (!client) return disconnected
      const created = await client.reply({ id, parent: thread, body, conversation })
      if (isFailure(created)) return created
      if (state.doc.replying === thread) setState("doc", "replying", undefined)
      await discuss(id)
      return created
    },
    /** Resolves a thread. It opens again only where the instance reopens comments (`reopenComments`, G12). */
    async resolve(id: string, thread: string) {
      const client = options.client()
      if (!client) return disconnected
      const resolved = await client.resolve({ id, comment: thread })
      if (isFailure(resolved)) return resolved
      await discuss(id)
      if (state.doc.thread === thread) setState("doc", "thread", undefined)
      return resolved
    },
    // What only the person may do (G01): each goes as them, or answers `sign-in` or `person` without sending anything.
    /** Moves a document to the trash; the browser reads its listing again, and an open one closes. */
    async trash(id: string) {
      const client = options.client()
      if (!client) return disconnected
      const done = await client.trash({ id })
      if (isFailure(done)) return done
      if (state.open === id) store.closeDoc()
      if (state.browse.selected === id) setState("browse", "selected", undefined)
      await reload()
      return undefined
    },
    /** Makes `to` the document's owner; the user keeps `edit`. */
    async transfer(id: string, to: string) {
      const client = options.client()
      if (!client) return disconnected
      const done = await client.transfer({ id, to })
      if (isFailure(done)) return done
      setState("known", id, done)
      if (state.open === id) await store.openDoc(id, { tab: state.doc.tab, ...fromChat() })
      await reload()
      return done
    },
    /** Makes an earlier version the current one again, as a new version; the open document reads its versions again. */
    async restore(id: string, revision: string) {
      const client = options.client()
      if (!client) return disconnected
      const done = await client.restore({ id, revision })
      if (isFailure(done)) return done
      if (state.open === id) await store.openDoc(id, { tab: "versions", ...fromChat() })
      return done
    },
    /** Accepts or rejects a proposal; the open document reads its proposals and versions again. */
    async review(id: string, proposal: string, accept: boolean) {
      const client = options.client()
      if (!client) return disconnected
      const done = await client.review({ id, proposal, accept })
      if (isFailure(done)) return done
      if (state.open === id) await store.openDoc(id, { tab: "proposals", ...fromChat() })
      return done
    },
    /**
     * Opens a resolved thread again (G12, 0.84). It moves to Open, where the Comments tab follows it when it is the
     * document there, quietly: the user is already looking at it.
     */
    async reopen(id: string, thread: string) {
      const client = options.client()
      if (!client) return disconnected
      const reopened = await client.reopen({ id, comment: thread })
      if (isFailure(reopened)) return reopened
      await discuss(id)
      if (state.open === id) setState("doc", { thread, quiet: true, filter: "open" })
      return reopened
    },
  }

  // Where the open document came from, kept when it is read again in place.
  function fromChat() {
    const from = state.from
    return from && "chat" in from ? { from: { ...from.chat } } : {}
  }

  // The people a document is granted to, by user id, for naming the authors of comments.
  function learnNames(access: Access) {
    access.grants
      .concat(access.inherited)
      .filter((grant) => grant.subject === "user" && grant.name)
      .forEach((grant) => setState("people", grant.value, grant.name ?? ""))
  }

  // A document's comments and nodes, read together; a late answer for an older read is dropped, and one that fails
  // keeps what the window had and says so.
  async function discuss(id: string) {
    const client = options.client()
    if (!client) return
    const read = (asked.discussion.get(id) ?? 0) + 1
    asked.discussion.set(id, read)
    if (!state.discussion[id]) setState("discussion", id, { comments: [], nodes: [], status: "loading" })
    const [comments, outline] = await Promise.all([client.comments({ id }), client.outline({ id })])
    if (read !== asked.discussion.get(id)) return
    if (isFailure(comments)) return setState("discussion", id, "status", "failed")
    setState("discussion", id, {
      comments: [...comments],
      // A document without nodes (a PDF the Drive keeps whole) still has its comments.
      nodes: isFailure(outline) ? [] : [...outline.nodes],
      status: "ready",
    })
    await nameAuthors(comments)
  }

  // The authors of comments no grant names, asked of the instance by id once it names people (`peopleByRest`).
  async function nameAuthors(comments: readonly Comment[]) {
    const client = options.client()
    if (!client || !capabilities()?.peopleByRest) return
    const ids = [
      ...new Set(
        comments
          .filter((comment) => !comment.mine && state.people[comment.author] === undefined)
          .map((comment) => comment.author),
      ),
    ]
    if (ids.length === 0) return
    const found = await client.people({ ids })
    if (!isFailure(found)) found.forEach((person) => setState("people", person.id, person.name))
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
// which the Drive's state does not carry, and how to start the person's sign-in for it (G01, the accounts Ipc).
const [active, setActive] = createSignal<{ url: string; user?: string; signIn?: () => void }>()

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

/**
 * Starts the person's sign-in in the system browser for the active account (G01), as Settings does: the Drive's state
 * follows when it ends. Only ever on the user's click.
 */
export function signInAsYou() {
  active()?.signIn?.()
}
