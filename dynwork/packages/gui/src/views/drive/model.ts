import { DriveCapabilities } from "../../drive/capabilities"
import type { Comment, Document, Folder, Link, Outline } from "../../drive/contract"

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
 * no nodes; at a cell range, once `rangeComments` is on; at a point of a PDF page, once `pdfComments` is on.
 */
export function anchorsOf(doc: Pick<Document, "format" | "mime">, capabilities: DriveCapabilities.Capabilities) {
  const pdf = isPdf(doc)
  return {
    node: !pdf,
    range:
      doc.format === "xlsx" &&
      DriveCapabilities.anchorable(capabilities, { kind: "range", sheet: 0, from: "A1", to: "A1" }),
    page: pdf && DriveCapabilities.anchorable(capabilities, { kind: "page", page: 1, x: 0, y: 0 }),
  }
}
