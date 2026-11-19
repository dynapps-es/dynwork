import { usePlugin, type MountedSession } from "@opencode/plugin/gui"
import { builtinContext } from "@opencode/plugin/gui/builtin"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { createEffect, createResource, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { isFailure, type Link, type Revision } from "../../drive/contract"
import { uploadFiles } from "./browser"
import { conversationOf, docKey } from "./chat"
import { failureText, FormatGlyph, Tag, useNames } from "./parts"
import { drive } from "./store"
import { Viewer } from "./viewer"

// The Drive beside a chat (a side panel tab, as Claude's artifacts): the documents the chat made, changed or attached,
// newest first, from the conversation ↔ document index, and one tab per document with its viewer and a version picker.
// A document opens in the Drive view for the rest.

/** What a change's card says it did. */
const actKey = {
  created: "drive.card.created",
  edited: "drive.card.edited",
  proposed: "drive.card.proposed",
  attached: "drive.card.attached",
  read: "drive.card.read",
} as const

/** The chat's artifacts: a card per change, Add from the Drive, and Upload to the Drive for a file the chat made. */
export function ArtifactsPanel(props: { session: MountedSession }) {
  const ctx = usePlugin()
  const names = useNames()
  const links = () => drive.artifactsOf(props.session.id)
  let input: HTMLInputElement | undefined
  // The index names documents no listing may hold yet.
  createEffect(() => void drive.learn(links().map((link) => link.document)))
  const add = async () => {
    const id = await ctx.dialogs.select({
      title: ctx.t("drive.panel.add"),
      placeholder: ctx.t("drive.search"),
      options: (drive.remote()?.documents ?? []).map((doc) => ({
        title: doc.name,
        value: doc.id,
        description: names.path(doc.folder),
      })),
    })
    if (!id) return
    const linked = await drive.link(props.session.id, id, "attached")
    if (linked) return ctx.toast.show({ title: failureText(ctx, linked), variant: "error" })
    ctx.layout.open(docKey(id), props.session, { tab: "select" })
  }
  return (
    <div data-component="drive-panel">
      <div data-slot="drive-panel-head">
        <Icon name="file-document" size="small" />
        <b>{ctx.t("drive.panel.title")}</b>
        <span data-slot="drive-grow" />
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const files = [...(event.currentTarget.files ?? [])]
            event.currentTarget.value = ""
            void uploadFiles(ctx, files, conversationOf(ctx, props.session))
          }}
        />
        <Button
          variant="ghost"
          size="small"
          icon="cloud-upload"
          title={ctx.t("drive.panel.upload.hint")}
          onClick={() => input?.click()}
        >
          {ctx.t("drive.panel.upload")}
        </Button>
        <Button variant="ghost" size="small" icon="plus" onClick={() => void add()}>
          {ctx.t("drive.panel.add")}
        </Button>
      </div>
      <div data-slot="drive-panel-body">
        <Show
          when={links().length}
          fallback={
            <div data-slot="drive-panel-empty">
              <p>{ctx.t("drive.panel.empty")}</p>
            </div>
          }
        >
          <For each={links()}>{(link) => <ChangeCard link={link} session={props.session} />}</For>
          <p data-slot="drive-note">{ctx.t("drive.panel.note")}</p>
        </Show>
      </div>
    </div>
  )
}

/** A change as a card: the document, what the chat did and when, its folder. Click opens it beside the chat. */
export function ChangeCard(props: { link: Link; session: MountedSession }) {
  const ctx = usePlugin()
  const names = useNames()
  return (
    <Show when={drive.doc(props.link.document)}>
      {(found) => (
        <button
          type="button"
          data-slot="drive-change"
          onClick={() => ctx.layout.open(docKey(found().id), props.session, { tab: "select" })}
        >
          <FormatGlyph format={found().format} size="large" />
          <span data-slot="drive-change-body">
            <span data-slot="drive-change-title">{found().name}</span>
            <span data-slot="drive-change-meta">
              <Tag tone={props.link.act === "proposed" ? "warning" : props.link.act === "created" ? "agent" : "info"}>
                {ctx.t(actKey[props.link.act])}
              </Tag>
              <span data-slot="drive-faint">{names.ago(props.link.at)}</span>
              <span data-slot="drive-faint">{names.path(found().folder)}</span>
            </span>
          </span>
          <Icon name="layout-right" size="small" />
        </button>
      )}
    </Show>
  )
}

// The version each document tab shows, by chat and document; none is the head. The tabs of a panel share one render, so
// the choice lives here and not in it.
const [picks, setPicks] = createStore<Record<string, string | undefined>>({})

/** One document beside the chat: its header with its version and Open in the Drive, then its viewer. */
export function DocPanel(props: { session: MountedSession; id: string }) {
  const ctx = usePlugin()
  const names = useNames()
  const doc = () => drive.doc(props.id)
  const key = () => `${props.session.id}:${props.id}`
  // Read again when the document gets a new head; the source is a string so a new object for it reads nothing.
  const [revisions] = createResource(
    () => drive.client() && `${props.id}:${doc()?.revision ?? ""}`,
    () => drive.client()?.revisions({ id: props.id }),
  )
  const list = (): readonly Revision[] => {
    const answer = revisions()
    return answer && !isFailure(answer) ? answer : []
  }
  // The picked version while the Drive still lists it, else the head.
  const shown = () => list().findIndex((revision) => revision.id === picks[key()])
  const label = (index: number) =>
    index <= 0
      ? `${ctx.t("drive.rev", { rev: String(list().length) })} · ${ctx.t("drive.version.current")}`
      : ctx.t("drive.rev", { rev: String(list().length - index) })
  const toDrive = () => {
    void drive.openDoc(props.id)
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
                {names.path(found().folder)} · {names.ago(found().updated)}
              </span>
            </div>
            <Show when={list().length > 1}>
              <ctx.ui.Menu
                label={label(shown())}
                trigger="button"
                placement="bottom-end"
                items={list().map((revision, index) => ({
                  label: label(index),
                  icon: index === Math.max(shown(), 0) ? "check-small" : undefined,
                  onSelect: () => setPicks(key(), index === 0 ? undefined : revision.id),
                }))}
              />
            </Show>
            <IconButton
              type="button"
              variant="ghost-muted"
              icon={<Icon name="square-arrow-top-right" size="small" />}
              aria-label={ctx.t("drive.panel.open")}
              title={ctx.t("drive.panel.open")}
              onClick={toDrive}
            />
          </div>
          <div data-slot="drive-panel-content" data-format={found().format}>
            <Viewer doc={found()} revision={shown() > 0 ? picks[key()] : undefined} />
          </div>
        </div>
      )}
    </Show>
  )
}
