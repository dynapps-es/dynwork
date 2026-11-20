export * as DriveMentions from "./mentions"

import type { OpenCodeClient } from "@opencode/client/promise"
import type { MainContext } from "@opencode/plugin/gui/main"
import type { Backend } from "./backend"
import { fail } from "./backend"
import { isFailure, type Comment, type Document, type Link } from "./contract"
import type { DriveIpc } from "./ipc"

// @Agent in a comment (D12, D15). The comment mentions the user themself, with `attention: agent`, which is how the
// instance means "my agent, do this": DynWork writes it, and when it sees it (from its own write or from the bridge
// stream) it wakes the conversation the document is linked to. That conversation answers in the thread with the
// `documents` MCP tools the instance gives it (D4), so a reply and an edit are the agent's own, attributed as every
// other write it makes. Nothing here posts for the agent.
//
// What the instance does and does not say (0.83, checked against sp-local):
// - the stream announces `document.comment.mentioned` for the mentioned user without its attention, so a mention of
//   the user by someone else cannot be told from `agent`, `human` or `silent` there;
// - a mention of oneself makes no notification (`/api/v1/notifications`), only the stream event;
// - the stream keeps no history.
// So only a mention of the user by the user themself is attended. A mention someone else made, even with attention
// `agent`, would run their words as the user's agent, and is left to Governance.
//
// 0.84 makes this the official hand-off (G10): a mention of oneself at attention `agent` is delivered on the stream and
// as an inbox item at `agent`; at `human`, `silent` or with none it is not delivered at all. The event still carries no
// attention. DynWork writes `@Agent` at `agent` only, so the same two sources go on: the write DynWork made, and the
// stream for one made elsewhere (the web). Both name the comment, and a comment is attended once (`attend`), so the
// conversation wakes once whichever arrives first. The inbox is not read: the stream says the same thing live.

/** Text that asks for the agent: `@Agent` or `@Agente`, as a word of its own. */
const asking = /(^|\s)@Agente?(?![\p{L}\p{N}_])/iu

/** A mention as the instance stores it in a body: `@[Name](user:<id>)`. */
const token = /@\[([^\]]*)\]\(user:([^)\s]+)\)/g

/** Whether a comment's text asks for the agent. */
export const asks = (body: string) => asking.test(body)

/** The text with its first `@Agent` written as the mention of `user`, the way the instance reads one. */
export function write(body: string, user: { id: string; name: string }) {
  const name =
    user.name
      .replace(/[[\]()]+/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "Agent"
  return body.replace(asking, (_, lead: string) => `${lead}@[${name}](user:${user.id})`)
}

/**
 * What a reader sees of a body: a mention of `me` reads `@Agent`, any other `@Name`. `agent` says whether it mentions
 * `me` at all.
 */
export function read(body: string, me?: string) {
  const found = { agent: false }
  const text = body.replace(token, (_, name: string, id: string) => {
    if (id !== me) return `@${name}`
    found.agent = true
    return "@Agent"
  })
  return { text, agent: found.agent }
}

/** What the stream says: someone was mentioned in a comment of a document. */
export interface Heard {
  document: string
  comment: string
  user: string
  author: string
}

/**
 * What the bridge stream carries for the Drive: a mention, or that something the user can see changed
 * (`document.drive.changed`, 0.84), which names no document: the account's Drive is read again (`DriveIpc` `reread`).
 */
export type Streamed = ({ kind: "mentioned" } & Heard) | { kind: "changed" }

export interface Options {
  /**
   * The service's account, index, mention record, `using`, `reread` for a change the stream announces, and `streamed`,
   * told while the stream is open.
   */
  service: Pick<DriveIpc.Service, "using" | "current" | "linksOf" | "mention" | "listen" | "reread" | "streamed">
  /** Whether a conversation still exists (its session). */
  session: (id: string) => Promise<boolean>
  /** Prompts a conversation. Answers whether the service took it. */
  wake: (input: { session: string; text: string; document: string; comment: string }) => Promise<boolean>
  now?: () => number
}

export interface Timing {
  /** How long to wait before opening the stream again, and before looking for an account to follow when there is none. */
  retry: number
  /** How long a stream stays open: it has no heartbeat, so a silent break is only noticed by opening a new one. */
  lifetime: number
  /** Waits `ms`, or less when `signal` aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
}

const sleeping: Timing["sleep"] = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })

export const timing: Timing = { retry: 2_000, lifetime: 5 * 60_000, sleep: sleeping }

export function make(options: Options) {
  const service = options.service
  const now = options.now ?? Date.now
  // Comments being attended right now: the stream and the write that made the comment arrive within moments of each other.
  const pending = new Set<string>()

  /** The stream says someone was mentioned: only the active user, by themself, is a job for the agent. */
  async function heard(event: Heard) {
    const account = service.current()
    if (account?.userId === undefined || event.user !== account.userId || event.author !== account.userId) return
    await attend(account.id, event.document, event.comment)
  }

  /**
   * Wakes the conversation of a comment that asked for the agent, once. Whatever the source, the comment is read back
   * from the instance and must be the user's own and mention the user: the stream's word is not taken for it.
   */
  async function attend(account: string, document: string, comment: string) {
    const key = `${account}/${comment}`
    if (pending.has(key) || service.mention.get(account, comment) !== undefined) return
    pending.add(key)
    try {
      const outcome = await route(account, document, comment)
      if (outcome === undefined) return
      service.mention.add(account, { comment, document, at: now(), ...outcome })
    } finally {
      pending.delete(key)
    }
  }

  async function route(account: string, document: string, comment: string) {
    // `using` runs on the active account: when it is no longer this one, nothing of it is read or woken.
    const thread = await service.using(async (backend, active) =>
      active.id === account ? gather(backend, document, comment) : fail("signed-out", "Another account is active."),
    )
    if (isFailure(thread)) return thread.code === "signed-out" ? undefined : ({ outcome: "failed" } as const)
    if (thread === undefined) return undefined
    const conversation = await attended(service.linksOf(account), document)
    if (conversation === undefined) return { outcome: "unlinked" } as const
    const woken = await options
      .wake({ session: conversation, text: prompt(thread), document, comment })
      .catch(() => false)
    return woken ? ({ outcome: "woken", conversation } as const) : ({ outcome: "failed", conversation } as const)
  }

  // The conversation that last worked with the document and still exists.
  async function attended(links: readonly Link[], document: string) {
    const sessions = links
      .filter((link) => link.document === document)
      .toSorted((a, b) => b.at - a.at)
      .map((link) => link.conversation)
    for (const session of new Set(sessions)) if (await options.session(session).catch(() => false)) return session
    return undefined
  }

  /**
   * Follows the bridge stream of the active account until `life` aborts, opening it again when it ends. A switch of
   * account ends the stream of the one that left. The one stream carries the mentions and the changes of the Drive.
   */
  async function follow(life: AbortSignal, timings: Timing = timing) {
    while (!life.aborted) {
      const account = service.current()
      if (account?.userId !== undefined) await attach(account.id, life, timings).catch(() => undefined)
      await timings.sleep(timings.retry, life)
    }
  }

  async function attach(account: string, life: AbortSignal, timings: Timing) {
    const stop = new AbortController()
    const off = service.listen.account((next) => next?.id !== account && stop.abort())
    const end = () => stop.abort()
    life.addEventListener("abort", end, { once: true })
    const timer = setTimeout(end, timings.lifetime)
    try {
      const events = await service.using(async (backend, active) => {
        if (active.id !== account) return fail("signed-out", "Another account is active.")
        return backend.stream?.(stop.signal) ?? fail("unsupported", "The Drive does not announce mentions.")
      })
      if (isFailure(events)) return
      service.streamed(account, true)
      for await (const event of events) {
        if (event.kind === "changed") service.reread(account)
        else void heard(event).catch(() => undefined)
      }
    } finally {
      service.streamed(account, false)
      clearTimeout(timer)
      life.removeEventListener("abort", end)
      off()
    }
  }

  return { heard, attend, follow }
}

export type Mentions = ReturnType<typeof make>

// The thread, read back, when the comment is the user's own and asks for the agent; undefined when it is not one.
async function gather(backend: Backend, document: string, comment: string) {
  const [comments, detail] = await Promise.all([backend.comments(document), backend.get(document)])
  if (isFailure(comments)) return comments
  if (isFailure(detail)) return detail
  const asked = comments.find((entry) => entry.id === comment)
  if (!asked?.mine || !asked.agent) return undefined
  return { document: detail.document, asked, thread: threadOf(comments, asked) }
}

// The comments of the asking one's thread, oldest first: its root and everything answering down from it.
function threadOf(comments: readonly Comment[], asked: Comment) {
  const byId = new Map(comments.map((entry) => [entry.id, entry]))
  const rootOf = (entry: Comment): Comment => {
    const parent = entry.parent === undefined ? undefined : byId.get(entry.parent)
    return parent ? rootOf(parent) : entry
  }
  const root = rootOf(asked)
  return comments.filter((entry) => rootOf(entry).id === root.id).toSorted((a, b) => a.created - b.created)
}

/** How many comments of the thread the prompt carries: the latest ones, which are what the user answers. */
const shown = 12

/**
 * What the conversation is told. The comment and the thread are in it so that the agent can start without reading;
 * the way back is the `documents` tools it already has: `documents_comment` replies in the thread, `documents_edit`
 * changes the document.
 */
export function prompt(input: { document: Pick<Document, "id" | "name">; asked: Comment; thread: readonly Comment[] }) {
  const anchor = input.asked.anchor
  const where = !anchor
    ? "It is not pinned to a node."
    : anchor.cells
      ? `It is pinned to cells ${anchor.cells} of sheet node ${anchor.node}.`
      : `It is pinned to node ${anchor.node}${anchor.find ? `, on the words “${anchor.find}”` : ""}.`
  const lines = input.thread
    .slice(-shown)
    .map(
      (entry) =>
        `- ${entry.mine ? "The user or their agent" : "Someone else"}${entry.id === input.asked.id ? " (this comment)" : ""}: ${entry.body}`,
    )
  return [
    `The user asked for you in a comment on the Drive document “${input.document.name}” (document_id ${input.document.id}).`,
    where,
    "",
    "The thread, oldest first:",
    ...lines,
    "",
    "Do what the comment asks. Read the document with the documents tools when you need more than the thread, and change it with documents_edit only when the comment asks for a change.",
    `Then answer in the thread: documents_comment with action create, document_id ${input.document.id}, parent_id ${input.asked.id} and your answer as body, in the language of the comment. Do not mention anyone in the answer.`,
  ].join("\n")
}

/**
 * Sets the mentions up in main: follows the bridge stream of the active account, and attends the comments the Drive
 * service writes with `@Agent`. `client` is DynWork's service, whose sessions are the conversations.
 */
export function setup(
  ctx: Pick<MainContext, "onCleanup">,
  input: { service: Options["service"]; client: () => OpenCodeClient | undefined },
) {
  const mentions = make({
    service: input.service,
    session: async (id) => {
      const found = await input
        .client()
        ?.session.get({ sessionID: id })
        .catch(() => undefined)
      return found !== undefined
    },
    wake: async (wake) => {
      const client = input.client()
      if (!client) return false
      await client.session.prompt({
        sessionID: wake.session,
        text: wake.text,
        metadata: { dynwork: { drive: { document: wake.document, comment: wake.comment } } },
      })
      return true
    },
  })
  const life = new AbortController()
  const off = input.service.listen.asked((asked) => void mentions.attend(asked.account, asked.document, asked.comment))
  ctx.onCleanup(() => {
    off()
    life.abort()
  })
  void mentions.follow(life.signal)
  return mentions
}
