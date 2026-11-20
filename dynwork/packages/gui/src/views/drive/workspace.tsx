import { usePlugin } from "@opencode/plugin/gui"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { ResizeHandle } from "@opencode/ui/resize-handle"
import { Tabs } from "@opencode/ui/tabs"
import { createEffect, createSignal, For, Match, on, Show, Switch } from "solid-js"
import { DriveCapabilities } from "../../drive/capabilities"
import { isFailure, type Document } from "../../drive/contract"
import { askAgent, back, sessionOf, titleOf } from "./chat"
import { bannerOf, personOffer, revisionBy } from "./model"
import { canComment, CommentMarks, CommentsTab, MarksToggle } from "./comments"
import { CommentPopup, DocMenu, SharePopover } from "./menus"
import { drawerWidth, outlineWidth, panes } from "./panes"
import {
  Avatar,
  capText,
  failureText,
  FormatGlyph,
  Level,
  openGovernance,
  PresentButton,
  PresentExit,
  Tag,
  useNames,
} from "./parts"
import { createInline } from "./spot"
import { account, drawerAsks, drive, governance, signInAsYou, type DocTab } from "./store"
import { createPresent, Viewer, type Outline } from "./viewer"

// The drawer's tabs. Sharing is the Share button's popover in the bar, as beside a chat.
const tabs: readonly DocTab[] = ["details", "comments", "versions", "proposals"]

/**
 * A document open in the Drive: its bar, the edition banner, its index, its viewer and the drawer. The index, the
 * drawer and the comments marked on the document show or hide from the bar, and the index and the drawer take the
 * width their inner edge is dragged to (`panes`). The index marks the heading being read; Present shows the document
 * alone, full screen; Share opens who has access under its button.
 */
export function Workspace(props: { doc: Document }) {
  const ctx = usePlugin()
  const names = useNames()
  const [outline, setOutline] = createSignal<Outline>()
  const headings = () => outline()?.headings ?? []
  let canvas: HTMLDivElement | undefined
  let rail: HTMLElement | undefined
  const present = createPresent(() => canvas)
  // With the marks shown, a selection or a click on the document opens a comment popup there; the new thread opens in
  // the Comments tab, quietly, as `drive.comment` does: nothing moves under the reader, and a hidden drawer stays so.
  const inline = createInline({
    doc: () => props.doc,
    shown: panes.marks,
    allowed: () => canComment(props.doc),
    paused: present.on,
  })
  createEffect(() => {
    if (present.on() || !panes.marks()) inline.close()
  })
  // The heading being read stays in sight in a long index.
  createEffect(() => {
    const index = outline()?.active()
    const item = index === undefined ? undefined : rail?.querySelectorAll<HTMLElement>("button")[index]
    if (!rail || !item) return
    if (item.offsetTop < rail.scrollTop) rail.scrollTop = item.offsetTop
    if (item.offsetTop + item.offsetHeight > rail.scrollTop + rail.clientHeight)
      rail.scrollTop = item.offsetTop + item.offsetHeight - rail.clientHeight
  })
  // The index's levels from the document's top one, three at most.
  const depth = (level: number) => Math.min(3, level - Math.min(...headings().map((heading) => heading.level)) + 1)
  const backLabel = () => ctx.t(drive.state.from && "chat" in drive.state.from ? "drive.back.chat" : "drive.back.drive")
  // A comment picked or started from the document shows in the drawer: a hidden drawer opens for it. A thread the user
  // just wrote does not open it: the document would get narrower under the reader.
  createEffect(
    on(
      () => drawerAsks(drive.state.doc),
      (asked) => {
        if (asked.some(Boolean) && !panes.drawer()) panes.toggle("drawer")
      },
      { defer: true },
    ),
  )
  // A new head has other nodes, and maybe other comments: read them again.
  createEffect(
    on(
      () => props.doc.revision,
      () => void drive.discuss(props.doc.id),
      { defer: true },
    ),
  )

  return (
    <div data-slot="drive-workspace">
      <div data-slot="drive-ws-top">
        <ctx.ui.Tooltip value={backLabel()} placement="bottom">
          <ctx.ui.IconButton variant="ghost" icon="arrow-left" label={backLabel()} onClick={() => back(ctx)} />
        </ctx.ui.Tooltip>
        <Show when={headings().length}>
          <ctx.ui.Tooltip
            value={ctx.t(panes.outline() ? "drive.outline.hide" : "drive.outline.show")}
            placement="bottom"
          >
            <ctx.ui.IconButton
              variant="ghost"
              icon={panes.outline() ? "layout-left-full" : "layout-left"}
              label={ctx.t("drive.outline")}
              onClick={() => panes.toggle("outline")}
            />
          </ctx.ui.Tooltip>
        </Show>
        <FormatGlyph format={props.doc.format} />
        <div data-slot="drive-ws-name">
          <span data-slot="drive-ws-title">{props.doc.name}</span>
          <span data-slot="drive-ws-path">{names.path(props.doc.folder)}</span>
        </div>
        <span data-slot="drive-ws-saved">
          <Icon name="check-small" size="small" />
          {names.ago(props.doc.updated)}
        </span>
        <span data-slot="drive-grow" />
        <MarksToggle doc={props.doc} />
        <PresentButton present={present} />
        <Show when={governance(props.doc.id)}>
          <SharePopover doc={props.doc} label />
        </Show>
        <ctx.ui.Tooltip value={ctx.t(panes.drawer() ? "drive.drawer.hide" : "drive.drawer.show")} placement="bottom">
          <ctx.ui.IconButton
            variant="ghost"
            icon={panes.drawer() ? "layout-right-full" : "layout-right"}
            label={ctx.t("drive.drawer")}
            onClick={() => panes.toggle("drawer")}
          />
        </ctx.ui.Tooltip>
        <Button
          variant="ghost"
          icon="outline-steer"
          onClick={() => askAgent(ctx, props.doc, ctx.t("drive.ask.doc", { doc: props.doc.name }))}
        >
          {ctx.t("drive.ask")}
        </Button>
        <Button
          variant="contrast"
          icon="square-arrow-top-right"
          disabled={!governance(props.doc.id)}
          onClick={() => openGovernance(ctx, props.doc)}
        >
          {ctx.t("drive.governance")}
        </Button>
        <DocMenu doc={props.doc} />
      </div>

      <Banner />

      <div data-slot="drive-ws-body">
        <Show when={panes.outline() && headings().length}>
          <div data-slot="drive-rail-pane" style={{ width: `${panes.width("outline")}px` }}>
            <ResizeHandle
              direction="horizontal"
              edge="end"
              size={panes.width("outline")}
              min={outlineWidth.min}
              max={outlineWidth.max}
              onResize={(width) => panes.resize(width, "outline")}
              onDraggingChange={(dragging) => {
                if (!dragging) panes.settle()
              }}
            />
            <nav ref={rail} data-slot="drive-rail" aria-label={ctx.t("drive.outline")}>
              <div data-slot="drive-rail-title">{ctx.t("drive.outline")}</div>
              <For each={headings()}>
                {(heading, index) => (
                  <button
                    type="button"
                    data-level={depth(heading.level)}
                    data-state={outline()?.active() === index() ? "active" : undefined}
                    aria-current={outline()?.active() === index() ? "location" : undefined}
                    title={heading.text}
                    onClick={() => outline()?.go(index())}
                  >
                    {heading.text}
                  </button>
                )}
              </For>
            </nav>
          </div>
        </Show>
        <div ref={canvas} data-slot="drive-canvas">
          <Viewer
            doc={props.doc}
            onOutline={setOutline}
            onMark={(thread) => drive.focusThread(thread)}
            onSpot={inline.offer}
          />
          <Show when={props.doc.format === "markdown"}>
            <CommentMarks doc={props.doc} onSpot={inline.offer} />
          </Show>
          <CommentPopup doc={props.doc} inline={inline} ask />
          <PresentExit present={present} />
        </div>
        <Show when={panes.drawer()}>
          <aside data-slot="drive-drawer" style={{ width: `${panes.width()}px` }}>
            <ResizeHandle
              direction="horizontal"
              edge="start"
              size={panes.width()}
              min={drawerWidth.min}
              max={drawerWidth.max}
              onResize={(width) => panes.resize(width)}
              onDraggingChange={(dragging) => {
                if (!dragging) panes.settle()
              }}
            />
            <Tabs
              value={drive.state.doc.tab}
              onChange={(value) => drive.setTab(tabs.find((tab) => tab === value) ?? "details")}
            >
              <Tabs.List aria-label={ctx.t("drive.drawer")}>
                <For each={tabs}>
                  {(tab) => (
                    <Tabs.Trigger value={tab}>
                      {ctx.t(`drive.tab.${tab}`)}
                      <Show when={count(tab, props.doc)}>
                        <span data-slot="drive-count">{count(tab, props.doc)}</span>
                      </Show>
                    </Tabs.Trigger>
                  )}
                </For>
              </Tabs.List>
            </Tabs>
            <div data-slot="drive-drawer-body">
              <Switch>
                <Match when={drive.state.doc.tab === "comments"}>
                  <CommentsTab doc={props.doc} onReveal={(thread) => outline()?.reveal(thread)} />
                </Match>
                <Match when={drive.state.doc.tab === "versions"}>
                  <Versions doc={props.doc} />
                </Match>
                <Match when={drive.state.doc.tab === "proposals"}>
                  <Proposals doc={props.doc} />
                </Match>
                <Match when={true}>
                  <Details doc={props.doc} />
                </Match>
              </Switch>
            </div>
          </aside>
        </Show>
      </div>
    </div>
  )
}

function count(tab: DocTab, doc: Document) {
  if (tab === "comments") return drive.threadsOf(doc.id).filter((thread) => thread.open).length
  if (tab === "versions") return drive.state.opened.revisions?.length ?? 0
  if (tab === "proposals") return (drive.state.opened.proposals ?? []).filter((item) => item.status === "open").length
  return 0
}

/**
 * How DynWork writes here (D2, G01): as the person while their own session is on; otherwise as an agent that signs
 * "<user> by DynWork", with what the Drive lets it do on this document attended and what a scheduled task could do
 * unattended (C2), and, where the instance has a session for DynWork, the way to sign in and act as themselves.
 */
function Banner() {
  const ctx = usePlugin()
  const cap = () => drive.state.opened.cap
  const kind = () => bannerOf(drive.acting())
  return (
    <Show
      when={kind() !== "person"}
      fallback={
        <div data-slot="drive-banner" data-tone="success">
          <Icon name="edit" size="small" />
          <span data-slot="drive-grow">
            <b>{ctx.t("drive.banner.v2.title")}</b> {ctx.t("drive.banner.v2")}
          </span>
        </div>
      }
    >
      <div data-slot="drive-banner">
        <Icon name="info" size="small" />
        <span data-slot="drive-grow">
          <b>{ctx.t("drive.banner.mvp.title")}</b>{" "}
          {ctx.t(kind() === "signIn" ? "drive.banner.signIn" : "drive.banner.mvp", {
            user: account()?.user ?? ctx.t("drive.you"),
          })}
          <Show when={cap()}>
            {(found) => (
              <>
                {" "}
                {ctx.t("drive.banner.cap", {
                  attended: capText(ctx.t, found().cap),
                  unattended: capText(ctx.t, found().unattended),
                })}
              </>
            )}
          </Show>
        </span>
        <Show when={kind() === "signIn"}>
          <Button variant="ghost" size="small" onClick={signInAsYou}>
            {ctx.t("drive.signIn")}
          </Button>
        </Show>
      </div>
    </Show>
  )
}

/** The conversations that made, changed or used a document, from the local index, each with what it did. */
export function LinkedChats(props: { doc: Document }) {
  const ctx = usePlugin()
  const grouped = () => {
    const own = drive.links().filter((link) => link.document === props.doc.id)
    return [...new Set(own.map((link) => link.conversation))].map((conversation) => ({
      conversation,
      acts: [...new Set(own.filter((link) => link.conversation === conversation).map((link) => link.act))]
        .map((act) => ctx.t(`drive.card.${act}`))
        .join(" · "),
    }))
  }
  return (
    <Show when={grouped().length} fallback={<p data-slot="drive-note">{ctx.t("drive.chats.none")}</p>}>
      <div data-slot="drive-links">
        <For each={grouped()}>
          {(item) => (
            <button
              type="button"
              data-slot="drive-link-row"
              disabled={!sessionOf(ctx, item.conversation)}
              title={sessionOf(ctx, item.conversation) ? undefined : ctx.t("drive.chat.closed")}
              onClick={() => {
                const session = sessionOf(ctx, item.conversation)
                if (session) ctx.tabs.focus(session.tab)
              }}
            >
              <Icon name="speech-bubble" size="small" />
              <span>{titleOf(ctx, item.conversation) ?? ctx.t("drive.chat.untitled")}</span>
              <span data-slot="drive-faint">{item.acts}</span>
            </button>
          )}
        </For>
      </div>
    </Show>
  )
}

function Details(props: { doc: Document }) {
  const ctx = usePlugin()
  const names = useNames()
  const detail = () => drive.state.opened.detail
  return (
    <>
      <dl data-slot="drive-facts">
        <dt>{ctx.t("drive.fact.format")}</dt>
        <dd>{names.format(props.doc.format)}</dd>
        <dt>{ctx.t("drive.fact.owner")}</dt>
        <dd>{names.owner(props.doc)}</dd>
        <dt>{ctx.t("drive.fact.folder")}</dt>
        <dd>{detail()?.path ?? names.path(props.doc.folder)}</dd>
        <dt>{ctx.t("drive.fact.size")}</dt>
        <dd>{names.size(props.doc.size)}</dd>
        <Show when={detail()?.access ?? props.doc.access}>
          {(access) => (
            <>
              <dt>{ctx.t("drive.fact.access")}</dt>
              <dd>
                <Level level={access()} />
              </dd>
            </>
          )}
        </Show>
        <dt>{ctx.t("drive.fact.created")}</dt>
        <dd>{names.ago(props.doc.created)}</dd>
        <dt>{ctx.t("drive.fact.updated")}</dt>
        <dd>{names.ago(props.doc.updated)}</dd>
      </dl>
      <div data-slot="drive-section">
        <Icon name="speech-bubble" size="small" />
        {ctx.t("drive.chats.using")}
      </div>
      <LinkedChats doc={props.doc} />
      <p data-slot="drive-note">{ctx.t("drive.chats.how")}</p>
    </>
  )
}

/**
 * The revisions, newest first, numbered from the first: who wrote each (the conversation and the agent, as the instance
 * tells them from 0.84, `revisionBy`), and its message ("… by DynWork").
 */
function Versions(props: { doc: Document }) {
  const ctx = usePlugin()
  const names = useNames()
  const list = () => drive.state.opened.revisions ?? []
  const capabilities = () => drive.remote()?.capabilities ?? DriveCapabilities.none
  const offer = () =>
    personOffer({ person: drive.acting(), access: drive.state.opened.detail?.access ?? props.doc.access, needs: "edit" })
  const [busy, setBusy] = createSignal<string>()
  const restore = async (revision: string) => {
    setBusy(revision)
    const done = await drive.restore(props.doc.id, revision)
    setBusy(undefined)
    if (isFailure(done))
      ctx.toast.show({ title: ctx.t("drive.version.failed"), description: failureText(ctx, done), variant: "error" })
  }
  return (
    <>
      <For each={list()}>
        {(revision, index) => (
          <div data-slot="drive-version" data-current={index() === 0 ? "" : undefined}>
            <Avatar
              name={revisionBy(capabilities(), revision) ?? names.owner(props.doc)}
              agent={revision.actor === "agent"}
              size="small"
            />
            <div data-slot="drive-version-body">
              <div data-slot="drive-version-title">
                {ctx.t("drive.rev", { rev: String(list().length - index()) })}
                <Show when={index() === 0}> · {ctx.t("drive.version.current")}</Show>
                <Show when={revision.actor === "agent"}>
                  <Tag tone="agent">{ctx.t("drive.agent")}</Tag>
                </Show>
              </div>
              <Show when={capabilities().conversationLabel && revisionBy(capabilities(), revision)}>
                {(by) => <div data-slot="drive-version-by">{by()}</div>}
              </Show>
              <div data-slot="drive-faint">{revision.message ?? ctx.t("drive.version.unnamed")}</div>
              <div data-slot="drive-faint">{names.ago(revision.created)}</div>
            </div>
            <Show when={index() > 0}>
              <Switch
                fallback={
                  <Button
                    variant="ghost"
                    size="small"
                    disabled={!governance(props.doc.id) || offer() === "level"}
                    title={ctx.t("drive.version.restore.mvp")}
                    onClick={() => openGovernance(ctx, props.doc)}
                  >
                    {ctx.t("drive.version.restore")}
                  </Button>
                }
              >
                <Match when={offer() === "live"}>
                  <Button
                    variant="ghost"
                    size="small"
                    disabled={busy() !== undefined}
                    title={ctx.t("drive.version.restore.hint")}
                    onClick={() => void restore(revision.id)}
                  >
                    {ctx.t("drive.version.restore")}
                  </Button>
                </Match>
                <Match when={offer() === "sign-in"}>
                  <Button
                    variant="ghost"
                    size="small"
                    title={ctx.t("drive.version.restore.signIn")}
                    onClick={signInAsYou}
                  >
                    {ctx.t("drive.version.restore")}
                  </Button>
                </Match>
              </Switch>
            </Show>
          </div>
        )}
      </For>
      <p data-slot="drive-note">{ctx.t("drive.version.note")}</p>
    </>
  )
}

/**
 * The proposals on the document: a person accepts or rejects them, here as themselves while their session is on (G01),
 * otherwise after signing in, or in Governance where the instance has no session for DynWork.
 */
function Proposals(props: { doc: Document }) {
  const ctx = usePlugin()
  const names = useNames()
  const list = () => drive.state.opened.proposals ?? []
  const offer = () =>
    personOffer({ person: drive.acting(), access: drive.state.opened.detail?.access ?? props.doc.access, needs: "edit" })
  const [busy, setBusy] = createSignal(false)
  const review = async (proposal: string, accept: boolean) => {
    setBusy(true)
    const done = await drive.review(props.doc.id, proposal, accept)
    setBusy(false)
    if (isFailure(done))
      ctx.toast.show({ title: ctx.t("drive.proposals.failed"), description: failureText(ctx, done), variant: "error" })
  }
  const tone = (status: string) => (status === "open" ? "warning" : status === "accepted" ? "success" : undefined)
  return (
    <Show when={list().length} fallback={<p data-slot="drive-note">{ctx.t("drive.proposals.none")}</p>}>
      <For each={list()}>
        {(proposal) => (
          <div data-slot="drive-thread" data-state="on">
            <div data-slot="drive-version-title">
              {proposal.message ?? ctx.t("drive.proposals.unnamed")}
              <Tag tone={tone(proposal.status)}>
                {["open", "accepted", "rejected"].includes(proposal.status)
                  ? ctx.t(`drive.proposals.${proposal.status}`)
                  : proposal.status}
              </Tag>
            </div>
            <Show when={proposal.status === "open"}>
              <div data-slot="drive-row-actions">
                <Switch
                  fallback={
                    <Button
                      variant="ghost"
                      size="small"
                      icon="square-arrow-top-right"
                      disabled={!governance(props.doc.id) || offer() === "level"}
                      title={ctx.t("drive.proposals.people")}
                      onClick={() => openGovernance(ctx, props.doc)}
                    >
                      {ctx.t("drive.proposals.review")}
                    </Button>
                  }
                >
                  <Match when={offer() === "live"}>
                    <Button variant="ghost" size="small" disabled={busy()} onClick={() => void review(proposal.id, false)}>
                      {ctx.t("drive.proposals.reject")}
                    </Button>
                    <Button
                      variant="neutral"
                      size="small"
                      disabled={busy()}
                      onClick={() => void review(proposal.id, true)}
                    >
                      {ctx.t("drive.proposals.accept")}
                    </Button>
                  </Match>
                  <Match when={offer() === "sign-in"}>
                    <Button variant="ghost" size="small" onClick={signInAsYou}>
                      {ctx.t("drive.proposals.signIn")}
                    </Button>
                  </Match>
                </Switch>
              </div>
            </Show>
            <div data-slot="drive-faint">{names.ago(proposal.created)}</div>
          </div>
        )}
      </For>
    </Show>
  )
}
