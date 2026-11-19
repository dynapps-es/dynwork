import { usePlugin, type MountedSession } from "@opencode/plugin/gui"
import { Button } from "@opencode/ui/button"
import { Dialog, DialogBody, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { createEffect, createResource, For, on, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { isFailure, type Document, type Link, type Revision } from "../../drive/contract"
import { uploadFiles } from "./browser"
import { conversationOf, docKey, openInDrive } from "./chat"
import { CommentMarks, MarksToggle, ThreadCard } from "./comments"
import { createPresent, failureText, FormatGlyph, PresentButton, PresentExit, Tag, useNames } from "./parts"
import { drive, governance } from "./store"
import { Viewer } from "./viewer"
import { Sharing } from "./workspace"

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

/**
 * One document beside the chat: its header with its version, the comments marked on it, Share, Present and Open in the
 * Drive, then its viewer. A click on a comment's mark opens its thread in a dialog.
 */
export function DocPanel(props: { session: MountedSession; id: string }) {
  const ctx = usePlugin()
  const names = useNames()
  const doc = () => drive.doc(props.id)
  const key = () => `${props.session.id}:${props.id}`
  let content: HTMLDivElement | undefined
  const present = createPresent(() => content)
  // The comments and nodes the marks need, read again with each new head.
  createEffect(
    on(
      () => drive.client() && doc()?.revision,
      (revision) => {
        if (revision) void drive.discuss(props.id)
      },
    ),
  )
  const thread = (found: Document, id: string) => ctx.dialogs.open(() => <ThreadDialog doc={found} thread={id} />)
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
            <MarksToggle doc={found()} />
            <Show when={governance(found().id)}>
              <ctx.ui.Tooltip value={ctx.t("drive.share.hint")} placement="bottom">
                <ctx.ui.IconButton
                  icon="outline-share"
                  label={ctx.t("drive.tab.share")}
                  onClick={() => {
                    // The dialog renders apart from this header: it takes the document as it is now.
                    const shared = found()
                    ctx.dialogs.open(() => <ShareDialog doc={shared} />)
                  }}
                />
              </ctx.ui.Tooltip>
            </Show>
            <PresentButton present={present} />
            <ctx.ui.Tooltip value={ctx.t("drive.panel.open")} placement="bottom">
              <ctx.ui.IconButton
                icon="square-arrow-top-right"
                label={ctx.t("drive.panel.open")}
                onClick={() => openInDrive(ctx, props.session, props.id)}
              />
            </ctx.ui.Tooltip>
          </div>
          <div ref={content} data-slot="drive-panel-content" data-format={found().format}>
            <Viewer
              doc={found()}
              revision={shown() > 0 ? picks[key()] : undefined}
              onMark={(id) => thread(found(), id)}
            />
            <Show when={found().format === "markdown" && shown() <= 0}>
              <CommentMarks doc={found()} interactive={false} onThread={(id) => thread(found(), id)} />
            </Show>
            <PresentExit present={present} />
          </div>
        </div>
      )}
    </Show>
  )
}

/** A thread picked on a document beside a chat: read, reply and resolve, as in the Drive's Comments tab. */
function ThreadDialog(props: { doc: Document; thread: string }) {
  const ctx = usePlugin()
  const thread = () => drive.threadsOf(props.doc.id).find((item) => item.id === props.thread)
  return (
    <Dialog>
      <DialogHeader>
        <DialogTitleGroup title={ctx.t("drive.tab.comments")} description={props.doc.name} />
      </DialogHeader>
      <DialogBody>
        <div data-component="drive-dialog">
          <Show when={thread()} fallback={<p data-slot="drive-note">{ctx.t("drive.comment.gone")}</p>}>
            {(found) => <ThreadCard doc={props.doc} thread={found()} />}
          </Show>
        </div>
      </DialogBody>
    </Dialog>
  )
}

/**
 * The document's Share tab beside a chat: who can see it and what agents may do, read when it opens. A part the Drive
 * does not answer is left out, as the drawer's tab does.
 */
function ShareDialog(props: { doc: Document }) {
  const ctx = usePlugin()
  const [read] = createResource(
    () => drive.client(),
    async (client) => {
      const [access, cap] = await Promise.all([
        client.access({ id: props.doc.id }),
        client.agentCap({ kind: "document", id: props.doc.id }),
      ])
      return { access: isFailure(access) ? undefined : access, cap: isFailure(cap) ? undefined : cap }
    },
  )
  return (
    <Dialog>
      <DialogHeader>
        <DialogTitleGroup title={ctx.t("drive.tab.share")} description={props.doc.name} />
      </DialogHeader>
      <DialogBody>
        <div data-component="drive-dialog">
          <Show when={read()} fallback={<p data-slot="drive-note">{ctx.t("drive.loading")}</p>}>
            {(found) => <Sharing doc={props.doc} access={found().access} cap={found().cap} />}
          </Show>
        </div>
      </DialogBody>
    </Dialog>
  )
}
