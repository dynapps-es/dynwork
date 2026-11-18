import type { Anchor, Doc, Folder, Format } from "./demo"

// Pure reads of the Drive's data: what the browser lists, folder paths, search snippets, cell ranges and times.

export const scopes = ["home", "recent", "mine", "shared", "chats"] as const
export type Scope = (typeof scopes)[number]
export const typeFilters = ["all", "docx", "xlsx", "pptx", "html", "markdown", "pdf"] as const
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

/** Recent means changed in the last day and a half, as the governance web's own Recent list. */
const recent = 2000

/** The documents the browser lists: a search looks everywhere, by name and content; otherwise the scope decides. */
export function visibleDocs(docs: readonly Doc[], browse: Browse, me: string) {
  const query = browse.query.trim().toLowerCase()
  const order = {
    updated: (a: Doc, b: Doc) => a.age - b.age,
    name: (a: Doc, b: Doc) => a.name.localeCompare(b.name),
    type: (a: Doc, b: Doc) => a.format.localeCompare(b.format) || a.age - b.age,
  }[browse.sort]
  return docs
    .filter((doc) => browse.type === "all" || doc.format === browse.type)
    .filter((doc) => {
      if (query) return doc.name.toLowerCase().includes(query) || doc.text.includes(query)
      if (browse.scope === "home") return browse.type !== "all" || doc.folder === browse.folder
      if (browse.scope === "recent") return doc.age < recent
      if (browse.scope === "mine") return doc.owner === me
      if (browse.scope === "shared") return doc.owner !== me
      return doc.chats.length > 0
    })
    .toSorted(order)
}

/** The folders the browser lists: the open folder's children at Home, the top shared folders under Shared. */
export function visibleFolders(folders: readonly Folder[], browse: Browse) {
  if (browse.query.trim() || browse.type !== "all") return []
  if (browse.scope === "home") return folders.filter((folder) => folder.parent === browse.folder)
  if (browse.scope === "shared")
    return folders.filter((folder) => folder.shared && !folders.find((parent) => parent.id === folder.parent)?.shared)
  return []
}

/** A folder and its parents, from the root. */
export function pathOf(folders: readonly Folder[], id: string | undefined): Folder[] {
  const folder = folders.find((item) => item.id === id)
  if (!folder) return []
  return [...pathOf(folders, folder.parent), folder]
}

/** Where a search matched a document's content and not its name: the words around the match. */
export function snippet(doc: Doc, query: string) {
  const q = query.trim().toLowerCase()
  if (!q || doc.name.toLowerCase().includes(q)) return undefined
  const at = doc.text.indexOf(q)
  if (at < 0) return undefined
  return {
    before: doc.text.slice(Math.max(0, at - 24), at),
    match: doc.text.slice(at, at + q.length),
    after: doc.text.slice(at + q.length, at + q.length + 30),
  }
}

/** The name split around a search match, for highlighting. */
export function highlight(name: string, query: string) {
  const q = query.trim().toLowerCase()
  const at = q ? name.toLowerCase().indexOf(q) : -1
  if (at < 0) return { before: name, match: "", after: "" }
  return { before: name.slice(0, at), match: name.slice(at, at + q.length), after: name.slice(at + q.length) }
}

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

/** The store anchors to a node and a quote inside it; a cell range and a point on a PDF have no node yet. */
export function needsStoreChange(anchor: Anchor) {
  return anchor.kind === "range" || anchor.kind === "page"
}

/** The cell an anchor starts at, for a spreadsheet's markers. */
export function anchorCell(anchor: Anchor) {
  if (anchor.kind === "cell") return anchor.cell
  if (anchor.kind === "range") return anchor.from
  return undefined
}

export const formatOf = (name: string): Format | undefined =>
  (({ docx: "docx", xlsx: "xlsx", pptx: "pptx", html: "html", md: "markdown", pdf: "pdf" }) as Record<string, Format>)[
    name.split(".").pop() ?? ""
  ]

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
