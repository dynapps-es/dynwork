import { usePlugin, type Context } from "@opencode/plugin/gui"
import { Button } from "@opencode/ui/button"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Tabs } from "@opencode/ui/tabs"
import { TextInput } from "@opencode/ui/text-input"
import { createSignal, For, Match, Show, Switch } from "solid-js"
import { isFailure, type Conversation, type Document, type Folder } from "../../drive/contract"
import { askAgent, titleOf } from "./chat"
import { byConversation, highlight, pathOf, scopes, typeFilters, type Format } from "./model"
import { failureText, FormatGlyph, Level, Tag, Thumb, useNames } from "./parts"
import { RowMenu } from "./menus"
import { LinkedChats } from "./workspace"
import { drive, type Upload } from "./store"

// The Drive's browser: scopes, type filters, folders and documents as a list or a grid, the conversations' documents,
// and the selected document's preview, over the account's Drive.

const browse = () => drive.state.browse

/** The header's actions: search, Upload and New. */
export function BrowserActions() {
  const ctx = usePlugin()
  let input: HTMLInputElement | undefined
  return (
    <>
      <TextInput
        type="search"
        class="drive-search"
        leadingIcon={<Icon name="magnifying-glass" size="small" />}
        value={browse().query}
        placeholder={ctx.t("drive.search")}
        aria-label={ctx.t("drive.search")}
        onInput={(event) => void drive.setQuery(event.currentTarget.value)}
      />
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])]
          event.currentTarget.value = ""
          void uploadFiles(ctx, files)
        }}
      />
      <Button variant="outline" icon="cloud-upload" onClick={() => input?.click()}>
        {ctx.t("drive.upload")}
      </Button>
      <Button
        variant="contrast"
        icon="plus"
        onClick={() => ctx.dialogs.open((dialog) => <NewDialog close={dialog.close} />)}
      >
        {ctx.t("drive.new")}
      </Button>
    </>
  )
}

type Ctx = Pick<Context, "toast" | "t">

/**
 * Uploads files picked or dropped: each one becomes a document in the open folder, or, from a chat, at the Drive's root
 * with that conversation's attribution. A toast follows each one.
 */
export async function uploadFiles(ctx: Ctx, files: readonly File[], conversation?: Conversation) {
  await Promise.all(
    files.map(async (file) => {
      const progress = ctx.toast.show({
        title: ctx.t("drive.upload.progress", { name: file.name }),
        variant: "loading",
        persistent: true,
      })
      const upload: Upload = { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), mime: file.type }
      const created = await drive.upload(upload, conversation)
      progress.dismiss()
      if (isFailure(created))
        return ctx.toast.show({
          title: ctx.t("drive.upload.failed", { name: file.name }),
          description: failureText(ctx, created),
          variant: "error",
        })
      const path = [ctx.t("drive.title"), ...pathOf(drive.folders(), created.document.folder).map((item) => item.name)]
      ctx.toast.show({
        title: ctx.t("drive.upload.done", { name: file.name }),
        description: path.join(" › "),
        variant: "success",
      })
    }),
  )
}

export function Browser() {
  const ctx = usePlugin()
  const names = useNames()
  const [dropping, setDropping] = createSignal(false)
  const atRoot = () =>
    browse().scope === "home" && !browse().folder && !browse().query.trim() && browse().type === "all"
  const target = () => drive.folder(drive.target())?.name ?? ctx.t("drive.title")

  return (
    <div data-slot="drive-browser">
      <div data-slot="drive-toolbar">
        <Tabs
          variant="pill"
          value={browse().scope}
          onChange={(value) => void drive.setScope(scopes.find((scope) => scope === value) ?? "home")}
        >
          <Tabs.List aria-label={ctx.t("drive.scope")}>
            <For each={scopes}>
              {(scope) => <Tabs.Trigger value={scope}>{ctx.t(`drive.scope.${scope}`)}</Tabs.Trigger>}
            </For>
          </Tabs.List>
        </Tabs>
        <div data-slot="drive-chips">
          <For each={typeFilters}>
            {(type) => (
              <button
                type="button"
                data-slot="drive-chip"
                aria-pressed={browse().type === type}
                onClick={() => drive.setType(type)}
              >
                <Show when={type !== "all"}>
                  <FormatGlyph format={type} />
                </Show>
                {ctx.t(`drive.type.${type}`)}
              </button>
            )}
          </For>
        </div>
        <span data-slot="drive-grow" />
        <Button variant="ghost" size="small" icon="selector" onClick={() => drive.nextSort()}>
          {ctx.t("drive.sort", { by: ctx.t(`drive.sort.${browse().sort}`) })}
        </Button>
        <div data-slot="drive-views" role="group" aria-label={ctx.t("drive.view")}>
          <IconButton
            type="button"
            variant="ghost-muted"
            size="small"
            icon={<Icon name="bullet-list" size="small" />}
            state={browse().view === "list" ? "pressed" : undefined}
            aria-pressed={browse().view === "list"}
            aria-label={ctx.t("drive.view.list")}
            title={ctx.t("drive.view.list")}
            onClick={() => drive.setView("list")}
          />
          <IconButton
            type="button"
            variant="ghost-muted"
            size="small"
            icon={<Icon name="dot-grid" size="small" />}
            state={browse().view === "grid" ? "pressed" : undefined}
            aria-pressed={browse().view === "grid"}
            aria-label={ctx.t("drive.view.grid")}
            title={ctx.t("drive.view.grid")}
            onClick={() => drive.setView("grid")}
          />
        </div>
      </div>

      <Status />

      <div data-slot="drive-browser-body">
        <div
          data-slot="drive-main"
          data-dropping={dropping() ? "" : undefined}
          onDragOver={(event) => {
            event.preventDefault()
            setDropping(true)
          }}
          onDragLeave={() => setDropping(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDropping(false)
            const files = [...(event.dataTransfer?.files ?? [])]
            if (files.length) void uploadFiles(ctx, files)
          }}
        >
          <Show when={browse().scope === "home" && browse().folder && !browse().query.trim()}>
            <div data-slot="drive-crumbs">
              <button type="button" onClick={() => void drive.goFolder(undefined)}>
                {ctx.t("drive.title")}
              </button>
              <For each={pathOf(drive.folders(), browse().folder)}>
                {(folder, index) => (
                  <>
                    <Icon name="chevron-right" size="small" />
                    <Show
                      when={index() < pathOf(drive.folders(), browse().folder).length - 1}
                      fallback={<b>{folder.name}</b>}
                    >
                      <button type="button" onClick={() => void drive.goFolder(folder.id)}>
                        {folder.name}
                      </button>
                    </Show>
                  </>
                )}
              </For>
            </div>
          </Show>
          <Show when={atRoot() && (drive.remote()?.documents.length ?? 0) > 0}>
            <div data-slot="drive-section">
              <Icon name="outline-reset" size="small" />
              {ctx.t("drive.recent")}
            </div>
            <div data-slot="drive-quick">
              <For each={(drive.remote()?.documents ?? []).slice(0, 4)}>
                {(doc) => <Card doc={doc} meta={`${names.owner(doc)} · ${names.ago(doc.updated)}`} />}
              </For>
            </div>
            <div data-slot="drive-section">
              <Icon name="folder" size="small" />
              {ctx.t("drive.loose")}
            </div>
          </Show>
          <Switch>
            <Match when={browse().scope === "chats" && !browse().query.trim()}>
              <ByChat />
            </Match>
            <Match when={drive.state.listing.status === "loading" && drive.shown().length === 0}>
              <div data-slot="drive-empty">{ctx.t("drive.loading")}</div>
            </Match>
            <Match when={drive.shown().length === 0 && drive.shownFolders().length === 0}>
              <div data-slot="drive-empty">
                {browse().query.trim()
                  ? ctx.t("drive.empty.search", { query: browse().query.trim() })
                  : ctx.t("drive.empty.folder")}
              </div>
            </Match>
            <Match when={browse().view === "list"}>
              <FileTable docs={drive.shown()} folders={drive.shownFolders()} />
            </Match>
            <Match when={true}>
              <div data-slot="drive-grid">
                <For each={drive.shownFolders()}>
                  {(folder) => (
                    <button
                      type="button"
                      data-slot="drive-card"
                      data-kind="folder"
                      onClick={() => void drive.goFolder(folder.id)}
                    >
                      <Thumb />
                      <span data-slot="drive-card-name">
                        <FormatGlyph format="folder" />
                        {folder.name}
                      </span>
                      <span data-slot="drive-card-meta">{names.ago(folder.updated)}</span>
                    </button>
                  )}
                </For>
                <For each={drive.shown()}>
                  {(doc) => <Card doc={doc} meta={`${names.owner(doc)} · ${names.ago(doc.updated)}`} />}
                </For>
              </div>
            </Match>
          </Switch>
          <Show when={drive.state.listing.next && browse().scope !== "chats"}>
            <div data-slot="drive-row-actions">
              <Button variant="ghost" size="small" onClick={() => void drive.more()}>
                {ctx.t("drive.more.load")}
              </Button>
            </div>
          </Show>
          <Show when={dropping()}>
            <div data-slot="drive-drop">{ctx.t("drive.drop", { folder: target() })}</div>
          </Show>
        </div>
        <Show when={drive.doc(browse().selected)}>{(doc) => <Preview doc={doc()} />}</Show>
      </div>
    </div>
  )
}

/** Why the Drive shows less than it should: no account, Governance away, or a listing that failed. */
function Status() {
  const ctx = usePlugin()
  const message = () => {
    const status = drive.status()
    if (status === "none") return ctx.t("drive.status.none")
    if (status === "signed-out") return ctx.t("drive.status.signed-out")
    if (status === "unreachable") return ctx.t("drive.status.unreachable")
    const failure = drive.state.listing.failure
    return failure ? failureText(ctx, failure) : undefined
  }
  return (
    <Show when={message()}>
      {(text) => (
        <div data-slot="drive-banner" data-tone="warning">
          <Icon name="warning" size="small" />
          <span data-slot="drive-grow">{text()}</span>
          <Show when={drive.status() !== "none"}>
            <Button variant="ghost" size="small" onClick={() => void drive.reload()}>
              {ctx.t("drive.retry")}
            </Button>
          </Show>
        </div>
      )}
    </Show>
  )
}

function Card(props: { doc: Document; meta: string }) {
  return (
    <button
      type="button"
      data-slot="drive-card"
      data-state={browse().selected === props.doc.id ? "selected" : undefined}
      onClick={() => drive.select(props.doc.id)}
      onDblClick={() => void drive.openDoc(props.doc.id)}
    >
      <Thumb doc={props.doc} />
      <span data-slot="drive-card-name">
        <FormatGlyph format={props.doc.format} />
        <Name name={props.doc.name} />
      </span>
      <span data-slot="drive-card-meta">{props.meta}</span>
    </button>
  )
}

/** A name with the search match marked. */
function Name(props: { name: string }) {
  const parts = () => highlight(props.name, browse().query)
  return (
    <span data-slot="drive-name">
      {parts().before}
      <Show when={parts().match}>
        <mark>{parts().match}</mark>
      </Show>
      {parts().after}
    </span>
  )
}

/** The conversation that made a document, from the index: its chat's title while its tab is open. */
function Origin(props: { doc: Document }) {
  const ctx = usePlugin()
  const made = () => drive.links().find((link) => link.document === props.doc.id && link.act === "created")
  return (
    <Show when={made()} fallback={<span data-slot="drive-faint">—</span>}>
      {(link) => (
        <span data-slot="drive-origin">
          <Icon name="speech-bubble" size="small" />
          {titleOf(ctx, link().conversation) ?? ctx.t("drive.chat.untitled")}
        </span>
      )}
    </Show>
  )
}

function FileTable(props: { docs: readonly Document[]; folders: readonly Folder[] }) {
  const ctx = usePlugin()
  const names = useNames()
  return (
    <table data-slot="drive-files">
      <thead>
        <tr>
          <th>{ctx.t("drive.col.name")}</th>
          <th>{ctx.t("drive.col.owner")}</th>
          <th>{ctx.t("drive.col.access")}</th>
          <th>{ctx.t("drive.col.origin")}</th>
          <th>{ctx.t("drive.col.updated")}</th>
          <th />
        </tr>
      </thead>
      <tbody>
        <For each={props.folders}>
          {(folder) => (
            <tr data-slot="drive-row" onClick={() => void drive.goFolder(folder.id)}>
              <td>
                <div data-slot="drive-name-cell">
                  <FormatGlyph format="folder" />
                  <span data-slot="drive-name">{folder.name}</span>
                </div>
              </td>
              <td>{names.owner(folder)}</td>
              <td data-slot="drive-faint">—</td>
              <td data-slot="drive-faint">—</td>
              <td>{names.ago(folder.updated)}</td>
              <td />
            </tr>
          )}
        </For>
        <For each={props.docs}>
          {(doc) => (
            <tr
              data-slot="drive-row"
              aria-selected={browse().selected === doc.id}
              onClick={() => drive.select(doc.id)}
              onDblClick={() => void drive.openDoc(doc.id)}
            >
              <td>
                <div data-slot="drive-name-cell">
                  <FormatGlyph format={doc.format} />
                  <Name name={doc.name} />
                </div>
              </td>
              <td>{names.owner(doc)}</td>
              <td>
                <Show when={doc.access} fallback={<span data-slot="drive-faint">—</span>}>
                  {(access) => <Level level={access()} />}
                </Show>
              </td>
              <td>
                <Origin doc={doc} />
              </td>
              <td>{names.ago(doc.updated)}</td>
              <td data-slot="drive-row-menu">
                <RowMenu doc={doc} />
              </td>
            </tr>
          )}
        </For>
      </tbody>
    </table>
  )
}

/** "From my chats": each conversation with the documents it made, changed or attached, from the local index. */
function ByChat() {
  const ctx = usePlugin()
  const names = useNames()
  const groups = () =>
    byConversation(drive.links())
      .map((group) => ({
        ...group,
        documents: group.documents.flatMap((entry) => {
          const doc = drive.doc(entry.document)
          return doc && (browse().type === "all" || doc.format === browse().type) ? [{ doc, acts: entry.acts }] : []
        }),
      }))
      .filter((group) => group.documents.length)
  return (
    <Show when={groups().length} fallback={<div data-slot="drive-empty">{ctx.t("drive.chats.empty")}</div>}>
      <For each={groups()}>
        {(group) => (
          <div data-slot="drive-chat-group">
            <div data-slot="drive-section">
              <Icon name="speech-bubble" size="small" />
              <b>{titleOf(ctx, group.conversation) ?? ctx.t("drive.chat.untitled")}</b>
              <span data-slot="drive-faint">
                {ctx.t(group.documents.length === 1 ? "drive.items.one" : "drive.items", {
                  count: String(group.documents.length),
                })}
              </span>
            </div>
            <table data-slot="drive-files" data-compact="">
              <tbody>
                <For each={group.documents}>
                  {(entry) => (
                    <tr
                      data-slot="drive-row"
                      aria-selected={browse().selected === entry.doc.id}
                      onClick={() => drive.select(entry.doc.id)}
                      onDblClick={() => void drive.openDoc(entry.doc.id)}
                    >
                      <td>
                        <div data-slot="drive-name-cell">
                          <FormatGlyph format={entry.doc.format} />
                          <span data-slot="drive-name">{entry.doc.name}</span>
                        </div>
                      </td>
                      <td>
                        <Tag tone="agent">{entry.acts.map((act) => ctx.t(`drive.card.${act}`)).join(" · ")}</Tag>
                      </td>
                      <td data-slot="drive-faint">{names.path(entry.doc.folder)}</td>
                      <td>{names.ago(entry.doc.updated)}</td>
                      <td data-slot="drive-row-menu">
                        <RowMenu doc={entry.doc} />
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        )}
      </For>
    </Show>
  )
}

/** The selected document beside the list: its sketch, Open and Use in a chat, its facts and its chats. */
function Preview(props: { doc: Document }) {
  const ctx = usePlugin()
  const names = useNames()
  return (
    <aside data-slot="drive-preview" aria-label={props.doc.name}>
      <div data-slot="drive-preview-head">
        <FormatGlyph format={props.doc.format} size="large" />
        <span data-slot="drive-preview-title" title={props.doc.name}>
          {props.doc.name}
        </span>
        <IconButton
          type="button"
          variant="ghost-muted"
          size="small"
          icon={<Icon name="close-small" size="small" />}
          aria-label={ctx.t("views.close")}
          onClick={() => drive.select(undefined)}
        />
      </div>
      <div data-slot="drive-preview-body">
        <Thumb doc={props.doc} />
        <div data-slot="drive-row-actions">
          <Button variant="contrast" icon="eye" onClick={() => void drive.openDoc(props.doc.id)}>
            {ctx.t("drive.open")}
          </Button>
          <Button variant="outline" icon="speech-bubble" onClick={() => askAgent(ctx, props.doc)}>
            {ctx.t("drive.useInChat")}
          </Button>
          <RowMenu doc={props.doc} />
        </div>
        <dl data-slot="drive-facts">
          <dt>{ctx.t("drive.fact.type")}</dt>
          <dd>
            {names.format(props.doc.format)} · {names.size(props.doc.size)}
          </dd>
          <dt>{ctx.t("drive.fact.location")}</dt>
          <dd>{names.path(props.doc.folder)}</dd>
          <dt>{ctx.t("drive.fact.owner")}</dt>
          <dd>{names.owner(props.doc)}</dd>
          <Show when={props.doc.access}>
            {(access) => (
              <>
                <dt>{ctx.t("drive.fact.access")}</dt>
                <dd>
                  <Level level={access()} />
                  <Show when={access() === "view"}> · {ctx.t("drive.fact.noAgents")}</Show>
                </dd>
              </>
            )}
          </Show>
          <dt>{ctx.t("drive.fact.updated")}</dt>
          <dd>{names.ago(props.doc.updated)}</dd>
        </dl>
        <div data-slot="drive-section">
          <Icon name="speech-bubble" size="small" />
          {ctx.t("drive.chats.linked")}
        </div>
        <LinkedChats doc={props.doc} />
      </div>
    </aside>
  )
}

/**
 * The templates New offers (C9): the Dynapps ones and a blank Markdown document, by the instance's template id.
 * The instance has no route that lists them, so they are fixed here.
 */
export const templates: readonly { kind: Format | "folder"; template?: string; title: string; hint: string }[] = [
  { kind: "docx", template: "dynapps-word", title: "drive.new.docx", hint: "drive.new.docx.hint" },
  { kind: "xlsx", template: "dynapps-sheet", title: "drive.new.xlsx", hint: "drive.new.xlsx.hint" },
  { kind: "pptx", template: "dynapps-deck", title: "drive.new.pptx", hint: "drive.new.pptx.hint" },
  { kind: "html", template: "dynapps-html", title: "drive.new.html", hint: "drive.new.html.hint" },
  { kind: "markdown", template: "blank-markdown", title: "drive.new.markdown", hint: "drive.new.markdown.hint" },
  { kind: "folder", title: "drive.new.folder", hint: "drive.new.folder.hint" },
]

/** New: a template or a folder, a name, and Create here. */
function NewDialog(props: { close: () => void }) {
  const ctx = usePlugin()
  const [kind, setKind] = createSignal<Format | "folder">("docx")
  const [name, setName] = createSignal(ctx.t("drive.new.untitled"))
  const [busy, setBusy] = createSignal(false)
  const where = () => drive.folder(drive.target())?.name ?? ctx.t("drive.title")
  const create = async () => {
    const chosen = templates.find((item) => item.kind === kind())
    const title = name().trim() || ctx.t("drive.new.untitled")
    if (!chosen) return
    setBusy(true)
    const made = chosen.template ? await drive.create(chosen.template, title) : await drive.createFolder(title)
    setBusy(false)
    if (isFailure(made))
      return ctx.toast.show({ title: ctx.t("drive.new.failed"), description: failureText(ctx, made), variant: "error" })
    props.close()
    if ("document" in made) void drive.openDoc(made.document.id)
  }
  return (
    <Dialog size="large">
      <DialogHeader>
        <DialogTitleGroup
          title={ctx.t("drive.new.title", { folder: where() })}
          description={ctx.t("drive.new.description")}
        />
      </DialogHeader>
      <DialogBody>
        <div data-component="drive-new">
          <div data-slot="drive-templates">
            <For each={templates}>
              {(template) => (
                <button
                  type="button"
                  data-slot="drive-template"
                  aria-pressed={kind() === template.kind}
                  onClick={() => setKind(template.kind)}
                >
                  <FormatGlyph format={template.kind} size="large" />
                  <b>{ctx.t(template.title)}</b>
                  <span>{ctx.t(template.hint)}</span>
                </button>
              )}
            </For>
          </div>
          <TextInput
            value={name()}
            aria-label={ctx.t("drive.new.name")}
            onInput={(event) => setName(event.currentTarget.value)}
          />
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={props.close}>
          {ctx.t("drive.cancel")}
        </Button>
        <Button variant="contrast" disabled={busy()} onClick={() => void create()}>
          {ctx.t("drive.new.create")}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
