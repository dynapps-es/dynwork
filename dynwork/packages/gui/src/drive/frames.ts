export * as DriveFrames from "./frames"

import type { App, WebContents } from "electron"

// The Drive viewer's HTML frame may run the page's scripts when the instance allows them (D5). A script can still send
// its frame to another page: CSP does not govern navigation, and the frame's sandbox keeps it in the frame. Main keeps
// that frame on the page DynWork gave it: in every window, a navigation of a frame with a viewer's name, or of a frame
// once seen with one (a script can rename its window), goes ahead only to the frame's `srcdoc` or a blank page.
// Every other frame is left alone.

/** The `name` the viewer gives its frames, alone or followed by `:<n>`, one per frame (`views/drive/viewer.tsx`). */
export const name = "dynwork-drive-frame"

/** Whether a frame's name is one the viewer gives. */
export const isViewer = (frame: string) => frame === name || frame.startsWith(`${name}:`)

/** Whether a sub-frame's navigation goes ahead. */
export function allows(input: { name: string; known: boolean; url: string; sameDocument: boolean }) {
  if (!isViewer(input.name) && !input.known) return true
  // A link to a heading of the same page stays in the page.
  if (input.sameDocument) return true
  return input.url === "about:srcdoc" || input.url === "about:blank"
}

/** What `guard` needs of Electron: the app's `web-contents-created`, and the contents that exist already. */
export interface Host {
  app: Pick<App, "on" | "off">
  contents: () => readonly WebContents[]
}

/** Guards the viewer's frames in every window, now and later; answers what removes the guard. */
export function guard(host: Host) {
  const seen = new Set<number>()
  const guarded = new Set<WebContents>()
  const navigate = (details: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>) => {
    const frame = details.frame
    if (details.isMainFrame || !frame) return
    const known = seen.has(frame.frameTreeNodeId)
    if (isViewer(frame.name)) seen.add(frame.frameTreeNodeId)
    if (allows({ name: frame.name, known, url: details.url, sameDocument: details.isSameDocument })) return
    details.preventDefault()
  }
  const watch = (contents: WebContents) => {
    if (guarded.has(contents)) return
    guarded.add(contents)
    contents.on("will-frame-navigate", navigate)
    contents.once("destroyed", () => guarded.delete(contents))
  }
  const created = (_event: unknown, contents: WebContents) => watch(contents)
  host.contents().forEach(watch)
  host.app.on("web-contents-created", created)
  return () => {
    host.app.off("web-contents-created", created)
    guarded.forEach((contents) => contents.off("will-frame-navigate", navigate))
    guarded.clear()
  }
}

// What the viewer learns from its HTML frame (`watch.ts`): which heading the reader is at, for the index, which comment
// mark they clicked, where each thread's first mark sits, for the comments' bubbles beside the frame, and what the user
// selected or clicked to comment on, for the comment popup. The frame is sandboxed without DynWork's origin, so the app
// cannot read it, and the page may be an agent's, with scripts: nothing of DynWork is exposed to it. Main runs `observer`
// in an isolated world of the frame, which the page's scripts can neither see nor reach, and it reports through a
// binding that exists only in that world. The report is ids, numbers and a short quote, each checked by the viewer
// against what it gave the page and what it knows of the document.

/** The isolated world main's observer runs in. */
export const world = "dynwork-drive"

/** The function main's observer reports through: it exists in `world` only. */
export const binding = "dynworkDriveFrame"

/** How many marks a report places at most: the first ones of the page. */
export const maxMarks = 100

/** How far from the visible area a report places a mark, in pixels either way: farther is as far. */
export const farthest = 1_000_000

/** The highest block index a pick may name: the viewer numbers the blocks it matched to nodes from 0. */
export const maxBlocks = 100_000

/** How long a picked quote is at most, in UTF-16 units: the part of the selection inside its first block. */
export const maxQuote = 500

/**
 * What a click on a page does on its own, so it opens no comment: a link, a button, a form control or what says it is
 * one. The Markdown view skips the same.
 */
export const controls = [
  "a",
  "area",
  "button",
  "input",
  "select",
  "textarea",
  "label",
  "summary",
  "option",
  "video",
  "audio",
  "[contenteditable='']",
  "[contenteditable='true']",
  "[onclick]",
  "[role=button]",
  "[role=link]",
  "[role=checkbox]",
  "[role=switch]",
  "[role=tab]",
  "[role=menuitem]",
  "[role=option]",
  "[role=slider]",
].join(", ")

/**
 * The heading a reader is at, out of the headings' tops from the top of the visible area: the last one whose top has
 * passed the upper third of it, else the first. -1 without headings.
 */
export function reading(tops: readonly number[], height: number) {
  if (tops.length === 0) return -1
  return Math.max(
    0,
    tops.findLastIndex((top) => top <= height / 3),
  )
}

/**
 * The observer, as the source main evaluates in `world` at the start of each document of a viewer frame. It reports
 * the id of the heading being read when it changes, where the first mark of each thread sits from the top of the
 * visible area (rounded pixels, `maxMarks` at most) when that changes, and the comment of a mark the user clicked: only
 * a trusted click, so the page's scripts cannot click one for the user.
 *
 * It also reports a pick: a selection the user made (read on the trusted click that ends it), or a click without one
 * that lands on no mark, link or control, in a block the viewer numbered (`data-dynwork-block`, an opaque index, never a node id). A
 * pick is the block's index, the part of the selection inside its first block (`maxQuote` at most) and where that part
 * or the block sits, in whole pixels of the frame's visible area. The observer only listens: it cancels nothing and
 * stops nothing, so the page's own click and selection handlers work as before.
 */
export const observer = `(() => {
  const send = globalThis[${JSON.stringify(binding)}]
  if (typeof send !== "function") return
  const reading = ${reading.toString()}
  const report = (kind, id) => send(JSON.stringify({ kind, id }))
  const within = (value) => Math.max(-${farthest}, Math.min(${farthest}, Math.round(value)))
  const size = (value) => Math.max(0, Math.min(${farthest}, Math.round(value)))
  // A new document starts at its top, which the view takes for granted: the scroll is reported once it moves.
  const state = { last: undefined, marks: "[]", scroll: "0,0", frame: 0 }
  const read = () => {
    state.frame = 0
    const page = document.scrollingElement ?? document.documentElement
    if (page) {
      const x = within(page.scrollLeft)
      const y = within(page.scrollTop)
      const at = x + "," + y
      if (at !== state.scroll) {
        state.scroll = at
        send(JSON.stringify({ kind: "scroll", x, y }))
      }
    }
    const headings = [...document.querySelectorAll("h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]")]
    const index = reading(headings.map((heading) => heading.getBoundingClientRect().top), innerHeight)
    const id = index < 0 ? undefined : headings[index].id
    if (id !== undefined && id !== state.last) {
      state.last = id
      report("heading", id)
    }
    const items = [...document.querySelectorAll("mark[data-dynwork-comment][id]")]
      .map((mark) => ({
        id: mark.getAttribute("data-dynwork-comment"),
        top: Math.max(-${farthest}, Math.min(${farthest}, Math.round(mark.getBoundingClientRect().top))),
      }))
      .filter((item) => item.id && item.id.length <= 256)
      .slice(0, ${maxMarks})
    const marks = JSON.stringify(items)
    if (marks === state.marks) return
    state.marks = marks
    send(JSON.stringify({ kind: "marks", items }))
  }
  const later = () => {
    if (!state.frame) state.frame = requestAnimationFrame(read)
  }
  addEventListener("scroll", later, { capture: true, passive: true })
  addEventListener("resize", later)
  addEventListener("load", later)
  document.addEventListener("DOMContentLoaded", later)
  later()
  const pick = (block, quote, at) => {
    const index = Number(block.getAttribute("data-dynwork-block"))
    if (!Number.isInteger(index) || index < 0 || index > ${maxBlocks}) return
    const rect = { left: within(at.left), top: within(at.top), width: size(at.width), height: size(at.height) }
    send(JSON.stringify(quote ? { kind: "pick", block: index, quote, rect } : { kind: "pick", block: index, rect }))
  }
  const blockOf = (node) => (node instanceof Element ? node : node?.parentElement)?.closest("[data-dynwork-block]")
  // A selection is read on the click that ends it, not on mouseup: Chromium sends that click after the mouseup has
  // settled the selection (a click inside one clears it first), to the elements' common ancestor after a drag, so no
  // timer is needed, and a frame's timers may not run while its window is hidden.
  const selected = () => {
    const selection = document.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false
    const range = selection.getRangeAt(0)
    const block = blockOf(range.startContainer)
    if (!block) return true
    // A selection that crosses blocks is the part of its first one.
    const part = range.cloneRange()
    if (!block.contains(range.endContainer)) part.setEnd(block, block.childNodes.length)
    const quote = part
      .toString()
      .replace(/\\s+/g, " ")
      .trim()
      .slice(0, ${maxQuote})
      .replace(/[\\ud800-\\udbff]$/, "")
    if (quote) pick(block, quote, part.getBoundingClientRect())
    return true
  }
  document.addEventListener(
    "click",
    (event) => {
      if (!event.isTrusted || !(event.target instanceof Element)) return
      if (event.target.closest(${JSON.stringify(controls)})) return
      if (selected()) return
      const id = event.target.closest("mark[data-dynwork-comment]")?.getAttribute("data-dynwork-comment")
      if (id) return report("mark", id)
      const block = event.target.closest("[data-dynwork-block]")
      if (block) pick(block, undefined, block.getBoundingClientRect())
    },
    true,
  )
})()`

/**
 * The script main adds once for the next document of a viewer frame whose page the view loads again (a comment added or
 * resolved, the marks shown or hidden): it puts that document where the reader left the previous one, before it is
 * drawn. `x` and `y` are where the previous one was scrolled, as its observer reported it; anything but whole numbers
 * within `farthest` makes no script. It runs in `world` of the viewer frame alone, not in a frame of the page, scrolls
 * the document's own scroller when the document is parsed, and again once it has loaded, unless the reader moved
 * meanwhile: what loads late (images, fonts) may have made the page taller than it was when parsed.
 */
export function restorer(x: number, y: number) {
  if (![x, y].every((value) => Number.isInteger(value) && Math.abs(value) <= farthest)) return undefined
  return `(() => {
  if (parent !== top) return
  const page = () => document.scrollingElement ?? document.documentElement
  const set = { x: undefined, y: undefined }
  const put = () => {
    const element = page()
    if (!element) return
    element.scrollTo(${x}, ${y})
    set.x = element.scrollLeft
    set.y = element.scrollTop
  }
  document.addEventListener("DOMContentLoaded", put, { once: true })
  addEventListener(
    "load",
    () => {
      const element = page()
      if (element && element.scrollLeft === set.x && element.scrollTop === set.y) put()
    },
    { once: true },
  )
})()`
}
