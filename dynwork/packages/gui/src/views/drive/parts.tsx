import { usePlugin } from "@opencode/plugin/gui"
import { Icon } from "@opencode/ui/icon"
import { For, Show, type JSX } from "solid-js"
import { chats, formats, people, type DocClass, type Doc, type Format, type Message, type Thread } from "./demo"
import { ago, needsStoreChange, pathOf, stem } from "./model"
import { drive } from "./store"

// Small pieces every Drive screen shares: the format glyph, avatars, class tags, thumbnails, times and a thread's lines.

const tones: Record<DocClass, string> = {
  "agent-workspace": "agent",
  internal: "info",
  confidential: "warning",
  restricted: "danger",
}

/** A document's format as a colored glyph, or a folder. */
export function FormatGlyph(props: { format: Format | "folder"; size?: "large" }) {
  return (
    <span data-slot="drive-format" data-format={props.format} data-size={props.size}>
      <Show when={props.format !== "folder"} fallback={<Icon name="folder" size="small" />}>
        {formats[props.format as Format]?.glyph}
      </Show>
    </span>
  )
}

/** A person's initials on their color; the agent's on the brand gradient. */
export function Avatar(props: { person: string; size?: "small" }) {
  const person = () => people[props.person] ?? people.D
  return (
    <span
      data-slot="drive-avatar"
      data-agent={person().agent ? "" : undefined}
      data-size={props.size}
      style={person().agent ? undefined : { background: person().color }}
      title={person().name}
    >
      {person().initials}
    </span>
  )
}

/** A few people's avatars, overlapping. */
export function AvatarRow(props: { people: readonly string[]; title?: string }) {
  return (
    <span data-slot="drive-avatars" title={props.title}>
      <For each={props.people}>{(person) => <Avatar person={person} size="small" />}</For>
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

/** A document's governance class: what agents may do with it. */
export function ClassTag(props: { cls: DocClass }) {
  const ctx = usePlugin()
  return (
    <Tag tone={tones[props.cls]} title={ctx.t(`drive.class.${props.cls}.hint`)}>
      {ctx.t(`drive.class.${props.cls}`)}
    </Tag>
  )
}

/** "You" or the person's name. */
export function useNames() {
  const ctx = usePlugin()
  return {
    who: (id: string) => {
      const person = people[id]
      if (!person) return id
      if (person.me) return ctx.t("drive.you")
      if (person.agent) return ctx.t("drive.agent")
      return person.name
    },
    ago: (minutes: number) => ago(minutes, ctx.locale.locale(), ctx.t("drive.now")),
    /** A folder's path from the Drive's root, "Drive › Artifacts › odoo-modules". */
    path: (folder: string | undefined) =>
      [ctx.t("drive.title"), ...pathOf(drive.state.folders, folder).map((item) => item.name)].join(" › "),
    /** Text the demo stores as a key, such as the agent's answers, in the window's language. */
    said: (text: string) => (text.startsWith("drive.") ? ctx.t(text) : text),
  }
}

/** A sketch of the document's first page, by format. */
export function Thumb(props: { doc?: Doc }) {
  const format = () => props.doc?.format ?? "folder"
  return (
    <div data-slot="drive-thumb" data-format={format()}>
      <Show when={format() === "folder"}>
        <Icon name="folder" />
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

/** One message of a thread: who, when, how it was written, and the text with `@Agent` marked. */
export function MessageLine(props: { message: Message }) {
  const ctx = usePlugin()
  const names = useNames()
  const parts = () => names.said(props.message.text).split(/(@\p{L}+)/u)
  return (
    <div data-slot="drive-message">
      <Avatar person={props.message.by} size="small" />
      <div data-slot="drive-message-body">
        <div data-slot="drive-message-who">
          <b>{names.who(props.message.by)}</b>
          <span>{names.ago(props.message.age)}</span>
          <Show when={props.message.dynwork}>
            <span data-slot="drive-via">{ctx.t("drive.comment.dynwork")}</span>
          </Show>
          <Show when={props.message.via}>
            {(via) => <span data-slot="drive-via">{ctx.t("drive.comment.fromChat", { chat: chatName(via()) })}</span>}
          </Show>
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

export const chatName = (id: string) => chats[id]?.name ?? id

const anchorIcons = {
  text: "outline-quote",
  block: "outline-text",
  cell: "dot-grid",
  range: "dot-grid",
  shape: "outline-photo",
  element: "select-element",
  page: "file-document",
} as const

/** What a thread points at, as a line: "Cell F7 · Credit notes", "Slide 3 · “…”". */
export function AnchorLine(props: { thread: Pick<Thread, "anchor" | "quote"> }) {
  const ctx = usePlugin()
  const label = () => {
    const anchor = props.thread.anchor
    const quote = props.thread.quote
    if (anchor.kind === "cell")
      return ctx.t("drive.anchor.cell", { cell: anchor.cell, sheet: ctx.t(`drive.sheet.${anchor.sheet}`) })
    if (anchor.kind === "range")
      return ctx.t("drive.anchor.range", {
        range: `${anchor.from}:${anchor.to}`,
        sheet: ctx.t(`drive.sheet.${anchor.sheet}`),
      })
    if (anchor.kind === "shape") return ctx.t("drive.anchor.shape", { slide: String(anchor.slide + 1), quote })
    if (anchor.kind === "element") return ctx.t("drive.anchor.element", { quote })
    if (anchor.kind === "page")
      return quote
        ? ctx.t("drive.anchor.pageQuote", { page: String(anchor.page + 1), quote })
        : ctx.t("drive.anchor.page", { page: String(anchor.page + 1) })
    if (anchor.kind === "block") return ctx.t("drive.anchor.block", { quote })
    return `“${quote}”`
  }
  return (
    <span data-slot="drive-anchor">
      <Icon name={anchorIcons[props.thread.anchor.kind]} size="small" />
      <span data-slot="drive-anchor-label">{label()}</span>
      <Show when={needsStoreChange(props.thread.anchor)}>
        <span data-slot="drive-decision" title={ctx.t("drive.anchor.p10")}>
          P10
        </span>
      </Show>
    </span>
  )
}
