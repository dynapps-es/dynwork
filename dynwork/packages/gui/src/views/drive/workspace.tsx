import { usePlugin } from "@opencode/plugin/gui"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Tabs } from "@opencode/ui/tabs"
import { For, Match, Show, Switch } from "solid-js"
import { isFailure, type Document, type Page } from "../../drive/contract"
import { askAgent, sessionOf, titleOf } from "./chat"
import { DocMenu } from "./menus"
import { Avatar, failureText, FormatGlyph, Level, openGovernance, Tag, useNames } from "./parts"
import { account, drive, governance, type DocTab } from "./store"

// The drawer's tabs. Comments join them with the Drive's own comments (phase 06 of the Drive plan).
const tabs: readonly DocTab[] = ["details", "versions", "proposals", "share"]

/** A document open in the Drive: its bar, the edition banner, its preview and the drawer. */
export function Workspace(props: { doc: Document }) {
  const ctx = usePlugin()
  const names = useNames()
  const failed = () => {
    const answer = drive.state.opened.page
    return answer && isFailure(answer) ? answer : undefined
  }
  const page = () => {
    const answer = drive.state.opened.page
    return answer && !isFailure(answer) ? answer : undefined
  }

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
        <span data-slot="drive-ws-saved">
          <Icon name="check-small" size="small" />
          {names.ago(props.doc.updated)}
        </span>
        <span data-slot="drive-grow" />
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
        <div data-slot="drive-canvas">
          <Switch fallback={<p data-slot="drive-note">{ctx.t("drive.loading")}</p>}>
            <Match when={failed()}>
              {(failure) => (
                <p data-slot="drive-note">
                  {ctx.t("drive.preview.failed")} {failureText(ctx, failure())}
                </p>
              )}
            </Match>
            <Match when={page()}>{(shown) => <PreviewFrame page={shown()} title={props.doc.name} />}</Match>
          </Switch>
        </div>
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
                    <Show when={count(tab)}>
                      <span data-slot="drive-count">{count(tab)}</span>
                    </Show>
                  </Tabs.Trigger>
                )}
              </For>
            </Tabs.List>
          </Tabs>
          <div data-slot="drive-drawer-body">
            <Switch>
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
      </div>
    </div>
  )
}

function count(tab: DocTab) {
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

/**
 * The document as the Drive previews it, in a sandboxed frame: no scripts, no access to DynWork, and the network the
 * instance's policy allows. The viewers per format, with what the policy allows to run, come with the document tabs.
 */
export function PreviewFrame(props: { page: Page; title: string }) {
  return <iframe data-slot="drive-frame" sandbox="" title={props.title} srcdoc={framed(props.page)} />
}

/** The page with the instance's policy as a meta tag, less the directives only a response header can carry. */
export function framed(page: Page) {
  const policy = (page.csp ?? "default-src 'none'")
    .split(";")
    .map((directive) => directive.trim())
    .filter((directive) => directive && !/^(sandbox|frame-ancestors|report-uri|report-to)\b/.test(directive))
    .join("; ")
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policy.replace(/"/g, "&quot;")}">`
  return `<!doctype html><html><head><meta charset="utf-8">${meta}</head><body>${page.html}</body></html>`
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
