import { usePlugin } from "@opencode/plugin/gui"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Popover } from "@opencode/ui/popover"
import { TextInput } from "@opencode/ui/text-input"
import { createResource, createSignal, For, Show } from "solid-js"
import type { DriveClient } from "../../drive/client"
import { isFailure, type Access, type Document, type Failure } from "../../drive/contract"
import { afterShare, madeByAgent, sharing } from "./model"
import { Avatar, capText, failureText, Level, levelText, openGovernance, Tag, useNames } from "./parts"
import { drive, governance, signInAsYou } from "./store"

// The Share popover of a document, under its Share button: beside a chat and in the Drive's own view. It reads who has
// access when it opens. What the user may change here is the instance's to say (`sharing`): any document they may
// share while their own session is on (G01), as themselves, with the recent sign-in the instance asks for; otherwise a
// document DynWork's agent made, where the Dynapps extension (from 0.85) lets an attended agent share. Every other
// change asks to sign in, or goes to Governance where the instance has no session for DynWork, so its controls are there,
// shut, with the reason and the way there. Loaded on the client only, as the
// Drive's menus are (`menus.tsx`): Kobalte's popover runs browser-only code when it loads.

/** The levels a grant can have; `own` is the owner's alone. */
const levels = ["view", "comment", "edit", "share"]

/** The level select's last choice, on a document whose sharing is live: takes the grant away. */
const remove = "remove"

/** The Share button and its popover. `label` shows the button's name beside its icon. */
export default function SharePopover(props: { doc: Document; label?: boolean }) {
  const ctx = usePlugin()
  const [open, setOpen] = createSignal(false)
  return (
    <Popover
      open={open()}
      onOpenChange={setOpen}
      placement="bottom-end"
      title={props.doc.name}
      class="drive-share"
      triggerAs={props.label ? Button : IconButton}
      triggerProps={
        props.label
          ? { variant: "ghost", icon: "outline-share" }
          : { variant: "ghost", icon: <Icon name="outline-share" />, "aria-label": ctx.t("drive.tab.share") }
      }
      trigger={props.label ? ctx.t("drive.tab.share") : undefined}
    >
      <Show when={open()}>
        <ShareBody doc={props.doc} />
      </Show>
    </Popover>
  )
}

/**
 * Invite, the people with access and the agents, Copy link and Open in Governance. On a document DynWork's agent made,
 * invite, a level and remove are live (`sharing`), each the user's own act; elsewhere they are shut and say why. What
 * the instance refuses shows beside the list, which stays as it was (`afterShare`).
 */
function ShareBody(props: { doc: Document }) {
  const ctx = usePlugin()
  const names = useNames()
  const [read] = createResource(
    () => drive.client(),
    async (client) => {
      const [access, cap, revisions] = await Promise.all([
        client.access({ id: props.doc.id }),
        client.agentCap({ kind: "document", id: props.doc.id }),
        client.revisions({ id: props.doc.id }),
      ])
      return {
        access: isFailure(access) ? undefined : access,
        cap: isFailure(cap) ? undefined : cap,
        made: !isFailure(revisions) && madeByAgent(props.doc, revisions),
      }
    },
  )
  // Both resources are read only once ready: reading one while it loads suspends the nearest Suspense, which is the
  // view's, so the document under the popover goes blank and the popover loses its trigger, its anchor.
  const loaded = () => (read.state === "ready" ? read() : undefined)
  // Who has access as the instance last answered: what it read, then each change it took.
  const [shown, setShown] = createSignal<Access>()
  const [refusal, setRefusal] = createSignal<Failure>()
  const [busy, setBusy] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const list = () => shown() ?? loaded()?.access
  const access = () => list()?.access ?? props.doc.access
  const offer = () =>
    sharing({
      access: access(),
      link: governance(props.doc.id),
      made: loaded()?.made,
      cap: loaded()?.cap?.cap,
      person: drive.acting(),
    })
  const live = () => offer().change === "live" && !busy()
  const reason = () => {
    const change = offer().change
    if (change === "level") return ctx.t("drive.share.level", { level: levelText(ctx.t, access() ?? "") })
    if (change === "sign-in") return ctx.t("drive.share.signIn")
    if (change === "governance") return ctx.t("drive.share.person")
    return drive.acting() === "on" ? ctx.t("drive.share.you") : ctx.t("drive.share.agent")
  }
  // People for the invite, as the user types: the instance's directory by name or email.
  const [found] = createResource(
    () => (offer().change === "live" && query().trim().length >= 2 ? query().trim() : undefined),
    async (text) => {
      await new Promise((resolve) => setTimeout(resolve, 250))
      if (text !== query().trim()) return []
      const answer = await drive.client()?.findPeople({ query: text, limit: 6 })
      return !answer || isFailure(answer) ? [] : answer
    },
  )
  const people = () => (found.state === "ready" ? found() : undefined)
  const change = async (call: (client: DriveClient.Client) => Promise<Access | Failure>) => {
    const client = drive.client()
    const now = list()
    if (!client || !now) return
    setBusy(true)
    const after = afterShare(now, await call(client))
    setBusy(false)
    setShown(after.access)
    setRefusal(after.refusal)
  }
  const invite = (user: string) => {
    setQuery("")
    void change((client) => client.share({ id: props.doc.id, kind: "user", value: user, level: "view" }))
  }
  const owner = () => {
    const id = list()?.owner
    return props.doc.mine ? ctx.t("drive.you") : ((id && drive.nameOf(id)) ?? names.owner(props.doc))
  }
  const copy = async () => {
    const url = governance(props.doc.id)
    if (!url) return
    await ctx.system.copy(url)
    ctx.toast.show({ title: ctx.t("drive.share.copied") })
  }
  return (
    <div data-slot="drive-share">
      <Show
        when={offer().change === "live"}
        fallback={
          <ctx.ui.Tooltip value={reason()} placement="bottom">
            <TextInput
              disabled
              appearance="base"
              leadingIcon={<Icon name="plus" size="small" />}
              placeholder={ctx.t("drive.share.invite")}
              aria-label={ctx.t("drive.share.invite")}
            />
          </ctx.ui.Tooltip>
        }
      >
        <TextInput
          appearance="base"
          leadingIcon={<Icon name="plus" size="small" />}
          placeholder={ctx.t("drive.share.invite")}
          aria-label={ctx.t("drive.share.invite")}
          value={query()}
          disabled={busy()}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
        <Show when={query().trim().length >= 2}>
          <div data-slot="drive-share-found">
            <For
              each={people() ?? []}
              fallback={<p data-slot="drive-note">{ctx.t(found.loading ? "drive.share.searching" : "drive.share.nobody")}</p>}
            >
              {(person) => (
                <button type="button" data-slot="drive-person" onClick={() => invite(person.id)}>
                  <Avatar name={person.name} size="small" />
                  <span data-slot="drive-person-name">
                    {person.name}
                    <Show when={person.email}>{(email) => <span data-slot="drive-faint">{email()}</span>}</Show>
                  </span>
                </button>
              )}
            </For>
          </div>
        </Show>
      </Show>
      <div data-slot="drive-share-title">{ctx.t("drive.share.people")}</div>
      <Show when={!read.loading} fallback={<p data-slot="drive-note">{ctx.t("drive.loading")}</p>}>
        <div data-slot="drive-share-people">
          <div data-slot="drive-person">
            <Avatar name={owner()} size="small" />
            <div data-slot="drive-person-name">{owner()}</div>
            <Tag>{ctx.t("drive.level.own")}</Tag>
          </div>
          <For each={list()?.grants ?? []}>
            {(grant) => (
              <div data-slot="drive-person">
                <Avatar name={grant.name ?? grant.value} size="small" />
                <div data-slot="drive-person-name">
                  {grant.name ?? grant.value}
                  <Show when={grant.subject !== "user"}>
                    <div data-slot="drive-faint">{grant.subject}</div>
                  </Show>
                </div>
                <ctx.ui.Tooltip value={reason()} placement="left">
                  <ctx.ui.Select
                    label={ctx.t("drive.share.levelOf", { name: grant.name ?? grant.value })}
                    options={[
                      ...(levels.includes(grant.level) ? levels : [...levels, grant.level]).map((level) => ({
                        value: level,
                        label: levelText(ctx.t, level),
                      })),
                      ...(offer().change === "live" ? [{ value: remove, label: ctx.t("drive.share.remove") }] : []),
                    ]}
                    value={grant.level}
                    onChange={(level) =>
                      void change((client) =>
                        level === remove
                          ? client.unshare({ id: props.doc.id, grant: grant.id })
                          : client.share({ id: props.doc.id, kind: grant.subject, value: grant.value, level }),
                      )
                    }
                    disabled={!live()}
                  />
                </ctx.ui.Tooltip>
              </div>
            )}
          </For>
          {/* What a folder grants is changed on the folder: shown, never changed here. */}
          <For each={list()?.inherited ?? []}>
            {(grant) => (
              <div data-slot="drive-person" data-inherited="">
                <Avatar name={grant.name ?? grant.value} size="small" />
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
          {/* The agents' cap is the owner's to set, in Governance: the instance keeps `own` from agents. */}
          <Show when={loaded()?.cap}>
            {(cap) => (
              <div data-slot="drive-person">
                <Avatar name={ctx.t("drive.share.agents")} agent size="small" />
                <div data-slot="drive-person-name">
                  {ctx.t("drive.share.agents")}
                  <div data-slot="drive-faint">
                    {ctx.t("drive.banner.cap", {
                      attended: capText(ctx.t, cap().cap),
                      unattended: capText(ctx.t, cap().unattended),
                    })}
                  </div>
                </div>
              </div>
            )}
          </Show>
        </div>
      </Show>
      <Show when={refusal()} fallback={<p data-slot="drive-note">{reason()}</p>}>
        {(failure) => (
          <p data-slot="drive-note" data-tone="warning">
            {failureText(ctx, failure())}
          </p>
        )}
      </Show>
      <div data-slot="drive-share-foot">
        <Button variant="ghost" size="small" icon="copy" disabled={!offer().copy} onClick={() => void copy()}>
          {ctx.t("drive.share.copy")}
        </Button>
        <span data-slot="drive-grow" />
        <Show when={offer().change === "sign-in"}>
          <Button variant="ghost" size="small" onClick={signInAsYou}>
            {ctx.t("drive.menu.signIn")}
          </Button>
        </Show>
        <Show when={offer().governance}>
          <Button
            variant="ghost"
            size="small"
            icon="square-arrow-top-right"
            onClick={() => openGovernance(ctx, props.doc)}
          >
            {ctx.t("drive.governance")}
          </Button>
        </Show>
      </div>
    </div>
  )
}
