export * as DriveShare from "./share"

import { DynWorkDocuments } from "@dynwork/server-plugin/documents"
import type { OpenCodeClient } from "@opencode/client/promise"
import type { MainContext } from "@opencode/plugin/gui/main"
import { Schema } from "effect"
import { fail } from "./backend"
import { isFailure, Shares, type ShareCard, type ShareDecision } from "./contract"
import type { DriveIpc } from "./ipc"

// The agent's shares, main's side (D24). Before a `documents_share` call runs, the server plugin publishes it and waits
// (`DynWorkDocuments.confirm`); main shows it on a card in its conversation, with the names of the document and the
// person (from the conversation's `documents_people`, or the Drive), says so (`shown`), and sends back the user's
// decision. With no window to show it, main takes no share and the plugin refuses it. "Allow in this conversation" is
// kept here, per conversation and kind of share, for as long as the app runs: the next share of that kind in that
// conversation is allowed without a card, one in another conversation shows its own. Nothing is saved, so a restart asks
// again.

/** A session as far as the card's conversation is read from it. */
export interface Session {
  parentID?: string
  /** A child whose metadata says `conversation: true` is a conversation of its own (DynWork's runs, the chats). */
  conversation?: boolean
}

export interface Options {
  /** The Drive service, for the names on the card. */
  service: Pick<DriveIpc.Service, "using" | "capabilities" | "folders">
  /** A session of the service, or undefined when it does not know it. */
  session: (id: string) => Promise<Session | undefined>
  /** Sends the plugin the user's decision. */
  decide: (decision: DynWorkDocuments.Decision) => Promise<unknown>
  /** Tells the plugin the card is up, so the share waits for the user; without it the plugin refuses the share. */
  shown: (id: string) => Promise<unknown>
  /** Whether a window is open to show the card. Without one, the share is not taken and the plugin refuses it. */
  attended: () => boolean
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
  // Shares being read or shown, so the same one arriving by event and by `shares` is handled once.
  const known = new Set<string>()
  // What the user allowed in a conversation: `<session>:<kind>`.
  const allowed = new Set<string>()

  async function request(share: DynWorkDocuments.Share) {
    if (known.has(share.id)) return
    known.add(share.id)
    const session = await conversation(share.session)
    if (allowed.has(`${session}:${share.kind}`)) {
      known.delete(share.id)
      await options.decide({ id: share.id, allow: true }).catch(() => undefined)
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
    options.changed()
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

  // The name and email the conversation's `documents_people` call gave come with the share. A user named by an id or an
  // email the conversation never looked up (it found them before the service restarted, say) is looked up here: by id
  // over REST while the instance has it (`peopleByRest`, 0.84), otherwise through the `documents` MCP server's
  // `documents_people`. That tool says it searches by "name, email or id", but 0.83.0 matches names and emails only
  // (`search_active_by_prefix`): an email is named, an id finds nobody until the instance searches ids. Only an exact
  // match names them; a lookup that fails or takes longer than `lookupWithin` leaves the value as the agent gave it,
  // and the card shows anyway.
  async function person(subject: DynWorkDocuments.Subject) {
    if (subject.name !== undefined || subject.kind !== "user") return subject
    const value = subject.value
    const email = value.includes("@")
    const found = await within(
      options.service.using((backend) =>
        options.service.capabilities().peopleByRest && !email ? backend.people([value]) : backend.findPeople(value, 1),
      ),
    )
    const match =
      found === undefined || isFailure(found)
        ? undefined
        : found.find((item) => (email ? item.email?.toLowerCase() === value.toLowerCase() : item.id === value))
    if (!match) return subject
    return { ...subject, name: match.name, ...(match.email === undefined ? {} : { email: match.email }) }
  }

  function withdraw(id: string) {
    known.delete(id)
    if (cards.delete(id)) options.changed()
  }

  async function settle(card: ShareCard, allow: boolean) {
    cards.delete(card.id)
    known.delete(card.id)
    await options.decide({ id: card.id, allow }).catch(() => undefined)
  }

  return {
    request,
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
     * finds none. Allowing in the conversation also allows the cards of the same kind already waiting there.
     */
    decide: async (id: string, decision: ShareDecision) => {
      const card = cards.get(id)
      if (!card) return fail("not-found", "This share is no longer waiting.")
      if (decision === "conversation") allowed.add(`${card.session}:${card.kind}`)
      const same = decision === "conversation" ? [...cards.values()].filter((other) => sameScope(other, card)) : [card]
      const settled = Promise.all(same.map((item) => settle(item, decision !== "reject")))
      options.changed()
      await settled
      return undefined
    },
  }
}

export type Logic = ReturnType<typeof make>

const sameScope = (a: ShareCard, b: ShareCard) => a.session === b.session && a.kind === b.kind

// A name only when one was read: a card without one shows the id the agent gave.
const named = (name: string | undefined) => (name === undefined ? {} : { name })

const CONFIRM = `rpc.${DynWorkDocuments.id}.confirm` as const
const WITHDRAW = `rpc.${DynWorkDocuments.id}.withdraw` as const
const RETRY = 2_000
const decodeShare = Schema.decodeUnknownOption(DynWorkDocuments.Share)
const decodeWithdrawn = Schema.decodeUnknownOption(DynWorkDocuments.Withdrawn)
const decodeShares = Schema.decodeUnknownOption(DynWorkDocuments.Shares)

/**
 * Sets the shares up in main, beside the agent's documents (`DriveAgent.setup`): the `dynwork.drive.shares` Ipc, and the
 * following of the server plugin's shares on DynWork's service for as long as the app runs.
 */
export function setup(
  ctx: Pick<MainContext, "onCleanup" | "provide">,
  input: { service: Options["service"]; client: () => OpenCodeClient | undefined; attended: () => boolean },
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
  for await (const event of client.event.subscribe({ types: [CONFIRM, WITHDRAW], signal })) {
    if (event.type === "server.connected") {
      const waiting = decodeShares(await call("shares", {}).catch(() => undefined))
      if (waiting._tag === "Some") void logic.sync(waiting.value.shares)
    }
    if (event.type === CONFIRM) {
      const share = decodeShare(event.data)
      if (share._tag === "Some") void logic.request(share.value)
    }
    if (event.type === WITHDRAW) {
      const withdrawn = decodeWithdrawn(event.data)
      if (withdrawn._tag === "Some") logic.withdraw(withdrawn.value.id)
    }
  }
}
