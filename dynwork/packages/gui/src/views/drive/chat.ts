import type { Context, SessionRef } from "@opencode/plugin/gui"
import type { Doc } from "./demo"
import { drive } from "./store"

// From the Drive to a chat: the last open chat tab gets the document in its side panel and as a chip in its composer,
// as the composer's own "+" would attach it. A demo stand-in for the real link, which the agent's tools write.

/** The side panel's host keys: the chat's list of artifacts, and one tab per document. */
export const listKey = "dynwork:drive"
export const docKey = (id: string) => `dynwork:drive.${id}`

type Host = Pick<Context, "tabs" | "layout" | "screen" | "sessions" | "toast" | "t">

/** The chat to send a document to: the routed one, else the last chat tab. */
function target(ctx: Host): SessionRef | undefined {
  return ctx.sessions.current() ?? ctx.tabs.list().findLast((tab) => tab.session)?.session
}

/**
 * Opens a document beside a chat and puts it in the composer, with a prompt when one is given. Without a chat tab open
 * it says so: the demo does not start sessions.
 */
export function askAgent(ctx: Host, doc: Doc, prompt?: string) {
  const session = target(ctx)
  if (!session) {
    ctx.toast.show({
      title: ctx.t("drive.chat.none"),
      description: ctx.t("drive.chat.none.hint"),
      icon: "speech-bubble",
    })
    return
  }
  drive.attach(session.key, doc.id)
  ctx.layout.open(docKey(doc.id), session, { tab: "select", background: true })
  ctx.tabs.focus(session.tab)
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
      origin: "dynwork-drive",
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
