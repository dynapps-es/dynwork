import { usePlugin, type IpcClient, type Live } from "@opencode/plugin/gui"
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  lazy,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  untrack,
  type Accessor,
} from "solid-js"
import { isServer } from "solid-js/web"
import type { DriveClient } from "../../drive/client"
import {
  isFailure,
  type Content,
  type Document,
  type Failure,
  type Frames,
  type Page,
  type Seen,
} from "../../drive/contract"
import { DriveFrames } from "../../drive/frames"
import { CommentBubbles } from "./comments"
import { markPage } from "./marks"
import { framed, holds, isPdf, marked, type Node, type Placed, type Thread } from "./model"
import { anchorPage, markdownHeadings, renderedHeading, type Heading } from "./outline"
import { panes } from "./panes"
import { failureText } from "./parts"
import type { Spot } from "./spot"
import { drive } from "./store"

// A document as its format is read, in the Drive view's workspace and in a chat's side panel (D5, D6):
// - HTML as designed (`/rendered`), in a sandboxed frame that mirrors the policy the instance served it with.
// - Markdown from its source (`/content`), with the app's own Markdown renderer, as the timeline draws a message.
// - A PDF from its stored bytes (`/content`), in DynWork's own viewer over pdf.js (`pdf-viewer.tsx`, loaded when a PDF
//   opens): no frame, no `blob:` URL, no PDF JavaScript and no network. The instance keeps an uploaded PDF as a `file`
//   typed `application/pdf`, which it does not render to PDF again (`?format=pdf` is for its own formats).
// - Word, Excel and PowerPoint as the Drive previews them (`/preview`), in the same frame as HTML, which that preview's
//   policy keeps without scripts.
// The account's JWT stays in main: a frame gets only the page, never DynWork's origin, cookies, token or Ipc.
// Nothing that comes out of a frame is trusted (G11): an agent writes these pages, so the viewer listens to no
// `message` event and reads no `postMessage`. What the viewer learns of an HTML frame, the heading being read, a
// comment mark clicked, where the marks sit and what the user picked to comment on, comes from main's observer in an
// isolated world of the frame (`drive/frames.ts`, `drive/watch.ts`), as ids and numbers the viewer checks against the
// ones it gave the page, and a quote it checks against the node's text (`fromFrame`).
// The open comments of an HTML document at its head are marked on the page (`marks.ts`) while the user shows them, and
// of Markdown by `CommentMarks`; either way a bubble beside the document names who wrote each, in a column of the app's
// own, outside the frame (`CommentBubbles`): no name, picture or text of a comment ever goes into the page.

// pdf.js and the viewer load on the client only, when a PDF opens; the tests render with Solid's server build.
const PdfViewer = lazy(() => import("./pdf-viewer"))

/** What a viewer shows: a page for a frame, a Markdown source, or a PDF's bytes for pdf.js. */
export type Shown =
  | { readonly kind: "page"; readonly page: Page }
  | { readonly kind: "markdown"; readonly text: string; readonly revision?: string }
  | { readonly kind: "pdf"; readonly pdf: Content }

/** Reads a document the way its format is viewed, at `revision` or at its head. */
export async function load(
  client: DriveClient.Client,
  doc: Pick<Document, "id" | "format" | "mime">,
  revision?: string,
): Promise<Shown | Failure> {
  if (isPdf(doc)) {
    const pdf = await client.content({ id: doc.id, revision })
    return isFailure(pdf) ? pdf : { kind: "pdf", pdf }
  }
  if (doc.format === "markdown") {
    const source = await client.content({ id: doc.id, revision })
    if (isFailure(source)) return source
    return { kind: "markdown", text: new TextDecoder("utf-8").decode(source.bytes), revision: source.revision }
  }
  if (doc.format === "html") {
    const page = await client.rendered({ id: doc.id, revision })
    if (!isFailure(page)) return { kind: "page", page }
    // An instance without `/rendered` (before 0.83) still previews the page, without its scripts.
    if (page.code !== "unsupported" && page.code !== "not-found") return page
  }
  const page = await client.preview({ id: doc.id, revision })
  return isFailure(page) ? page : { kind: "page", page }
}

/**
 * What a viewer tells of its document: its headings, the one being read, a jump to one of them, and to a comment's
 * mark.
 */
export interface Outline {
  readonly headings: readonly Heading[]
  /** The heading being read, by index; undefined until the viewer knows. */
  active(): number | undefined
  go(index: number): void
  /** Brings a thread's mark into view; nothing when the document shows none for it. */
  reveal(thread: string): void
}

// The window's observer of its frames, handed over by the window entry as the Drive's client is (`register.tsx`).
type FramesClient = IpcClient<(typeof Frames)["spec"]>
const [watching, setWatching] = createSignal<Accessor<Live<FramesClient>>>()

/** Makes `live` the frames' observer until the current owner is disposed. */
export function attachFrames(live: Accessor<Live<FramesClient>>) {
  setWatching(() => live)
  onCleanup(() => {
    if (watching() === live) setWatching(undefined)
  })
}

const observer = () => {
  const live = watching()?.()
  return live?.status === "active" ? live.value : undefined
}

/**
 * Present: a document alone, with the window full screen. The view puts `target`, the element that holds the viewer,
 * over the whole window (`data-presenting`, in the top layer) while main holds the window full screen
 * (`Frames.present`): a page cannot take its window full screen itself (`drive/present.ts`). Exit over the document, Escape anywhere in the window, or the
 * window leaving full screen brings the view back as it was.
 */
export function createPresent(target: () => HTMLElement | undefined) {
  const [on, setOn] = createSignal(false)
  const held = { call: undefined as AbortController | undefined }
  const stop = () => {
    held.call?.abort()
    held.call = undefined
    setOn(false)
  }
  // The element goes to the top layer (a manual popover): over the whole window whatever contains it, and still in its
  // place in the page, so a frame inside does not load again.
  createEffect(() => {
    const element = target()
    if (!element) return
    element.toggleAttribute("data-presenting", on())
    if (on()) {
      element.setAttribute("popover", "manual")
      return element.showPopover()
    }
    if (element.matches(":popover-open")) element.hidePopover()
    element.removeAttribute("popover")
  })
  // Main ends it on Escape before any page sees the key; this also ends it for a key the window alone receives.
  createEffect(() => {
    if (!on()) return
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") stop()
    }
    document.addEventListener("keydown", key)
    onCleanup(() => document.removeEventListener("keydown", key))
  })
  onCleanup(stop)
  return {
    on,
    start: () => {
      const client = observer()
      if (!client || held.call) return
      const call = new AbortController()
      held.call = call
      setOn(true)
      void client
        .present({ signal: call.signal })
        .catch(() => undefined)
        .finally(() => {
          if (held.call !== call) return
          held.call = undefined
          setOn(false)
        })
    },
    stop,
  }
}
export type Present = ReturnType<typeof createPresent>

/**
 * What a report of main's observer means for the frame shown: a heading of its index, a thread it marked, where its
 * marked threads sit, or a pick of one of the blocks it numbered (`blocks`, the node of each), with the quote picked in
 * it. Anything else is dropped: another frame's report, an id or a block the viewer did not give this page, a quote the
 * node does not hold (a script may change what the page shows; the comment still anchors to the document's own text).
 */
export function fromFrame(
  seen: Seen,
  shown: {
    readonly name: string
    readonly headings: readonly Heading[]
    readonly marks: Readonly<Record<string, string>>
    readonly blocks?: readonly Node[]
  },
) {
  if (seen.frame !== shown.name) return undefined
  if (seen.kind === "pick") {
    const node = Number.isInteger(seen.block) && seen.block >= 0 ? shown.blocks?.[seen.block] : undefined
    if (!node || (seen.quote !== undefined && !holds(node, seen.quote))) return undefined
    return { kind: "pick" as const, node, quote: seen.quote, rect: seen.rect }
  }
  if (seen.kind === "marks")
    return {
      kind: "marks" as const,
      placed: seen.items
        .filter((item) => Object.hasOwn(shown.marks, item.id))
        .map((item): Placed => ({ thread: item.id, top: item.top })),
    }
  if (seen.kind === "mark")
    return Object.hasOwn(shown.marks, seen.id) ? { kind: "mark" as const, thread: seen.id } : undefined
  const index = shown.headings.findIndex((heading) => heading.id === seen.id)
  return index < 0 ? undefined : { kind: "heading" as const, index }
}

// The formats whose headings make an index: an HTML page, Markdown, and Word as the Drive previews it. A sheet's or a
// slide deck's preview has no reading order to index, and a PDF's viewer draws pages, not headings.
const outlined = ["html", "markdown", "docx"]

/**
 * A document's viewer. It reads again when the document gets a new head, or when the tab picks another version. With
 * `onOutline` it tells the outline of what it shows, and undefined when it shows nothing that has one; with `onMark`,
 * which thread's mark the user clicked on an HTML page; with `onSpot`, what the user selected or clicked on one to
 * comment on (Markdown's come from `CommentMarks`).
 */
export function Viewer(props: {
  doc: Document
  revision?: string
  onOutline?: (outline: Outline | undefined) => void
  onMark?: (thread: string) => void
  onSpot?: (spot: Spot) => void
}) {
  const ctx = usePlugin()
  // A snapshot or a listing hands over a new document object for the same document: only these fields read again.
  const source = createMemo(
    () => {
      const client = drive.client()
      if (!client) return undefined
      return {
        client,
        id: props.doc.id,
        format: props.doc.format,
        mime: props.doc.mime,
        head: props.doc.revision,
        revision: props.revision,
      }
    },
    undefined,
    {
      equals: (a, b) =>
        a?.client === b?.client &&
        a?.id === b?.id &&
        a?.format === b?.format &&
        a?.mime === b?.mime &&
        a?.head === b?.head &&
        a?.revision === b?.revision,
    },
  )
  const [shown] = createResource(source, (input) => load(input.client, input, input.revision))
  const failed = () => {
    const answer = shown()
    return answer && isFailure(answer) ? answer : undefined
  }
  const ready = () => {
    const answer = shown()
    return answer && !isFailure(answer) ? answer : undefined
  }
  const page = () => {
    const answer = ready()
    return answer?.kind === "page" ? answer.page : undefined
  }
  const markdown = () => {
    const answer = ready()
    // The answer, not its text: an empty document is still one to show
    return answer?.kind === "markdown" ? answer : undefined
  }
  const pdf = () => {
    const answer = ready()
    return answer?.kind === "pdf" ? answer.pdf : undefined
  }
  const onOutline = () => (outlined.includes(props.doc.format) ? props.onOutline : undefined)
  // An HTML document's head shows its open comments, while the user shows them: an older version has other nodes.
  const marks = () => {
    if (props.revision !== undefined || props.doc.format !== "html" || !panes.marks()) return undefined
    return { nodes: drive.nodesOf(props.doc.id), threads: drive.threadsOf(props.doc.id) }
  }
  // Where the open threads' marks sit, as the frame's observer or the Markdown's layout tells; bubbles beside them while
  // the marks show, at the head.
  const [placed, setPlaced] = createSignal<readonly Placed[]>([])
  const bubbles = () =>
    props.revision === undefined &&
    marked(props.doc) &&
    panes.marks() &&
    drive.threadsOf(props.doc.id).some((thread) => thread.open)
  return (
    <div data-slot="drive-sheet">
      <Switch fallback={<p data-slot="drive-note">{ctx.t("drive.loading")}</p>}>
        <Match when={failed()}>
          {(failure) => (
            <p data-slot="drive-note">
              {ctx.t("drive.preview.failed")} {failureText(ctx, failure())}
            </p>
          )}
        </Match>
        <Match when={page()}>
          {(found) => (
            <PageFrame
              page={found()}
              title={props.doc.name}
              marks={marks()}
              onOutline={onOutline()}
              onMark={props.onMark}
              onSpot={props.onSpot}
              onPlaced={setPlaced}
            />
          )}
        </Match>
        <Match when={markdown()}>
          {(found) => (
            <MarkdownDoc doc={props.doc.id} text={found().text} onOutline={onOutline()} onPlaced={setPlaced} />
          )}
        </Match>
        <Match when={!isServer && pdf()}>{(found) => <PdfViewer doc={props.doc} bytes={found().bytes} />}</Match>
      </Switch>
      <Show when={bubbles()}>
        <CommentBubbles doc={props.doc} placed={placed()} onThread={(thread) => props.onMark?.(thread)} />
      </Show>
    </div>
  )
}

/**
 * A Markdown document, drawn by the app's renderer. Its outline scrolls to a heading as rendered, follows the heading
 * being read as the document scrolls, and brings a comment's block into view (`CommentMarks` names each block's node);
 * `onPlaced` hears where each open thread's block sits, as the document scrolls.
 */
function MarkdownDoc(props: {
  doc: string
  text: string
  onOutline?: (outline: Outline | undefined) => void
  onPlaced?: (placed: readonly Placed[]) => void
}) {
  const ctx = usePlugin()
  let element: HTMLDivElement | undefined
  const headings = createMemo(() => markdownHeadings(props.text))
  const [active, setActive] = createSignal<number>()
  // The rendered element of each heading of the source, where the renderer drew one.
  const rendered = (list: readonly Heading[]) => {
    const drawn = [...(element?.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6") ?? [])].map((heading) => ({
      text: heading.textContent ?? "",
      element: heading,
    }))
    return list.map((_, index) => renderedHeading(drawn, list, index))
  }
  const measure = () => {
    frame.id = 0
    if (!element) return
    const top = element.getBoundingClientRect().top
    const index = DriveFrames.reading(
      rendered(headings()).map((heading) => (heading ? heading.getBoundingClientRect().top - top : Infinity)),
      element.clientHeight,
    )
    setActive(index < 0 ? undefined : index)
    props.onPlaced?.(
      drive
        .threadsOf(props.doc)
        .filter((thread) => thread.open)
        .flatMap((thread) => {
          const block = element?.querySelector(`[data-node="${CSS.escape(thread.node)}"]`)
          return block ? [{ thread: thread.id, top: Math.round(block.getBoundingClientRect().top - top) }] : []
        }),
    )
  }
  const frame = { id: 0 }
  const later = () => {
    if (!frame.id) frame.id = requestAnimationFrame(measure)
  }
  // Other threads sit elsewhere.
  createEffect(() => {
    drive.threadsOf(props.doc)
    later()
  })
  onMount(() => {
    if (!element) return
    // The renderer draws after the document is read, and may draw again; `CommentMarks` names the blocks after it.
    const drawn = new MutationObserver(later)
    drawn.observe(element, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-node"] })
    later()
    onCleanup(() => {
      drawn.disconnect()
      cancelAnimationFrame(frame.id)
    })
  })
  createEffect(() => {
    const list = headings()
    props.onOutline?.({
      headings: list,
      active,
      go: (index) => rendered(list)[index]?.scrollIntoView({ block: "start", behavior: "smooth" }),
      reveal: (thread) => {
        const node = drive.threadsOf(props.doc).find((item) => item.id === thread)?.node
        if (node === undefined) return
        element
          ?.querySelector(`[data-node="${CSS.escape(node)}"]`)
          ?.scrollIntoView({ block: "center", behavior: "smooth" })
      },
    })
  })
  onCleanup(() => props.onOutline?.(undefined))
  return (
    <div ref={element} data-slot="drive-markdown" onScroll={later}>
      <ctx.ui.Markdown text={props.text} />
    </div>
  )
}

// Each frame of the window has a name of its own, which main's observer reports it by.
const named = { count: 0 }

/**
 * A page in a frame with the sandbox and the policy `frameOf` gives it. Its outline jumps to a heading's id and to a
 * comment's mark, and, while main observes the frame (`dynwork.drive.frames`), follows the heading being read; a click
 * on a mark goes to `onMark`, where the marks sit to `onPlaced`, and a pick to `onSpot`, placed in the window.
 */
function PageFrame(props: {
  page: Page
  title: string
  marks?: Marks
  onOutline?: (outline: Outline | undefined) => void
  onMark?: (thread: string) => void
  onSpot?: (spot: Spot) => void
  onPlaced?: (placed: readonly Placed[]) => void
}) {
  const name = `${DriveFrames.name}:${++named.count}`
  const frame = createMemo(() => frameOf(props.page, { name, marks: props.marks }))
  // The same page reads the same: a new list of the same comments loads nothing.
  const srcdoc = createMemo(() => frame().srcdoc)
  const [active, setActive] = createSignal<number>()
  let element: HTMLIFrameElement | undefined
  // The frame's own URL with a fragment: the page scrolls there and nothing loads.
  const jump = (id: string | undefined) => {
    const view = element?.contentWindow
    if (id && view) view.location.href = `about:srcdoc#${encodeURIComponent(id)}`
  }
  // Another srcdoc (a comment added or resolved, the marks shown or hidden) loads the page again from its top: it goes
  // back to the heading the reader was at once it has loaded.
  const back = { id: undefined as string | undefined }
  createEffect(
    on(
      srcdoc,
      () => {
        back.id = untrack(() => frame().headings[active() ?? -1]?.id)
        // The new page's marks are placed once its observer reports them.
        props.onPlaced?.([])
      },
      { defer: true },
    ),
  )
  createEffect(() => {
    const shown = frame()
    props.onOutline?.({
      headings: shown.headings,
      active,
      go: (index) => jump(shown.headings[index]?.id),
      reveal: (thread) => jump(Object.hasOwn(shown.marks, thread) ? shown.marks[thread] : undefined),
    })
  })
  onCleanup(() => props.onOutline?.(undefined))
  // What main's observer saw in this frame, while someone listens.
  createEffect(() => {
    const client = observer()
    if (!client || (!props.onOutline && !props.onMark && !props.onSpot)) return
    const held = new AbortController()
    void client.watch({ frame: name }, { signal: held.signal }).catch(() => undefined)
    client.on("seen", (seen) => {
      const found = fromFrame(seen, untrack(frame))
      if (found?.kind === "heading") setActive(found.index)
      if (found?.kind === "mark") props.onMark?.(found.thread)
      if (found?.kind === "marks") props.onPlaced?.(found.placed)
      if (found?.kind === "pick" && element) {
        // The frame's visible area, where the window draws it and at the window's scale.
        const rect = framed(found.rect, {
          box: element.getBoundingClientRect(),
          offsetWidth: element.offsetWidth,
          clientLeft: element.clientLeft,
          clientTop: element.clientTop,
          clientWidth: element.clientWidth,
          clientHeight: element.clientHeight,
        })
        if (rect) props.onSpot?.({ node: found.node, quote: found.quote, rect })
      }
    })
    onCleanup(() => held.abort())
  })
  return (
    <iframe
      ref={element}
      data-slot="drive-frame"
      name={name}
      sandbox={frame().sandbox}
      title={props.title}
      srcdoc={srcdoc()}
      onLoad={() => {
        jump(back.id)
        back.id = undefined
      }}
    />
  )
}

/** The comments to mark on a page: the document's nodes and its threads. */
export interface Marks {
  readonly nodes: readonly Node[]
  readonly threads: readonly Thread[]
}

// The sandbox flags a page may keep from the instance's `sandbox` directive. Never `allow-same-origin` (DynWork's
// origin, its storage and its Ipc), never the top window's navigation, never a popup that leaves the sandbox.
const flags = ["allow-scripts", "allow-forms", "allow-modals", "allow-popups", "allow-downloads", "allow-pointer-lock"]

/**
 * The frame for a page: the sandbox flags its policy's `sandbox` directive grants, out of `flags` (none without the
 * directive, so no scripts), and the page under that policy as a meta tag, first in its head, less the directives
 * only a response header can carry. Never more than the instance allowed; no policy at all is `default-src 'none'`.
 * The page is read into an inert document (`anchorPage`) to give its headings ids, its open comments are marked there
 * and its blocks numbered when `marks` names them (`markPage`), and it is written back whole.
 */
export function frameOf(page: Page, options: { name?: string; marks?: Marks } = {}) {
  const directives = (page.csp ?? "default-src 'none'")
    .split(";")
    .map((directive) => directive.trim())
    .filter(Boolean)
  const granted =
    directives
      .find((directive) => /^sandbox(\s|$)/i.test(directive))
      ?.split(/\s+/)
      .slice(1)
      .map((flag) => flag.toLowerCase()) ?? []
  const policy = directives
    .filter((directive) => !/^(sandbox|frame-ancestors|report-uri|report-to)(\s|$)/i.test(directive))
    .join("; ")
  const anchored = anchorPage(page.html)
  const tags = [
    [["charset", "utf-8"]],
    [
      ["http-equiv", "Content-Security-Policy"],
      ["content", policy],
    ],
    [
      ["name", "referrer"],
      ["content", "no-referrer"],
    ],
  ].map((attributes) => {
    const meta = anchored.page.createElement("meta")
    attributes.forEach(([key, value]) => meta.setAttribute(key, value))
    return meta
  })
  const marked = options.marks
    ? markPage(anchored.page, options.marks.nodes, options.marks.threads)
    : { marks: {}, blocks: [] }
  anchored.page.head.prepend(...tags)
  return {
    // Main keeps a frame with a viewer's name on its srcdoc, and observes it (`drive/frames.ts`).
    name: options.name ?? DriveFrames.name,
    sandbox: flags.filter((flag) => granted.includes(flag)).join(" "),
    srcdoc: `<!doctype html>${anchored.page.documentElement.outerHTML}`,
    /** The page's headings, each with the id a jump navigates the frame to. */
    headings: anchored.headings,
    /** The id of each marked thread's first mark, which a jump navigates the frame to. */
    marks: marked.marks,
    /** The node of each block numbered in the page, by its number, which main's observer reports a pick by. */
    blocks: marked.blocks,
  }
}
