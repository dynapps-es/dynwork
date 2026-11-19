import { matchNodes, type Thread } from "./model"

// The comments marked on a page (HTML) before it goes into its frame. The instance anchors a comment to a node and an
// optional quote inside it; the page is read into an inert document (`anchorPage`), its blocks are matched to the
// document's nodes by their text, in reading order (`matchNodes`, as the Markdown marks do), and the quote of each open
// thread is wrapped in a `<mark>` inside its block, or the block's text when the thread has no quote. The marks work
// without scripts: the browser's own `mark` look, a `title` with the comment's start, and an id a jump navigates to.
// Main's observer (`drive/frames.ts`) reports a click on one.

/** The id of a thread's first mark in the page, which a jump navigates to. */
export const markId = (thread: string) => `dynwork-comment-${thread}`

// The elements of a page a comment anchors to, as the instance's HTML reading has them; an image has no text to match.
const blocks = "h1, h2, h3, h4, h5, h6, p, li, table, tr, td, th"

// Text a mark never wraps: what does not show, and the whitespace between a table's rows, where a mark is not allowed.
const hidden = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "TEXTAREA"])
const tabular = new Set(["TABLE", "THEAD", "TBODY", "TFOOT", "TR", "COLGROUP"])

// The marks' look: the browser's own `mark` when the page's policy keeps out inline styles, readable on light and dark.
const look =
  "mark[data-dynwork-comment]{background:rgb(255 196 0 / 0.28);color:inherit;border-bottom:2px solid #f0b400;border-radius:2px;cursor:pointer}"

/**
 * Marks the open threads of a page read into an inert document, in place. A thread whose node or quote the page does
 * not show marks nothing, and a resolved one is not marked. Answers the id of each marked thread's first mark.
 */
export function markPage(
  page: Document,
  nodes: Parameters<typeof matchNodes>[0],
  threads: readonly Pick<Thread, "id" | "node" | "quote" | "open" | "messages">[],
) {
  const elements = [...page.body.querySelectorAll(blocks)]
  const matched = matchNodes(nodes, elements.map(ownText))
  const marked = threads.flatMap((thread) => {
    if (!thread.open) return []
    const element = elements[matched.findIndex((node) => node?.id === thread.node)]
    if (!element) return []
    const pieces = thread.quote === undefined ? whole(element) : quoted(element, thread.quote)
    const marks = pieces.map((piece) => wrap(page, piece, thread))
    if (!marks[0]) return []
    marks[0].id = markId(thread.id)
    return [[thread.id, marks[0].id] as const]
  })
  if (marked.length > 0) {
    const style = page.createElement("style")
    style.textContent = look
    page.head.append(style)
  }
  return Object.fromEntries(marked)
}

/** A part of one text node: `[from, to)`. */
interface Piece {
  readonly text: Text
  readonly from: number
  readonly to: number
}

/** A block's own children: a list item leaves out the lists nested in it, which are blocks of their own. */
const own = (element: Element) => [...element.childNodes].filter((child) => !/^(UL|OL)$/.test(child.nodeName))

/** A block's own text, as its node has it. */
const ownText = (element: Element) =>
  own(element)
    .map((child) => child.textContent ?? "")
    .join("")

/** The text nodes under a node that show, in reading order. */
function textsOf(node: Node): Text[] {
  if (node instanceof Text) return tabular.has(node.parentNode?.nodeName ?? "") ? [] : [node]
  if (hidden.has(node.nodeName)) return []
  return [...node.childNodes].flatMap(textsOf)
}

/** All the text of a block. */
function whole(element: Element): Piece[] {
  return own(element)
    .flatMap(textsOf)
    .filter((text) => /\S/.test(text.data))
    .map((text) => ({ text, from: 0, to: text.data.length }))
}

/**
 * Where a quote is in a block's text, as the pieces of the text nodes it spans: the text is read with each run of
 * spaces as one, as the page shows it, and the quote must be there as written. None when it is not.
 */
function quoted(element: Element, quote: string): Piece[] {
  const wanted = quote.replace(/\s+/g, " ").trim()
  if (!wanted) return []
  // Each character of the text as read, with the node and offset it comes from.
  const read = own(element)
    .flatMap(textsOf)
    .flatMap((text) => [...text.data].map((char, offset) => ({ char: /\s/.test(char) ? " " : char, text, offset })))
  const chars = read.filter((item, index) => item.char !== " " || read[index - 1]?.char !== " ")
  const at = chars
    .map((item) => item.char)
    .join("")
    .indexOf(wanted)
  if (at < 0) return []
  const span = chars.slice(at, at + wanted.length)
  return [...new Set(span.map((item) => item.text))].flatMap((text) => {
    const offsets = span.filter((item) => item.text === text).map((item) => item.offset)
    const piece = { text, from: Math.min(...offsets), to: Math.max(...offsets) + 1 }
    return /\S/.test(text.data.slice(piece.from, piece.to)) ? [piece] : []
  })
}

/** Wraps a piece of text in a thread's mark. */
function wrap(page: Document, piece: Piece, thread: Pick<Thread, "id" | "messages">) {
  const middle = piece.from > 0 ? piece.text.splitText(piece.from) : piece.text
  if (piece.to - piece.from < middle.data.length) middle.splitText(piece.to - piece.from)
  const mark = page.createElement("mark")
  mark.setAttribute("data-dynwork-comment", thread.id)
  mark.title = titleOf(thread)
  middle.parentNode?.insertBefore(mark, middle)
  mark.append(middle)
  return mark
}

/** A thread's comment in a line, as a mark's tooltip shows it. */
function titleOf(thread: Pick<Thread, "messages">) {
  const text = (thread.messages[0]?.text ?? "").replace(/\s+/g, " ").trim()
  return text.length > 120 ? `${text.slice(0, 119)}…` : text
}
