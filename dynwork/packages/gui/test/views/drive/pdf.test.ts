import { describe, expect, test } from "bun:test"
import {
  clampPage,
  fitWidth,
  pagesNear,
  pdfSource,
  scaleOf,
  zoomIn,
  zoomLevels,
  zoomOut,
} from "../../../src/views/drive/pdf"

// A real PDF, small enough to write by hand: one line of Helvetica text per page, 200 × 100 points each.
function tinyPdf(pages: readonly string[]) {
  const font = 3 + pages.length * 2
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${3 + index * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    ...pages.flatMap((line, index) => {
      const stream = `BT /F1 12 Tf 20 50 Td (${line}) Tj ET`
      return [
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents ${4 + index * 2} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`,
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      ]
    }),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  const body = objects.reduce(
    (built, object, index) => ({
      text: `${built.text}${index + 1} 0 obj\n${object}\nendobj\n`,
      offsets: [...built.offsets, built.text.length],
    }),
    { text: "%PDF-1.4\n", offsets: [] as number[] },
  )
  const xref = [
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`,
    ...body.offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`),
  ].join("")
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${body.text.length}\n%%EOF\n`
  return new TextEncoder().encode(body.text + xref + trailer)
}

describe("the PDF viewer's zoom", () => {
  test("the buttons step through the menu's levels, and stop at both ends", () => {
    expect(zoomIn(1)).toBe(1.25)
    expect(zoomOut(1)).toBe(0.75)
    expect(zoomIn(3)).toBe(3)
    expect(zoomOut(0.5)).toBe(0.5)
    expect(zoomLevels.reduce<number[]>((seen) => [...seen, zoomIn(seen.at(-1) ?? 0.5)], [0.5])).toEqual([
      0.5, 0.75, 1, 1.25, 1.5, 2, 3, 3,
    ])
  })

  test("from a fitted scale, a step goes to the next level, never to one it almost is", () => {
    expect(zoomIn(1.2499)).toBe(1.5)
    expect(zoomIn(1.1)).toBe(1.25)
    expect(zoomOut(1.2501)).toBe(1)
    expect(zoomOut(1.3)).toBe(1.25)
  })

  test("fit width fills the room with the widest page, within the levels' range", () => {
    expect(fitWidth(600, 900)).toBe(1.5)
    expect(fitWidth(595, 400)).toBeCloseTo(0.672, 3)
    expect(fitWidth(100, 1000)).toBe(3)
    expect(fitWidth(2000, 100)).toBe(0.5)
    expect(fitWidth(600, 0)).toBe(1)
    expect(scaleOf("fit", 600, 900)).toBe(1.5)
    expect(scaleOf(2, 600, 900)).toBe(2)
  })
})

describe("the pages the viewer draws", () => {
  test("those in view and one on each side, within the document", () => {
    expect(pagesNear([4, 5], 10)).toEqual([3, 4, 5, 6])
    expect(pagesNear([1], 10)).toEqual([1, 2])
    expect(pagesNear([10], 10)).toEqual([9, 10])
    expect(pagesNear(new Set([7]), 10, 2)).toEqual([5, 6, 7, 8, 9])
  })

  test("before anything is in view, the first page; none in an empty document", () => {
    expect(pagesNear([], 10)).toEqual([1])
    expect(pagesNear([], 0)).toEqual([])
    expect(pagesNear([12], 3)).toEqual([1])
  })

  test("a page to go to stays within the document", () => {
    expect([clampPage(0, 5), clampPage(3, 5), clampPage(9, 5), clampPage(2.6, 5), clampPage(1, 0)]).toEqual([
      1, 3, 5, 3, 1,
    ])
  })
})

describe("pdf.js over a PDF's bytes", () => {
  test("opens from the bytes alone: no URL, no fetch from the worker, no font, CMap or decoder URL, no XFA", () => {
    const bytes = tinyPdf(["One"])
    const source = pdfSource(bytes)
    expect(source.url).toBeUndefined()
    expect(source.useWorkerFetch).toBe(false)
    expect(source.enableXfa).toBe(false)
    expect([source.cMapUrl, source.standardFontDataUrl, source.wasmUrl]).toEqual([undefined, undefined, undefined])
    // A copy: pdf.js takes its buffer over to the worker, and the caller keeps its own
    expect(source.data).not.toBe(bytes)
    expect(source.data).toEqual(bytes)
  })

  // Canvas drawing cannot run here: happy-dom's canvas has no 2D context, so the pages' pixels are checked in the app.
  test("a real PDF opens with those options: its pages, their size and their text", async () => {
    const { getDocument, GlobalWorkerOptions } = await import("pdfjs-dist")
    GlobalWorkerOptions.workerSrc = import.meta.resolve("pdfjs-dist/build/pdf.worker.mjs")
    const task = getDocument(pdfSource(tinyPdf(["Hello one", "Hello two"])))
    const doc = await task.promise
    const page = await doc.getPage(2)
    const viewport = page.getViewport({ scale: 1.5 })
    const text = await page.getTextContent()
    expect(doc.numPages).toBe(2)
    expect([viewport.width, viewport.height]).toEqual([300, 150])
    expect(text.items.flatMap((item) => ("str" in item ? [item.str] : []))).toEqual(["Hello two"])
    await task.destroy()
  })
})
