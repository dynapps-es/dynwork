export * as DriveShare from "./share"

import { DynWorkDocuments } from "@dynwork/server-plugin/documents"
import type { OpenCodeClient } from "@opencode/client/promise"
import type { MainContext } from "@opencode/plugin/gui/main"
import { Schema } from "effect"
import { fail, type Backend } from "./backend"
import { isFailure, Shares, type Failure, type ShareCard, type ShareDecision } from "./contract"
import type { DriveIpc } from "./ipc"

// The agent's shares, main's side (D24), and the rest of what only the person may do (G01: trash, restore, accept or
// reject a proposal). Before such a call runs, the server plugin publishes it and waits (`DynWorkDocuments.confirm`);
// main shows it on a card in its conversation, with the names of the document and the person (from the conversation's
// `documents_people`, or the Drive), says so (`shown`), and sends back the user's decision. With no window to show it,
// main takes none and the plugin refuses it. Allowed while the person's session is on, main does it as the person
// (`perform`) and tells the plugin what happened, so the call never reaches the instance as the agent's; without the
// session, the call goes as the agent wrote it. "Allow in this conversation" is for shares (`grant`) only, kept here per
// conversation for as long as the app runs: the next share in that conversation is allowed without a card, one in
// another conversation shows its own. Deleting, transferring, revoking every grant, restoring and reviewing are asked
// every time. Nothing is saved, so a restart asks again.

/** A session as far as the card's conversation is read from it. */
export interface Session {
  parentID?: string
  /** A child whose metadata says `conversation: true` is a conversation of its own (DynWork's runs, the chats). */
  conversation?: boolean
}

export interface Options {
  /** The Drive service, for the names on the card. */
  service: Pick<DriveIpc.Service, "using" | "capabilities" | "folders" | "known" | "current">
  /** A session of the service, or undefined when it does not know it. */
  session: (id: string) => Promise<Session | undefined>
  /** Sends the plugin the user's decision. */
  decide: (decision: DynWorkDocuments.Decision) => Promise<unknown>
  /** Tells the plugin the card is up, so the share waits for the user; without it the plugin refuses the share. */
  shown: (id: string) => Promise<unknown>
  /** Whether a window is open to show the card. Without one, the share is not taken and the plugin refuses it. */
  attended: () => boolean
  /**
   * The person's backend while their session is on (`DriveIpc.Service.person`), to do what the user allowed as them;
   * undefined without one, and the call then goes as the agent's. Absent: never as the person.
   */
  person?: () => Backend | undefined
  /** The cards changed. */
  changed: () => void
}

/** How long a person's lookup may hold the card back: past it, the card shows the value the agent gave. */
export const lookupWithin = 3_000

// `work`'s answer, or undefined once `lookupWithin` passes first.
function within<A>(work: Promise<A>) {
  const timer = { id: undefined as ReturnType<typeof setTimeout> | undefined }
  const late = new Promise<undefined>((resolve) => {
    timer.id = setTimeout(() => resolve(undefined), lookupWithin)
  })
  return Promise.race([work, late]).finally(() => clearTimeout(timer.id))
}

/** How far up a subagent's sessions the card's conversation is looked for. */
const depth = 8

/** The share logic, with no service and no window: what `setup` wires, and what the tests drive. */
export function make(options: Options) {
  const cards = new Map<string, ShareCard>()
  // The calls behind the cards, by id: what `perform` needs that a card does not show.
  const calls = new Map<string, DynWorkDocuments.Share>()
  // Shares being read or shown, so the same one arriving by event and by `shares` is handled once.
  const known = new Set<string>()
  // The conversations whose shares the user allowed (`grant` only).
  const allowed = new Set<string>()

  async function request(share: DynWorkDocuments.Share) {
    if (known.has(share.id)) return
    known.add(share.id)
    const session = await conversation(share.session)
    if (share.kind === "grant" && allowed.has(session)) {
      known.delete(share.id)
      await options.decide({ id: share.id, allow: true, ...(await asPerson(share)) }).catch(() => undefined)
      return
    }
    // Nobody to ask: the share is left unanswered, and the plugin refuses it (`DynWorkDocuments.unheard`).
    if (!options.attended()) {
      known.delete(share.id)
      return
    }
    void options.shown(share.id).catch(() => undefined)
    const shown = await card(share, session)
    // Withdrawn while the names were read.
    if (!known.has(share.id)) return
    cards.set(shown.id, shown)
    calls.set(share.id, share)
    options.changed()
  }

  // What the user allowed, done as the person while their session is on: the plugin's `outcome`. Nothing without it.
  async function asPerson(share: DynWorkDocuments.Share) {
    const person = options.person?.()
    const outcome = person && (await perform(person, share))
    return outcome === undefined ? {} : { outcome }
  }

  // The conversation a share shows in: its own session, or for a subagent's, the conversation that started it.
  async function conversation(id: string) {
    const walk = async (current: string, left: number): Promise<string> => {
      if (left === 0) return current
      const found = await options.session(current).catch(() => undefined)
      if (!found?.parentID || found.conversation) return current
      return walk(found.parentID, left - 1)
    }
    return walk(id, depth)
  }

  async function card(share: DynWorkDocuments.Share, session: string): Promise<ShareCard> {
    const target = share.folder
      ? { kind: "folder" as const, id: share.folder, ...named(folderName(share.folder)) }
      : share.document && {
          kind: "document" as const,
          id: share.document,
          ...named(await documentName(share.document)),
        }
    return {
      id: share.id,
      session,
      kind: share.kind,
      ...(target ? { target } : {}),
      ...(share.subject ? { subject: await person(share.subject) } : {}),
      ...(share.level === undefined ? {} : { level: share.level }),
      ...(share.until === undefined ? {} : { until: share.until }),
      ...(share.note === undefined ? {} : { note: share.note }),
      ...(options.person?.() ? { person: true } : {}),
    }
  }

  async function documentName(id: string) {
    const detail = await options.service.using((backend) => backend.get(id))
    return isFailure(detail) ? undefined : detail.document.name
  }

  // The folders the Drive already read: the agent shares one it found there.
  function folderName(id: string) {
    return options.service.folders().find((folder) => folder.id === id)?.name
  }

  // Who a share names, first found first: the conversation's own `documents_people` answer (the plugin adds it to the
  // share), the people the account met before (`DriveIpc` `known`: the agent's lookups in any conversation, and earlier
  // cards, kept across restarts), then a lookup: by id, or an email by search, over REST while the instance has it
  // (`peopleByRest`, 0.84), otherwise through the `documents` MCP server's `documents_people`. That tool says it
  // searches by "name, email or id", but 0.83.0 matches names and emails only (`search_active_by_prefix`): an email is
  // named, an id finds nobody, which is why the agent is told to look a person up right before sharing on 0.83
  // (`DynWorkDocuments.instructions`). Only an exact match names them; a lookup that fails or takes longer than
  // `lookupWithin` leaves the value as the agent gave it, and the card shows anyway. Whoever is named is remembered for
  // the account.
  async function person(subject: DynWorkDocuments.Subject) {
    if (subject.kind !== "user") return subject
    const account = options.service.current()?.id
    if (subject.name !== undefined) {
      if (account) options.service.known.remember(account, [personOf(subject)])
      return subject
    }
    const value = subject.value
    const known = account === undefined ? undefined : options.service.known.find(account, value)
    if (known) return { ...subject, ...withName(known) }
    const email = value.includes("@")
    const found = await within(
      options.service.using((backend) =>
        options.service.capabilities().peopleByRest
          ? email
            ? backend.searchPeople(value, 1)
            : backend.people([value])
          : backend.findPeople(value, 1),
      ),
    )
    const match =
      found === undefined || isFailure(found)
        ? undefined
        : found.find((item) => (email ? item.email?.toLowerCase() === value.toLowerCase() : item.id === value))
    if (!match) return subject
    if (account) options.service.known.remember(account, [match])
    return { ...subject, ...withName(match) }
  }

  function withdraw(id: string) {
    known.delete(id)
    calls.delete(id)
    if (cards.delete(id)) options.changed()
  }

  async function settle(card: ShareCard, allow: boolean) {
    const share = calls.get(card.id)
    cards.delete(card.id)
    calls.delete(card.id)
    known.delete(card.id)
    const done = allow && share ? await asPerson(share) : {}
    await options.decide({ id: card.id, allow, ...done }).catch(() => undefined)
  }

  return {
    request,
    /** The people an agent's `documents_people` answered (the plugin's `people` event): kept for the active account. */
    heard: (seen: DynWorkDocuments.Seen) => {
      const account = options.service.current()?.id
      if (account)
        options.service.known.remember(
          account,
          seen.people.map((item) => ({
            id: item.user_id,
            name: item.name,
            ...(item.email === undefined ? {} : { email: item.email }),
          })),
        )
    },
    withdraw,
    /** The shares still waiting in the service, read after (re)connecting: new ones are shown, gone ones dropped. */
    sync: async (waiting: readonly DynWorkDocuments.Share[]) => {
      const ids = new Set(waiting.map((share) => share.id))
      cards.forEach((card) => {
        if (!ids.has(card.id)) withdraw(card.id)
      })
      await Promise.all(waiting.map(request))
    },
    cards: () => [...cards.values()],
    /**
     * The user's decision on a card. The card leaves before the plugin hears it, so a second decision (another window)
     * finds none. Allowing in the conversation is for a share (`grant`): it also allows the shares already waiting
     * there. On any other card it counts as allowing once, and nothing is remembered.
     */
    decide: async (id: string, decision: ShareDecision) => {
      const card = cards.get(id)
      if (!card) return fail("not-found", "This share is no longer waiting.")
      const remembered = decision === "conversation" && card.kind === "grant"
      if (remembered) allowed.add(card.session)
      const same = remembered ? [...cards.values()].filter((other) => sameScope(other, card)) : [card]
      const settled = Promise.all(same.map((item) => settle(item, decision !== "reject")))
      options.changed()
      await settled
      return undefined
    },
  }
}

export type Logic = ReturnType<typeof make>

const sameScope = (a: ShareCard, b: ShareCard) => a.session === b.session && a.kind === "grant" && b.kind === "grant"

// A name only when one was read: a card without one shows the id the agent gave.
const named = (name: string | undefined) => (name === undefined ? {} : { name })

const CONFIRM = `rpc.${DynWorkDocuments.id}.confirm` as const
const PEOPLE = `rpc.${DynWorkDocuments.id}.people` as const
const decodeSeen = Schema.decodeUnknownOption(DynWorkDocuments.Seen)
const WITHDRAW = `rpc.${DynWorkDocuments.id}.withdraw` as const
const RETRY = 2_000
const decodeShare = Schema.decodeUnknownOption(DynWorkDocuments.Share)
const decodeWithdrawn = Schema.decodeUnknownOption(DynWorkDocuments.Withdrawn)
const decodeShares = Schema.decodeUnknownOption(DynWorkDocuments.Shares)

/**
 * Does what the user allowed on a card as the person (G01), with their backend, and answers what the agent reads in
 * place of the instance's answer; undefined for what it cannot do as them (a folder's grant, a call missing what it
 * needs), which then goes as the agent wrote it. The answer names the document and the action, never a credential.
 */
export async function perform(person: Backend, share: DynWorkDocuments.Share): Promise<string | undefined> {
  const document = share.document
  const running = document === undefined || share.folder !== undefined ? undefined : act(person, share, document)
  if (running === undefined) return undefined
  const answer = await running
  if (isFailure(answer)) return refused(answer)
  return `The user allowed it on the card and Dynwork did it as the user, not as you: ${what(share)}. It is done: do not call it again.`
}

// The call `perform` makes as the person, or undefined when the share lacks what it needs.
function act(person: Backend, share: DynWorkDocuments.Share, document: string) {
  const subject = share.subject
  if (share.kind === "grant")
    return subject && share.level !== undefined
      ? person.share(document, {
          kind: subject.kind,
          value: subject.value,
          level: share.level,
          ...(share.until === undefined ? {} : { until: share.until }),
        })
      : undefined
  if (share.kind === "transfer") return subject && person.transfer(document, subject.value)
  if (share.kind === "revoke") return person.revokeAll(document)
  if (share.kind === "trash") return person.trash(document)
  if (share.kind === "restore") return share.revision === undefined ? undefined : person.restore(document, share.revision)
  if (share.proposal === undefined) return undefined
  return person.review(document, share.proposal, {
    accept: share.kind === "accept",
    ...(share.note === undefined ? {} : { note: share.note }),
  })
}

// What was done, in the agent's terms.
function what(share: DynWorkDocuments.Share) {
  const document = `document ${share.document}`
  const subject = share.subject ? `${share.subject.kind} ${share.subject.value}` : "(nobody given)"
  if (share.kind === "grant") return `shared ${document} with ${subject} (${share.level})`
  if (share.kind === "transfer") return `made ${subject} the owner of ${document}`
  if (share.kind === "revoke") return `revoked every grant on ${document}`
  if (share.kind === "trash") return `moved ${document} to the trash`
  if (share.kind === "restore") return `restored revision ${share.revision} of ${document} as a new revision`
  return `${share.kind === "accept" ? "accepted" : "rejected"} proposal ${share.proposal} on ${document}`
}

function refused(failure: Failure) {
  if (failure.code === "sign-in")
    return "The user allowed it on the card, but did not finish signing in to Governance, which it asks for this: nothing changed. Tell the user they can sign in from Dynwork's Settings and ask you again."
  return `The user allowed it on the card, but Governance refused it as the user (${failure.code}): ${failure.message} Nothing changed.`
}

/**
 * Sets the shares up in main, beside the agent's documents (`DriveAgent.setup`): the `dynwork.drive.shares` Ipc, and the
 * following of the server plugin's shares on DynWork's service for as long as the app runs.
 */
export function setup(
  ctx: Pick<MainContext, "onCleanup" | "provide">,
  input: {
    service: Options["service"] & Pick<DriveIpc.Service, "person">
    client: () => OpenCodeClient | undefined
    attended: () => boolean
  },
) {
  const call = async (method: string, value: unknown) => {
    const client = input.client()
    if (!client) return undefined
    return (await client.rpc.call({ rpcID: DynWorkDocuments.id, method, input: value as never })).output
  }
  const provider = { changed: () => {} }
  const logic = make({
    service: input.service,
    session: async (id) => {
      const found = await input.client()?.session.get({ sessionID: id })
      return found && { parentID: found.parentID, conversation: found.metadata?.conversation === true }
    },
    decide: (decision) => call("decide", decision),
    shown: (id) => call("shown", { id }),
    attended: input.attended,
    person: input.service.person,
    changed: () => provider.changed(),
  })
  const ipc = ctx.provide(Shares, {
    state: () => ({ cards: logic.cards() }),
    decide: (value) => logic.decide(value.id, value.decision),
  })
  provider.changed = () => ipc.changed()

  const life = new AbortController()
  ctx.onCleanup(() => life.abort())
  void (async () => {
    while (!life.signal.aborted) {
      const client = input.client()
      if (client) await follow(client, logic, call, life.signal).catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, RETRY))
    }
  })()
  return logic
}

async function follow(
  client: OpenCodeClient,
  logic: Logic,
  call: (method: string, value: unknown) => Promise<unknown>,
  signal: AbortSignal,
) {
  for await (const event of client.event.subscribe({ types: [CONFIRM, WITHDRAW, PEOPLE], signal })) {
    if (event.type === "server.connected") {
      const waiting = decodeShares(await call("shares", {}).catch(() => undefined))
      if (waiting._tag === "Some") void logic.sync(waiting.value.shares)
    }
    if (event.type === CONFIRM) {
      const share = decodeShare(event.data)
      if (share._tag === "Some") void logic.request(share.value)
    }
    if (event.type === PEOPLE) {
      const seen = decodeSeen(event.data)
      if (seen._tag === "Some") logic.heard(seen.value)
    }
    if (event.type === WITHDRAW) {
      const withdrawn = decodeWithdrawn(event.data)
      if (withdrawn._tag === "Some") logic.withdraw(withdrawn.value.id)
    }
  }
}

// A person as the account keeps them: id, name and email, nothing else.
function personOf(subject: DynWorkDocuments.Subject) {
  return {
    id: subject.value,
    name: subject.name ?? subject.value,
    ...(subject.email === undefined ? {} : { email: subject.email }),
  }
}

// The name and email a card shows for someone found.
function withName(person: { readonly name: string; readonly email?: string }) {
  return { name: person.name, ...(person.email === undefined ? {} : { email: person.email }) }
}
