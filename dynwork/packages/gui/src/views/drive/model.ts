import { DriveCapabilities } from "../../drive/capabilities"
import {
  isFailure,
  type Anchor,
  type Comment,
  type Document,
  type Failure,
  type Folder,
  type Link,
  type Outline,
  type Revision,
} from "../../drive/contract"

// Pure reads of the Drive's data, as the `dynwork.drive` Ipc answers it: what the browser lists, folder paths, the
// conversations' documents, sizes and times; and the anchors the comments layer draws.

export const scopes = ["home", "recent", "mine", "shared", "chats"] as const
export type Scope = (typeof scopes)[number]
export const formats = ["docx", "xlsx", "pptx", "html", "markdown", "pdf"] as const
/** The formats the Drive draws a glyph and a viewer for; the instance may classify a file as anything else. */
export type Format = (typeof formats)[number]
export const typeFilters = ["all", ...formats] as const
export type TypeFilter = (typeof typeFilters)[number]
export const sorts = ["updated", "name", "type"] as const
export type Sort = (typeof sorts)[number]

export interface Browse {
  readonly scope: Scope
  readonly folder: string | undefined
  readonly query: string
  readonly type: TypeFilter
  readonly sort: Sort
}

/** Whether a document is a PDF: by the instance's format, or, for an uploaded file (format `file`), by its type. */
export const isPdf = (doc: Pick<Document, "format" | "mime">) =>
  doc.format === "pdf" || doc.mime.split(";")[0]?.trim() === "application/pdf"

/** A format the Drive knows, else undefined. */
export const known = (format: string) => formats.find((item) => item === format)

/**
 * The documents the browser lists out of what the Drive answered: Home at the root keeps the loose files only (the
 * user's own listing holds every folder's), then the type filter and the order.
 */
export function visibleDocs(documents: readonly Document[], browse: Browse) {
  const order = {
    updated: (a: Document, b: Document) => b.updated - a.updated,
    name: (a: Document, b: Document) => a.name.localeCompare(b.name),
    type: (a: Document, b: Document) => a.format.localeCompare(b.format) || b.updated - a.updated,
  }[browse.sort]
  const root = browse.scope === "home" && browse.folder === undefined && !browse.query.trim()
  return (
    documents
      .filter((document) => !root || document.folder === undefined)
      // An uploaded PDF is a `file` to the instance: PDF goes by type too.
      .filter(
        (document) =>
          browse.type === "all" || document.format === browse.type || (browse.type === "pdf" && isPdf(document)),
      )
      .toSorted(order)
  )
}

/**
 * The folders the browser lists: the open folder's children at Home, and under Shared the top folders others share
 * with the user (one whose parent is shared too shows inside it).
 */
export function visibleFolders(folders: readonly Folder[], browse: Browse) {
  if (browse.query.trim() || browse.type !== "all") return []
  if (browse.scope === "home") return folders.filter((folder) => folder.parent === browse.folder)
  if (browse.scope === "shared")
    return folders.filter(
      (folder) => !folder.mine && !folders.some((parent) => parent.id === folder.parent && !parent.mine),
    )
  return []
}

/** A folder and its parents, from the root. */
export function pathOf(folders: readonly Folder[], id: string | undefined): Folder[] {
  const folder = folders.find((item) => item.id === id)
  if (!folder) return []
  return [...pathOf(folders, folder.parent), folder]
}

/** The documents each conversation made, changed or attached, newest conversation first, with what it did. */
export function byConversation(links: readonly Link[]) {
  const newest = links.toSorted((a, b) => b.at - a.at)
  return [...new Set(newest.map((link) => link.conversation))].map((conversation) => {
    const own = newest.filter((link) => link.conversation === conversation)
    return {
      conversation,
      documents: [...new Set(own.map((link) => link.document))].map((document) => ({
        document,
        acts: [...new Set(own.filter((link) => link.document === document).map((link) => link.act))],
      })),
    }
  })
}

/** One card of a chat's artifacts per document, with its latest act: a document edited twenty times is one card. */
export function latest(links: readonly Link[]) {
  const newest = links.toSorted((a, b) => b.at - a.at)
  return newest.filter((link, index) => newest.findIndex((other) => other.document === link.document) === index)
}

/**
 * The documents a chat made or changed that it has not been seen to before, newest last: `seen` holds what the window
 * already knew (by conversation and document) and is brought up to date. An attachment or a read opens nothing: the
 * user did that, or it changed nothing.
 */
export function arrivals(links: readonly Link[], seen: Set<string>) {
  const fresh = links
    .toSorted((a, b) => a.at - b.at)
    .filter((link) => !seen.has(`${link.conversation}:${link.document}`))
  links.forEach((link) => seen.add(`${link.conversation}:${link.document}`))
  return fresh.filter((link) => link.act === "created" || link.act === "edited" || link.act === "proposed")
}

/**
 * How a document the agent made or changed lands in the side panel's strip: a new one is selected and stays; a change to
 * one that has no tab opens as the strip's preview tab, which the next such change replaces, so an agent editing many
 * documents leaves one tab and not one each.
 */
export function landing(act: Link["act"]) {
  return act === "created" ? ("select" as const) : ("preview" as const)
}

/** The name split around a search match, for highlighting. */
export function highlight(name: string, query: string) {
  const q = query.trim().toLowerCase()
  const at = q ? name.toLowerCase().indexOf(q) : -1
  if (at < 0) return { before: name, match: "", after: "" }
  return { before: name.slice(0, at), match: name.slice(at, at + q.length), after: name.slice(at + q.length) }
}

/** A file's type from its extension, for an upload the system did not type. */
export function mimeOf(name: string) {
  return (
    {
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      html: "text/html",
      htm: "text/html",
      md: "text/markdown",
      pdf: "application/pdf",
      txt: "text/plain",
      csv: "text/csv",
    } as Record<string, string>
  )[name.split(".").pop()?.toLowerCase() ?? ""]
}

/** A document's name without its extension. */
export const stem = (name: string) => name.replace(/\.\w+$/, "")

/** "5 minutes ago" in the window's language; `now` for under a minute. */
export function ago(minutes: number, locale: string, now: string) {
  if (minutes < 1) return now
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" })
  if (minutes < 60) return format.format(-Math.round(minutes), "minute")
  if (minutes < 1440) return format.format(-Math.round(minutes / 60), "hour")
  if (minutes < 10080) return format.format(-Math.round(minutes / 1440), "day")
  return format.format(-Math.round(minutes / 10080), "week")
}

/** A size in bytes as the window's language writes it: "320 kB", "1.2 MB". */
export function size(bytes: number, locale: string) {
  const units = ["byte", "kilobyte", "megabyte", "gigabyte"] as const
  const index = Math.min(units.length - 1, Math.max(0, Math.floor(Math.log(Math.max(bytes, 1)) / Math.log(1024))))
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: units[index],
    unitDisplay: index === 0 ? "long" : "short",
    maximumFractionDigits: index < 2 ? 0 : 1,
  }).format(bytes / 1024 ** index)
}

// Comments. The instance anchors a comment to a node of the document (a paragraph, a table cell, a slide's box) and an
// optional quote inside it; the Comments tab and the Markdown marks (`comments.tsx`) read them through these.

export type Node = Outline["nodes"][number]

export interface Message {
  readonly id: string
  /** The author's user id, which `DriveStore.nameOf` may name. */
  readonly author: string
  /** Written by the signed-in user: DynWork signs it as an agent until people sign in as themselves (P1). */
  readonly mine: boolean
  readonly text: string
  /** Epoch milliseconds. */
  readonly created: number
}

/** A comment and its replies, by the node and the quote it points at. */
export interface Thread {
  /** The first comment's id. */
  readonly id: string
  readonly node: string
  readonly quote: string | undefined
  readonly open: boolean
  readonly messages: readonly Message[]
}

/**
 * The threads of a document's comments, newest first, each with its messages oldest first. A reply of a reply belongs to
 * the same thread; a thread is open until its first comment is resolved.
 */
export function threadsOf(comments: readonly Comment[]): Thread[] {
  const byId = new Map(comments.map((comment) => [comment.id, comment]))
  const rootOf = (comment: Comment): Comment => {
    const parent = comment.parent === undefined ? undefined : byId.get(comment.parent)
    return parent ? rootOf(parent) : comment
  }
  const message = (comment: Comment): Message => ({
    id: comment.id,
    author: comment.author,
    mine: comment.mine,
    text: comment.body,
    created: comment.created,
  })
  return comments
    .filter((comment) => comment.parent === undefined || !byId.has(comment.parent))
    .toSorted((a, b) => b.created - a.created)
    .flatMap((root) => {
      if (!root.anchor) return []
      return {
        id: root.id,
        node: root.anchor.node,
        quote: root.anchor.find,
        open: root.resolved === undefined,
        messages: comments
          .filter((comment) => comment.id === root.id || rootOf(comment).id === root.id)
          .toSorted((a, b) => a.created - b.created)
          .map(message),
      }
    })
}

// A node's text is the instance's own reading of it: Markdown source for a Markdown document, plain text for the
// rest, with a marker for what the block is. A reader sees neither, so the two are compared without them.

/** A node's text as a reader sees it: the block marker and the inline Markdown syntax out, spaces collapsed. */
export function plain(source: string) {
  return source
    .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*|\|\s*)/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~|\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** What two renderings of the same text share: its letters and digits, whatever the markup, case or spacing. */
const keyOf = (text: string) =>
  text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "")

/**
 * The node each block of a rendered document is, by the text they share, walking both in reading order: a block with no
 * node (a caption, a rule, what a script drew) stays unmatched and does not move the nodes on, and a node with no block
 * (a blank line, a table's separator row, a slide's heading) is skipped.
 */
export function matchNodes(nodes: readonly Node[], blocks: readonly string[]): (Node | undefined)[] {
  const keys = nodes.map((node) => keyOf(plain(node.text)))
  let from = 0
  return blocks.map((block) => {
    const key = keyOf(block)
    if (!key) return undefined
    const at = keys.indexOf(key, from)
    if (at < 0) return undefined
    from = at + 1
    return nodes[at]
  })
}

/**
 * The quote to anchor at inside a node, from the text a person selected: the instance finds it in the node's own text,
 * markup included, and refuses the whole comment when it is not there, so a selection that crosses Markdown syntax
 * anchors to the node alone.
 */
export function quoteIn(node: Pick<Node, "text">, selected: string) {
  const quote = selected.replace(/\s+/g, " ").trim().slice(0, 90)
  return quote && node.text.includes(quote) ? quote : undefined
}

/**
 * Whether a node holds a quote a page reported picking, with each run of spaces as one: a page's script can change what
 * the page shows, but not make the app anchor a comment to text the document does not have.
 */
export function holds(node: Pick<Node, "text">, quote: string) {
  const squash = (text: string) => text.replace(/\s+/g, " ").trim()
  const wanted = squash(quote)
  return wanted !== "" && squash(node.text).includes(wanted)
}

/**
 * The comment a pick on a document opens, at its node and the quote picked in it (`quoteIn`), or at the whole node
 * without one; none unless the user shows the marks, may comment and the document draws its marks (HTML, Markdown).
 */
export function pickAnchor(input: {
  shown: boolean
  allowed: boolean
  doc: Pick<Document, "format"> | undefined
  node: Node
  quote?: string
}): Anchor | undefined {
  if (!input.shown || !input.allowed || !input.doc || !marked(input.doc)) return undefined
  const find = input.quote === undefined ? undefined : quoteIn(input.node, input.quote)
  return find === undefined ? { kind: "node", node: input.node.id } : { kind: "node", node: input.node.id, find }
}

/** A rectangle in pixels, as `getBoundingClientRect` gives one. */
export interface Rect {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/** The part of `rect` inside `bounds`; none when they do not meet. */
export function clip(rect: Rect, bounds: Rect): Rect | undefined {
  const left = Math.max(rect.left, bounds.left)
  const top = Math.max(rect.top, bounds.top)
  const right = Math.min(rect.left + rect.width, bounds.left + bounds.width)
  const bottom = Math.min(rect.top + rect.height, bounds.top + bounds.height)
  if (right < left || bottom < top) return undefined
  return { left, top, width: right - left, height: bottom - top }
}

/**
 * A rectangle a frame reported in its own visible area, in the window's: the frame's box where the window draws it,
 * scaled as the window scales it (`box` against its layout width), from inside its border, and kept within what the
 * frame shows.
 */
export function framed(
  rect: Rect,
  frame: {
    box: Rect
    offsetWidth: number
    clientLeft: number
    clientTop: number
    clientWidth: number
    clientHeight: number
  },
) {
  const scale = frame.offsetWidth > 0 ? frame.box.width / frame.offsetWidth : 1
  const left = frame.box.left + frame.clientLeft * scale
  const top = frame.box.top + frame.clientTop * scale
  return clip(
    {
      left: left + rect.left * scale,
      top: top + rect.top * scale,
      width: rect.width * scale,
      height: rect.height * scale,
    },
    { left, top, width: frame.clientWidth * scale, height: frame.clientHeight * scale },
  )
}

/** A node's text for a list or a line: what a reader sees of it, in a few words. */
export function nodeLabel(node: Pick<Node, "text">, size = 90) {
  const text = plain(node.text.replace(/\t/g, " · "))
  return text.length > size ? `${text.slice(0, size - 1)}…` : text
}

/** The nodes worth offering to comment on: the ones with something a reader sees, matching a search. */
export function pickable(nodes: readonly Node[], query: string) {
  const q = query.trim().toLowerCase()
  return nodes.filter((node) => {
    const text = plain(node.text)
    return text && (!q || text.toLowerCase().includes(q))
  })
}

/**
 * How a document takes a comment, by its format and the instance's capabilities (D11): at a node, always, but a PDF has
 * no nodes and takes no comment, the core does not read it (D22); at a cell range, once `rangeComments` is on.
 */
export function anchorsOf(doc: Pick<Document, "format" | "mime">, capabilities: DriveCapabilities.Capabilities) {
  return {
    node: !isPdf(doc),
    range:
      doc.format === "xlsx" &&
      DriveCapabilities.anchorable(capabilities, { kind: "range", sheet: 0, from: "A1", to: "A1" }),
  }
}

/** Whether a document shows its comments marked on it: an HTML page and Markdown, which DynWork draws itself. */
export const marked = (doc: Pick<Document, "format">) => doc.format === "html" || doc.format === "markdown"

/**
 * A translated sentence with its `{{name}}` values marked to show in bold: the template is split where each value goes,
 * so every language keeps its own word order (the share card's sentence).
 */
export function emphasized(template: string, values: Record<string, string>) {
  return template
    .split(/({{\s*\w+\s*}})/g)
    .filter(Boolean)
    .map((part) => {
      const key = /^{{\s*(\w+)\s*}}$/.exec(part)?.[1]
      return key === undefined ? { text: part, strong: false } : { text: values[key] ?? "", strong: true }
    })
}

/**
 * Whom a share names, as its card says it: "Name (email)" for a person the conversation looked up (the email tells two
 * people of one name apart), the value the agent gave otherwise (an email, or an id never seen), and a group or role
 * with its kind.
 */
export function shareSubject(subject: { kind: string; value: string; name?: string; email?: string }) {
  const named =
    subject.name === undefined ? subject.value : subject.email ? `${subject.name} (${subject.email})` : subject.name
  return subject.kind === "user" ? named : `${named} (${subject.kind})`
}

/** A thread placed beside a document: its first mark's top, in pixels from the top of the document's visible area. */
export interface Placed {
  readonly thread: string
  readonly top: number
}

/**
 * The comments' bubbles beside a document, top to bottom: a thread joins the bubble above while its top is closer than
 * `size` to that bubble's, so threads at one height share a bubble.
 */
export function bubbleRows(placed: readonly Placed[], size = 28) {
  return placed
    .toSorted((a, b) => a.top - b.top)
    .reduce<{ top: number; threads: string[] }[]>((rows, item) => {
      const last = rows.at(-1)
      if (last && item.top - last.top < size) last.threads.push(item.thread)
      else rows.push({ top: item.top, threads: [item.thread] })
      return rows
    }, [])
}

/**
 * The faces of a bubble, front first: the thread open now when the bubble has it, then the others in their order. The
 * first `folded` show while the bubble is folded; `more` counts the rest ("+N"), which show when it spreads apart.
 */
export function bubbleFaces(threads: readonly string[], active: string | undefined, folded = 2) {
  const faces =
    active !== undefined && threads.includes(active) ? [active, ...threads.filter((id) => id !== active)] : [...threads]
  return { faces, more: Math.max(0, faces.length - folded) }
}

/**
 * Whether DynWork's own agent made a document: its first revision (the last of a newest-first list) is an agent's,
 * written through the API or the `documents` MCP server, on a document of the user's. That is the document the Dynapps
 * extension lets an attended agent share from 0.85 (`created_by_agent`, which the instance does not show: another agent
 * of the user's, writing through the API, reads the same, and the instance refuses it). A file the bridge synced is
 * written by the user's device, not by DynWork.
 */
export function madeByAgent(doc: Pick<Document, "mine">, revisions: readonly Pick<Revision, "actor" | "origin">[]) {
  const first = revisions.at(-1)
  return doc.mine && first?.actor === "agent" && (first.origin === "api" || first.origin === "mcp_execution")
}

/**
 * What the Share popover offers on a document. `change` says whether invite, a level and remove are live here and,
 * when not, why:
 * - `live`: DynWork's agent made it (`made`), the user may share it (`own` or `share`: the instance takes nothing less
 *   for a share) and the agents' cap is `edit`: the policy that lets an attended agent share (Dynapps from 0.85). The
 *   instance still decides each call; a refusal shows inline (`afterShare`).
 * - `governance`: the user may share it, in Governance: a document DynWork's agent did not make, or under a lower cap.
 * - `level`: the user's access does not let them share it at all.
 * An access not read counts as `governance`. `copy` and `governance` offer the document's page in Governance, when the
 * account's instance is known: to copy, and to open it where the user can share. What a folder grants and the agents'
 * cap are never changed here (the cap needs `own`, which the instance keeps from agents).
 */
export function sharing(input: { access: string | undefined; link: string | undefined; made?: boolean; cap?: string }) {
  const shares = input.access === undefined || input.access === "own" || input.access === "share"
  const live = input.made === true && (input.access === "own" || input.access === "share") && input.cap === "edit"
  return {
    change: live ? ("live" as const) : shares ? ("governance" as const) : ("level" as const),
    copy: input.link !== undefined,
    governance: shares && input.link !== undefined,
  }
}

/**
 * Who has access after a share or a revocation the popover asked for: the instance's answer, or, when it refused, the
 * list as it was and the refusal to show beside it.
 */
export function afterShare<A>(shown: A, answer: A | Failure) {
  return isFailure(answer) ? { access: shown, refusal: answer } : { access: answer, refusal: undefined }
}
