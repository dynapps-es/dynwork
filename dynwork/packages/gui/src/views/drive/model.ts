import type { Document, Folder, Link } from "../../drive/contract"

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
  return documents
    .filter((document) => !root || document.folder === undefined)
    .filter((document) => browse.type === "all" || document.format === browse.type)
    .toSorted(order)
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

// The comments layer (`comments.tsx`, `canvas.tsx`) draws threads on a document; the Drive's own comments reach it in
// phase 06 of the Drive plan. Until then these are its shapes, and no thread exists.

/**
 * What a comment points at. The Drive anchors to a node (a paragraph, a cell, a shape's paragraph) and an optional
 * quote inside it; `range` and `page` have no node yet and need a change in the Drive (P10).
 */
export type Anchor =
  | { readonly kind: "text" }
  | { readonly kind: "block" }
  | { readonly kind: "cell"; readonly sheet: number; readonly cell: string }
  | { readonly kind: "range"; readonly sheet: number; readonly from: string; readonly to: string }
  | { readonly kind: "shape"; readonly slide: number; readonly node: string }
  | { readonly kind: "element"; readonly find: string }
  | { readonly kind: "page"; readonly page: number; readonly x: number; readonly y: number }

export interface Message {
  /** `me`, or another author's id. */
  readonly by: string
  readonly text: string
  readonly age: number
  /** Written from DynWork, which the Drive counts as an agent until people sign in as themselves (P1). */
  readonly dynwork?: boolean
}

export interface Thread {
  readonly id: string
  readonly quote: string
  readonly anchor: Anchor
  readonly open: boolean
  readonly messages: readonly Message[]
}

/** The author of what the user writes in the comments layer. */
export const me = "me"

const column = (cell: string) => cell.charCodeAt(0)
const row = (cell: string) => Number(cell.slice(1))

/** The cells an "A1:B2" range covers, by column then row; none for no range. */
export function cellsIn(range: string | undefined) {
  if (!range) return []
  const [a, b] = range.split(":")
  const c0 = Math.min(column(a), column(b))
  const c1 = Math.max(column(a), column(b))
  const r0 = Math.min(row(a), row(b))
  const r1 = Math.max(row(a), row(b))
  return Array.from({ length: c1 - c0 + 1 }, (_, i) =>
    Array.from({ length: r1 - r0 + 1 }, (_, j) => String.fromCharCode(c0 + i) + (r0 + j)),
  ).flat()
}

/** The range two corner cells make, top-left first; undefined when they are the same cell. */
export function rangeOf(a: string, b: string) {
  if (a === b) return undefined
  const cells = cellsIn(`${a}:${b}`)
  return `${cells[0]}:${cells[cells.length - 1]}`
}

/** The Drive anchors to a node and a quote inside it; a cell range and a point on a PDF have no node yet. */
export function needsStoreChange(anchor: Anchor) {
  return anchor.kind === "range" || anchor.kind === "page"
}

/** The cell an anchor starts at, for a spreadsheet's markers. */
export function anchorCell(anchor: Anchor) {
  if (anchor.kind === "cell") return anchor.cell
  if (anchor.kind === "range") return anchor.from
  return undefined
}
