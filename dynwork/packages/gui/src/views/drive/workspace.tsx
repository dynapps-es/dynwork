import { usePlugin } from "@opencode/plugin/gui"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { ResizeHandle } from "@opencode/ui/resize-handle"
import { Tabs } from "@opencode/ui/tabs"
import { createEffect, createSignal, For, Match, on, Show, Switch } from "solid-js"
import type { Document } from "../../drive/contract"
import { askAgent, back, sessionOf, titleOf } from "./chat"
import { CommentMarks, CommentsTab } from "./comments"
import { DocMenu } from "./menus"
import { drawerWidth, panes } from "./panes"
import { Avatar, FormatGlyph, Level, openGovernance, Tag, useNames } from "./parts"
import { account, drive, governance, type DocTab } from "./store"
import { Viewer, type Outline } from "./viewer"

// The drawer's tabs.
const tabs: readonly DocTab[] = ["details", "comments", "versions", "proposals", "share"]

/**
 * A document open in the Drive: its bar, the edition banner, its index, its viewer and the drawer. The index and the
 * drawer show or hide from the bar, and the drawer takes the width its edge is dragged to (`panes`).
 */
export function Workspace(props: { doc: Document }) {
  const ctx = usePlugin()
  const names = useNames()
  const [outline, setOutline] = createSignal<Outline>()
  const headings = () => outline()?.headings ?? []
  // The index's levels from the document's top one, three at most.
  const depth = (level: number) => Math.min(3, level - Math.min(...headings().map((heading) => heading.level)) + 1)
  const backLabel = () => ctx.t(drive.state.from && "chat" in drive.state.from ? "drive.back.chat" : "drive.back.drive")
  // A comment picked or started from the document shows in the drawer: a hidden drawer opens for it.
  createEffect(
    on(
      () => [drive.state.doc.thread, drive.state.doc.compose, drive.state.doc.choosing] as const,
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
          <nav data-slot="drive-rail" aria-label={ctx.t("drive.outline")}>
            <div data-slot="drive-rail-title">{ctx.t("drive.outline")}</div>
            <For each={headings()}>
              {(heading, index) => (
                <button
                  type="button"
                  data-level={depth(heading.level)}
                  title={heading.text}
                  onClick={() => outline()?.go(index())}
                >
                  {heading.text}
                </button>
              )}
            </For>
          </nav>
        </Show>
        <div data-slot="drive-canvas">
          <Viewer doc={props.doc} onOutline={setOutline} />
          <Show when={props.doc.format === "markdown"}>
            <CommentMarks doc={props.doc} />
          </Show>
        </div>
        <Show when={panes.drawer()}>
          <aside data-slot="drive-drawer" style={{ width: `${panes.width()}px` }}>
            <ResizeHandle
              direction="horizontal"
              edge="start"
              size={panes.width()}
              min={drawerWidth.min}
              max={drawerWidth.max}
              onResize={panes.resize}
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
                  <CommentsTab doc={props.doc} />
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
 * How DynWork writes here (D2): as an agent that signs "<user> by DynWork", what the Drive lets it do on this document
 * attended and what a scheduled task could do unattended (C2); as the person once the Drive allows it (P1).
 */
function Banner() {
  const ctx = usePlugin()
  const cap = () => drive.state.opened.cap
  return (
    <Show
      when={!drive.person()}
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
          {ctx.t("drive.banner.mvp", { user: account()?.user ?? ctx.t("drive.you") })}
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
      </div>
    </Show>
  )
}

/** What an agent may do, in words: `none`, `read`, `suggest`, `edit`, or the instance's own word. */
function capText(t: (key: string) => string, cap: string) {
  return ["none", "read", "suggest", "edit"].includes(cap) ? t(`drive.cap.${cap}`) : cap
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

/** The revisions, newest first, numbered from the first: who wrote each, and its message ("… by DynWork"). */
function Versions(props: { doc: Document }) {
  const ctx = usePlugin()
  const names = useNames()
  const list = () => drive.state.opened.revisions ?? []
  return (
    <>
      <For each={list()}>
        {(revision, index) => (
          <div data-slot="drive-version" data-current={index() === 0 ? "" : undefined}>
            <Avatar
              name={revision.actor === "agent" ? "DynWork" : names.owner(props.doc)}
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
              <div data-slot="drive-faint">{revision.message ?? ctx.t("drive.version.unnamed")}</div>
              <div data-slot="drive-faint">{names.ago(revision.created)}</div>
            </div>
            <Show when={index() > 0}>
              <Button
                variant="ghost"
                size="small"
                disabled={!governance(props.doc.id)}
                title={ctx.t("drive.version.restore.mvp")}
                onClick={() => openGovernance(ctx, props.doc)}
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

/** The proposals on the document: a person accepts or rejects them, in Governance until DynWork acts as the person. */
function Proposals(props: { doc: Document }) {
  const ctx = usePlugin()
  const names = useNames()
  const list = () => drive.state.opened.proposals ?? []
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
                <Button
                  variant="ghost"
                  size="small"
                  icon="square-arrow-top-right"
                  disabled={!governance(props.doc.id)}
                  title={ctx.t("drive.proposals.people")}
                  onClick={() => openGovernance(ctx, props.doc)}
                >
                  {ctx.t("drive.proposals.review")}
                </Button>
              </div>
            </Show>
            <div data-slot="drive-faint">{names.ago(proposal.created)}</div>
          </div>
        )}
      </For>
    </Show>
  )
}

/** Who can see the document and what agents may do with it; sharing happens in Governance (P1). */
function Sharing(props: { doc: Document }) {
  const ctx = usePlugin()
  const names = useNames()
  const access = () => drive.state.opened.access
  const cap = () => drive.state.opened.cap
  return (
    <>
      <div data-slot="drive-person">
        <Avatar name={names.owner(props.doc)} />
        <div data-slot="drive-person-name">{names.owner(props.doc)}</div>
        <Tag>{ctx.t("drive.level.own")}</Tag>
      </div>
      <For each={[...(access()?.grants ?? []), ...(access()?.inherited ?? [])]}>
        {(grant) => (
          <div data-slot="drive-person">
            <Avatar name={grant.name ?? grant.value} />
            <div data-slot="drive-person-name">
              {grant.name ?? grant.value}
              <Show when={grant.from}>
                {(from) => <div data-slot="drive-faint">{ctx.t("drive.share.from", { folder: from().name })}</div>}
              </Show>
            </div>
            <Tag>
              <Level level={grant.level} />
            </Tag>
          </div>
        )}
      </For>
      <Show when={cap()}>
        {(found) => (
          <div data-slot="drive-person">
            <Avatar name={ctx.t("drive.share.agents")} agent />
            <div data-slot="drive-person-name">
              {ctx.t("drive.share.agents")}
              <div data-slot="drive-faint">
                {ctx.t("drive.banner.cap", {
                  attended: capText(ctx.t, found().cap),
                  unattended: capText(ctx.t, found().unattended),
                })}
              </div>
            </div>
          </div>
        )}
      </Show>
      <div data-slot="drive-row-actions">
        <Button
          variant="outline"
          size="small"
          icon="share"
          disabled={!governance(props.doc.id)}
          onClick={() => openGovernance(ctx, props.doc)}
        >
          {ctx.t("drive.share.governance")}
        </Button>
      </div>
      <p data-slot="drive-note" data-tone={drive.person() ? undefined : "warning"}>
        {ctx.t(drive.person() ? "drive.share.levels" : "drive.share.mvp")}
      </p>
    </>
  )
}
