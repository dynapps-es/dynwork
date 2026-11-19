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
// mark they clicked, and where each thread's first mark sits, for the comments' bubbles beside the frame. The frame is sandboxed without DynWork's origin, so the app cannot read it, and the page
// may be an agent's, with scripts: nothing of DynWork is exposed to it. Main runs `observer` in an isolated world of the
// frame, which the page's scripts can neither see nor reach, and it reports through a binding that exists only in that
// world. The report is ids and numbers, each id checked by the viewer against the ones it gave the page.

/** The isolated world main's observer runs in. */
export const world = "dynwork-drive"

/** The function main's observer reports through: it exists in `world` only. */
export const binding = "dynworkDriveFrame"

/** How many marks a report places at most: the first ones of the page. */
export const maxMarks = 100

/** How far from the visible area a report places a mark, in pixels either way: farther is as far. */
export const farthest = 1_000_000

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
 */
export const observer = `(() => {
  const send = globalThis[${JSON.stringify(binding)}]
  if (typeof send !== "function") return
  const reading = ${reading.toString()}
  const report = (kind, id) => send(JSON.stringify({ kind, id }))
  const state = { last: undefined, marks: "[]", frame: 0 }
  const read = () => {
    state.frame = 0
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
  document.addEventListener(
    "click",
    (event) => {
      if (!event.isTrusted || !(event.target instanceof Element)) return
      const id = event.target.closest("mark[data-dynwork-comment]")?.getAttribute("data-dynwork-comment")
      if (id) report("mark", id)
    },
    true,
  )
})()`
