import { usePlugin, type Context } from "@opencode/plugin/gui"
import { Button } from "@opencode/ui/button"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Tabs } from "@opencode/ui/tabs"
import { TextInput } from "@opencode/ui/text-input"
import { createSignal, For, Match, Show, Switch } from "solid-js"
import { askAgent } from "./chat"
import { chats, me, type Doc, type Folder, type Format } from "./demo"
import { formatOf, highlight, pathOf, scopes, snippet, typeFilters, visibleDocs, visibleFolders } from "./model"
import { AvatarRow, ClassTag, FormatGlyph, Tag, Thumb, chatName, useNames } from "./parts"
import { RowMenu } from "./menus"
import { ChatMark, LinkedChats } from "./workspace"
import { drive } from "./store"

// The Drive's browser: scopes, type filters, folders and documents as a list or a grid, the conversations' artifacts,
// and the selected document's preview.

const browse = () => drive.state.browse
const docsShown = () => visibleDocs(drive.state.docs, browse(), me)
const foldersShown = () => visibleFolders(drive.state.folders, browse())

/** The header's actions: search, Upload and New. */
export function BrowserActions() {
  const ctx = usePlugin()
  return (
    <>
      <TextInput
        type="search"
        class="drive-search"
        leadingIcon={<Icon name="magnifying-glass" size="small" />}
        value={browse().query}
        placeholder={ctx.t("drive.search")}
        aria-label={ctx.t("drive.search")}
        onInput={(event) => drive.setQuery(event.currentTarget.value)}
      />
      <Button variant="outline" icon="cloud-upload" onClick={() => void pickAndUpload(ctx)}>
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

type Ctx = Pick<Context, "toast" | "t" | "desktop">

async function pickAndUpload(ctx: Ctx) {
  const paths = ctx.desktop ? await ctx.desktop.pick({ multiple: true, title: ctx.t("drive.upload") }) : []
  const names = paths.length ? paths.map((path) => path.split(/[\\/]/).pop() ?? path) : ["Supplier invoice Q4.pdf"]
  names.forEach((name) => upload(ctx, name))
}

/** A file lands in the open folder after a moment, as a resumable upload in parts would. */
export function upload(ctx: Ctx, name: string) {
  const progress = ctx.toast.show({
    title: ctx.t("drive.upload.progress", { name }),
    variant: "loading",
    persistent: true,
  })
  setTimeout(() => {
    progress.dismiss()
    const created = drive.upload(name, formatOf(name) ?? "pdf")
    const path = [ctx.t("drive.title"), ...pathOf(drive.state.folders, created.folder).map((item) => item.name)]
    ctx.toast.show({ title: ctx.t("drive.upload.done", { name }), description: path.join(" › "), variant: "success" })
  }, 1200)
}

export function Browser() {
  const ctx = usePlugin()
  const names = useNames()
  const [dropping, setDropping] = createSignal(false)
  const atRoot = () =>
    browse().scope === "home" && !browse().folder && !browse().query.trim() && browse().type === "all"
  const target = () => drive.folder(browse().folder)?.name ?? ctx.t("drive.title")

  return (
    <div data-slot="drive-browser">
      <div data-slot="drive-toolbar">
        <Tabs
          variant="pill"
          value={browse().scope}
          onChange={(value) => drive.setScope(scopes.find((scope) => scope === value) ?? "home")}
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
                  <FormatGlyph format={type as Format} />
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
            const files = [...(event.dataTransfer?.files ?? [])].map((file) => file.name)
            ;(files.length ? files : ["Supplier invoice Q4.pdf"]).forEach((name) => upload(ctx, name))
          }}
        >
          <Show when={browse().scope === "home" && browse().folder && !browse().query.trim()}>
            <div data-slot="drive-crumbs">
              <button type="button" onClick={() => drive.goFolder(undefined)}>
                {ctx.t("drive.title")}
              </button>
              <For each={pathOf(drive.state.folders, browse().folder)}>
                {(folder, index) => (
                  <>
                    <Icon name="chevron-right" size="small" />
                    <Show
                      when={index() < pathOf(drive.state.folders, browse().folder).length - 1}
                      fallback={<b>{folder.name}</b>}
                    >
                      <button type="button" onClick={() => drive.goFolder(folder.id)}>
                        {folder.name}
                      </button>
                    </Show>
                  </>
                )}
              </For>
              <Show when={drive.folder(browse().folder)}>{(folder) => <ClassTag cls={folder().cls} />}</Show>
            </div>
          </Show>
          <Show when={atRoot()}>
            <div data-slot="drive-section">
              <Icon name="outline-reset" size="small" />
              {ctx.t("drive.recent")}
            </div>
            <div data-slot="drive-quick">
              <For each={drive.state.docs.toSorted((a, b) => a.age - b.age).slice(0, 4)}>
                {(doc) => (
                  <Card
                    doc={doc}
                    meta={
                      doc.chats.length
                        ? ctx.t("drive.card.agentIn", { chat: chatName(doc.chats[0].chat), when: names.ago(doc.age) })
                        : `${names.who(doc.owner)} · ${names.ago(doc.age)}`
                    }
                  />
                )}
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
            <Match when={docsShown().length === 0 && foldersShown().length === 0}>
              <div data-slot="drive-empty">
                {browse().query.trim()
                  ? ctx.t("drive.empty.search", { query: browse().query.trim() })
                  : ctx.t("drive.empty.folder")}
              </div>
            </Match>
            <Match when={browse().view === "list"}>
              <FileTable docs={docsShown()} folders={foldersShown()} />
            </Match>
            <Match when={true}>
              <div data-slot="drive-grid">
                <For each={foldersShown()}>
                  {(folder) => (
                    <button
                      type="button"
                      data-slot="drive-card"
                      data-kind="folder"
                      onClick={() => drive.goFolder(folder.id)}
                    >
                      <Thumb />
                      <span data-slot="drive-card-name">
                        <FormatGlyph format="folder" />
                        {folder.name}
                      </span>
                      <span data-slot="drive-card-meta">
                        <ClassTag cls={folder.cls} />
                      </span>
                    </button>
                  )}
                </For>
                <For each={docsShown()}>
                  {(doc) => (
                    <Card
                      doc={doc}
                      meta={`${doc.chats.length ? ctx.t("drive.card.from", { chat: chatName(doc.chats[0].chat) }) : names.who(doc.owner)} · ${names.ago(doc.age)}`}
                    />
                  )}
                </For>
              </div>
            </Match>
          </Switch>
          <Show when={dropping()}>
            <div data-slot="drive-drop">{ctx.t("drive.drop", { folder: target() })}</div>
          </Show>
        </div>
        <Show when={drive.doc(browse().selected)}>{(doc) => <Preview doc={doc()} />}</Show>
      </div>
    </div>
  )
}

function Card(props: { doc: Doc; meta: string }) {
  return (
    <button
      type="button"
      data-slot="drive-card"
      data-state={browse().selected === props.doc.id ? "selected" : undefined}
      onClick={() => drive.select(props.doc.id)}
      onDblClick={() => drive.openDoc(props.doc.id)}
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

function FileTable(props: { docs: readonly Doc[]; folders: readonly Folder[] }) {
  const ctx = usePlugin()
  const names = useNames()
  return (
    <table data-slot="drive-files">
      <thead>
        <tr>
          <th>{ctx.t("drive.col.name")}</th>
          <th>{ctx.t("drive.col.owner")}</th>
          <th title={ctx.t("drive.col.class.hint")}>{ctx.t("drive.col.class")}</th>
          <th>{ctx.t("drive.col.origin")}</th>
          <th>{ctx.t("drive.col.updated")}</th>
          <th />
        </tr>
      </thead>
      <tbody>
        <For each={props.folders}>
          {(folder) => {
            const count = () =>
              drive.state.docs.filter((doc) => doc.folder === folder.id).length +
              drive.state.folders.filter((item) => item.parent === folder.id).length
            return (
              <tr data-slot="drive-row" onClick={() => drive.goFolder(folder.id)}>
                <td>
                  <div data-slot="drive-name-cell">
                    <FormatGlyph format="folder" />
                    <span data-slot="drive-name">{folder.name}</span>
                    <span data-slot="drive-faint">
                      {ctx.t(count() === 1 ? "drive.items.one" : "drive.items", { count: String(count()) })}
                    </span>
                  </div>
                </td>
                <td>{names.who(folder.owner)}</td>
                <td>
                  <ClassTag cls={folder.cls} />
                </td>
                <td data-slot="drive-faint">—</td>
                <td>{names.ago(folder.age)}</td>
                <td />
              </tr>
            )
          }}
        </For>
        <For each={props.docs}>
          {(doc) => (
            <tr
              data-slot="drive-row"
              aria-selected={browse().selected === doc.id}
              onClick={() => drive.select(doc.id)}
              onDblClick={() => drive.openDoc(doc.id)}
            >
              <td>
                <div data-slot="drive-name-cell">
                  <FormatGlyph format={doc.format} />
                  <div data-slot="drive-name-stack">
                    <Name name={doc.name} />
                    <Show when={snippet(doc, browse().query)}>
                      {(found) => (
                        <span data-slot="drive-snippet">
                          …{found().before}
                          <mark>{found().match}</mark>
                          {found().after}…
                        </span>
                      )}
                    </Show>
                  </div>
                  <Show when={doc.editing.length}>
                    <AvatarRow people={doc.editing} title={ctx.t("drive.editing")} />
                  </Show>
                </div>
              </td>
              <td>{names.who(doc.owner)}</td>
              <td>
                <ClassTag cls={doc.cls} />
              </td>
              <td>
                <Show
                  when={doc.chats[0]}
                  fallback={
                    <Show when={doc.agent} fallback={<span data-slot="drive-faint">—</span>}>
                      <Tag tone="agent">{ctx.t("drive.agent")}</Tag>
                    </Show>
                  }
                >
                  {(link) => (
                    <span data-slot="drive-origin" title={ctx.t("drive.chat.demo")}>
                      <Icon name="speech-bubble" size="small" />
                      {chatName(link().chat)}
                    </span>
                  )}
                </Show>
              </td>
              <td>{names.ago(doc.age)}</td>
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

/** "From my chats": each conversation with the artifacts it made or changed. */
function ByChat() {
  const ctx = usePlugin()
  const names = useNames()
  const groups = () =>
    Object.values(chats)
      .map((chat) => ({
        chat,
        docs: drive.state.docs.filter(
          (doc) =>
            doc.chats.some((link) => link.chat === chat.id) &&
            (browse().type === "all" || doc.format === browse().type),
        ),
      }))
      .filter((group) => group.docs.length)
  return (
    <For each={groups()}>
      {(group) => (
        <div data-slot="drive-chat-group">
          <div data-slot="drive-section">
            <ChatMark chat={group.chat.id} />
            <b>{group.chat.name}</b>
            <span data-slot="drive-faint">
              {ctx.t("drive.chat.count", { project: group.chat.project, count: String(group.docs.length) })}
            </span>
          </div>
          <table data-slot="drive-files" data-compact="">
            <tbody>
              <For each={group.docs}>
                {(doc) => (
                  <tr
                    data-slot="drive-row"
                    aria-selected={browse().selected === doc.id}
                    onClick={() => drive.select(doc.id)}
                    onDblClick={() => drive.openDoc(doc.id)}
                  >
                    <td>
                      <div data-slot="drive-name-cell">
                        <FormatGlyph format={doc.format} />
                        <span data-slot="drive-name">{doc.name}</span>
                      </div>
                    </td>
                    <td>
                      <Tag tone="agent">
                        {doc.chats
                          .filter((link) => link.chat === group.chat.id)
                          .map((link) => ctx.t(`drive.act.${link.act}`, { rev: String(link.rev) }))
                          .join(" · ")}
                      </Tag>
                    </td>
                    <td data-slot="drive-faint">{names.path(doc.folder)}</td>
                    <td>{names.ago(doc.age)}</td>
                    <td data-slot="drive-row-menu">
                      <RowMenu doc={doc} />
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      )}
    </For>
  )
}

/** The selected document beside the list: its sketch, Open and Use in a chat, its facts, chats and people. */
function Preview(props: { doc: Doc }) {
  const ctx = usePlugin()
  const names = useNames()
  const open = () => drive.threadsOf(props.doc.id).filter((thread) => thread.open).length
  const access = () =>
    drive.state.shares[props.doc.id]?.map((share) => share.person) ?? [
      props.doc.owner,
      ...(props.doc.owner !== me ? [me] : []),
    ]
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
          <Button variant="contrast" icon="eye" onClick={() => drive.openDoc(props.doc.id)}>
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
            {ctx.t(`drive.format.${props.doc.format}`)} · {props.doc.size}
          </dd>
          <dt>{ctx.t("drive.fact.location")}</dt>
          <dd>{names.path(props.doc.folder)}</dd>
          <dt>{ctx.t("drive.fact.owner")}</dt>
          <dd>{names.who(props.doc.owner)}</dd>
          <dt>{ctx.t("drive.fact.access")}</dt>
          <dd>
            {ctx.t(`drive.level.${props.doc.access}`)}
            <Show when={props.doc.access === "view"}> · {ctx.t("drive.fact.noAgents")}</Show>
          </dd>
          <dt>{ctx.t("drive.fact.class")}</dt>
          <dd>
            <ClassTag cls={props.doc.cls} />
          </dd>
          <dt>{ctx.t("drive.fact.version")}</dt>
          <dd>
            {ctx.t("drive.rev", { rev: String(props.doc.rev) })} · {names.ago(props.doc.age)}
          </dd>
          <Show when={open()}>
            <dt>{ctx.t("drive.fact.comments")}</dt>
            <dd>{ctx.t("drive.fact.open", { count: String(open()) })}</dd>
          </Show>
        </dl>
        <div data-slot="drive-section">
          <Icon name="speech-bubble" size="small" />
          {ctx.t("drive.chats.linked")}
        </div>
        <LinkedChats doc={props.doc} />
        <div data-slot="drive-section">
          <Icon name="shield" size="small" />
          {ctx.t("drive.withAccess")}
        </div>
        <AvatarRow people={access()} />
      </div>
    </aside>
  )
}

const templates: readonly { kind: Format | "folder"; title: string; hint: string }[] = [
  { kind: "docx", title: "drive.new.docx", hint: "drive.new.docx.hint" },
  { kind: "xlsx", title: "drive.new.xlsx", hint: "drive.new.xlsx.hint" },
  { kind: "pptx", title: "drive.new.pptx", hint: "drive.new.pptx.hint" },
  { kind: "html", title: "drive.new.html", hint: "drive.new.html.hint" },
  { kind: "markdown", title: "drive.new.markdown", hint: "drive.new.markdown.hint" },
  { kind: "folder", title: "drive.new.folder", hint: "drive.new.folder.hint" },
]

/** New: a template, a name, and Create here or Create with the agent. */
function NewDialog(props: { close: () => void }) {
  const ctx = usePlugin()
  const [kind, setKind] = createSignal<Format | "folder">("docx")
  const [name, setName] = createSignal(ctx.t("drive.new.untitled"))
  const where = () => drive.folder(drive.state.browse.folder)?.name ?? ctx.t("drive.title")
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
          <p data-slot="drive-note" data-tone="agent">
            <Icon name="outline-steer" size="small" /> {ctx.t("drive.new.agent.hint")}
          </p>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={props.close}>
          {ctx.t("drive.cancel")}
        </Button>
        <Button
          variant="outline"
          icon="outline-steer"
          disabled={kind() === "folder"}
          onClick={() => {
            props.close()
            const id = drive.create(kind(), name().trim() || ctx.t("drive.new.untitled"))
            const created = drive.doc(id)
            if (created) askAgent(ctx, created, ctx.t("drive.new.agent.prompt", { doc: created.name }))
          }}
        >
          {ctx.t("drive.new.agent")}
        </Button>
        <Button
          variant="contrast"
          onClick={() => {
            props.close()
            const id = drive.create(kind(), name().trim() || ctx.t("drive.new.untitled"))
            if (id) drive.openDoc(id)
          }}
        >
          {ctx.t("drive.new.create")}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
