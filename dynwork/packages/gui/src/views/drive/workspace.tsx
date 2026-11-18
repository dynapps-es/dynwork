import { usePlugin } from "@opencode/plugin/gui"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Tabs } from "@opencode/ui/tabs"
import { For, Match, Show, Switch } from "solid-js"
import { outline, sheetsOf, slidesOf } from "./canvas"
import { askAgent } from "./chat"
import { AgentWorking, CommentCanvas, commentHint } from "./comments"
import { DocMenu } from "./menus"
import { chats, levels, people, type Doc, type Thread } from "./demo"
import { AnchorLine, Avatar, ClassTag, FormatGlyph, MessageLine, Tag, chatName, useNames } from "./parts"
import { drive, type DocTab } from "./store"

const tabs: readonly DocTab[] = ["details", "comments", "versions", "proposals", "share"]

/** A document open in the Drive: its bar, the edition banner, the outline, the canvas and the drawer. */
export function Workspace(props: { doc: Doc }) {
  const ctx = usePlugin()
  const names = useNames()
  const mvp = () => drive.state.mode === "mvp"
  const canEdit = () => props.doc.access === "own" || props.doc.access === "edit"
  const present = [...new Set(["D", ...props.doc.editing])]
  const demo = (key: string) => ctx.toast.show({ title: ctx.t(key), description: props.doc.name, icon: "info" })

  return (
    <div data-slot="drive-workspace">
      <div data-slot="drive-ws-top">
        <IconButton
          type="button"
          variant="ghost"
          icon={<Icon name="arrow-left" />}
          aria-label={ctx.t("views.back")}
          title={ctx.t("views.back")}
          onClick={() => drive.closeDoc()}
        />
        <FormatGlyph format={props.doc.format} />
        <div data-slot="drive-ws-name">
          <span data-slot="drive-ws-title">{props.doc.name}</span>
          <span data-slot="drive-ws-path">{names.path(props.doc.folder)}</span>
        </div>
        <ClassTag cls={props.doc.cls} />
        <span data-slot="drive-ws-saved">
          <Icon name="check-small" size="small" />
          {ctx.t("drive.rev", { rev: String(props.doc.rev) })} · {names.ago(props.doc.age)}
        </span>
        <span data-slot="drive-grow" />
        <span data-slot="drive-avatars" title={ctx.t("drive.here")}>
          <For each={present}>{(person) => <Avatar person={person} />}</For>
        </span>
        <Show when={props.doc.access !== "view"}>
          <Button
            variant={drive.state.doc.commenting ? "neutral" : "ghost"}
            icon="comment"
            data-slot="drive-comment-toggle"
            aria-pressed={drive.state.doc.commenting}
            data-state={drive.state.doc.commenting ? "pressed" : undefined}
            title={ctx.t("drive.mode.toggle.hint")}
            onClick={() => drive.setCommenting(!drive.state.doc.commenting)}
          >
            {ctx.t("drive.comment")}
          </Button>
        </Show>
        <Button
          variant="ghost"
          icon="outline-steer"
          onClick={() => askAgent(ctx, props.doc, ctx.t("drive.ask.doc", { doc: props.doc.name }))}
        >
          {ctx.t("drive.ask")}
        </Button>
        <Show when={props.doc.format === "pptx" || props.doc.format === "html"}>
          <Button variant="ghost" icon="expand" onClick={() => demo("drive.present.demo")}>
            {ctx.t("drive.present")}
          </Button>
        </Show>
        <Button variant="contrast" icon="share" onClick={() => drive.setTab("share")}>
          {ctx.t("drive.share")}
        </Button>
        <DocMenu doc={props.doc} />
      </div>

      <Switch>
        <Match when={mvp()}>
          <div data-slot="drive-banner">
            <Icon name="info" size="small" />
            <span data-slot="drive-grow">
              <b>{ctx.t("drive.banner.mvp.title")}</b> {ctx.t("drive.banner.mvp")}
            </span>
            <Button
              variant="ghost"
              size="small"
              icon="square-arrow-top-right"
              onClick={() => demo("drive.governance.demo")}
            >
              {ctx.t("drive.governance")}
            </Button>
          </div>
        </Match>
        <Match when={canEdit()}>
          <div data-slot="drive-banner" data-tone="success">
            <Icon name="edit" size="small" />
            <span data-slot="drive-grow">
              <b>{ctx.t("drive.banner.v2.title")}</b> {ctx.t("drive.banner.v2")}
            </span>
          </div>
        </Match>
        <Match when={true}>
          <div data-slot="drive-banner">
            <Icon name="lock" size="small" />
            <span data-slot="drive-grow">
              {ctx.t("drive.banner.access", { level: ctx.t(`drive.level.${props.doc.access}`) })}
            </span>
          </div>
        </Match>
      </Switch>
      <Show when={drive.state.doc.commenting}>
        <div data-slot="drive-banner" data-tone="comment">
          <Icon name="comment" size="small" />
          <span data-slot="drive-grow">
            <b>{ctx.t("drive.mode.title")}</b> {ctx.t(commentHint(props.doc))}. {ctx.t("drive.mode.escape")}
          </span>
          <Button variant="ghost" size="small" onClick={() => drive.setCommenting(false)}>
            {ctx.t("drive.mode.exit")}
          </Button>
        </div>
      </Show>

      <div data-slot="drive-ws-body">
        <Rail doc={props.doc} />
        <CommentCanvas doc={props.doc} />
        <aside data-slot="drive-drawer">
          <Tabs
            value={drive.state.doc.tab}
            onChange={(value) => drive.setTab(tabs.find((tab) => tab === value) ?? "details")}
          >
            <Tabs.List aria-label={ctx.t("drive.drawer")}>
              <For each={tabs}>
                {(tab) => (
                  <Tabs.Trigger value={tab}>
                    {ctx.t(`drive.tab.${tab}`)}
                    <Show when={count(props.doc, tab)}>
                      <span data-slot="drive-count">{count(props.doc, tab)}</span>
                    </Show>
                  </Tabs.Trigger>
                )}
              </For>
            </Tabs.List>
          </Tabs>
          <div data-slot="drive-drawer-body">
            <Switch>
              <Match when={drive.state.doc.tab === "details"}>
                <Details doc={props.doc} />
              </Match>
              <Match when={drive.state.doc.tab === "comments"}>
                <Comments doc={props.doc} />
              </Match>
              <Match when={drive.state.doc.tab === "versions"}>
                <Versions doc={props.doc} />
              </Match>
              <Match when={drive.state.doc.tab === "proposals"}>
                <Proposals doc={props.doc} />
              </Match>
              <Match when={drive.state.doc.tab === "share"}>
                <Sharing doc={props.doc} />
              </Match>
            </Switch>
          </div>
        </aside>
      </div>
    </div>
  )
}

function count(doc: Doc, tab: DocTab) {
  if (tab === "comments") return drive.threadsOf(doc.id).filter((thread) => thread.open).length
  if (tab === "versions") return drive.state.versions[doc.id]?.length ?? 1
  if (tab === "proposals") return (drive.state.proposals[doc.id] ?? []).filter((item) => item.state === "open").length
  return 0
}

/** The left rail: the outline, sheets, slides, sections or pages, and Markdown's Rendered and Source. */
function Rail(props: { doc: Doc }) {
  const ctx = usePlugin()
  const jump = (index: number) =>
    document
      .querySelector(`[data-slot=drive-paper] #o-${index + 1}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" })
  return (
    <nav data-slot="drive-rail" aria-label={ctx.t("drive.rail")}>
      <Switch>
        <Match when={props.doc.format === "xlsx"}>
          <div data-slot="drive-rail-title">{ctx.t("drive.rail.sheets")}</div>
          <For each={sheetsOf(props.doc)}>
            {(name, index) => (
              <button
                type="button"
                data-state={drive.state.doc.sheet === index() ? "pressed" : undefined}
                onClick={() => drive.setSheet(index())}
              >
                {name.startsWith("drive.") ? ctx.t(name) : name}
              </button>
            )}
          </For>
        </Match>
        <Match when={props.doc.format === "pptx"}>
          <div data-slot="drive-rail-title">{ctx.t("drive.rail.slides")}</div>
          <For each={slidesOf(props.doc)}>
            {(slide, index) => (
              <button
                type="button"
                data-state={drive.state.doc.slide === index() ? "pressed" : undefined}
                onClick={() => drive.setSlide(index())}
              >
                {index() + 1}. {slide.title}
              </button>
            )}
          </For>
        </Match>
        <Match when={props.doc.format === "html"}>
          <div data-slot="drive-rail-title">{ctx.t("drive.rail.sections")}</div>
          <For each={["Header", "KPIs", "Chart by journal"]}>{(name) => <button type="button">{name}</button>}</For>
        </Match>
        <Match when={props.doc.format === "pdf"}>
          <div data-slot="drive-rail-title">{ctx.t("drive.rail.pages")}</div>
          <For each={[0, 1]}>
            {(page) => (
              <button
                type="button"
                onClick={() =>
                  document
                    .querySelector(`[data-slot=drive-pdf] [data-page="${page}"]`)
                    ?.scrollIntoView({ behavior: "smooth" })
                }
              >
                {ctx.t("drive.rail.page", { page: String(page + 1) })}
              </button>
            )}
          </For>
        </Match>
        <Match when={true}>
          <div data-slot="drive-rail-title">{ctx.t("drive.rail.outline")}</div>
          <For each={outline(props.doc)}>
            {(heading, index) => (
              <button type="button" data-level={index() ? "2" : "1"} onClick={() => jump(index())}>
                {heading}
              </button>
            )}
          </For>
          <Show when={props.doc.format === "markdown"}>
            <div data-slot="drive-rail-title">{ctx.t("drive.rail.view")}</div>
            <button
              type="button"
              data-state={drive.state.doc.source ? undefined : "pressed"}
              onClick={() => drive.state.doc.source && drive.toggleSource()}
            >
              {ctx.t("drive.rail.rendered")}
            </button>
            <button
              type="button"
              data-state={drive.state.doc.source ? "pressed" : undefined}
              onClick={() => !drive.state.doc.source && drive.toggleSource()}
            >
              {ctx.t("drive.rail.source")}
            </button>
          </Show>
        </Match>
      </Switch>
    </nav>
  )
}

/** The conversations that made or changed a document, each with what it did. */
export function LinkedChats(props: { doc: Doc }) {
  const ctx = usePlugin()
  const grouped = () =>
    [...new Set(props.doc.chats.map((link) => link.chat))].map((chat) => ({
      chat,
      acts: props.doc.chats
        .filter((link) => link.chat === chat)
        .map((link) => ctx.t(`drive.act.${link.act}`, { rev: String(link.rev) }))
        .join(" · "),
    }))
  return (
    <Show when={grouped().length} fallback={<p data-slot="drive-note">{ctx.t("drive.chats.none")}</p>}>
      <div data-slot="drive-links">
        <For each={grouped()}>
          {(item) => (
            <button
              type="button"
              data-slot="drive-link-row"
              title={ctx.t("drive.chat.demo")}
              onClick={() =>
                ctx.toast.show({
                  title: ctx.t("drive.chat.demo"),
                  description: chatName(item.chat),
                  icon: "speech-bubble",
                })
              }
            >
              <ChatMark chat={item.chat} />
              <span>{chatName(item.chat)}</span>
              <span data-slot="drive-faint">{item.acts}</span>
            </button>
          )}
        </For>
      </div>
    </Show>
  )
}

export function ChatMark(props: { chat: string }) {
  return (
    <span data-slot="drive-chat-mark" style={{ background: chats[props.chat]?.color }}>
      {chats[props.chat]?.letter}
    </span>
  )
}

function Details(props: { doc: Doc }) {
  const ctx = usePlugin()
  const names = useNames()
  const demo = (key: string) => ctx.toast.show({ title: ctx.t(key), description: props.doc.name, icon: "download" })
  return (
    <>
      <dl data-slot="drive-facts">
        <dt>{ctx.t("drive.fact.format")}</dt>
        <dd>{ctx.t(`drive.format.${props.doc.format}`)}</dd>
        <dt>{ctx.t("drive.fact.owner")}</dt>
        <dd>{names.who(props.doc.owner)}</dd>
        <dt>{ctx.t("drive.fact.folder")}</dt>
        <dd>{names.path(props.doc.folder)}</dd>
        <dt>{ctx.t("drive.fact.version")}</dt>
        <dd>{ctx.t("drive.rev", { rev: String(props.doc.rev) })}</dd>
        <dt>{ctx.t("drive.fact.size")}</dt>
        <dd>{props.doc.size}</dd>
        <dt>{ctx.t("drive.fact.access")}</dt>
        <dd>{ctx.t(`drive.level.${props.doc.access}`)}</dd>
        <dt>{ctx.t("drive.fact.class")}</dt>
        <dd>
          <ClassTag cls={props.doc.cls} />
        </dd>
      </dl>
      <p data-slot="drive-note">{ctx.t(`drive.class.${props.doc.cls}.hint`)}</p>
      <div data-slot="drive-section">
        <Icon name="speech-bubble" size="small" />
        {ctx.t("drive.chats.using")}
      </div>
      <LinkedChats doc={props.doc} />
      <p data-slot="drive-note">{ctx.t("drive.chats.how")}</p>
      <div data-slot="drive-section">
        <Icon name="download" size="small" />
        {ctx.t("drive.export")}
      </div>
      <div data-slot="drive-row-actions">
        <Button variant="outline" size="small" onClick={() => demo("drive.export.demo")}>
          PDF
        </Button>
        <Show when={props.doc.format === "docx" || props.doc.format === "markdown"}>
          <Button variant="outline" size="small" onClick={() => demo("drive.export.demo")}>
            Markdown
          </Button>
          <Button variant="outline" size="small" onClick={() => demo("drive.export.demo")}>
            {ctx.t("drive.export.word")}
          </Button>
        </Show>
        <Button variant="outline" size="small" onClick={() => demo("drive.download.demo")}>
          {ctx.t("drive.export.original")}
        </Button>
      </div>
    </>
  )
}

function Comments(props: { doc: Doc }) {
  const ctx = usePlugin()
  const all = () => drive.threadsOf(props.doc.id)
  const shown = () => all().filter((thread) => (drive.state.doc.filter === "open" ? thread.open : !thread.open))
  return (
    <>
      <div data-slot="drive-chips">
        <button
          type="button"
          data-slot="drive-chip"
          aria-pressed={drive.state.doc.filter === "open"}
          onClick={() => drive.setFilter("open")}
        >
          {ctx.t("drive.comments.open", { count: String(all().filter((thread) => thread.open).length) })}
        </button>
        <button
          type="button"
          data-slot="drive-chip"
          aria-pressed={drive.state.doc.filter === "resolved"}
          onClick={() => drive.setFilter("resolved")}
        >
          {ctx.t("drive.comments.resolved", { count: String(all().filter((thread) => !thread.open).length) })}
        </button>
      </div>
      <Show
        when={shown().length}
        fallback={
          <p data-slot="drive-note">
            {ctx.t(drive.state.doc.filter === "open" ? "drive.comments.none" : "drive.comments.noneResolved")}
          </p>
        }
      >
        <For each={shown()}>{(thread) => <ThreadItem thread={thread} />}</For>
      </Show>
      <Show when={drive.state.mode === "mvp"}>
        <p data-slot="drive-note">
          <Icon name="info" size="small" /> {ctx.t("drive.comments.mvp")}
        </p>
      </Show>
    </>
  )
}

function ThreadItem(props: { thread: Thread }) {
  const ctx = usePlugin()
  const selected = () => drive.state.doc.thread === props.thread.id
  return (
    <div
      data-slot="drive-thread"
      data-state={selected() ? "on" : undefined}
      data-resolved={props.thread.open ? undefined : ""}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("button, a, textarea")) return
        drive.focusThread(props.thread.id)
        document
          .querySelector(`[data-slot=drive-canvas] [data-t="${props.thread.id}"]`)
          ?.scrollIntoView({ block: "center", behavior: "smooth" })
      }}
    >
      <div data-slot="drive-thread-anchor">
        <AnchorLine thread={props.thread} />
      </div>
      <For each={props.thread.messages}>{(message) => <MessageLine message={message} />}</For>
      <Show when={drive.state.typing === props.thread.id}>
        <AgentWorking />
      </Show>
      <Show when={selected() && !props.thread.open}>
        <div data-slot="drive-row-actions">
          <Button variant="ghost" size="small" onClick={() => drive.reopen(props.thread.id)}>
            {ctx.t("drive.comment.reopen")}
          </Button>
        </div>
      </Show>
    </div>
  )
}

function Versions(props: { doc: Doc }) {
  const ctx = usePlugin()
  const names = useNames()
  const list = () =>
    drive.state.versions[props.doc.id] ?? [
      { rev: props.doc.rev, by: props.doc.owner, via: "web", what: "drive.version.latest", age: props.doc.age },
    ]
  const where = (via: string) =>
    via === "web"
      ? ctx.t("drive.via.web")
      : via === "drive"
        ? ctx.t("drive.via.folder")
        : ctx.t("drive.via.chat", { chat: chatName(via) })
  return (
    <>
      <For each={list()}>
        {(version, index) => (
          <div data-slot="drive-version" data-current={index() === 0 ? "" : undefined}>
            <Avatar person={version.by} size="small" />
            <div data-slot="drive-version-body">
              <div data-slot="drive-version-title">
                {ctx.t("drive.rev", { rev: String(version.rev) })}
                <Show when={index() === 0}> · {ctx.t("drive.version.current")}</Show>
                <Show when={version.proposal}>
                  <Tag tone="warning">{ctx.t("drive.version.proposal")}</Tag>
                </Show>
              </div>
              <div data-slot="drive-faint">{names.said(version.what)}</div>
              <div data-slot="drive-faint">
                {names.who(version.by)} · {where(version.via)} · {names.ago(version.age)}
              </div>
            </div>
            <Show when={index() > 0}>
              <Button
                variant="ghost"
                size="small"
                disabled={drive.state.mode === "mvp"}
                title={drive.state.mode === "mvp" ? ctx.t("drive.version.restore.mvp") : undefined}
                onClick={() => ctx.toast.show({ title: ctx.t("drive.version.restored"), icon: "outline-reset" })}
              >
                {ctx.t("drive.version.restore")}
              </Button>
            </Show>
          </div>
        )}
      </For>
      <p data-slot="drive-note">{ctx.t("drive.version.note")}</p>
    </>
  )
}

function Proposals(props: { doc: Doc }) {
  const ctx = usePlugin()
  const names = useNames()
  const list = () => drive.state.proposals[props.doc.id] ?? []
  return (
    <Show when={list().length} fallback={<p data-slot="drive-note">{ctx.t("drive.proposals.none")}</p>}>
      <For each={list()}>
        {(proposal) => (
          <div data-slot="drive-thread" data-state="on">
            <MessageLine message={{ by: proposal.by, text: proposal.title, age: proposal.age, via: proposal.via }} />
            <div data-slot="drive-diff">
              <del data-slot="drive-del">{proposal.before}</del>
              <ins data-slot="drive-ins">{proposal.after}</ins>
            </div>
            <Switch>
              <Match when={proposal.state === "open" && drive.state.mode === "mvp"}>
                <div data-slot="drive-row-actions">
                  <Button variant="outline" size="small" disabled title={ctx.t("drive.proposals.people")}>
                    {ctx.t("drive.proposals.accept")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="small"
                    icon="square-arrow-top-right"
                    onClick={() =>
                      ctx.toast.show({ title: ctx.t("drive.governance.demo"), description: props.doc.name })
                    }
                  >
                    {ctx.t("drive.proposals.review")}
                  </Button>
                </div>
              </Match>
              <Match when={proposal.state === "open"}>
                <div data-slot="drive-row-actions">
                  <Button variant="contrast" size="small" onClick={() => drive.decide(proposal.id, true)}>
                    {ctx.t("drive.proposals.accept")}
                  </Button>
                  <Button variant="outline" size="small" onClick={() => drive.decide(proposal.id, false)}>
                    {ctx.t("drive.proposals.reject")}
                  </Button>
                </div>
              </Match>
              <Match when={true}>
                <Tag tone={proposal.state === "accepted" ? "success" : "danger"}>
                  {ctx.t(proposal.state === "accepted" ? "drive.proposals.accepted" : "drive.proposals.rejected")}
                </Tag>
              </Match>
            </Switch>
            <div data-slot="drive-faint">{names.ago(proposal.age)}</div>
          </div>
        )}
      </For>
    </Show>
  )
}

function Sharing(props: { doc: Doc }) {
  const ctx = usePlugin()
  const names = useNames()
  const list = () =>
    drive.state.shares[props.doc.id] ?? [
      { person: props.doc.owner, level: "own" as const },
      ...(props.doc.owner !== "D" ? [{ person: "D", level: props.doc.access }] : []),
    ]
  const can = () => drive.state.mode === "v2" && (props.doc.access === "own" || props.doc.access === "share")
  return (
    <>
      <Show when={can()}>
        <div data-slot="drive-invite">
          <input type="text" placeholder={ctx.t("drive.share.add")} />
          <Button
            variant="contrast"
            size="small"
            onClick={() => ctx.toast.show({ title: ctx.t("drive.share.sent"), icon: "share" })}
          >
            {ctx.t("drive.share.invite")}
          </Button>
        </div>
      </Show>
      <For each={list()}>
        {(share) => (
          <div data-slot="drive-person">
            <Avatar person={share.person} />
            <div data-slot="drive-person-name">
              {names.who(share.person)}
              <div data-slot="drive-faint">{people[share.person]?.email}</div>
            </div>
            <Show when={can() && share.level !== "own"} fallback={<Tag>{ctx.t(`drive.level.${share.level}`)}</Tag>}>
              <select data-slot="drive-level" aria-label={ctx.t("drive.share.level")}>
                <For each={levels.filter((level) => level !== "own")}>
                  {(level) => (
                    <option value={level} selected={level === share.level}>
                      {ctx.t(`drive.level.${level}`)}
                    </option>
                  )}
                </For>
              </select>
            </Show>
          </div>
        )}
      </For>
      <div data-slot="drive-person">
        <span data-slot="drive-avatar" data-agent="">
          AI
        </span>
        <div data-slot="drive-person-name">
          {ctx.t("drive.share.agents")}
          <div data-slot="drive-faint">{ctx.t(`drive.class.${props.doc.cls}.hint`)}</div>
        </div>
        <ClassTag cls={props.doc.cls} />
      </div>
      <div data-slot="drive-row-actions">
        <Button
          variant="outline"
          size="small"
          icon="link"
          onClick={() => ctx.toast.show({ title: ctx.t("drive.link.copied"), icon: "link" })}
        >
          {ctx.t("drive.link.copy")}
        </Button>
      </div>
      <p data-slot="drive-note" data-tone={drive.state.mode === "mvp" ? "warning" : undefined}>
        {ctx.t(drive.state.mode === "mvp" ? "drive.share.mvp" : "drive.share.levels")}
      </p>
    </>
  )
}
