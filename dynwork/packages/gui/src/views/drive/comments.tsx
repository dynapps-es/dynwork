import { usePlugin } from "@opencode/plugin/gui"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { SegmentedControl, SegmentedControlItem } from "@opencode/ui/segmented-control"
import { TextInput } from "@opencode/ui/text-input"
import { Textarea } from "@opencode/ui/textarea"
import { createEffect, createSignal, For, Index, onCleanup, onMount, Show, type JSX } from "solid-js"
import { isFailure, type Anchor, type Document, type Failure, type Mention } from "../../drive/contract"
import { DriveCapabilities } from "../../drive/capabilities"
import { askAgent, sessionOf, titleOf } from "./chat"
import {
  anchorsOf,
  bubbleFaces,
  bubbleRows,
  clip,
  marked,
  matchNodes,
  nodeLabel,
  pickable,
  pointsAt,
  quoteIn,
  rangeOf,
  sheetsOf,
  type Node,
  type Placed,
  type Thread,
} from "./model"
import { panes } from "./panes"
import { AnchorLine, authorName, Avatar, failureText, MessageLine, useNames } from "./parts"
import { clicked, selected, type Spot } from "./spot"
import { drive } from "./store"

// Comments on a document (D11). The instance anchors a comment to a node (a paragraph, a table cell, a slide's box) and
// an optional quote inside it. A Markdown document is drawn by the app itself, so a selection or a click there finds
// its node (`CommentMarks`); a page the instance renders (HTML, Word, Excel, PowerPoint) runs in an isolated frame the
// app cannot read, so the Comments tab lists its nodes to pick from. A cell range of a spreadsheet's sheet is offered
// once the instance takes one (`rangeComments`, 0.84); a PDF takes no comment (D22). A resolved thread opens again where
// the instance reopens comments (`reopenComments`, 0.84).

/** How many paragraphs and cells the picker shows before it asks for a narrower search. */
const SHOWN = 80

/** The user may comment unless the document is theirs to read only: by the open document's detail when it is that one. */
export const canComment = (doc: Document) => {
  const detail = drive.state.opened.detail
  return (detail?.document.id === doc.id ? detail.access : doc.access) !== "view"
}

/**
 * Shows or hides the comments marked on the document, with how many threads are open. Only where marks are drawn: an
 * HTML page and Markdown; the instance's previews of Word, Excel and PowerPoint, and a PDF, carry none.
 */
export function MarksToggle(props: { doc: Document }) {
  const ctx = usePlugin()
  const open = () => drive.threadsOf(props.doc.id).filter((thread) => thread.open).length
  const label = () => ctx.t(panes.marks() ? "drive.marks.hide" : "drive.marks.show")
  // One button with its count inside, as the chat header counts its artifacts.
  return (
    <Show when={marked(props.doc)}>
      <ctx.ui.Tooltip value={label()} placement="bottom">
        <Button
          variant="ghost"
          icon="comment"
          data-slot="drive-marks-toggle"
          data-state={panes.marks() ? "pressed" : undefined}
          aria-pressed={panes.marks()}
          aria-label={label()}
          onClick={() => panes.toggle("marks")}
        >
          <Show when={open()}>
            <span class="tabular-nums">{open()}</span>
          </Show>
        </Button>
      </ctx.ui.Tooltip>
    </Show>
  )
}

/**
 * The comments' bubbles in a column beside a document, as Google Docs shows them: one beside each marked part, with
 * who wrote its thread (their initials: 0.83 gives no picture), and the threads at one height in one bubble, two faces
 * and "+N". Each face is its own button and opens its own thread, as a click on its mark does; the thread open now
 * (`drive.state.doc.thread`) goes to the front of its bubble, ringed in the comments' accent, as its card and its mark
 * are. Hovering or focusing a bubble of several threads spreads all its faces apart, so each one is easy to point at.
 * The column is the app's own, outside the document's frame: no name, picture or text of a comment goes into the page.
 */
export function CommentBubbles(props: {
  doc: Document
  placed: readonly Placed[]
  onThread: (thread: string) => void
}) {
  const ctx = usePlugin()
  const author = (thread: string) => {
    const first = drive.threadsOf(props.doc.id).find((item) => item.id === thread)?.messages[0]
    return first ? authorName(ctx, first) : ctx.t("drive.comment.other")
  }
  return (
    <aside data-slot="drive-bubbles" aria-label={ctx.t("drive.tab.comments")}>
      {/* By place, not by object: the rows are new at each scroll, and a button that stays takes the click. */}
      <Index each={bubbleRows(props.placed)}>
        {(row) => {
          const faces = () => bubbleFaces(row().threads, drive.state.doc.thread)
          return (
            <div
              data-slot="drive-bubble"
              data-more={faces().more > 0 ? "" : undefined}
              role="group"
              style={{ top: `${row().top}px` }}
              aria-label={ctx.t("drive.bubble", { count: String(row().threads.length) })}
            >
              <Index each={faces().faces}>
                {(thread, index) => (
                  <button
                    type="button"
                    data-slot="drive-bubble-face"
                    data-state={thread() === drive.state.doc.thread ? "on" : undefined}
                    aria-pressed={thread() === drive.state.doc.thread}
                    aria-label={ctx.t("drive.bubble.thread", { name: author(thread()) })}
                    style={{ "z-index": String(faces().faces.length - index) }}
                    onClick={() => props.onThread(thread())}
                  >
                    <Avatar name={author(thread())} size="small" />
                  </button>
                )}
              </Index>
              <Show when={faces().more}>
                <span data-slot="drive-bubble-more" aria-hidden="true">
                  +{faces().more}
                </span>
              </Show>
            </div>
          )
        }}
      </Index>
    </aside>
  )
}

export function CommentsTab(props: { doc: Document; onReveal?: (thread: string) => void }) {
  const ctx = usePlugin()
  const threads = () => drive.threadsOf(props.doc.id)
  const shown = () => threads().filter((thread) => thread.open === (drive.state.doc.filter === "open"))
  const count = (open: boolean) => threads().filter((thread) => thread.open === open).length
  const discussion = () => drive.state.discussion[props.doc.id]
  return (
    <>
      <Show when={drive.state.doc.compose}>{(anchor) => <Composer doc={props.doc} anchor={anchor()} />}</Show>
      <Show when={drive.state.doc.choosing}>
        <Picker doc={props.doc} />
      </Show>
      <Show when={!drive.state.doc.compose && !drive.state.doc.choosing}>
        <div data-slot="drive-comments-bar">
          <SegmentedControl
            value={drive.state.doc.filter}
            aria-label={ctx.t("drive.tab.comments")}
            onChange={(value) => {
              if (value === "open" || value === "resolved") drive.setFilter(value)
            }}
          >
            <SegmentedControlItem value="open">
              {ctx.t("drive.comment.filter.open")} · {count(true)}
            </SegmentedControlItem>
            <SegmentedControlItem value="resolved">
              {ctx.t("drive.comment.resolved")} · {count(false)}
            </SegmentedControlItem>
          </SegmentedControl>
          <span data-slot="drive-grow" />
          <Button
            variant="contrast"
            size="small"
            icon="comment"
            disabled={!canComment(props.doc)}
            onClick={() => drive.startComment()}
          >
            {ctx.t("drive.comment.new")}
          </Button>
        </div>
        <Show when={marked(props.doc) && panes.marks() && canComment(props.doc) && !drive.state.doc.commenting}>
          <p data-slot="drive-note">{ctx.t("drive.comment.inline.hint")}</p>
        </Show>
        <Show
          when={
            props.doc.format === "markdown" && canComment(props.doc) && (!panes.marks() || drive.state.doc.commenting)
          }
        >
          <p data-slot="drive-note" data-tone={drive.state.doc.commenting ? "info" : undefined}>
            {ctx.t(drive.state.doc.commenting ? "drive.comment.mode" : "drive.comment.mode.hint")}
          </p>
        </Show>
        <Show when={discussion()?.status === "failed"}>
          <p data-slot="drive-note" data-tone="warning">
            {ctx.t("drive.comment.failed")}
          </p>
        </Show>
        <Show
          when={shown().length}
          fallback={
            <p data-slot="drive-note">
              {ctx.t(
                discussion()?.status === "loading"
                  ? "drive.loading"
                  : drive.state.doc.filter === "open"
                    ? "drive.comment.none"
                    : "drive.comment.noneResolved",
              )}
            </p>
          }
        >
          <For each={shown()}>
            {(thread) => <ThreadCard doc={props.doc} thread={thread} onReveal={props.onReveal} />}
          </For>
        </Show>
        <Show when={!canComment(props.doc)}>
          <p data-slot="drive-note">{ctx.t("drive.comment.readOnly")}</p>
        </Show>
      </Show>
    </>
  )
}

/**
 * What an anchor points at, as a line: its quote, the node's own text, or a sheet and a cell range of it ("Sales ·
 * B2:D9"). A comment whose sheet is gone keeps the sheet's node and loses its range (the instance detaches it): it
 * names the sheet, and says it is gone.
 */
export function Pointing(props: { doc: Document; anchor: Anchor }) {
  const ctx = usePlugin()
  const line = () => {
    const at = pointsAt(props.anchor, drive.nodesOf(props.doc.id))
    if (at.kind === "range")
      return { icon: "dot-grid" as const, text: ctx.t("drive.anchor.range", { sheet: at.sheet, range: at.cells }) }
    if (at.kind === "sheet")
      return {
        icon: "dot-grid" as const,
        text: at.gone ? ctx.t("drive.anchor.sheetGone", { sheet: at.sheet }) : at.sheet,
      }
    if (at.kind === "quote") return { icon: "outline-quote" as const, text: `“${at.text}”` }
    return {
      icon: "outline-quote" as const,
      text: ctx.t(at.kind === "blank" ? "drive.anchor.blank" : "drive.anchor.gone"),
    }
  }
  return <AnchorLine icon={line().icon} text={line().text} />
}

/**
 * A thread: what it points at, with Resolve beside it, and its messages, with Reply. Reply opens one reply box at a time, so a panel
 * of threads stays a list. Picking it brings its mark on the document into view (`onReveal`); picked from the document,
 * it scrolls into view in its list. A resolved thread offers Reopen where the instance reopens comments, and a reopened
 * one says who reopened it and when.
 */
export function ThreadCard(props: { doc: Document; thread: Thread; onReveal?: (thread: string) => void }) {
  const ctx = usePlugin()
  const names = useNames()
  const [failure, setFailure] = createSignal<Failure>()
  const [busy, setBusy] = createSignal(false)
  let field: HTMLTextAreaElement | undefined
  let card: HTMLDivElement | undefined
  const anchor = (): Anchor =>
    props.thread.cells === undefined
      ? { kind: "node", node: props.thread.node, find: props.thread.quote }
      : { kind: "range", node: props.thread.node, cells: props.thread.cells }
  const reopens = () => drive.remote()?.capabilities.reopenComments === true
  const reopener = (by: NonNullable<Thread["reopened"]>) =>
    by.mine ? ctx.t("drive.you") : ((by.by && drive.nameOf(by.by)) ?? ctx.t("drive.comment.other"))
  const on = () => drive.state.doc.thread === props.thread.id
  createEffect(() => {
    if (on()) card?.scrollIntoView({ block: "nearest" })
  })
  const replying = () => drive.state.doc.replying === props.thread.id
  const act = async (run: () => Promise<unknown>) => {
    setBusy(true)
    const answer = await run()
    setBusy(false)
    setFailure(isFailure(answer) ? answer : undefined)
    return answer
  }
  const send = async () => {
    const text = field?.value.trim()
    if (!text) return
    await act(() => drive.reply(props.doc.id, props.thread.id, text))
  }
  return (
    <div
      ref={card}
      data-slot="drive-thread"
      data-state={on() ? "on" : undefined}
      data-resolved={props.thread.open ? undefined : ""}
      onClick={() => {
        drive.focusThread(props.thread.id)
        props.onReveal?.(props.thread.id)
      }}
    >
      <div data-slot="drive-thread-anchor">
        <Pointing doc={props.doc} anchor={anchor()} />
        <Show when={props.thread.open && canComment(props.doc)}>
          <ctx.ui.Tooltip value={ctx.t(reopens() ? "drive.comment.resolve.reopenable" : "drive.comment.resolve.hint")}>
            <ctx.ui.IconButton
              variant="ghost-muted"
              size="small"
              icon="check"
              label={ctx.t("drive.comment.resolve")}
              disabled={busy()}
              onClick={(event) => {
                event.stopPropagation()
                void act(() => drive.resolve(props.doc.id, props.thread.id))
              }}
            />
          </ctx.ui.Tooltip>
        </Show>
      </div>
      <Show when={props.thread.open && props.thread.reopened}>
        {(by) => (
          <p data-slot="drive-note" data-tone="info">
            {ctx.t("drive.comment.reopenedBy", { name: reopener(by()), when: names.ago(by().at) })}
          </p>
        )}
      </Show>
      <For each={props.thread.messages}>
        {(message) => (
          <>
            <MessageLine message={message} />
            <Show when={drive.mentionOf(message.id)}>
              {(mention) => <AgentNote doc={props.doc} mention={mention()} text={message.text} />}
            </Show>
          </>
        )}
      </For>
      <Show
        when={props.thread.open}
        fallback={
          <>
            <div data-slot="drive-card-row" onClick={(event) => event.stopPropagation()}>
              <span data-slot="drive-tag" data-tone="success">
                {ctx.t("drive.comment.resolved")}
              </span>
              <span data-slot="drive-grow" />
              <Show when={reopens() && canComment(props.doc)}>
                <ctx.ui.Tooltip value={ctx.t("drive.comment.reopen.hint")}>
                  <Button
                    variant="ghost"
                    size="small"
                    icon="outline-undo"
                    disabled={busy()}
                    onClick={() => void act(() => drive.reopen(props.doc.id, props.thread.id))}
                  >
                    {ctx.t("drive.comment.reopen")}
                  </Button>
                </ctx.ui.Tooltip>
              </Show>
            </div>
            <Show when={failure()}>{(found) => <Said failure={found()} />}</Show>
          </>
        }
      >
        <Show when={canComment(props.doc)}>
          <Show
            when={replying()}
            fallback={
              <div data-slot="drive-card-row" onClick={(event) => event.stopPropagation()}>
                <Button
                  variant="ghost"
                  size="small"
                  icon="speech-bubble"
                  onClick={() => drive.startReply(props.thread.id)}
                >
                  {ctx.t("drive.comment.reply.open")}
                </Button>
              </div>
            }
          >
            <div data-slot="drive-reply" onClick={(event) => event.stopPropagation()}>
              <Textarea
                ref={(element) => {
                  field = element
                  queueMicrotask(() => element.focus())
                }}
                rows={2}
                surface="layer-1"
                aria-label={ctx.t("drive.comment.reply")}
                placeholder={ctx.t("drive.comment.reply")}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void send()
                  if (event.key === "Escape") drive.cancelReply()
                }}
              />
              <div data-slot="drive-card-row">
                <AgentButton field={() => field} />
                <span data-slot="drive-grow" />
                <Button variant="ghost" size="small" onClick={() => drive.cancelReply()}>
                  {ctx.t("drive.cancel")}
                </Button>
                <Button variant="contrast" size="small" title="⌘↵" disabled={busy()} onClick={() => void send()}>
                  {ctx.t("drive.comment.send")}
                </Button>
              </div>
            </div>
          </Show>
        </Show>
        <Show when={failure()}>{(found) => <Said failure={found()} />}</Show>
      </Show>
    </div>
  )
}

/**
 * What became of a comment that asked for the agent: the chat it went to, or why it went nowhere. A document no chat has
 * used cannot be answered by a chat that does not exist, so it offers to start from one.
 */
function AgentNote(props: { doc: Document; mention: Mention; text: string }) {
  const ctx = usePlugin()
  const chat = () => props.mention.conversation
  const session = () => (chat() === undefined ? undefined : sessionOf(ctx, chat()!))
  return (
    <p
      data-slot="drive-note"
      data-tone={props.mention.outcome === "woken" ? "info" : "warning"}
      onClick={(event) => event.stopPropagation()}
    >
      <Show when={props.mention.outcome === "woken"}>
        {ctx.t("drive.mention.woken", { chat: (chat() && titleOf(ctx, chat()!)) ?? ctx.t("drive.chat.untitled") })}
      </Show>
      <Show when={props.mention.outcome === "failed"}>{ctx.t("drive.mention.failed")}</Show>
      <Show when={props.mention.outcome === "unlinked"}>{ctx.t("drive.mention.unlinked")}</Show>
      <Show when={props.mention.outcome === "woken" && session()}>
        {(open) => (
          <Button variant="ghost" size="small" onClick={() => ctx.tabs.focus(open().tab)}>
            {ctx.t("drive.mention.open")}
          </Button>
        )}
      </Show>
      <Show when={props.mention.outcome === "unlinked"}>
        <Button
          variant="ghost"
          size="small"
          onClick={() => askAgent(ctx, props.doc, ctx.t("drive.ask.doc", { doc: props.doc.name }) + props.text)}
        >
          {ctx.t("drive.useInChat")}
        </Button>
      </Show>
    </p>
  )
}

/** The agent's mention, written into a box. */
function AgentButton(props: { field: () => HTMLTextAreaElement | undefined }) {
  const ctx = usePlugin()
  return (
    <Button
      variant="ghost"
      size="small"
      icon="outline-steer"
      title={ctx.t("drive.comment.mention")}
      onClick={() => {
        const field = props.field()
        if (!field) return
        field.value = `${field.value.trimEnd()}${field.value ? " " : ""}@Agent `
        // What listens to the box hears it, as it hears typing: the comment popup keeps what is written.
        field.dispatchEvent(new Event("input", { bubbles: true }))
        field.focus()
      }}
    >
      @Agent
    </Button>
  )
}

function Said(props: { failure: Failure }) {
  const ctx = usePlugin()
  return (
    <p data-slot="drive-note" data-tone="warning">
      {failureText(ctx, props.failure)}
    </p>
  )
}

/** The new comment in the Comments tab: a card with the comment's form. */
function Composer(props: { doc: Document; anchor: Anchor }) {
  return (
    <div data-slot="drive-thread" data-state="on">
      <CommentForm doc={props.doc} anchor={props.anchor} onCancel={() => drive.cancelComment()} />
    </div>
  )
}

/**
 * A new comment's form, in the Comments tab and in the popup on the document: what it points at, who signs it, the
 * text with the agent's mention, Cancel and Comment. What the Drive refuses shows below it, the text kept to try again.
 * `onSent` hears the new thread; `onInput`, what is written, for a popup that keeps it; `extra` goes beside @Agent.
 */
export function CommentForm(props: {
  doc: Document
  anchor: Anchor
  onCancel: () => void
  onSent?: (thread: string) => void
  onInput?: (text: string) => void
  extra?: JSX.Element
}) {
  const ctx = usePlugin()
  const [failure, setFailure] = createSignal<Failure>()
  const [busy, setBusy] = createSignal(false)
  let field!: HTMLTextAreaElement
  onMount(() => field.focus())
  const send = async () => {
    const text = field.value.trim()
    if (!text) return
    setBusy(true)
    const answer = await drive.comment(props.doc.id, props.anchor, text)
    setBusy(false)
    setFailure(isFailure(answer) ? answer : undefined)
    if (!isFailure(answer)) props.onSent?.(answer.id)
  }
  return (
    <>
      <div data-slot="drive-thread-anchor">
        <Pointing doc={props.doc} anchor={props.anchor} />
      </div>
      <div data-slot="drive-card-who">
        <Avatar name={ctx.t("drive.you")} size="small" />
        <b>{ctx.t("drive.you")}</b>
        <Show when={!drive.person()}>
          <span data-slot="drive-via">{ctx.t("drive.comment.dynwork")}</span>
        </Show>
      </div>
      <Textarea
        ref={field}
        rows={3}
        surface="layer-1"
        aria-label={ctx.t("drive.comment.placeholder")}
        placeholder={ctx.t("drive.comment.placeholder")}
        onInput={(event) => props.onInput?.(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void send()
        }}
      />
      <div data-slot="drive-card-row">
        <AgentButton field={() => field} />
        {props.extra}
        <span data-slot="drive-grow" />
        <Button variant="ghost" size="small" onClick={() => props.onCancel()}>
          {ctx.t("drive.cancel")}
        </Button>
        <Button variant="contrast" size="small" title="⌘↵" disabled={busy()} onClick={() => void send()}>
          {ctx.t("drive.comment")}
        </Button>
      </div>
      <Show when={failure()}>{(found) => <Said failure={found()} />}</Show>
    </>
  )
}

/**
 * Where a new comment goes, when the document cannot be clicked: its paragraphs and cells to search and pick, and a
 * cell range when the instance takes one. A PDF takes none (D22).
 */
function Picker(props: { doc: Document }) {
  const ctx = usePlugin()
  const [query, setQuery] = createSignal("")
  const kinds = () => anchorsOf(props.doc, drive.remote()?.capabilities ?? DriveCapabilities.none)
  const found = () => pickable(drive.nodesOf(props.doc.id), query())
  const pick = (node: Node) => drive.startComment({ kind: "node", node: node.id })
  return (
    <>
      <div data-slot="drive-comments-bar">
        <b>{ctx.t("drive.comment.pick")}</b>
        <span data-slot="drive-grow" />
        <Button variant="ghost" size="small" onClick={() => drive.cancelComment()}>
          {ctx.t("drive.cancel")}
        </Button>
      </div>
      <Show when={props.doc.format === "markdown"}>
        <p data-slot="drive-note">{ctx.t("drive.comment.pick.select")}</p>
      </Show>
      <Show when={kinds().node}>
        <TextInput
          type="search"
          leadingIcon={<Icon name="magnifying-glass" size="small" />}
          value={query()}
          placeholder={ctx.t("drive.comment.pick.search")}
          aria-label={ctx.t("drive.comment.pick.search")}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
        <Show
          when={found().length}
          fallback={
            <p data-slot="drive-note">
              {ctx.t(
                drive.state.discussion[props.doc.id]?.status === "loading"
                  ? "drive.loading"
                  : "drive.comment.pick.none",
              )}
            </p>
          }
        >
          <div data-slot="drive-picks">
            <For each={found().slice(0, SHOWN)}>
              {(node) => (
                <button type="button" data-slot="drive-pick" onClick={() => pick(node)}>
                  {nodeLabel(node, 140)}
                </button>
              )}
            </For>
          </div>
          <Show when={found().length > SHOWN}>
            <p data-slot="drive-note">{ctx.t("drive.comment.pick.more", { count: String(found().length - SHOWN) })}</p>
          </Show>
        </Show>
      </Show>
      <Show when={kinds().range && sheetsOf(drive.nodesOf(props.doc.id)).length > 0}>
        <RangeForm sheets={sheetsOf(drive.nodesOf(props.doc.id))} />
      </Show>
      <Show when={!kinds().node}>
        <p data-slot="drive-note">{ctx.t("drive.comment.pdf.off")}</p>
      </Show>
    </>
  )
}

/**
 * A cell range of a spreadsheet's sheet, once the instance takes a comment there (`rangeComments`): the sheet, when there
 * are several, and an A1 range checked as the instance checks it (`B2` or `B2:D9`, columns to XFD, rows to 1 048 576,
 * the start at the top-left), written upper-case.
 */
function RangeForm(props: { sheets: readonly { node: string; name: string }[] }) {
  const ctx = usePlugin()
  const [range, setRange] = createSignal("")
  const [picked, setPicked] = createSignal<string>()
  const sheet = () => props.sheets.find((item) => item.node === picked()) ?? props.sheets[0]
  const read = () => rangeOf(range())
  const cells = () => {
    const found = read()
    return found && "cells" in found ? found.cells : undefined
  }
  const refused = () => {
    const found = read()
    return found && "refused" in found ? found.refused : undefined
  }
  const send = () => {
    const at = sheet()
    const valid = cells()
    if (at && valid) drive.startComment({ kind: "range", node: at.node, cells: valid })
  }
  return (
    <div data-slot="drive-range">
      <b>{ctx.t("drive.comment.range.title")}</b>
      <Show when={props.sheets.length > 1}>
        <div data-slot="drive-card-row" role="group" aria-label={ctx.t("drive.comment.range.sheet")}>
          <For each={props.sheets}>
            {(item) => (
              <Button
                variant="ghost"
                size="small"
                data-state={item.node === sheet()?.node ? "pressed" : undefined}
                aria-pressed={item.node === sheet()?.node}
                onClick={() => setPicked(item.node)}
              >
                {item.name}
              </Button>
            )}
          </For>
        </div>
      </Show>
      <div data-slot="drive-card-row">
        <TextInput
          value={range()}
          placeholder={ctx.t("drive.comment.range.placeholder")}
          aria-label={ctx.t("drive.comment.range.field", { sheet: sheet()?.name ?? "" })}
          aria-invalid={refused() !== undefined}
          onInput={(event) => setRange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") send()
          }}
        />
        <Button variant="outline" size="small" disabled={!cells()} onClick={send}>
          {ctx.t("drive.comment.range")}
        </Button>
      </div>
      <Show when={refused()}>
        {(why) => (
          <p data-slot="drive-note" data-tone="warning">
            {ctx.t(`drive.comment.range.${why()}`)}
          </p>
        )}
      </Show>
    </div>
  )
}

// The blocks of a Markdown document a comment can point at: a table row is one node of its source, so a row, and not
// its cells, is what a table's comment points at.
const blocks = "p, li, h1, h2, h3, h4, h5, h6, tr"

/** A block's own text: a list item leaves out the lists nested in it, which are blocks of their own. */
const textOf = (element: Element) =>
  [...element.childNodes]
    .filter((child) => !(child instanceof Element && child.matches("ul, ol")))
    .map((child) => child.textContent)
    .join("")

/**
 * The marks and the selection toolbar of a Markdown document, over the element that holds it (the workspace's canvas, a
 * chat's panel): each block the document's nodes name carries its node and, while the user shows the marks, its
 * thread; a click on a marked block opens the thread (`onThread`, else the Comments tab). While the marks show and the
 * user may comment, a selection or a click on another block goes to `onSpot`, which opens the comment popup there. In
 * the workspace (`interactive`) comment mode (C) comments on a block, and with the marks hidden a selection offers the
 * toolbar to comment on it or ask the agent. Keys stay the workspace's: beside a chat, C and Escape are the chat's. It
 * matches the document's blocks to its nodes by their text, in reading order (`matchNodes`).
 */
export function CommentMarks(props: {
  doc: Document
  interactive?: boolean
  onThread?: (thread: string) => void
  onSpot?: (spot: Spot) => void
}) {
  const ctx = usePlugin()
  let mark!: HTMLSpanElement
  const [picked, setPicked] = createSignal<{
    node: Node
    quote: string | undefined
    text: string
    left: number
    top: number
  }>()
  const canvas = () => mark.parentElement
  const host = () => canvas()?.querySelector<HTMLElement>("[data-slot=drive-markdown]")

  const sync = () => {
    const root = host()
    if (!root) return
    const elements = [...root.querySelectorAll<HTMLElement>(blocks)]
    const nodes = drive.nodesOf(props.doc.id)
    const threads = drive.threadsOf(props.doc.id)
    const matched = matchNodes(nodes, elements.map(textOf))
    elements.forEach((element, index) => {
      const node = matched[index]
      const own = node && panes.marks() ? threads.filter((thread) => thread.node === node.id) : []
      const lead = own.find((thread) => thread.open) ?? own[0]
      if (node) element.dataset.node = node.id
      else delete element.dataset.node
      if (lead) element.dataset.thread = lead.id
      else delete element.dataset.thread
      element.toggleAttribute("data-resolved", lead !== undefined && !lead.open)
      element.toggleAttribute("data-on", lead !== undefined && lead.id === drive.state.doc.thread)
    })
  }
  let frame = 0
  const later = () => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(sync)
  }

  const interactive = () => props.interactive !== false
  // A pick goes to the popup while the marks show and the user may comment; the rest is as before.
  const spotting = () => props.onSpot !== undefined && panes.marks() && canComment(props.doc)
  // Where a block or a selection sits, within what the document shows.
  const placed = (rect: DOMRect, root: HTMLElement) => clip(rect, root.getBoundingClientRect()) ?? rect
  createEffect(() => canvas()?.toggleAttribute("data-commenting", interactive() && drive.state.doc.commenting))

  // What the marks depend on: the nodes, the threads, the open one and whether they show.
  createEffect(() => {
    drive.nodesOf(props.doc.id)
    drive.threadsOf(props.doc.id)
    drive.state.doc.thread
    panes.marks()
    later()
  })

  onMount(() => {
    const outer = canvas()
    if (!outer) return
    // The renderer draws after the document is read, and may draw again: the marks follow what it leaves.
    const observer = new MutationObserver(later)
    observer.observe(outer, { childList: true, subtree: true, characterData: true })
    const mouseup = (event: MouseEvent) =>
      setTimeout(() => {
        const target = event.target instanceof Element ? event.target : undefined
        if (target?.closest("[data-slot=drive-selection]")) return
        setPicked(undefined)
        const root = host()
        const selection = window.getSelection()
        if (!root || !selection || selection.isCollapsed || !canComment(props.doc)) return
        const found = selected(selection.getRangeAt(0), root)
        const node = found && drive.nodesOf(props.doc.id).find((item) => item.id === found.node)
        if (!found || !node) return
        const at = found.part.getBoundingClientRect()
        if (spotting()) return props.onSpot?.({ node, quote: found.quote, rect: placed(at, root) })
        if (!interactive()) return
        // The toolbar sits in the canvas, which is not scrolled: the markdown inside it is.
        const outerAt = outer.getBoundingClientRect()
        setPicked({
          node,
          quote: quoteIn(node, found.quote),
          text: found.quote,
          left: Math.max(8, at.left - outerAt.left),
          top: Math.max(8, at.top - outerAt.top - 40),
        })
      }, 0)
    // A click on a marked block opens its thread; with the marks shown, one on any other block opens the popup there,
    // and in comment mode, with them hidden, a comment in the Comments tab.
    const click = (event: MouseEvent) => {
      const root = host()
      if (!root || window.getSelection()?.isCollapsed === false) return
      const found = clicked(event.target instanceof Element ? event.target : undefined, root)
      if (found?.kind === "thread")
        return props.onThread ? props.onThread(found.thread) : drive.focusThread(found.thread)
      if (found?.kind !== "block" || !canComment(props.doc)) return
      const node = drive.nodesOf(props.doc.id).find((item) => item.id === found.node)
      if (spotting() && node) {
        if (interactive() && drive.state.doc.commenting) drive.setCommenting(false)
        return props.onSpot?.({ node, rect: placed(found.block.getBoundingClientRect(), root) })
      }
      if (!interactive() || !drive.state.doc.commenting) return
      drive.setCommenting(false)
      drive.startComment({ kind: "node", node: found.node })
    }
    // C toggles comment mode while no field has the focus; Escape leaves it.
    const keys = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      const typing =
        event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable=true]")
      if (event.key === "Escape" && interactive() && drive.state.doc.commenting) {
        event.preventDefault()
        return drive.setCommenting(false)
      }
      if (!interactive() || typing || event.metaKey || event.ctrlKey || event.altKey || event.key.toLowerCase() !== "c")
        return
      if (canComment(props.doc)) drive.setCommenting(!drive.state.doc.commenting)
    }
    outer.addEventListener("mouseup", mouseup)
    outer.addEventListener("click", click)
    document.addEventListener("keydown", keys)
    onCleanup(() => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      outer.removeEventListener("mouseup", mouseup)
      outer.removeEventListener("click", click)
      document.removeEventListener("keydown", keys)
      outer.removeAttribute("data-commenting")
      if (interactive()) drive.setCommenting(false)
      host()
        ?.querySelectorAll("[data-node], [data-thread]")
        .forEach((element) => {
          element.removeAttribute("data-node")
          element.removeAttribute("data-thread")
        })
    })
  })

  return (
    <>
      <span ref={mark} hidden />
      <Show when={picked()}>
        {(selection) => (
          <div data-slot="drive-selection" style={{ left: `${selection().left}px`, top: `${selection().top}px` }}>
            <Button
              variant="ghost"
              size="small"
              icon="comment"
              onClick={() => {
                drive.startComment({ kind: "node", node: selection().node.id, find: selection().quote })
                window.getSelection()?.removeAllRanges()
                setPicked(undefined)
              }}
            >
              {ctx.t("drive.comment")}
            </Button>
            <Button
              variant="ghost"
              size="small"
              icon="speech-bubble"
              onClick={() => {
                setPicked(undefined)
                askAgent(ctx, props.doc, ctx.t("drive.ask.quote", { doc: props.doc.name, quote: selection().text }))
              }}
            >
              {ctx.t("drive.ask")}
            </Button>
          </div>
        )}
      </Show>
    </>
  )
}
