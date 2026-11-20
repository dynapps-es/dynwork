import { createSignal } from "solid-js"
import type { Anchor, Document } from "../../drive/contract"
import { DriveFrames } from "../../drive/frames"
import { pickAnchor, type Node, type Rect } from "./model"

// Commenting in place: with the marks shown, a selection or a click on a document opens a popup to write a comment
// right there (`comment-popup.tsx`), beside a document in the Drive and beside a chat. What the user picked comes from
// the app's own DOM for Markdown (`selected`, `clicked`) and from main's observer of the frame for HTML
// (`viewer.tsx`, `fromFrame`); either way it is a node, maybe a quote in it, and where it sits in the window.

/** What the user picked on a document: a node, the quote selected in it, and where that sits in the window. */
export interface Spot {
  readonly node: Node
  readonly quote?: string
  readonly rect: Rect
}

/** A spot as the popup takes it: the comment it opens, the quote picked, and where it sits. */
export interface Shown {
  readonly anchor: Anchor
  readonly quote?: string
  readonly rect: Rect
}

/**
 * The comment popup's state for one document: the spot it shows at, and the text written in it. A new spot moves the
 * popup there, unless something is written in it: that text stays until it is sent, cancelled or closed with Escape.
 * A click outside closes an empty popup and leaves a written one open, so a stray click loses nothing; it is the same
 * rule as a new spot, and the popup's own Cancel and Escape are always there to drop it.
 */
export function createInline(options: {
  doc: () => Pick<Document, "format"> | undefined
  /** Whether the user shows the marks. */
  shown: () => boolean
  /** Whether the user may comment on the document. */
  allowed: () => boolean
  /** While true, nothing opens: the document is being presented. */
  paused?: () => boolean
}) {
  const [spot, setSpot] = createSignal<Shown>()
  const [draft, setDraft] = createSignal("")
  const close = () => {
    setSpot(undefined)
    setDraft("")
  }
  return {
    spot,
    draft,
    setDraft,
    close,
    /** Opens the popup at a spot, when the document takes a comment there now. */
    offer(found: Spot) {
      if (options.paused?.() || draft().trim()) return
      const anchor = pickAnchor({
        shown: options.shown(),
        allowed: options.allowed(),
        doc: options.doc(),
        node: found.node,
        quote: found.quote,
      })
      if (anchor) setSpot({ anchor, quote: found.quote, rect: found.rect })
    },
    /** A press or focus outside the popup. */
    outside() {
      if (!draft().trim()) close()
    },
  }
}
export type Inline = ReturnType<typeof createInline>

/** The text of a selection, as a quote: one space for each run of them, `DriveFrames.maxQuote` at most. */
const quoteOf = (text: string) =>
  text
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, DriveFrames.maxQuote)
    .replace(/[\ud800-\udbff]$/, "")

/**
 * What a selection on a Markdown document picks: the block it starts in (one `CommentMarks` named a node), and the part
 * of the selection inside that block, as a quote and as a range to place the popup by. A selection that crosses blocks
 * is the part of its first one; one that starts outside a named block of `root`, or selects only spaces, picks nothing.
 */
export function selected(range: Range, root: Element) {
  const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
  const block = start?.closest<HTMLElement>("[data-node]")
  if (!block?.dataset.node || !root.contains(block)) return undefined
  const part = range.cloneRange()
  if (!block.contains(range.endContainer)) part.setEnd(block, block.childNodes.length)
  const quote = quoteOf(part.toString())
  return quote ? { node: block.dataset.node, block, part, quote } : undefined
}

/**
 * What a click on a Markdown document does: a link, a button or a control does its own and opens nothing; a marked
 * block opens its thread; any other block with a node picks that node, whole; anywhere else, nothing.
 */
export function clicked(target: Element | undefined, root: Element) {
  if (!target || !root.contains(target) || target.closest(DriveFrames.controls)) return undefined
  const thread = target.closest<HTMLElement>("[data-thread]")?.dataset.thread
  if (thread) return { kind: "thread" as const, thread }
  const block = target.closest<HTMLElement>("[data-node]")
  if (!block?.dataset.node) return undefined
  return { kind: "block" as const, node: block.dataset.node, block }
}
