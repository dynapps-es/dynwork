import { usePlugin } from "@opencode/plugin/gui"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { createEffect, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js"
import { Deck, HtmlFrame, paperHtml, pdfHtml, Sheet, notesSource, type FrameMessage } from "./canvas"
import { me, people, type Anchor, type Doc, type Thread } from "./demo"
import { askAgent } from "./chat"
import { AnchorLine, Avatar, MessageLine, useNames } from "./parts"
import { anchorCell } from "./model"
import { drive } from "./store"

// Comments on a part of a document, as Claude's artifacts do: select text, cells or a range, or turn on comment mode
// (C) and click a paragraph, a slide's box, an element of an HTML page or a point of a PDF. The comment opens there, in
// a card beside what it points at; pins and highlights open their thread. The store anchors a comment to a node and a
// quote inside it; a cell range and a PDF point need a change in the store (P10), and the anchor says so.

interface Box {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

interface Pin {
  readonly id: string
  readonly x: number
  readonly y: number
}

/** A selection's toolbar: what it would anchor to, and where it sits. */
interface Picked {
  readonly anchor: Anchor
  readonly quote: string
  readonly box: Box
}

// The DOM a new comment marks once it is saved: the selected text, or the clicked block.
let pending: { range?: Range; element?: HTMLElement } = {}

const paper = (doc: Doc) => doc.format === "docx" || doc.format === "markdown"
const clean = (text: string, size: number) => text.replace(/\s+/g, " ").trim().slice(0, size)
/** The box of an element's text, narrower than the element when it is a full-width block such as a bullet. */
const textBox = (element: Element) => {
  const range = document.createRange()
  range.selectNodeContents(element)
  return range.getBoundingClientRect()
}

/** The document on the workspace's canvas, with its comments: marks, pins, the card, the selection's toolbar. */
export function CommentCanvas(props: { doc: Doc }) {
  const ctx = usePlugin()
  const names = useNames()
  let box!: HTMLDivElement
  const [pins, setPins] = createSignal<readonly Pin[]>([])
  const [frameRects, setFrameRects] = createSignal<readonly { id: string; box: Box }[]>([])
  const [cardAt, setCardAt] = createSignal<{ left: number; top: number }>()
  const [cardBox, setCardBox] = createSignal<Box>()
  const [picked, setPicked] = createSignal<Picked>()
  const [ghost, setGhost] = createSignal<{ page: number; x: number; y: number }>()
  const [tip, setTip] = createSignal<{ thread: Thread; left: number; top: number }>()
  let openedAt = 0
  const open = () => drive.threadsOf(props.doc.id).filter((thread) => thread.open)
  const canComment = () => props.doc.access !== "view"
  const canEdit = () => props.doc.access === "own" || props.doc.access === "edit"
  const threadCard = () => {
    const card = drive.state.doc.card
    return card?.kind === "thread" ? drive.thread(card.id) : undefined
  }
  const newCard = () => {
    const card = drive.state.doc.card
    return card?.kind === "new" ? card : undefined
  }

  // A box in the canvas's scrolled coordinates.
  const local = (rect: Box) => {
    const outer = box.getBoundingClientRect()
    return {
      left: rect.left - outer.left + box.scrollLeft,
      top: rect.top - outer.top + box.scrollTop,
      right: rect.right - outer.left + box.scrollLeft,
      bottom: rect.bottom - outer.top + box.scrollTop,
    }
  }

  // Where each open thread's pin goes, by format: the page margin, a slide box's corner, a PDF page's point, an HTML
  // element's corner. A spreadsheet marks its cells instead.
  const measure = () => {
    if (!box) return
    const threads = open()
    const host = box.querySelector<HTMLElement>("[data-slot=drive-paper], [data-slot=drive-pdf]")
    host?.querySelectorAll<HTMLElement>("[data-t]").forEach((element) => {
      const thread = drive.thread(element.dataset.t ?? "")
      element.toggleAttribute("data-on", element.dataset.t === drive.state.doc.thread)
      element.toggleAttribute("data-resolved", thread?.open === false)
    })
    if (paper(props.doc) && host) {
      const page = local(host.getBoundingClientRect())
      const used: number[] = []
      setPins(
        threads.flatMap((thread) => {
          const element = host.querySelector(`[data-t="${thread.id}"]`)
          if (!element) return []
          const raw = local(element.getBoundingClientRect()).top - 2
          const y = used.reduce((top, other) => (Math.abs(top - other) < 28 ? other + 28 : top), raw)
          used.push(y)
          return [{ id: thread.id, x: page.right - 40, y }]
        }),
      )
      return
    }
    if (props.doc.format === "pptx") {
      const slide = box.querySelector<HTMLElement>("[data-slot=drive-stage] [data-slot=drive-slide]")
      if (!slide) return setPins([])
      slide.querySelectorAll("[data-anchored]").forEach((node) => node.removeAttribute("data-anchored"))
      const frame = local(slide.getBoundingClientRect())
      setPins(
        threads.flatMap((thread) => {
          const anchor = thread.anchor
          if (anchor.kind !== "shape" || anchor.slide !== drive.state.doc.slide) return []
          const node = slide.querySelector<HTMLElement>(`[data-node="${anchor.node}"]`)
          if (!node) return []
          node.setAttribute("data-anchored", thread.id === drive.state.doc.thread ? "on" : "")
          const at = local(textBox(node))
          return [
            { id: thread.id, x: Math.min(at.right + 4, frame.right - 30), y: Math.max(frame.top + 4, at.top - 14) },
          ]
        }),
      )
      return
    }
    if (props.doc.format === "pdf" && host) {
      setPins(
        threads.flatMap((thread) => {
          const anchor = thread.anchor
          const page = anchor.kind === "page" && host.querySelector<HTMLElement>(`[data-page="${anchor.page}"]`)
          if (anchor.kind !== "page" || !page) return []
          const at = local(page.getBoundingClientRect())
          return [
            {
              id: thread.id,
              x: at.left + ((at.right - at.left) * anchor.x) / 100,
              y: at.top + ((at.bottom - at.top) * anchor.y) / 100,
            },
          ]
        }),
      )
      return
    }
    if (props.doc.format === "html") {
      setPins(frameRects().map((item) => ({ id: item.id, x: item.box.right - 6, y: Math.max(2, item.box.top - 14) })))
      return
    }
    setPins([])
  }

  createEffect(() => {
    // Everything a pin depends on.
    open().map((thread) => thread.id)
    drive.state.doc.thread
    drive.state.doc.slide
    drive.state.paper[props.doc.id]
    drive.state.added[props.doc.id]
    drive.state.proposals[props.doc.id]?.[0]?.state
    frameRects()
    requestAnimationFrame(measure)
  })
  onMount(() => {
    const observer = new ResizeObserver(() => measure())
    observer.observe(box)
    onCleanup(() => observer.disconnect())
  })

  // The card sits beside what it points at when there is room on the right, else just below it, so it never hides it.
  createEffect(() => {
    const card = drive.state.doc.card
    pins()
    if (!card) return setCardAt(undefined)
    requestAnimationFrame(() => {
      const target = card.kind === "new" ? cardBox() : anchorBox(card.id)
      if (!target) return setCardAt(undefined)
      const at = local(target)
      const width = 300
      const right = at.right + 12
      const max = box.scrollLeft + box.clientWidth - width - 8
      setCardAt(
        right <= max
          ? { left: right, top: Math.max(box.scrollTop + 8, at.top - 8) }
          : { left: Math.max(box.scrollLeft + 8, Math.min(max, at.left)), top: at.bottom + 10 },
      )
    })
  })

  const anchorBox = (id: string): Box | undefined => {
    const thread = drive.thread(id)
    if (!thread) return undefined
    const cell = anchorCell(thread.anchor)
    if (cell) {
      const last = thread.anchor.kind === "range" ? thread.anchor.to : cell
      const first = box.querySelector(`[data-cell="${cell}"]`)?.getBoundingClientRect()
      const end = box.querySelector(`[data-cell="${last}"]`)?.getBoundingClientRect()
      return first && end ? { left: first.left, top: first.top, right: end.right, bottom: end.bottom } : undefined
    }
    return (box.querySelector(`[data-pin="${id}"]`) ?? box.querySelector(`[data-t="${id}"]`))?.getBoundingClientRect()
  }

  const compose = (anchor: Anchor, quote: string, target: Box, dom: typeof pending = {}) => {
    pending = dom
    setPicked(undefined)
    setGhost(anchor.kind === "page" && !quote ? { page: anchor.page, x: anchor.x, y: anchor.y } : undefined)
    setCardBox(target)
    openedAt = Date.now()
    drive.setCard({ kind: "new", anchor, quote })
  }
  const closeCard = () => {
    pending = {}
    setGhost(undefined)
    drive.setCard(undefined)
  }

  const commit = (text: string) => {
    const card = drive.state.doc.card
    if (card?.kind !== "new" || !text.trim()) return
    const id = drive.comment(card.anchor, card.quote, text.trim())
    if (pending.range) {
      const span = document.createElement("span")
      span.dataset.mark = ""
      span.dataset.t = id
      // A selection across blocks cannot be wrapped; its quote still anchors it.
      if (pending.range.startContainer.parentNode === pending.range.endContainer.parentNode)
        pending.range.surroundContents(span)
    }
    if (pending.element) pending.element.dataset.t = id
    const host = box.querySelector<HTMLElement>("[data-slot=drive-paper], [data-slot=drive-pdf]")
    if (host && (pending.range || pending.element)) drive.setPaper(props.doc.id, host.innerHTML)
    pending = {}
    setGhost(undefined)
    drive.focusThread(id)
    if (/@agent/i.test(text)) answer(id)
  }

  const answer = (id: string, text?: string) =>
    drive.answer(id, text, (target) =>
      ctx.toast.show({
        title: ctx.t("drive.agent.answered"),
        description: target.name,
        icon: "comment",
        variant: "success",
      }),
    )

  // Text selection on paper and PDF pages: the toolbar, or straight to the composer in comment mode.
  const selected = (event: MouseEvent) =>
    setTimeout(() => {
      const target = event.target as HTMLElement
      // A spreadsheet hears its own selection (`sheetPick`).
      if (target.closest("[data-slot=drive-popover], [data-pin], [data-slot=drive-sheet-grid]")) return
      setPicked(undefined)
      const host = target.closest<HTMLElement>("[data-slot=drive-paper], [data-slot=drive-pdf]")
      const selection = window.getSelection()
      if (host && selection && !selection.isCollapsed && host.contains(selection.anchorNode)) {
        const range = selection.getRangeAt(0).cloneRange()
        const rect = range.getBoundingClientRect()
        const page = target.closest<HTMLElement>("[data-page]")
        const pageBox = page?.getBoundingClientRect()
        const anchor: Anchor =
          page && pageBox
            ? {
                kind: "page",
                page: Number(page.dataset.page),
                x: Math.min(92, ((rect.right - pageBox.left) / pageBox.width) * 100),
                y: ((rect.top - pageBox.top) / pageBox.height) * 100 - 3,
              }
            : { kind: "text" }
        const quote = clean(range.toString(), 90)
        if (drive.state.doc.commenting) return compose(anchor, quote, rect, { range })
        return setPicked({ anchor, quote, box: rect })
      }
      if (!drive.state.doc.commenting || !canComment() || target.closest("[data-t]")) return
      const block =
        !target.closest("[data-page]") &&
        target.closest<HTMLElement>("[data-slot=drive-paper] :is(p, h1, h2, li, td, th)")
      if (block)
        compose({ kind: "block" }, clean(block.innerText, 60), block.getBoundingClientRect(), { element: block })
    }, 0)

  const click = (event: MouseEvent) => {
    const target = event.target as HTMLElement
    setTip(undefined)
    if (
      drive.state.doc.card &&
      Date.now() - openedAt > 300 &&
      !target.closest("[data-slot=drive-popover], [data-t], [data-pin], [data-slot=drive-selection], [data-cell]")
    )
      closeCard()
    const thread = target.closest<HTMLElement>("[data-pin], [data-t]")
    const id = thread?.dataset.pin ?? thread?.dataset.t
    if (id && !(drive.state.doc.commenting && !window.getSelection()?.isCollapsed)) {
      openedAt = Date.now()
      return drive.focusThread(id)
    }
    if (!drive.state.doc.commenting || !canComment() || target.closest("[data-slot=drive-popover], button")) return
    if (props.doc.format === "pptx") {
      const slide = target.closest<HTMLElement>("[data-slot=drive-stage] [data-slot=drive-slide]")
      if (!slide) return
      const node =
        target.closest<HTMLElement>("[data-node]") ?? slide.querySelector<HTMLElement>("[data-node$='.title']")
      if (!node?.dataset.node) return
      return compose(
        { kind: "shape", slide: drive.state.doc.slide, node: node.dataset.node },
        clean(node.innerText, 60),
        textBox(node),
      )
    }
    if (props.doc.format === "pdf") {
      const page = target.closest<HTMLElement>("[data-page]")
      if (!page || !window.getSelection()?.isCollapsed) return
      const rect = page.getBoundingClientRect()
      compose(
        {
          kind: "page",
          page: Number(page.dataset.page),
          x: ((event.clientX - rect.left) / rect.width) * 100,
          y: ((event.clientY - rect.top) / rect.height) * 100 - 2,
        },
        "",
        { left: event.clientX, right: event.clientX + 14, top: event.clientY - 12, bottom: event.clientY },
      )
    }
  }

  const frameMessage = (message: FrameMessage, frame: HTMLIFrameElement) => {
    const at = frame.getBoundingClientRect()
    const shift = (x: number, y: number, w: number, h: number) =>
      local({ left: at.left + x, top: at.top + y, right: at.left + x + w, bottom: at.top + y + h })
    if (message.dw === "rects")
      setFrameRects(message.list.map((item) => ({ id: item.id, box: shift(item.x, item.y, item.w, item.h) })))
    if (message.dw === "pick" && canComment())
      compose({ kind: "element", find: message.text }, message.text, {
        left: at.left + message.x,
        top: at.top + message.y,
        right: at.left + message.x + message.w,
        bottom: at.top + message.y + message.h,
      })
  }

  // A spreadsheet hears the selection on release: a commented cell opens its thread, comment mode or a right click
  // opens the composer, and a range shows the toolbar.
  const sheetPick = (input: { range: string | undefined; rect: DOMRect; context: boolean }) => {
    const sheet = drive.state.doc.sheet
    const cell = drive.state.doc.cell
    const anchor: Anchor = input.range
      ? { kind: "range", sheet, from: input.range.split(":")[0], to: input.range.split(":")[1] }
      : { kind: "cell", sheet, cell }
    const quote = input.range ?? box.querySelector<HTMLElement>(`[data-cell="${cell}"]`)?.innerText ?? ""
    const hit =
      !input.range &&
      open().find(
        (thread) => anchorCell(thread.anchor) === cell && "sheet" in thread.anchor && thread.anchor.sheet === sheet,
      )
    if (hit && !drive.state.doc.commenting && !input.context) {
      openedAt = Date.now()
      return drive.focusThread(hit.id)
    }
    if ((drive.state.doc.commenting || input.context) && canComment()) return compose(anchor, quote, input.rect)
    if (input.range) setPicked({ anchor, quote, box: input.rect })
  }
  const sheetComment = () => {
    const range = drive.state.doc.range
    const cells = range ? range.split(":") : [drive.state.doc.cell, drive.state.doc.cell]
    const first = box.querySelector(`[data-cell="${cells[0]}"]`)?.getBoundingClientRect()
    const last = box.querySelector(`[data-cell="${cells[1]}"]`)?.getBoundingClientRect()
    if (!first || !last) return
    sheetPick({
      range,
      rect: new DOMRect(first.left, first.top, last.right - first.left, last.bottom - first.top),
      context: true,
    })
  }
  const hover = (cell: string | undefined, rect: DOMRect | undefined) => {
    const thread =
      cell && !drive.state.doc.card
        ? open().find(
            (item) =>
              anchorCell(item.anchor) === cell && "sheet" in item.anchor && item.anchor.sheet === drive.state.doc.sheet,
          )
        : undefined
    if (!thread || !rect) return setTip(undefined)
    const at = local(rect)
    setTip({ thread, left: at.right + 6, top: at.top })
  }

  // Escape closes the card, then leaves comment mode; C toggles comment mode when no field has the focus.
  const keys = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return
    const typing = (event.target as HTMLElement).closest?.("input, textarea, select, [contenteditable=true]")
    if (event.key === "Escape" && (drive.state.doc.card || picked())) {
      event.preventDefault()
      setPicked(undefined)
      return closeCard()
    }
    if (event.key === "Escape" && drive.state.doc.commenting) {
      event.preventDefault()
      return drive.setCommenting(false)
    }
    if (!typing && !event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "c" && canComment())
      drive.setCommenting(!drive.state.doc.commenting)
  }
  document.addEventListener("keydown", keys)
  onCleanup(() => document.removeEventListener("keydown", keys))

  return (
    <div
      ref={box}
      data-slot="drive-canvas"
      data-commenting={drive.state.doc.commenting ? "" : undefined}
      onMouseUp={selected}
      onClick={click}
      onScroll={() => setTip(undefined)}
    >
      <Show when={paper(props.doc)}>
        <Show
          when={!(props.doc.format === "markdown" && drive.state.doc.source && props.doc.id === "d6")}
          fallback={<pre data-slot="drive-source">{notesSource}</pre>}
        >
          <div
            data-slot="drive-paper"
            contentEditable={drive.state.mode === "v2" && canEdit() ? true : undefined}
            spellcheck={false}
            innerHTML={paperHtml(props.doc, names.path(props.doc.folder), ctx.t)}
          />
        </Show>
      </Show>
      <Show when={props.doc.format === "pdf"}>
        <div data-slot="drive-pdf" innerHTML={pdfHtml(props.doc)} />
      </Show>
      <Show when={props.doc.format === "xlsx"}>
        <Sheet doc={props.doc} onPick={sheetPick} onHover={hover} onComment={canComment() ? sheetComment : undefined} />
      </Show>
      <Show when={props.doc.format === "pptx"}>
        <Deck doc={props.doc} />
      </Show>
      <Show when={props.doc.format === "html"}>
        <HtmlFrame
          doc={props.doc}
          commenting={drive.state.doc.commenting && canComment()}
          anchors={() =>
            open().flatMap((thread) =>
              thread.anchor.kind === "element"
                ? [{ id: thread.id, find: thread.anchor.find, on: thread.id === drive.state.doc.thread }]
                : [],
            )
          }
          onMessage={frameMessage}
        />
      </Show>

      <For each={pins()}>
        {(pin) => {
          const thread = () => drive.thread(pin.id)
          const first = () => people[thread()?.messages[0]?.by ?? me]
          return (
            <button
              type="button"
              data-pin={pin.id}
              data-state={pin.id === drive.state.doc.thread ? "on" : undefined}
              data-agent={first()?.agent ? "" : undefined}
              style={{ left: `${pin.x}px`, top: `${pin.y}px` }}
              title={`${names.who(thread()?.messages[0]?.by ?? me)}: ${names.said(thread()?.messages[0]?.text ?? "")}`}
            >
              {first()?.initials}
              <Show when={(thread()?.messages.length ?? 0) > 1}>
                <i>{thread()?.messages.length}</i>
              </Show>
            </button>
          )
        }}
      </For>
      <Show when={ghost()}>
        {(point) => {
          const at = () => {
            const page = box.querySelector<HTMLElement>(`[data-page="${point().page}"]`)
            if (!page) return undefined
            const rect = local(page.getBoundingClientRect())
            return {
              left: rect.left + ((rect.right - rect.left) * point().x) / 100,
              top: rect.top + ((rect.bottom - rect.top) * point().y) / 100,
            }
          }
          return (
            <Show when={at()}>
              {(place) => (
                <span data-pin-ghost="" style={{ left: `${place().left}px`, top: `${place().top}px` }}>
                  +
                </span>
              )}
            </Show>
          )
        }}
      </Show>

      <Show when={picked()}>
        {(selection) => {
          const at = () => local(selection().box)
          return (
            <div data-slot="drive-selection" style={{ left: `${at().left}px`, top: `${at().top - 40}px` }}>
              <Show when={canComment()}>
                <Button
                  variant="ghost"
                  size="small"
                  icon="comment"
                  onClick={() => {
                    const range = window.getSelection()?.rangeCount
                      ? window.getSelection()?.getRangeAt(0).cloneRange()
                      : undefined
                    compose(
                      selection().anchor,
                      selection().quote,
                      selection().box,
                      selection().anchor.kind === "text" || selection().anchor.kind === "page" ? { range } : {},
                    )
                  }}
                >
                  {ctx.t("drive.comment")}
                </Button>
              </Show>
              <Button
                variant="ghost"
                size="small"
                icon="speech-bubble"
                onClick={() => {
                  setPicked(undefined)
                  askAgent(ctx, props.doc, ctx.t("drive.ask.quote", { doc: props.doc.name, quote: selection().quote }))
                }}
              >
                {ctx.t("drive.ask")}
              </Button>
              <Show when={canEdit() && props.doc.format !== "pdf"}>
                <Button
                  variant="ghost"
                  size="small"
                  icon="edit"
                  onClick={() => {
                    const range = selection().anchor.kind === "range"
                    const id = drive.comment(
                      selection().anchor,
                      selection().quote,
                      ctx.t(range ? "drive.edit.cells" : "drive.edit.text"),
                    )
                    setPicked(undefined)
                    drive.focusThread(id)
                    answer(id, props.doc.cls === "confidential" ? "drive.agent.proposed" : "drive.agent.rewrote")
                  }}
                >
                  {ctx.t("drive.edit")}
                </Button>
              </Show>
            </div>
          )
        }}
      </Show>

      <Show when={tip()}>
        {(shown) => (
          <div data-slot="drive-tip" style={{ left: `${shown().left}px`, top: `${shown().top}px` }}>
            <AnchorLine thread={shown().thread} />
            <MessageLine message={shown().thread.messages[0]} />
            <Show when={shown().thread.messages.length > 1}>
              <div data-slot="drive-faint">
                {ctx.t("drive.comment.replies", { count: String(shown().thread.messages.length - 1) })}
              </div>
            </Show>
          </div>
        )}
      </Show>

      <Show when={cardAt()}>
        {(at) => (
          <div data-slot="drive-popover" style={{ left: `${at().left}px`, top: `${at().top}px` }}>
            <Show when={threadCard()} keyed>
              {(thread) => <ThreadCard thread={thread} onClose={closeCard} answer={answer} />}
            </Show>
            <Show when={newCard()} keyed>
              {(card) => <NewComment card={card} onCancel={closeCard} onSend={commit} />}
            </Show>
          </div>
        )}
      </Show>
    </div>
  )
}

/** The composer of a new comment, in its card: what it anchors to, who signs it, the text, @Agent. */
function NewComment(props: {
  card: { anchor: Anchor; quote: string }
  onCancel: () => void
  onSend: (text: string) => void
}) {
  const ctx = usePlugin()
  let field!: HTMLTextAreaElement
  onMount(() => field.focus())
  return (
    <>
      <div data-slot="drive-card-anchor">
        <AnchorLine thread={props.card} />
      </div>
      <div data-slot="drive-card-who">
        <Avatar person={me} size="small" />
        <b>{ctx.t("drive.you")}</b>
        <Show when={drive.state.mode === "mvp"}>
          <span data-slot="drive-via">{ctx.t("drive.comment.dynwork")}</span>
        </Show>
      </div>
      <textarea
        ref={field}
        data-slot="drive-card-text"
        placeholder={ctx.t("drive.comment.placeholder")}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) props.onSend(field.value)
        }}
      />
      <div data-slot="drive-card-row">
        <Button
          variant="ghost"
          size="small"
          icon="outline-steer"
          title={ctx.t("drive.comment.mention")}
          onClick={() => {
            field.value = `${field.value.trimEnd()}${field.value ? " " : ""}@Agent `
            field.focus()
          }}
        >
          @Agent
        </Button>
        <span data-slot="drive-grow" />
        <Button variant="ghost" size="small" onClick={props.onCancel}>
          {ctx.t("drive.cancel")}
        </Button>
        <Button variant="contrast" size="small" title="⌘↵" onClick={() => props.onSend(field.value)}>
          {ctx.t("drive.comment")}
        </Button>
      </div>
    </>
  )
}

/** A thread's card: its messages, the agent at work, and a reply box, Send to the agent and Resolve. */
function ThreadCard(props: { thread: Thread; onClose: () => void; answer: (id: string) => void }) {
  const ctx = usePlugin()
  let field: HTMLTextAreaElement | undefined
  const send = () => {
    const text = field?.value.trim()
    if (!text) return
    drive.reply(props.thread.id, text)
    if (field) field.value = ""
    if (/@agent/i.test(text)) props.answer(props.thread.id)
  }
  return (
    <>
      <div data-slot="drive-card-anchor">
        <AnchorLine thread={props.thread} />
        <IconButton
          type="button"
          variant="ghost-muted"
          size="small"
          icon={<Icon name="close-small" size="small" />}
          aria-label={ctx.t("views.close")}
          title={ctx.t("views.close")}
          onClick={props.onClose}
        />
      </div>
      <div data-slot="drive-card-messages">
        <For each={props.thread.messages}>{(message) => <MessageLine message={message} />}</For>
      </div>
      <Show when={drive.state.typing === props.thread.id}>
        <AgentWorking />
      </Show>
      <Show
        when={props.thread.open}
        fallback={
          <div data-slot="drive-card-row">
            <span data-slot="drive-tag" data-tone="success">
              {ctx.t("drive.comment.resolved")}
            </span>
            <span data-slot="drive-grow" />
            <Button variant="ghost" size="small" onClick={() => drive.reopen(props.thread.id)}>
              {ctx.t("drive.comment.reopen")}
            </Button>
          </div>
        }
      >
        <textarea
          ref={field}
          data-slot="drive-card-text"
          placeholder={ctx.t("drive.comment.reply")}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) send()
          }}
        />
        <div data-slot="drive-card-row">
          <Button
            variant="ghost"
            size="small"
            icon="outline-steer"
            title={ctx.t("drive.comment.toAgent.hint")}
            onClick={() => {
              drive.reply(props.thread.id, ctx.t("drive.comment.toAgent.text"))
              props.answer(props.thread.id)
            }}
          >
            {ctx.t("drive.comment.toAgent")}
          </Button>
          <span data-slot="drive-grow" />
          <IconButton
            type="button"
            variant="ghost-muted"
            size="small"
            icon={<Icon name="check" size="small" />}
            aria-label={ctx.t("drive.comment.resolve")}
            title={ctx.t("drive.comment.resolve")}
            onClick={() => drive.resolve(props.thread.id)}
          />
          <Button variant="contrast" size="small" onClick={send}>
            {ctx.t("drive.comment.send")}
          </Button>
        </div>
      </Show>
    </>
  )
}

export function AgentWorking(): JSX.Element {
  const ctx = usePlugin()
  return (
    <div data-slot="drive-agent-working">
      <span data-slot="drive-spin" />
      {ctx.t("drive.agent.working")}
    </div>
  )
}

/** The comment mode banner's hint, by format. */
export const commentHint = (doc: Doc) =>
  doc.format === "xlsx"
    ? "drive.mode.hint.sheet"
    : doc.format === "pptx"
      ? "drive.mode.hint.slides"
      : doc.format === "html"
        ? "drive.mode.hint.html"
        : doc.format === "pdf"
          ? "drive.mode.hint.pdf"
          : "drive.mode.hint.text"
