import type { DocumentInitParameters } from "pdfjs-dist/types/src/display/api"

// The PDF viewer's arithmetic and pdf.js's options, apart from the component, which loads pdf.js only when a PDF opens.

/** The zoom levels the menu lists and the buttons step through. */
export const zoomLevels = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const

/** A zoom: a scale, or `fit`, the width of the widest page in the room there is (the default). */
export type Zoom = number | "fit"

const min = zoomLevels[0]
const max = zoomLevels[zoomLevels.length - 1]
// Two scales this close are the same level, so a fitted 1.2499 steps to 1.5 and not to 1.25.
const near = 0.01

/** The next level above `scale`, or the largest. */
export function zoomIn(scale: number) {
  return zoomLevels.find((level) => level > scale + near) ?? max
}

/** The next level below `scale`, or the smallest. */
export function zoomOut(scale: number) {
  return zoomLevels.findLast((level) => level < scale - near) ?? min
}

/** The scale at which a page `width` points wide fills `room` CSS pixels, within the zoom levels' range. */
export function fitWidth(width: number, room: number) {
  if (width <= 0 || room <= 0) return 1
  return Math.min(max, Math.max(min, room / width))
}

/** The scale a zoom stands for, with the page width and the room `fit` needs. */
export function scaleOf(zoom: Zoom, width: number, room: number) {
  return zoom === "fit" ? fitWidth(width, room) : zoom
}

/**
 * The pages to draw: those in view and `around` on each side, as 1-based page numbers in order. Pages outside are left
 * blank, so a long PDF holds only a few canvases.
 */
export function pagesNear(visible: Iterable<number>, count: number, around = 1) {
  const shown = [...visible].filter((page) => page >= 1 && page <= count)
  if (shown.length === 0) return count > 0 ? [1] : []
  const from = Math.max(1, Math.min(...shown) - around)
  const to = Math.min(count, Math.max(...shown) + around)
  return Array.from({ length: to - from + 1 }, (_, index) => from + index)
}

/** A page number within the document. */
export function clampPage(page: number, count: number) {
  return Math.min(Math.max(1, Math.round(page)), Math.max(1, count))
}

/**
 * How pdf.js opens a PDF here: from its bytes, with nothing fetched. No URL, no worker fetch, and no font, CMap or
 * decoder URL, so the PDF reaches no network; XFA forms are off. pdf.js's core API runs no PDF JavaScript (that is the
 * viewer's scripting sandbox, not used here), and pdf.js 6 no longer compiles fonts with `eval`.
 */
export function pdfSource(bytes: Uint8Array): DocumentInitParameters {
  return {
    // pdf.js takes the buffer over to its worker: a copy keeps the caller's bytes usable.
    data: bytes.slice(),
    useWorkerFetch: false,
    enableXfa: false,
    stopAtErrors: false,
  }
}
