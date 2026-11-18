export * as DriveIpc from "./ipc"

import { randomUUID } from "node:crypto"
import { Schema } from "effect"
import type { IpcImpl, Persisted } from "@opencode/plugin/gui/main"
import { fail, type Backend } from "./backend"
import { DriveCapabilities } from "./capabilities"
import { isFailure, Link, type Conversation, type Drive, type Failure, type State } from "./contract"

/** The account the Drive shows: the active, signed-in one, and the name its direct writes are signed with. */
export interface Account {
  id: string
  /** The user's email or name: "<user> by DynWork". */
  user: string
}

/** Timers the service arms; `set` answers what cancels it. Tests pass their own, so nothing waits on real time. */
export interface Timers {
  set(fire: () => unknown, ms: number): () => void
}

/**
 * What the service keeps on this computer, per account: the `x-context-id` it gave each conversation (a UUID v4, by
 * session id), the conversation ↔ document index and the folder each conversation's files go to (by session id).
 */
export const Saved = Schema.Struct({
  accounts: Schema.Record(
    Schema.String,
    Schema.Struct({
      contexts: Schema.Record(Schema.String, Schema.String),
      links: Schema.Array(Link),
      // Absent in what an earlier version saved.
      folders: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    }),
  ),
})
export type Saved = typeof Saved.Type
export const initial: Saved = { accounts: {} }

export interface Options<A extends Account = Account> {
  account: () => A | undefined
  /** The account's Drive. Made once per account switch. */
  backend: (account: A) => Backend
  store: Persisted<Saved, Saved>
  /** The state changed: the provider's `changed()`. */
  changed: () => void
  /** What the account's instance has delivered. Absent: nothing (`DriveCapabilities.none`). */
  capabilities?: (account: string) => Partial<DriveCapabilities.Capabilities>
  timers?: Timers
  now?: () => number
}

// The snapshot pushed to windows, tagged with the account it was read for. A switch of account replaces it whole.
type Cache = Pick<State, "account" | "status" | "folders" | "documents" | "read">

const empty = (account: string | undefined): Cache => ({
  account,
  status: account === undefined ? "none" : "loading",
  folders: [],
  documents: [],
})

/**
 * The Drive service over the active account's backend.
 * - `state` is a snapshot of the account's folders and recent documents, read at start, after each write, on
 *   `refresh`, and polled every 5 minutes, or every 20 s while a window watches (D10). It is a snapshot because
 *   `IpcImpl.state` is synchronous and a backend's answer is not.
 * - When the active account changes (`account()`, which main calls on every change of the accounts), the snapshot
 *   and the backend go and the new account's Drive is read.
 * - Every write carries its attribution (`DriveCapabilities.attribution`); a write from a conversation enters the
 *   index while the Drive cannot answer it (`DriveCapabilities.indexed`).
 */
export function make<A extends Account>(options: Options<A>) {
  const now = options.now ?? Date.now
  const timers = options.timers ?? {
    set: (fire, ms) => {
      const timer = setTimeout(fire, ms)
      timer.unref?.()
      return () => clearTimeout(timer)
    },
  }
  const live: {
    account?: A
    backend?: Backend
    cache: Cache
    // The newest read begun, so that one answering late, or for an account that left, is dropped.
    reads: number
    watching: number
    stop?: () => void
  } = { cache: empty(undefined), reads: 0, watching: 0 }

  const capabilities = (): DriveCapabilities.Capabilities => ({
    ...DriveCapabilities.none,
    ...(live.account ? options.capabilities?.(live.account.id) : undefined),
  })

  // Takes the active account; on a change, drops what the previous one left. Answers whether it changed.
  function follow() {
    const account = options.account()
    if (account?.id === live.cache.account) {
      live.account = account
      return false
    }
    live.stop?.()
    live.stop = undefined
    live.reads++
    live.account = account
    live.backend = account ? options.backend(account) : undefined
    live.cache = empty(account?.id)
    options.changed()
    return true
  }

  async function load() {
    follow()
    const backend = live.backend
    const account = live.account
    if (!backend || !account) return
    const read = ++live.reads
    const [folders, listing] = await Promise.all([
      guard(() => backend.folders()),
      guard(() => backend.list({ scope: "recent", limit: 100 })),
    ])
    if (read !== live.reads) return
    const failure = [folders, listing].find(isFailure)
    // A read that failed keeps the last answer: a window does not blank because Governance is away for a moment.
    live.cache = {
      account: account.id,
      status: failure === undefined ? "ready" : failure.code === "signed-out" ? "signed-out" : "unreachable",
      folders: isFailure(folders) ? live.cache.folders : folders,
      documents: isFailure(listing) ? live.cache.documents : listing.documents,
      read: failure === undefined ? now() : live.cache.read,
    }
    arm()
    options.changed()
  }

  function arm() {
    live.stop?.()
    live.stop = timers.set(() => void load(), DriveCapabilities.pollEvery(capabilities(), live.watching > 0))
  }

  // The backend of the active account, or the failure that says there is none.
  function on<A>(call: (backend: Backend, account: Account) => Promise<A | Failure>): Promise<A | Failure> {
    if (follow()) void load()
    const backend = live.backend
    const account = live.account
    if (!backend || !account) return Promise.resolve(fail("signed-out", "Sign in to Governance to use the Drive."))
    return guard(() => call(backend, account))
  }

  // `on`, then the snapshot catches up with what the call changed.
  async function changing<A>(call: (backend: Backend, account: Account) => Promise<A | Failure>) {
    const answer = await on(call)
    if (!isFailure(answer)) await load()
    return answer
  }

  // The conversation's `x-context-id`: given once, kept for the life of the account on this computer.
  function context(account: string, conversation: string) {
    const known = options.store.value.accounts[account]?.contexts[conversation]
    if (known !== undefined) return known
    const id = randomUUID()
    options.store.update((draft) => {
      draft.accounts[account] ??= { contexts: {}, links: [] }
      draft.accounts[account].contexts[conversation] = id
    })
    return id
  }

  function author(account: Account, conversation: Conversation | undefined) {
    return DriveCapabilities.attribution(capabilities(), {
      user: account.user,
      conversation: conversation && { name: conversation.name, context: context(account.id, conversation.id) },
    })
  }

  function record(account: string, link: Omit<Link, "at" | "via"> & { via: "rest" | "mcp" }) {
    if (!DriveCapabilities.indexed(capabilities(), link.via)) return
    const sameAct = (entry: Link) =>
      entry.conversation === link.conversation && entry.document === link.document && entry.act === link.act
    options.store.update((draft) => {
      draft.accounts[account] ??= { contexts: {}, links: [] }
      if (draft.accounts[account].links.some((entry) => sameAct(entry) && entry.revision === link.revision)) return
      // A document an agent edits twenty times is one entry, at its latest revision.
      draft.accounts[account].links = draft.accounts[account].links.filter((entry) => !sameAct(entry))
      draft.accounts[account].links.push({ ...link, at: now() })
    })
    options.changed()
  }

  const links = (account: string | undefined) =>
    (account === undefined ? [] : (options.store.value.accounts[account]?.links ?? [])).toSorted((a, b) => b.at - a.at)

  const ipc: IpcImpl<(typeof Drive)["spec"]> = {
    state: () => ({ ...live.cache, capabilities: capabilities(), links: links(live.cache.account) }),
    refresh: () => load(),
    watch: (_, caller) =>
      new Promise<void>((resolve) => {
        if (caller.signal.aborted) return resolve()
        live.watching++
        if (live.watching === 1) void load()
        caller.signal.addEventListener(
          "abort",
          () => {
            live.watching--
            if (live.watching === 0 && live.stop) arm()
            resolve()
          },
          { once: true },
        )
      }),
    list: (input) => on((backend) => backend.list(input)),
    folders: () => on((backend) => backend.folders()),
    get: (input) => on((backend) => backend.get(input.id)),
    rendered: (input) => on((backend) => backend.rendered(input.id, input.revision)),
    preview: (input) => on((backend) => backend.preview(input.id, input.revision)),
    content: (input) => on((backend) => backend.content(input.id, input.revision)),
    pdf: (input) => on((backend) => backend.pdf(input.id, input.revision)),
    outline: (input) => on((backend) => backend.outline(input.id)),
    revisions: (input) => on((backend) => backend.revisions(input.id)),
    proposals: (input) => on((backend) => backend.proposals(input.id)),
    comments: (input) => on((backend) => backend.comments(input.id)),
    access: (input) => on((backend) => backend.access(input.id)),
    agentCap: (input) => on((backend) => backend.agentCap(input)),
    createFolder: (input) => changing((backend) => backend.createFolder(input)),
    upload: (input) =>
      changing(async (backend, account) => {
        const created = await backend.upload({ ...input, ...author(account, input.conversation) })
        if (!isFailure(created) && input.conversation)
          record(account.id, {
            conversation: input.conversation.id,
            document: created.document.id,
            act: "created",
            revision: created.revision.id,
            via: "rest",
          })
        return created
      }),
    // The instance keeps no message on a document it makes from a template (C4): only the conversation's context.
    create: (input) =>
      changing(async (backend, account) => {
        const created = await backend.create({
          template: input.template,
          name: input.name,
          folder: input.folder,
          contextId: author(account, input.conversation).contextId,
        })
        if (!isFailure(created) && input.conversation)
          record(account.id, {
            conversation: input.conversation.id,
            document: created.document.id,
            act: "created",
            revision: created.revision.id,
            via: "rest",
          })
        return created
      }),
    edit: (input) =>
      changing(async (backend, account) => {
        const edited = await backend.edit(input.id, {
          ops: input.ops,
          base: input.base,
          mode: input.mode,
          ...author(account, input.conversation),
        })
        if (!isFailure(edited) && input.conversation)
          record(account.id, {
            conversation: input.conversation.id,
            document: input.id,
            act: edited.kind === "landed" ? "edited" : "proposed",
            revision: edited.revision.id,
            via: "rest",
          })
        return edited
      }),
    // A comment carries no revision message (the instance names its agent from the token): only the conversation.
    comment: (input) =>
      on(async (backend, account) => {
        if (!DriveCapabilities.anchorable(capabilities(), input.anchor))
          return fail("unsupported", "This kind of comment is not available yet.")
        return backend.comment(input.id, {
          body: input.body,
          anchor: input.anchor,
          contextId: author(account, input.conversation).contextId,
        })
      }),
    reply: (input) =>
      on((backend, account) =>
        backend.reply(input.id, {
          body: input.body,
          parent: input.parent,
          contextId: author(account, input.conversation).contextId,
        }),
      ),
    resolve: (input) => on((backend) => backend.resolve(input.id, input.comment)),
    link: (input) =>
      on(async (_, account) => {
        record(account.id, input)
        return undefined
      }),
    documentsOf: (input) =>
      on(async (backend, account) => {
        const local = links(account.id).filter((link) => link.conversation === input.conversation)
        if (!capabilities().docsByContext || !backend.byContext) return local
        const listed = await backend.byContext(context(account.id, input.conversation))
        if (isFailure(listed)) return listed
        // The Drive does not say what the conversation did, only that it wrote: `edited`, unless the index knows more.
        const known = new Set(local.map((link) => link.document))
        const server = listed
          .filter((document) => !known.has(document.id))
          .map(
            (document): Link => ({
              conversation: input.conversation,
              document: document.id,
              act: "edited",
              revision: document.revision,
              via: "server",
              at: document.updated,
            }),
          )
        return [...local, ...server].toSorted((a, b) => b.at - a.at)
      }),
  }

  follow()
  void load()

  return {
    ipc,
    /**
     * For main code that works for a conversation (`DriveAgent`): `call` on the active account's backend, answering as
     * the Ipc's methods do when there is none or it fails. `changing` also has the snapshot catch up with a write.
     */
    using: on,
    changing,
    /** Enters what a conversation did into the index, where the Drive cannot answer it (`DriveCapabilities.indexed`). */
    record,
    /** The Drive's folder a conversation's files go to, once made (by session id). */
    folder: {
      get: (account: string, conversation: string) => options.store.value.accounts[account]?.folders?.[conversation],
      all: (account: string) => options.store.value.accounts[account]?.folders ?? {},
      set: (account: string, conversation: string, folder: string) =>
        options.store.update((draft) => {
          draft.accounts[account] ??= { contexts: {}, links: [] }
          draft.accounts[account].folders ??= {}
          draft.accounts[account].folders[conversation] = folder
        }),
    },
    /** The author of a write, as the service would sign it (`DriveCapabilities.attribution`). */
    author,
    /** Main calls it on every change of the accounts: a new active account replaces the snapshot. */
    account: () => {
      if (follow()) void load()
    },
    /** The `x-context-id` of a conversation of the active account, for the agent's writes (phase 07). */
    context: (conversation: string) => (live.account ? context(live.account.id, conversation) : undefined),
    capabilities,
    dispose: () => {
      live.stop?.()
      live.stop = undefined
      live.reads++
    },
  }
}

export type Service = ReturnType<typeof make>

// The one place a backend's rejection is caught: backends answer failures as data, so a rejection is a bug in one, and
// its message may carry what no window should see. It is not passed on.
function guard<A>(call: () => Promise<A>): Promise<A | Failure> {
  return Promise.resolve()
    .then(call)
    .catch(() => fail("failed", "The Drive did not answer."))
}
