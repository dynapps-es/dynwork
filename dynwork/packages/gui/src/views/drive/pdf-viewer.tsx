import { usePlugin } from "@opencode/plugin/gui"
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist"
import type { TextLayer } from "pdfjs-dist/types/src/display/text_layer"
import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import type { Document } from "../../drive/contract"
import { clampPage, pagesNear, pdfSource, scaleOf, zoomIn, zoomLevels, zoomOut, type Zoom } from "./pdf"
import { exportPdf } from "./row-menu"

// DynWork's own PDF viewer, loaded with pdf.js only when a PDF opens (`viewer.tsx` imports it lazily). pdf.js reads the
// bytes the `pdf` Ipc gave, with nothing fetched and no PDF JavaScript (`pdfSource`); pages draw to canvases, only near
// the view, at the screen's pixel ratio, with a text layer to select and copy from. Pages stay as the PDF draws them,
// white in a dark theme too; the chrome follows the theme.

type Size = { readonly width: number; readonly height: number }

// The room around the pages, in CSS pixels, which `fit` leaves free.
const gutter = 48

export default function PdfViewer(props: { doc: Document; bytes: Uint8Array }) {
  const ctx = usePlugin()
  const [opened] = createResource(
    () => props.bytes,
    (bytes) => open(bytes).catch(() => undefined),
  )
  createEffect(() => {
    const current = opened()
    if (current) onCleanup(() => void current.task.destroy())
  })

  let scroller: HTMLDivElement | undefined
  const pages: HTMLElement[] = []
  const [room, setRoom] = createSignal(0)
  const [zoom, setZoom] = createSignal<Zoom>("fit")
  const [visible, setVisible] = createSignal<ReadonlySet<number>>(new Set())
  const [current, setCurrent] = createSignal(1)
  const count = () => opened()?.sizes.length ?? 0
  const widest = () => Math.max(1, ...(opened()?.sizes.map((size) => size.width) ?? []))
  const scale = createMemo(() => scaleOf(zoom(), widest(), room()))
  const near = createMemo(() => new Set(pagesNear(visible(), count())))

  // Which pages are in view, and the one that shows most is the current page.
  const ratios = new Map<number, number>()
  let observer: IntersectionObserver | undefined
  onMount(() => {
    if (!scroller) return
    const sizer = new ResizeObserver(() => setRoom(Math.max(0, (scroller?.clientWidth ?? 0) - gutter)))
    sizer.observe(scroller)
    observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => ratios.set(Number(entry.target.getAttribute("data-page")), entry.intersectionRatio))
        const shown = [...ratios].filter((item) => item[1] > 0)
        setVisible(new Set(shown.map((item) => item[0])))
        const most = shown.reduce((best, item) => (item[1] > best[1] ? item : best), [current(), 0])
        if (most[1] > 0) setCurrent(most[0])
      },
      { root: scroller, threshold: [0, 0.25, 0.5, 0.75, 1] },
    )
    pages.forEach((page) => observer?.observe(page))
    onCleanup(() => {
      sizer.disconnect()
      observer?.disconnect()
    })
  })
  const track = (page: HTMLElement) => {
    pages.push(page)
    observer?.observe(page)
    onCleanup(() => {
      observer?.unobserve(page)
      pages.splice(pages.indexOf(page), 1)
      ratios.delete(Number(page.getAttribute("data-page")))
    })
  }

  // A zoom keeps the place in the document: the same share of it stays at the top.
  let place = 0
  createEffect(
    on(
      scale,
      () =>
        requestAnimationFrame(() => {
          if (scroller) scroller.scrollTop = place * scroller.scrollHeight
        }),
      { defer: true },
    ),
  )

  const goTo = (page: number) => {
    const target = clampPage(page, count())
    pages.find((item) => item.getAttribute("data-page") === String(target))?.scrollIntoView({ block: "start" })
    setCurrent(target)
  }
  const percent = (value: number) => new Intl.NumberFormat(ctx.locale.locale(), { style: "percent" }).format(value)
  const zoomLabel = () => {
    const value = zoom()
    return value === "fit" ? ctx.t("drive.pdf.fit") : percent(value)
  }
  const keys = (event: KeyboardEvent) => {
    const act = (run: () => void) => {
      event.preventDefault()
      run()
    }
    if (event.metaKey || event.ctrlKey) {
      if (event.key === "+" || event.key === "=") return act(() => setZoom(zoomIn(scale())))
      if (event.key === "-") return act(() => setZoom(zoomOut(scale())))
      if (event.key === "0") return act(() => setZoom("fit"))
      return
    }
    if (event.key === "ArrowRight" || event.key === "PageDown") return act(() => goTo(current() + 1))
    if (event.key === "ArrowLeft" || event.key === "PageUp") return act(() => goTo(current() - 1))
  }

  return (
    <div data-component="drive-pdf" tabIndex={0} aria-label={props.doc.name} onKeyDown={keys}>
      <div data-slot="drive-pdf-bar">
        <ctx.ui.Tooltip value={ctx.t("drive.pdf.previous")}>
          <ctx.ui.IconButton
            icon="chevron-left"
            size="small"
            label={ctx.t("drive.pdf.previous")}
            disabled={current() <= 1}
            onClick={() => goTo(current() - 1)}
          />
        </ctx.ui.Tooltip>
        <span data-slot="drive-pdf-pages">
          {ctx.t("drive.pdf.page", { page: String(current()), count: String(count() || "…") })}
        </span>
        <ctx.ui.Tooltip value={ctx.t("drive.pdf.next")}>
          <ctx.ui.IconButton
            icon="chevron-right"
            size="small"
            label={ctx.t("drive.pdf.next")}
            disabled={current() >= count()}
            onClick={() => goTo(current() + 1)}
          />
        </ctx.ui.Tooltip>
        <span data-slot="drive-grow" />
        <ctx.ui.Tooltip value={ctx.t("drive.pdf.out")}>
          <ctx.ui.IconButton
            icon="outline-magnifier-minus"
            size="small"
            label={ctx.t("drive.pdf.out")}
            onClick={() => setZoom(zoomOut(scale()))}
          />
        </ctx.ui.Tooltip>
        <ctx.ui.Menu
          label={zoomLabel()}
          trigger="button"
          placement="bottom-end"
          items={[
            { label: ctx.t("drive.pdf.fit"), onSelect: () => setZoom("fit") },
            { type: "separator" },
            ...zoomLevels.map((level) => ({ label: percent(level), onSelect: () => setZoom(level) })),
          ]}
        />
        <ctx.ui.Tooltip value={ctx.t("drive.pdf.in")}>
          <ctx.ui.IconButton
            icon="outline-magnifier-plus"
            size="small"
            label={ctx.t("drive.pdf.in")}
            onClick={() => setZoom(zoomIn(scale()))}
          />
        </ctx.ui.Tooltip>
        <ctx.ui.Tooltip value={ctx.t("drive.pdf.download")}>
          <ctx.ui.IconButton
            icon="arrow-down-to-line"
            size="small"
            label={ctx.t("drive.pdf.download")}
            onClick={() => void exportPdf(ctx, props.doc)}
          />
        </ctx.ui.Tooltip>
      </div>
      <div
        data-slot="drive-pdf-scroll"
        ref={scroller}
        onScroll={() => {
          if (scroller) place = scroller.scrollTop / Math.max(1, scroller.scrollHeight)
        }}
      >
        <Show
          when={opened()}
          fallback={<p data-slot="drive-note">{ctx.t(opened.loading ? "drive.loading" : "drive.pdf.failed")}</p>}
        >
          {(found) => (
            <For each={found().sizes}>
              {(size, index) => (
                <Page
                  doc={found().doc}
                  number={index() + 1}
                  size={size}
                  scale={scale()}
                  drawn={near().has(index() + 1)}
                  ref={track}
                />
              )}
            </For>
          )}
        </Show>
      </div>
    </div>
  )
}

/** One page: its place at the zoom's size always, its canvas and text layer only while it is near the view. */
function Page(props: {
  doc: PDFDocumentProxy
  number: number
  size: Size
  scale: number
  drawn: boolean
  ref: (page: HTMLElement) => void
}) {
  let canvas: HTMLCanvasElement | undefined
  let text: HTMLDivElement | undefined
  // Only a change of these draws again; the window of pages is a new object at every scroll.
  const drawn = createMemo(() => props.drawn)
  const zoom = createMemo(() => props.scale)
  createEffect(() => {
    if (!canvas || !text) return
    const layer = text
    const target = canvas
    if (!drawn()) {
      target.width = 0
      target.height = 0
      layer.replaceChildren()
      return
    }
    const scale = zoom()
    const state: { task?: RenderTask; text?: TextLayer; cancelled: boolean } = { cancelled: false }
    void draw(props.doc, props.number, scale, target, layer, state)
    onCleanup(() => {
      state.cancelled = true
      state.task?.cancel()
      state.text?.cancel()
    })
  })
  return (
    <div
      data-slot="drive-pdf-page"
      data-page={props.number}
      ref={props.ref}
      style={{
        width: `${props.size.width * props.scale}px`,
        height: `${props.size.height * props.scale}px`,
        "--total-scale-factor": String(props.scale),
        "--scale-round-x": "1px",
        "--scale-round-y": "1px",
      }}
    >
      <canvas ref={canvas} />
      <div ref={text} data-slot="drive-pdf-texts" />
    </div>
  )
}

/** Draws a page at `scale` and the screen's pixel ratio, then its text layer, unless `state` is cancelled meanwhile. */
async function draw(
  doc: PDFDocumentProxy,
  number: number,
  scale: number,
  canvas: HTMLCanvasElement,
  layer: HTMLDivElement,
  state: { task?: RenderTask; text?: TextLayer; cancelled: boolean },
) {
  const page = await doc.getPage(number)
  if (state.cancelled) return
  const viewport = page.getViewport({ scale })
  const ratio = window.devicePixelRatio || 1
  canvas.width = Math.floor(viewport.width * ratio)
  canvas.height = Math.floor(viewport.height * ratio)
  state.task = page.render({ canvas, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] })
  const drawn = await state.task.promise.then(
    () => true,
    () => false,
  )
  if (!drawn || state.cancelled) return
  const { TextLayer } = await import("pdfjs-dist")
  if (state.cancelled) return
  // Built off the document, then put in at once: pdf.js measures each run of text while it adds it, and in the app's
  // large document every measure after a change recomputes its styles (a page took seconds instead of milliseconds).
  const built = document.createElement("div")
  built.setAttribute("data-slot", "drive-pdf-text")
  state.text = new TextLayer({ textContentSource: page.streamTextContent(), container: built, viewport })
  const shown = await state.text.render().then(
    () => true,
    () => false,
  )
  if (shown && !state.cancelled) layer.replaceChildren(built)
}

/** Opens a PDF with pdf.js and reads every page's size, for the pages' places before they draw. */
async function open(bytes: Uint8Array) {
  const { getDocument, GlobalWorkerOptions } = await import("pdfjs-dist")
  // Vite bundles the worker with the app and serves it from the app's own origin; nothing comes from a CDN.
  const { default: worker } = await import("pdfjs-dist/build/pdf.worker.min.mjs?url")
  GlobalWorkerOptions.workerSrc = worker
  const task = getDocument(pdfSource(bytes))
  const doc = await task.promise
  const sizes = await Promise.all(
    Array.from({ length: doc.numPages }, (_, index) =>
      doc.getPage(index + 1).then((page) => {
        const viewport = page.getViewport({ scale: 1 })
        return { width: viewport.width, height: viewport.height } satisfies Size
      }),
    ),
  )
  return { doc, sizes, task }
}
