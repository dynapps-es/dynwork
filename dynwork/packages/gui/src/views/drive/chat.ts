import type { Context, SessionRef } from "@opencode/plugin/gui"
import { builtinContext } from "@opencode/plugin/gui/builtin"
import type { Document } from "../../drive/contract"
import { drive } from "./store"

// From the Drive to a chat: the last open chat tab gets the document in its side panel and as a chip in its composer,
// as the composer's own "+" would attach it, and the conversation ↔ document index records the attachment.

/** The side panel's host keys: the chat's list of artifacts, and one tab per document. */
export const listKey = "dynwork:drive"
export const docKey = (id: string) => `dynwork:drive.${id}`

/** The origin of the Drive's composer chips: opening one routes its link (`docKey`) back to the Drive. */
export const origin = "dynwork-drive"

type Host = Pick<Context, "tabs" | "layout" | "screen" | "sessions" | "toast" | "t">

/** Opens a document in the Drive view from the chat it is beside; its Back comes back to that chat. */
export function openInDrive(ctx: Context, session: SessionRef, id: string) {
  void drive.openDoc(id, { from: { server: session.server.id, id: session.id, tab: session.tab } })
  builtinContext(ctx).layout.page("drive")
}

/**
 * Back from the open document to where it was opened from: the chat it was beside, opened again when its tab is closed,
 * or the Drive as it was then (`drive.closeDoc`).
 */
export function back(ctx: Pick<Context, "tabs">) {
  const chat = drive.closeDoc()
  if (!chat) return
  if (ctx.tabs.list().some((tab) => tab.key === chat.tab)) return ctx.tabs.focus(chat.tab)
  ctx.tabs.open({ server: chat.server, id: chat.id }, { focus: true })
}

/** The chat to send a document to: the routed one, else the last chat tab. */
function target(ctx: Host): SessionRef | undefined {
  return ctx.sessions.current() ?? ctx.tabs.list().findLast((tab) => tab.session)?.session
}

/** An open chat by its session id, for a conversation the index names. */
export function sessionOf(ctx: Pick<Context, "sessions">, conversation: string) {
  return ctx.sessions.list().find((session) => session.id === conversation)
}

/** A conversation's title as its chat shows it, while its tab is open; else undefined. */
export function titleOf(ctx: Pick<Context, "sessions">, conversation: string) {
  const session = sessionOf(ctx, conversation)
  return session?.server.data.session.get(session.id)?.title || undefined
}

/** A chat as the Drive names its writes: its session id and its title (D2). */
export function conversationOf(ctx: Pick<Context, "sessions" | "t">, session: SessionRef) {
  return { id: session.id, name: titleOf(ctx, session.id) ?? ctx.t("drive.chat.untitled") }
}

/**
 * Opens the chat's Artifacts tab and selects it, adding it to the strip when it is not there, and shows the side panel.
 * A document's preview tab stays.
 */
export function openArtifacts(ctx: Pick<Context, "layout">, session: SessionRef) {
  ctx.layout.open(listKey, session, { tab: "select" })
}

/**
 * Opens a document as a tab beside the chat, without attaching it, and answers that chat. Without a chat tab open it
 * says so.
 */
export function openBeside(ctx: Host, doc: Document) {
  const session = target(ctx)
  if (!session) {
    ctx.toast.show({
      title: ctx.t("drive.chat.none"),
      description: ctx.t("drive.chat.none.hint"),
      icon: "speech-bubble",
    })
    return undefined
  }
  ctx.layout.open(docKey(doc.id), session, { tab: "select", background: true })
  ctx.tabs.focus(session.tab)
  return session
}

/**
 * Opens a document beside a chat and puts it in the composer, with a prompt when one is given. Without a chat tab open
 * it says so.
 */
export function askAgent(ctx: Host, doc: Document, prompt?: string) {
  const session = openBeside(ctx, doc)
  if (!session) return
  void drive.link(session.id, doc.id, "attached")
  // The composer is the routed session's: wait for the tab to route it.
  const started = Date.now()
  const fill = () => {
    if (ctx.sessions.current()?.key !== session.key) {
      if (Date.now() - started < 3000) setTimeout(fill, 50)
      return
    }
    const composer = ctx.screen.current()?.composer
    if (!composer) return
    composer.attach({
      type: "note",
      origin,
      href: docKey(doc.id),
      commentID: `drive-${doc.id}-${Date.now()}`,
      label: doc.name,
      title: doc.name,
      subtitle: ctx.t("drive.title"),
      icon: "file-document",
      subject: doc.name,
      comment: prompt ?? "",
    })
    if (prompt) composer.setText(prompt)
    composer.focus()
  }
  fill()
}
