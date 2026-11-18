import { usePlugin, type MountedSession } from "@opencode/plugin/gui"
import { builtinContext } from "@opencode/plugin/gui/builtin"
import { DockPrompt } from "@opencode/session-ui/dock-prompt"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { createEffect, For, Match, onCleanup, Show, Switch } from "solid-js"
import { Deck, HtmlFrame, paperHtml, pdfHtml, Sheet } from "./canvas"
import { docKey } from "./chat"
import type { Change, Doc } from "./demo"
import { ClassTag, FormatGlyph, Tag, useNames } from "./parts"
import { drive } from "./store"
import { DemoBadge } from "../shell"

// The Drive beside a chat (a side panel tab, as Claude's artifacts): the chat's artifacts in the order its agent made
// or changed them, and one tab per document with its versions. A document opens in the Drive view to comment on it.

/** What a change's card says it did. */
const actKey = {
  created: "drive.card.created",
  edited: "drive.card.edited",
  proposed: "drive.card.proposed",
  attached: "drive.card.attached",
  read: "drive.card.read",
} as const

/** The chat's artifacts: a card per change, Add from the Drive, and the sample conversation for an empty chat. */
export function ArtifactsPanel(props: { session: MountedSession }) {
  const ctx = usePlugin()
  const names = useNames()
  const chat = () => drive.chat(props.session.key)
  const add = async () => {
    const id = await ctx.dialogs.select({
      title: ctx.t("drive.panel.add"),
      placeholder: ctx.t("drive.search"),
      options: drive.state.docs.map((doc) => ({
        title: doc.name,
        value: doc.id,
        description: names.path(doc.folder),
      })),
    })
    const doc = drive.doc(id)
    if (!doc) return
    drive.attach(props.session.key, doc.id)
    ctx.layout.open(docKey(doc.id), props.session, { tab: "select" })
  }
  return (
    <div data-component="drive-panel">
      <div data-slot="drive-panel-head">
        <Icon name="file-document" size="small" />
        <b>{ctx.t("drive.panel.title")}</b>
        <DemoBadge />
        <span data-slot="drive-grow" />
        <Button variant="ghost" size="small" icon="plus" onClick={() => void add()}>
          {ctx.t("drive.panel.add")}
        </Button>
      </div>
      <div data-slot="drive-panel-body">
        <Show
          when={chat().changes.length}
          fallback={
            <div data-slot="drive-panel-empty">
              <p>{ctx.t("drive.panel.empty")}</p>
              <Button variant="contrast" icon="download" onClick={() => drive.loadSample(props.session.key)}>
                {ctx.t("drive.panel.sample")}
              </Button>
            </div>
          }
        >
          <For each={chat().changes}>{(change) => <ChangeCard change={change} session={props.session} />}</For>
          <p data-slot="drive-note">{ctx.t("drive.panel.note")}</p>
        </Show>
      </div>
    </div>
  )
}

/** A change as a card: the document, what the agent did and the version, its folder. Click opens it beside the chat. */
export function ChangeCard(props: { change: Change; session: MountedSession }) {
  const ctx = usePlugin()
  const names = useNames()
  const doc = () => drive.doc(props.change.doc)
  return (
    <Show when={doc()}>
      {(found) => (
        <button
          type="button"
          data-slot="drive-change"
          onClick={() => {
            drive.setVersion(
              props.session.key,
              found().id,
              props.change.rev === found().rev ? undefined : props.change.rev,
            )
            ctx.layout.open(docKey(found().id), props.session, { tab: "select" })
          }}
        >
          <FormatGlyph format={found().format} size="large" />
          <span data-slot="drive-change-body">
            <span data-slot="drive-change-title">{found().name}</span>
            <span data-slot="drive-change-meta">
              <Tag
                tone={props.change.act === "proposed" ? "warning" : props.change.act === "created" ? "agent" : "info"}
              >
                {ctx.t(actKey[props.change.act])}
              </Tag>
              <span data-slot="drive-version-pill">
                {props.change.from ? `v${props.change.from} → ` : ""}v{props.change.rev}
              </span>
              <span data-slot="drive-faint">{names.path(found().folder)}</span>
            </span>
          </span>
          <Icon name="layout-right" size="small" />
        </button>
      )}
    </Show>
  )
}

/** One document beside the chat: its header with versions, comments and Open in the Drive, then its content. */
export function DocPanel(props: { session: MountedSession; id: string }) {
  const ctx = usePlugin()
  const names = useNames()
  const doc = () => drive.doc(props.id)
  const revs = () => (drive.state.versions[props.id] ?? [{ rev: doc()?.rev ?? 1 }]).map((version) => version.rev)
  const shown = () => drive.chat(props.session.key).version[props.id] ?? doc()?.rev
  const open = () => drive.threadsOf(props.id).filter((thread) => thread.open).length
  const toDrive = (thread?: string) => {
    drive.openDoc(props.id, "comments")
    if (thread) drive.focusThread(thread)
    builtinContext(ctx).layout.page("drive")
  }
  return (
    <Show when={doc()}>
      {(found) => (
        <div data-component="drive-panel" data-doc="">
          <div data-slot="drive-panel-head">
            <FormatGlyph format={found().format} size="large" />
            <div data-slot="drive-panel-meta">
              <span data-slot="drive-panel-title">{found().name}</span>
              <span data-slot="drive-faint">
                {names.path(found().folder)} · <ClassTag cls={found().cls} />
              </span>
            </div>
            <select
              data-slot="drive-level"
              aria-label={ctx.t("drive.panel.version")}
              value={String(shown())}
              onChange={(event) => {
                const rev = Number(event.currentTarget.value)
                drive.setVersion(props.session.key, props.id, rev === found().rev ? undefined : rev)
              }}
            >
              <For each={revs()}>
                {(rev) => (
                  <option value={String(rev)} selected={rev === shown()}>
                    v{rev}
                    {rev === found().rev ? ` · ${ctx.t("drive.version.current")}` : ""}
                  </option>
                )}
              </For>
            </select>
            <IconButton
              type="button"
              variant="ghost-muted"
              icon={<Icon name="comment" size="small" />}
              aria-label={ctx.t("drive.tab.comments")}
              title={ctx.t("drive.tab.comments")}
              onClick={() => toDrive()}
            />
            <Show when={open()}>
              <span data-slot="drive-faint">{open()}</span>
            </Show>
            <IconButton
              type="button"
              variant="ghost-muted"
              icon={<Icon name="square-arrow-top-right" size="small" />}
              aria-label={ctx.t("drive.panel.open")}
              title={ctx.t("drive.panel.open")}
              onClick={() => toDrive()}
            />
          </div>
          <Show when={shown() !== found().rev}>
            <div data-slot="drive-banner" data-tone="warning">
              <Icon name="outline-reset" size="small" />
              <span data-slot="drive-grow">{ctx.t("drive.panel.old", { rev: String(shown()) })}</span>
              <Button
                variant="ghost"
                size="small"
                onClick={() => drive.setVersion(props.session.key, props.id, undefined)}
              >
                {ctx.t("drive.panel.current")}
              </Button>
            </div>
          </Show>
          <div
            data-slot="drive-panel-content"
            data-format={found().format}
            onClick={(event) => {
              const id = (event.target as HTMLElement).closest<HTMLElement>("[data-t]")?.dataset.t
              if (id) toDrive(id)
            }}
          >
            <Compact doc={found()} />
          </div>
        </div>
      )}
    </Show>
  )
}

function Compact(props: { doc: Doc }) {
  const ctx = usePlugin()
  const names = useNames()
  let paper: HTMLDivElement | undefined
  // A resolved thread's quote stays in the text without its highlight, as in the view.
  createEffect(() => {
    const threads = drive.threadsOf(props.doc.id)
    drive.state.paper[props.doc.id]
    queueMicrotask(() =>
      paper
        ?.querySelectorAll<HTMLElement>("[data-t]")
        .forEach((element) =>
          element.toggleAttribute(
            "data-resolved",
            threads.find((thread) => thread.id === element.dataset.t)?.open === false,
          ),
        ),
    )
  })
  return (
    <Switch>
      <Match when={props.doc.format === "docx" || props.doc.format === "markdown"}>
        <div
          ref={paper}
          data-slot="drive-paper"
          data-compact=""
          innerHTML={paperHtml(props.doc, names.path(props.doc.folder), ctx.t)}
        />
      </Match>
      <Match when={props.doc.format === "pdf"}>
        <div data-slot="drive-pdf" data-compact="" innerHTML={pdfHtml(props.doc)} />
      </Match>
      <Match when={props.doc.format === "xlsx"}>
        <Sheet doc={props.doc} compact />
      </Match>
      <Match when={props.doc.format === "pptx"}>
        <Deck doc={props.doc} compact />
      </Match>
      <Match when={props.doc.format === "html"}>
        <HtmlFrame
          doc={props.doc}
          anchors={() =>
            drive
              .threadsOf(props.doc.id)
              .flatMap((thread) =>
                thread.open && thread.anchor.kind === "element"
                  ? [{ id: thread.id, find: thread.anchor.find, on: false }]
                  : [],
              )
          }
        />
      </Match>
    </Switch>
  )
}

/**
 * The agent's pending overwrite, where the composer is, as OpenCode's permission dock: Allow writes a new revision
 * (the current one stays in the history), Deny leaves the document alone.
 */
export function OverwriteDock(props: { session: MountedSession }) {
  const ctx = usePlugin()
  const doc = () => drive.doc("d2")
  const keys = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return
    event.preventDefault()
    drive.settleDock(props.session.key, true)
  }
  document.addEventListener("keydown", keys)
  onCleanup(() => document.removeEventListener("keydown", keys))
  return (
    <DockPrompt
      kind="permission"
      header={
        <div data-slot="permission-row" data-variant="header">
          <span data-slot="permission-icon">
            <Icon name="warning" size="normal" />
          </span>
          <div data-slot="permission-header-title">{ctx.t("drive.dock.title")}</div>
        </div>
      }
      footer={
        <>
          <div />
          <div data-slot="permission-footer-actions">
            <Button variant="ghost" size="normal" onClick={() => drive.settleDock(props.session.key, false)}>
              {ctx.t("drive.dock.deny")}
            </Button>
            <Button variant="submit" size="normal" onClick={() => drive.settleDock(props.session.key, true)}>
              {ctx.t("drive.dock.allow")}
              <kbd data-slot="proposal-key">⌘↵</kbd>
            </Button>
          </div>
        </>
      }
    >
      <div data-slot="permission-row">
        <span data-slot="permission-spacer" aria-hidden="true" />
        <div data-slot="permission-hint">
          {ctx.t("drive.dock.description", {
            doc: doc()?.name ?? "",
            rev: String(doc()?.rev ?? 0),
            next: String((doc()?.rev ?? 0) + 1),
          })}
        </div>
      </div>
    </DockPrompt>
  )
}
