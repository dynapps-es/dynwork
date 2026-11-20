export * as DriveIpc from "./ipc"

import { Schema } from "effect"
import type { IpcImpl, Persisted } from "@opencode/plugin/gui/main"
import { DriveArtifacts } from "./artifacts"
import { fail, type Backend } from "./backend"
import { DriveCapabilities } from "./capabilities"
import { DriveCells } from "./cells"
import { isFailure, Link, Mention, Person, type Conversation, type Drive, type Failure, type State } from "./contract"
import { DriveMentions } from "./mentions"

/** The account the Drive shows: the active, signed-in one, and the name its direct writes are signed with. */
export interface Account {
  id: string
  /** The user's email or name: "<user> by DynWork". */
  user: string
  /** The user's id in the instance: what `@Agent` mentions. Absent in an account signed in before DynWork kept it. */
  userId?: string
}

/** Timers the service arms; `set` answers what cancels it. Tests pass their own, so nothing waits on real time. */
export interface Timers {
  set(fire: () => unknown, ms: number): () => void
}

/**
 * A conversation's context in the instance (D20): the id the instance gave it, which its writes carry as `x-context-id`,
 * and the title it was registered or last renamed under.
 */
const Context = Schema.Struct({ id: Schema.String, name: Schema.String })

/**
 * What the service keeps on this computer, per account: each conversation's context (by session id), the conversation
 * ↔ document index, the folder each conversation's files go to (by session id), what became of the comments that
 * asked for the agent, and the people the agent and the share cards met (id, name and email only, for the cards). A context saved as a plain string is a UUID an earlier version made up and the instance never
 * registered: it is not sent, and the conversation's next write registers one in its place. The index keys
 * conversations by session id, so no link is lost.
 */
export const Saved = Schema.Struct({
  accounts: Schema.Record(
    Schema.String,
    Schema.Struct({
      contexts: Schema.Record(Schema.String, Schema.Union([Schema.String, Context])),
      links: Schema.Array(Link),
      // Absent in what an earlier version saved.
      folders: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
      mentions: Schema.optionalKey(Schema.Array(Mention)),
      people: Schema.optionalKey(Schema.Array(Person)),
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
  /**
   * Switches to force on or off over what the account's instance delivers, which the service reads from the instance
   * itself (`DriveCapabilities.delivered`). Absent: what the instance delivers, as read.
   */
  capabilities?: (account: string) => Partial<DriveCapabilities.Capabilities>
  timers?: Timers
  now?: () => number
}

// The snapshot pushed to windows, tagged with the account it was read for. A switch of account replaces it whole.
type Cache = Pick<State, "account" | "status" | "folders" | "documents" | "read">

/** How many comments that asked for the agent an account keeps the outcome of: the newest. */
const keptMentions = 200

/** How many people an account keeps for the share cards: the most recently seen. */
export const keptPeople = 500

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
 *   index, which the instance's own list of the conversation's documents completes where it has one (`docsByContext`).
 * - What the account's instance delivers (`capabilities`) is read from its discovery when the account becomes active
 *   and each time it answers again after failing (`detect`), and pushed to windows with the snapshot.
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
  // Main code that follows the active account and the comments that ask for the agent (`DriveMentions`).
  const listeners = {
    account: new Set<(account: A | undefined) => unknown>(),
    asked: new Set<(asked: { account: string; document: string; comment: string }) => unknown>(),
    capabilities: new Set<(account: string) => unknown>(),
  }
  const live: {
    account?: A
    backend?: Backend
    cache: Cache
    // The newest read begun, so that one answering late, or for an account that left, is dropped.
    reads: number
    watching: number
    stop?: () => void
    // What the instance delivers, once read (`detect`); the newest reading begun, so a late one is dropped
    delivered?: DriveCapabilities.Capabilities
    detections: number
    // The account's stream is open (`DriveMentions`): with `pushChanges`, the fast poll is not needed
    streaming: boolean
  } = { cache: empty(undefined), reads: 0, watching: 0, detections: 0, streaming: false }
  // The registrations under way, by account and conversation: the writes of one conversation share one.
  const registering = new Map<string, Promise<string | undefined>>()
  // A read the stream asked for (`reread`): one at a time, and one more after it when another change came meanwhile.
  const hinted = { reading: false, again: false }

  const capabilities = (): DriveCapabilities.Capabilities => ({
    ...DriveCapabilities.none,
    ...live.delivered,
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
    live.detections++
    live.delivered = undefined
    live.streaming = false
    live.account = account
    live.backend = account ? options.backend(account) : undefined
    live.cache = empty(account?.id)
    options.changed()
    listeners.account.forEach((listener) => listener(account))
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
    // The instance answers again (or for the first time): what it delivers may have changed with it.
    if (failure === undefined && (live.cache.status !== "ready" || live.delivered === undefined))
      void detect(backend, account)
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
    live.stop = timers.set(
      () => void load(),
      DriveCapabilities.pollEvery(capabilities(), live.watching > 0, live.streaming),
    )
  }

  /**
   * Reads what the account's instance delivers from its discovery (`DriveCapabilities.delivered`), probing
   * `GET /documents/people?ids=` with the user's own id only where discovery tells neither its version nor the Drive.
   * An instance that does not answer leaves what was read before, and the next read that succeeds asks again.
   */
  async function detect(backend: Backend, account: A) {
    const run = ++live.detections
    const said = await guard(() => backend.discovery())
    if (isFailure(said)) return
    const read = DriveCapabilities.delivered(said) ?? (await probe(backend, account))
    if (run !== live.detections || live.account?.id !== account.id) return
    const before = capabilities()
    live.delivered = read
    if (live.stop) arm()
    const after = capabilities()
    if (!DriveCapabilities.keys.some((key) => before[key] !== after[key])) return
    options.changed()
    listeners.capabilities.forEach((listener) => listener(account.id))
  }

  async function probe(backend: Backend, account: A) {
    const user = account.userId
    if (user === undefined) return DriveCapabilities.none
    const found = await guard(() => backend.people([user]))
    if (isFailure(found) && found.code === "unreachable") return undefined
    return DriveCapabilities.delivered({ people: !isFailure(found) }) ?? DriveCapabilities.none
  }

  /**
   * The account's stream opened or closed (`DriveMentions`). Closed, the poll is armed again at once, the fast one if a
   * window watches. Opened, the poll already armed still fires, and the read it makes covers what the stream missed
   * while it was closed (it keeps no history); the next one is armed for the push.
   */
  function streamed(account: string, open: boolean) {
    if (live.account?.id !== account || live.streaming === open) return
    live.streaming = open
    if (!open && live.stop) arm()
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

  // The id the instance gave a conversation of an account, once registered.
  function registered(account: string, conversation: string) {
    const known = options.store.value.accounts[account]?.contexts[conversation]
    return typeof known === "object" ? known.id : undefined
  }

  /**
   * The conversation's `x-context-id` (D20): registered in the instance under its title on its first write, and kept
   * for the life of the account on this computer; after its title changes, the next write renames it. When the instance
   * does not answer, the write goes without one and the next write tries again.
   */
  function context(backend: Backend, account: string, conversation: Conversation) {
    const key = `${account}/${conversation.id}`
    const running = registering.get(key)
    if (running) return running
    const done = register(backend, account, conversation).finally(() => registering.delete(key))
    registering.set(key, done)
    return done
  }

  async function register(backend: Backend, account: string, conversation: Conversation) {
    const known = options.store.value.accounts[account]?.contexts[conversation.id]
    if (typeof known === "object") {
      if (known.name === conversation.name) return known.id
      const renamed = await guard(() => backend.renameContext(known.id, conversation.name))
      if (!isFailure(renamed)) keep(account, conversation.id, { id: known.id, name: conversation.name })
      // Gone from the instance (the user deleted it there): registered again below. Anything else leaves it as it is.
      if (!isFailure(renamed) || renamed.code !== "not-found") return known.id
    }
    const id = await guard(() => backend.createContext(conversation.name))
    if (isFailure(id)) return undefined
    keep(account, conversation.id, { id, name: conversation.name })
    return id
  }

  // The instance refused the conversation's context (0.84, `unknown-context`): the next write registers it again.
  function forget(account: string, conversation: string) {
    options.store.update((draft) => {
      if (draft.accounts[account]) delete draft.accounts[account].contexts[conversation]
    })
  }

  function keep(account: string, conversation: string, context: typeof Context.Type) {
    options.store.update((draft) => {
      draft.accounts[account] ??= { contexts: {}, links: [] }
      draft.accounts[account].contexts[conversation] = context
    })
  }

  // Who a write is signed by, and the conversation's context, registered on the way.
  async function author(backend: Backend, account: Account, conversation: Conversation | undefined) {
    const id = conversation && (await context(backend, account.id, conversation))
    return DriveCapabilities.attribution(capabilities(), {
      user: account.user,
      conversation: conversation && { name: conversation.name, context: id },
    })
  }

  /**
   * A write with its author (`author`). When the instance does not hold the conversation's context any more (0.84,
   * `unknown-context`: deleted in Governance, say), it is registered again and the write is made once more; nothing was
   * written the first time.
   */
  async function attributed<B>(
    backend: Backend,
    account: Account,
    conversation: Conversation | undefined,
    write: (signed: Awaited<ReturnType<typeof author>>) => Promise<B | Failure>,
  ) {
    const first = await write(await author(backend, account, conversation))
    if (!conversation || !isFailure(first) || first.code !== "unknown-context") return first
    forget(account.id, conversation.id)
    return write(await author(backend, account, conversation))
  }

  // What the instance answers of a revision or a comment, with whether it is DynWork's own: written from a conversation
  // it registered for the account, or signed "… by DynWork" (a revision written without the conversation's context).
  function owned<B extends { context?: string; message?: string; conversation?: string }>(account: string, item: B) {
    const known = Object.values(options.store.value.accounts[account]?.contexts ?? {}).find(
      (context) => typeof context === "object" && context.id === item.context,
    )
    const ours = typeof known === "object" || item.message?.endsWith(" by DynWork") === true
    if (!ours) return item
    // The instance tells the title to the conversation's owner only; DynWork knows its own anyway.
    return { ...item, ours, conversation: item.conversation ?? (typeof known === "object" ? known.name : undefined) }
  }

  // The revision message alone, for a write that carries no context: the agent's through the MCP (`contextByMcp` off).
  const message = (account: Account, conversation: Conversation | undefined) =>
    DriveCapabilities.attribution(capabilities(), {
      user: account.user,
      conversation: conversation && { name: conversation.name },
    }).message

  /**
   * The stream says the Drive changed (`document.drive.changed`): with `pushChanges` on, the account's Drive is read
   * now, and a burst of changes makes at most one more read. Off, the poll alone reads it, as before.
   */
  async function reread(account: string) {
    if (live.account?.id !== account || !capabilities().pushChanges) return
    if (hinted.reading) {
      hinted.again = true
      return
    }
    hinted.reading = true
    do {
      hinted.again = false
      await load()
    } while (hinted.again && live.account?.id === account)
    hinted.reading = false
  }

  // The index keeps every write of a conversation, also where the instance lists them by conversation: it is what opens
  // a new document beside its chat, what `@Agent` wakes a conversation by, and what answers when the instance does not.
  function record(account: string, link: Omit<Link, "at" | "via"> & { via: "rest" | "mcp" }) {
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

  const mentions = (account: string | undefined) =>
    account === undefined ? [] : (options.store.value.accounts[account]?.mentions ?? [])

  // `@Agent` in the text of a comment is written as a mention of the user themself, handed to their agent, and the comment
  // that made it is attended (`DriveMentions`) once it exists. An account that does not know its user keeps the text as it is.
  const say = (account: Account, body: string) =>
    account.userId !== undefined && DriveMentions.asks(body)
      ? { body: DriveMentions.write(body, { id: account.userId, name: account.user }), agent: true }
      : { body, agent: false }
  const asked = (account: Account, document: string, comment: string, agent: boolean) => {
    if (agent) listeners.asked.forEach((listener) => listener({ account: account.id, document, comment }))
  }

  const ipc: IpcImpl<(typeof Drive)["spec"]> = {
    state: () => ({
      ...live.cache,
      capabilities: capabilities(),
      links: links(live.cache.account),
      mentions: mentions(live.cache.account),
    }),
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
    revisions: (input) =>
      on(async (backend, account) => {
        const list = await backend.revisions(input.id)
        return isFailure(list) ? list : list.map((revision) => owned(account.id, revision))
      }),
    proposals: (input) => on((backend) => backend.proposals(input.id)),
    comments: (input) =>
      on(async (backend, account) => {
        const list = await backend.comments(input.id)
        return isFailure(list) ? list : list.map((comment) => owned(account.id, comment))
      }),
    access: (input) => on((backend) => backend.access(input.id)),
    // A change of who has access is the user's own, from the window; the instance's agent policy decides (`share`).
    share: (input) => on((backend) => backend.share(input.id, { kind: input.kind, value: input.value, level: input.level })),
    unshare: (input) => on((backend) => backend.unshare(input.id, input.grant)),
    // Over REST where the instance has it (0.84), otherwise through the `documents` MCP server's `documents_people`.
    findPeople: (input) =>
      on((backend) =>
        capabilities().peopleByRest
          ? backend.searchPeople(input.query, input.limit)
          : backend.findPeople(input.query, input.limit),
      ),
    agentCap: (input) => on((backend) => backend.agentCap(input)),
    createFolder: (input) => changing((backend) => backend.createFolder(input)),
    upload: (input) =>
      changing(async (backend, account) => {
        const created = await attributed(backend, account, input.conversation, (signed) =>
          backend.upload({ ...input, ...signed }),
        )
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
    // 0.83 keeps no message on a document it makes from a template (C4), only the conversation's context; 0.84 keeps it.
    create: (input) =>
      changing(async (backend, account) => {
        const created = await attributed(backend, account, input.conversation, (signed) =>
          backend.create({ template: input.template, name: input.name, folder: input.folder, ...signed }),
        )
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
        const edited = await attributed(backend, account, input.conversation, (signed) =>
          backend.edit(input.id, { ops: input.ops, base: input.base, mode: input.mode, ...signed }),
        )
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
        // A cell range goes as the instance keeps it (`b2:d9` is `B2:D9`); one it would refuse does not go.
        const cells = input.anchor.kind === "range" ? DriveCells.parse(input.anchor.cells) : undefined
        if (cells && "refused" in cells) return fail("invalid", "That is not a cell range such as B2 or B2:D9.")
        const anchor = cells ? { ...input.anchor, cells: cells.cells } : input.anchor
        const said = say(account, input.body)
        const created = await attributed(backend, account, input.conversation, (signed) =>
          backend.comment(input.id, {
            body: said.body,
            anchor,
            contextId: signed.contextId,
            ...(said.agent ? { agent: true } : {}),
          }),
        )
        if (!isFailure(created)) asked(account, input.id, created.id, said.agent)
        return created
      }),
    reply: (input) =>
      on(async (backend, account) => {
        const said = say(account, input.body)
        const created = await attributed(backend, account, input.conversation, (signed) =>
          backend.reply(input.id, {
            body: said.body,
            parent: input.parent,
            contextId: signed.contextId,
            ...(said.agent ? { agent: true } : {}),
          }),
        )
        if (!isFailure(created)) asked(account, input.id, created.id, said.agent)
        return created
      }),
    resolve: (input) => on((backend) => backend.resolve(input.id, input.comment)),
    reopen: (input) =>
      on(async (backend) =>
        capabilities().reopenComments
          ? backend.reopen(input.id, input.comment)
          : fail("unsupported", "Governance cannot reopen a comment yet."),
      ),
    people: (input) =>
      on(async (backend) =>
        capabilities().peopleByRest
          ? backend.people(input.ids)
          : fail("unsupported", "Governance does not name people by id yet."),
      ),
    link: (input) =>
      on(async (_, account) => {
        record(account.id, input)
        return undefined
      }),
    documentsOf: (input) =>
      on(async (backend, account) =>
        DriveArtifacts.merge(
          input.conversation,
          links(account.id).filter((link) => link.conversation === input.conversation),
          await listed(backend, account.id, input.conversation),
        ),
      ),
    byContext: (input) => on((backend, account) => listed(backend, account.id, input.conversation)),
  }

  /**
   * What the instance lists for a conversation (G07): only where it lists by conversation and this computer registered
   * the conversation. A failure, `unknown-context` included, is none: the index answers alone, and no window shows it.
   */
  async function listed(backend: Backend, account: string, conversation: string) {
    const id = registered(account, conversation)
    if (!capabilities().docsByContext || id === undefined) return []
    const answer = await guard(async () => (await backend.byContext?.(id)) ?? [])
    return isFailure(answer) ? [] : answer
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
    /** Enters what a conversation did into the index. */
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
    /** The author of a write, as the service signs it (`DriveCapabilities.attribution`), the conversation registered. */
    author,
    /** A write with its author, registered again and made once more when the instance no longer holds its context. */
    attributed,
    /** The revision message alone, for a write without the conversation's context: the agent's through the MCP. */
    message,
    /** The stream says the account's Drive changed. */
    reread: (account: string) => void reread(account),
    /** The account's stream opened (`true`) or closed: the push replaces the fast poll only while it is open. */
    streamed,
    /** Main calls it on every change of the accounts: a new active account replaces the snapshot. */
    account: () => {
      if (follow()) void load()
    },
    /** The active account, signed in, or undefined. */
    current: () => {
      if (follow()) void load()
      return live.account
    },
    /** What a conversation did to which documents of an account, newest first. */
    linksOf: links,
    /** What became of the comments of an account that asked for the agent: one record per comment, kept. */
    mention: {
      get: (account: string, comment: string) => mentions(account).find((entry) => entry.comment === comment),
      add: (account: string, entry: Mention) => {
        options.store.update((draft) => {
          draft.accounts[account] ??= { contexts: {}, links: [] }
          draft.accounts[account].mentions = [...(draft.accounts[account].mentions ?? []), entry].slice(-keptMentions)
        })
        options.changed()
      },
    },
    /**
     * The people an account met (`DriveShare`): what the agent's `documents_people` answered and what the cards looked up,
     * so a card names someone by id after a restart or in another conversation, where 0.83 cannot look an id up. The
     * most recent `keptPeople`; a person seen again moves to the end with what was seen last.
     */
    known: {
      find: (account: string, value: string) => {
        const lower = value.toLowerCase()
        return options.store.value.accounts[account]?.people?.findLast(
          (person) => person.id === value || person.email?.toLowerCase() === lower,
        )
      },
      remember: (account: string, people: readonly Person[]) => {
        if (people.length === 0) return
        const ids = new Set(people.map((person) => person.id))
        options.store.update((draft) => {
          draft.accounts[account] ??= { contexts: {}, links: [] }
          draft.accounts[account].people = [
            ...(draft.accounts[account].people ?? []).filter((person) => !ids.has(person.id)),
            ...people,
          ].slice(-keptPeople)
        })
      },
    },
    /** For main code: `account` is told when the active account changes, `asked` when a comment asks for the agent. */
    listen: {
      account: (listener: (account: A | undefined) => unknown) => {
        listeners.account.add(listener)
        return () => void listeners.account.delete(listener)
      },
      asked: (listener: (asked: { account: string; document: string; comment: string }) => unknown) => {
        listeners.asked.add(listener)
        return () => void listeners.asked.delete(listener)
      },
      /** What the account's instance delivers changed (`detect`): the agent's switches go to the plugin again. */
      capabilities: (listener: (account: string) => unknown) => {
        listeners.capabilities.add(listener)
        return () => void listeners.capabilities.delete(listener)
      },
    },
    /** The folders of the Drive as last read. */
    folders: () => live.cache.folders,
    /** The `x-context-id` of a conversation of the active account, once registered. */
    context: (conversation: string) => (live.account ? registered(live.account.id, conversation) : undefined),
    /**
     * The instance refused a write of the agent's for not knowing `context` (0.84, `unknown_context`): when it is still
     * the conversation's on the active account, it is forgotten, and the conversation's next write registers it again.
     */
    stale: (conversation: string, context: string) => {
      const account = live.account?.id
      if (account !== undefined && registered(account, conversation) === context) forget(account, conversation)
    },
    capabilities,
    /**
     * What the agent's `documents` rules and calls need of what `account`'s instance delivers (`DriveCapabilities.agent`),
     * for the server plugin; undefined while `account` is not the Drive's active one.
     */
    switches: (account: string) => {
      if (follow()) void load()
      return live.account?.id === account ? DriveCapabilities.agent(capabilities()) : undefined
    },
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
