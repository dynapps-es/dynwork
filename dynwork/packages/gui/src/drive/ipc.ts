export * as DriveIpc from "./ipc"

import { Schema } from "effect"
import type { IpcImpl, Persisted } from "@opencode/plugin/gui/main"
import { DriveArtifacts } from "./artifacts"
import { fail, type Backend } from "./backend"
import { DriveCapabilities } from "./capabilities"
import { DriveCells } from "./cells"
import {
  isFailure,
  Link,
  Mention,
  Person,
  Unimported,
  type Conversation,
  type Created,
  type Drive,
  type Failure,
  type State,
} from "./contract"
import { DriveMentions } from "./mentions"
import type { Person as PersonSession } from "../accounts/contract"

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
 * asked for the agent, the people the agent and the share cards met (id, name and email only, for the cards), and the
 * agent's pages DynWork could not import. A context saved as a plain string is a UUID an earlier version made up and
 * the instance never registered: it is not sent, and the conversation's next write registers one in its place. The
 * index keys conversations by session id, so no link is lost.
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
      unimported: Schema.optionalKey(Schema.Array(Unimported)),
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
  /**
   * The person's own session in each account's instance (G01, `DynWorkPerson`), kept by main: how it stands, and a
   * backend that acts as the person with it. Absent, DynWork acts as its agent only, as before.
   */
  person?: {
    status: (account: string) => PersonSession["status"]
    backend: (account: A) => Backend
  }
  timers?: Timers
  now?: () => number
}

/**
 * How the person's session stands for the active account: `on` acts as them (renewing included); `off` could once they
 * sign in; `unavailable` where the instance has no session for DynWork (before 0.84), or main keeps none.
 */
export type Acting = "on" | "off" | "unavailable"

// The snapshot pushed to windows, tagged with the account it was read for. A switch of account replaces it whole.
type Cache = Pick<State, "account" | "status" | "folders" | "documents" | "read">

/** How many comments that asked for the agent an account keeps the outcome of: the newest. */
const keptMentions = 200

/** How many people an account keeps for the share cards: the most recently seen. */
export const keptPeople = 500

/** How many pages DynWork could not import an account keeps for the Artifacts tabs: the newest. */
export const keptUnimported = 50

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
    // The person's backend for the account (G01): used only while their session is on
    person?: Backend
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
  // What imports an agent's page again (`reimport`): `DriveAgent`'s, once main sets it up.
  const pages: { importer?: (page: Unimported) => Promise<Created | Failure> } = {}

  const capabilities = (): DriveCapabilities.Capabilities => ({
    ...DriveCapabilities.none,
    ...live.delivered,
    personActions: acting() === "on",
    ...(live.account ? options.capabilities?.(live.account.id) : undefined),
  })

  function acting(): Acting {
    const account = live.account
    if (!account || !options.person || !live.person) return "unavailable"
    const status = options.person.status(account.id)
    if (status === "on" || status === "renewing") return "on"
    return status === "unavailable" ? "unavailable" : "off"
  }

  // The backend a user's own act goes through: the person's while their session is on (`personActions`).
  const personal = () => (capabilities().personActions ? live.person : undefined)

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
    live.person = account ? options.person?.backend(account) : undefined
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

  /**
   * A user's own act, from a window (G01). While the person's session is on it goes as the person (`actor`), signed with
   * no "… by DynWork"; otherwise as DynWork's agent, as before, and what the instance keeps to the person then asks the
   * user to sign in, where the instance has a session for DynWork. The agent's backend (`agent`) registers a
   * conversation: the person's session does not reach the contexts route.
   */
  function manual<B>(
    call: (actor: Backend, account: Account, agent: Backend, person: boolean) => Promise<B | Failure>,
  ): Promise<B | Failure> {
    return on(async (backend, account) => {
      const person = personal()
      const answer = await call(person ?? backend, account, backend, person !== undefined)
      if (person === undefined && isFailure(answer) && answer.code === "person" && acting() === "off")
        return fail("sign-in", "Sign in to act as you.")
      return answer
    })
  }

  /**
   * What only the person can do (G01): trash, transfer, restore, review a proposal. As the person while their session is
   * on; otherwise nothing is sent, and the window says to sign in, or, where the instance has no session for DynWork, to
   * do it in Governance.
   */
  function owners<B>(call: (person: Backend) => Promise<B | Failure>): Promise<B | Failure> {
    return on(async () => {
      const person = personal()
      if (person) return call(person)
      return acting() === "off"
        ? fail("sign-in", "Sign in to act as you.")
        : fail("person", "Only you can do this, in Governance.")
    })
  }

  // A user's own write with its conversation's attribution: the agent registers the conversation, the actor writes, and
  // the person's write carries no "… by DynWork".
  const signedBy = <B>(
    agent: Backend,
    account: Account,
    conversation: Conversation | undefined,
    person: boolean,
    write: (signed: { contextId?: string; message?: string }) => Promise<B | Failure>,
  ) =>
    attributed(agent, account, conversation, (signed) =>
      write(person ? { contextId: signed.contextId } : signed),
    )

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

  const unimported = (account: string | undefined) =>
    (account === undefined ? [] : (options.store.value.accounts[account]?.unimported ?? [])).toSorted(
      (a, b) => b.at - a.at,
    )

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
      person: acting(),
      links: links(live.cache.account),
      mentions: mentions(live.cache.account),
      unimported: unimported(live.cache.account),
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
    share: (input) =>
      manual((actor) => actor.share(input.id, { kind: input.kind, value: input.value, level: input.level })),
    unshare: (input) => manual((actor) => actor.unshare(input.id, input.grant)),
    // The owner's, and the person's only (G01): each goes as the person or not at all.
    trash: async (input) => {
      const done = await owners((person) => person.trash(input.id))
      if (!isFailure(done)) await load()
      return done
    },
    transfer: async (input) => {
      const done = await owners((person) => person.transfer(input.id, input.to))
      if (!isFailure(done)) await load()
      return done
    },
    restore: async (input) => {
      const done = await owners((person) => person.restore(input.id, input.revision))
      if (!isFailure(done)) await load()
      return done
    },
    review: async (input) => {
      const done = await owners((person) =>
        person.review(input.id, input.proposal, {
          accept: input.accept,
          ...(input.note === undefined ? {} : { note: input.note }),
        }),
      )
      if (!isFailure(done)) await load()
      return done
    },
    // Over REST where the instance has it (0.84), otherwise through the `documents` MCP server's `documents_people`.
    findPeople: (input) =>
      on((backend) =>
        capabilities().peopleByRest
          ? backend.searchPeople(input.query, input.limit)
          : backend.findPeople(input.query, input.limit),
      ),
    agentCap: (input) => on((backend) => backend.agentCap(input)),
    createFolder: async (input) => {
      const made = await manual((actor) => actor.createFolder(input))
      if (!isFailure(made)) await load()
      return made
    },
    upload: async (input) => {
      const created = await manual(async (actor, account, agent, person) => {
        const created = await signedBy(agent, account, input.conversation, person, (signed) =>
          actor.upload({ ...input, ...signed }),
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
      })
      if (!isFailure(created)) await load()
      return created
    },
    // 0.83 keeps no message on a document it makes from a template (C4), only the conversation's context; 0.84 keeps it.
    create: async (input) => {
      const created = await manual(async (actor, account, agent, person) => {
        const created = await signedBy(agent, account, input.conversation, person, (signed) =>
          actor.create({ template: input.template, name: input.name, folder: input.folder, ...signed }),
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
      })
      if (!isFailure(created)) await load()
      return created
    },
    edit: async (input) => {
      const edited = await manual(async (actor, account, agent, person) => {
        const edited = await signedBy(agent, account, input.conversation, person, (signed) =>
          actor.edit(input.id, { ops: input.ops, base: input.base, mode: input.mode, ...signed }),
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
      })
      if (!isFailure(edited)) await load()
      return edited
    },
    // A comment carries no revision message (the instance names its agent from the token): only the conversation.
    comment: (input) =>
      manual(async (actor, account, agent, person) => {
        if (!DriveCapabilities.anchorable(capabilities(), input.anchor))
          return fail("unsupported", "This kind of comment is not available yet.")
        // A cell range goes as the instance keeps it (`b2:d9` is `B2:D9`); one it would refuse does not go.
        const cells = input.anchor.kind === "range" ? DriveCells.parse(input.anchor.cells) : undefined
        if (cells && "refused" in cells) return fail("invalid", "That is not a cell range such as B2 or B2:D9.")
        const anchor = cells ? { ...input.anchor, cells: cells.cells } : input.anchor
        const said = say(account, input.body)
        const created = await signedBy(agent, account, input.conversation, person, (signed) =>
          actor.comment(input.id, {
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
      manual(async (actor, account, agent, person) => {
        const said = say(account, input.body)
        const created = await signedBy(agent, account, input.conversation, person, (signed) =>
          actor.reply(input.id, {
            body: said.body,
            parent: input.parent,
            contextId: signed.contextId,
            ...(said.agent ? { agent: true } : {}),
          }),
        )
        if (!isFailure(created)) asked(account, input.id, created.id, said.agent)
        return created
      }),
    resolve: (input) => manual((actor) => actor.resolve(input.id, input.comment)),
    reopen: (input) =>
      manual(async (actor) =>
        capabilities().reopenComments
          ? actor.reopen(input.id, input.comment)
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
    reimport: (input) =>
      on(async (_, account) => {
        const page = unimported(account.id).find(
          (entry) => entry.conversation === input.conversation && entry.call === input.call,
        )
        if (!page || !pages.importer) return fail("not-found", "That page is no longer waiting to be imported.")
        return pages.importer(page)
      }),
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
     * The agent's pages DynWork could not import (`DriveAgent`), by the upload's call: kept with what stopped them, the
     * newest `keptUnimported`, until an import of the call succeeds. `importer` is what a retry (`reimport`) runs.
     */
    unimported: {
      keep: (account: string, page: Unimported) => {
        options.store.update((draft) => {
          draft.accounts[account] ??= { contexts: {}, links: [] }
          draft.accounts[account].unimported = [
            ...(draft.accounts[account].unimported ?? []).filter((entry) => entry.call !== page.call),
            page,
          ].slice(-keptUnimported)
        })
        options.changed()
      },
      drop: (account: string, call: string) => {
        if (!unimported(account).some((entry) => entry.call === call)) return
        options.store.update((draft) => {
          const kept = draft.accounts[account]?.unimported
          if (kept) draft.accounts[account]!.unimported = kept.filter((entry) => entry.call !== call)
        })
        options.changed()
      },
      importer: (importer: (page: Unimported) => Promise<Created | Failure>) => {
        pages.importer = importer
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
    /** How the person's session stands for the active account (G01). */
    acting,
    /**
     * The person's backend for the active account while their session is on, for main code that acts as them once the
     * user allowed it (`DriveShare`); undefined otherwise. Its credential stays in main.
     */
    person: () => {
      if (follow()) void load()
      return personal()
    },
    /** The person's session changed (`DynWorkPerson`): windows read the state again. */
    personChanged: () => options.changed(),
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
