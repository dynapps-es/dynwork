import { usePlugin, type Context } from "@opencode/plugin/gui"
import { Icon } from "@opencode/ui/icon"
import { For, Show, type JSX } from "solid-js"
import type { Document, Failure } from "../../drive/contract"
import { ago, known, pathOf, size, stem, type Format, type Message } from "./model"
import { drive, governance } from "./store"
import type { Present } from "./viewer"

// Small pieces every Drive screen shares: the format glyph, avatars, tags, thumbnails, times and a thread's lines.

const glyphs: Record<Format, string> = {
  docx: "W",
  xlsx: "X",
  pptx: "P",
  html: "</>",
  markdown: "M↓",
  pdf: "PDF",
}

/**
 * A document loading, in the middle of where it will show: the app's loading indicator, which says what it waits for to
 * a screen reader.
 */
export function DocLoading() {
  const ctx = usePlugin()
  return (
    <div data-slot="drive-loading" role="status" aria-label={ctx.t("drive.preview.loading")}>
      <ctx.ui.Loader size="large" />
    </div>
  )
}

/** A document's format as a colored glyph, a folder, or a plain file for a format the Drive has no viewer for. */
export function FormatGlyph(props: { format: string; size?: "large" }) {
  const format = () => (props.format === "folder" ? "folder" : known(props.format))
  return (
    <span data-slot="drive-format" data-format={format() ?? "file"} data-size={props.size}>
      <Show when={format() !== "folder"} fallback={<Icon name="folder" size="small" />}>
        {/* Read in place: a document tab's header stays mounted while the tab shows another document. */}
        <Show when={format()} fallback={<Icon name="file-document" size="small" />}>
          {glyphs[format() as Format]}
        </Show>
      </Show>
    </span>
  )
}

/** Someone's initials; an agent's on the brand gradient. */
export function Avatar(props: { name: string; agent?: boolean; size?: "small" }) {
  const initials = () =>
    props.name
      .split(/[\s@._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("")
  return (
    <span data-slot="drive-avatar" data-agent={props.agent ? "" : undefined} data-size={props.size} title={props.name}>
      {props.agent ? "AI" : initials()}
    </span>
  )
}

export function Tag(props: { tone?: string; title?: string; children: JSX.Element }) {
  return (
    <span data-slot="drive-tag" data-tone={props.tone} title={props.title}>
      {props.children}
    </span>
  )
}

/** A failure in the window's language: the Drive's own message never reaches the screen. */
export function failureText(ctx: Pick<Context, "t">, failure: Failure) {
  return ctx.t(`drive.failure.${failure.code}`)
}

/** Opens a document's page in Governance, where the person's actions are, or the Drive there. */
export function openGovernance(ctx: Pick<Context, "system">, doc?: Pick<Document, "id">) {
  const url = governance(doc?.id)
  if (url) void ctx.system.openExternal(url)
}

/** An access level, in the window's language when it is one the Drive names. */
export function levelText(t: (key: string) => string, level: string) {
  return ["own", "share", "edit", "comment", "view"].includes(level) ? t(`drive.level.${level}`) : level
}

/** The user's access level, in the window's language when it is one the Drive names. */
export function Level(props: { level: string }) {
  const ctx = usePlugin()
  return <>{levelText(ctx.t, props.level)}</>
}

/** What an agent may do, in words: `none`, `read`, `suggest`, `edit`, or the instance's own word. */
export function capText(t: (key: string) => string, cap: string) {
  return ["none", "read", "suggest", "edit"].includes(cap) ? t(`drive.cap.${cap}`) : cap
}

/** Names, times, sizes and paths in the window's language. */
export function useNames() {
  const ctx = usePlugin()
  return {
    /** "You" for the user's own documents; the Drive names no other owner in a listing. */
    owner: (item: Pick<Document, "mine">) => ctx.t(item.mine ? "drive.you" : "drive.owner.other"),
    /** An epoch-millisecond time, as "5 minutes ago". */
    ago: (at: number) => ago(Math.max(0, (Date.now() - at) / 60_000), ctx.locale.locale(), ctx.t("drive.now")),
    size: (bytes: number | undefined) => (bytes === undefined ? "—" : size(bytes, ctx.locale.locale())),
    /** A folder's path from the Drive's root, "Drive › Artifacts › odoo-modules". */
    path: (folder: string | undefined) =>
      [ctx.t("drive.title"), ...pathOf(drive.folders(), folder).map((item) => item.name)].join(" › "),
    /** A format's name, or the instance's own word for one the Drive has no viewer for. */
    format: (format: string) => (known(format) ? ctx.t(`drive.format.${format}`) : format),
  }
}

/** A sketch of the document's first page, by format. */
export function Thumb(props: { doc?: Pick<Document, "name" | "format"> }) {
  const format = () => (props.doc ? (known(props.doc.format) ?? "file") : "folder")
  return (
    <div data-slot="drive-thumb" data-format={format()}>
      <Show when={format() === "folder" || format() === "file"}>
        <Icon name={format() === "folder" ? "folder" : "file-document"} />
      </Show>
      <Show when={format() === "docx"}>
        <i data-heading="" />
        <For each={[100, 100, 80, 100, 60, 100]}>{(width) => <i style={{ width: `${width}%` }} />}</For>
      </Show>
      <Show when={format() === "pptx"}>
        <b>{stem(props.doc?.name ?? "")}</b>
        <i />
      </Show>
      <Show when={format() === "html"}>
        <b />
        <i />
        <i />
        <i />
      </Show>
      <Show when={format() === "markdown"}>
        <span># {stem(props.doc?.name ?? "")}</span>
        <span>- …</span>
        <span>- …</span>
      </Show>
      <Show when={format() === "pdf"}>
        <For each={[100, 70, 100, 100, 50]}>{(width) => <i style={{ width: `${width}%` }} />}</For>
      </Show>
    </div>
  )
}

/**
 * Who wrote a comment: "You", or a name. The Drive names an author by an id only: the grants of the documents opened
 * name some, and the rest are "Someone".
 */
export function authorName(ctx: Pick<Context, "t">, message: Pick<Message, "mine" | "author">) {
  return message.mine ? ctx.t("drive.you") : (drive.nameOf(message.author) ?? ctx.t("drive.comment.other"))
}

/** One message of a thread: who, when, and the text with `@Agent` marked. */
export function MessageLine(props: { message: Message }) {
  const ctx = usePlugin()
  const names = useNames()
  const name = () => authorName(ctx, props.message)
  const parts = () => props.message.text.split(/(@\p{L}+)/u)
  return (
    <div data-slot="drive-message">
      <Avatar name={name()} size="small" />
      <div data-slot="drive-message-body">
        <div data-slot="drive-message-who">
          <b>{name()}</b>
          <span>{names.ago(props.message.created)}</span>
        </div>
        <div data-slot="drive-message-text">
          <For each={parts()}>
            {(part) => (part.startsWith("@") ? <span data-slot="drive-mention">{part}</span> : part)}
          </For>
        </div>
      </div>
    </div>
  )
}

/** What a thread or a new comment points at, as a line: the quote, the node's text, a cell range or a PDF page. */
export function AnchorLine(props: { text: string; icon: "outline-quote" | "dot-grid" | "file-document" }) {
  return (
    <span data-slot="drive-anchor">
      <Icon name={props.icon} size="small" />
      <span data-slot="drive-anchor-label">{props.text}</span>
    </span>
  )
}

/** The Present button of a document's bar. */
export function PresentButton(props: { present: Present }) {
  const ctx = usePlugin()
  return (
    <ctx.ui.Tooltip value={ctx.t("drive.present.hint")} placement="bottom">
      <ctx.ui.IconButton
        variant="ghost"
        icon="outline-maximize"
        label={ctx.t("drive.present")}
        onClick={() => props.present.start()}
      />
    </ctx.ui.Tooltip>
  )
}

/** Exit, over a document while it is presented. */
export function PresentExit(props: { present: Present }) {
  const ctx = usePlugin()
  return (
    <Show when={props.present.on()}>
      <div data-slot="drive-present-exit">
        <ctx.ui.Button variant="neutral" size="small" icon="close" onClick={() => props.present.stop()}>
          {ctx.t("drive.present.exit")}
        </ctx.ui.Button>
      </div>
    </Show>
  )
}
