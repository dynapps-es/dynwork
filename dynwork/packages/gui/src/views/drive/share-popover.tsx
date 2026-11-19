import { usePlugin } from "@opencode/plugin/gui"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Popover } from "@opencode/ui/popover"
import { TextInput } from "@opencode/ui/text-input"
import { createResource, createSignal, For, Show } from "solid-js"
import { isFailure, type Document } from "../../drive/contract"
import { sharing } from "./model"
import { Avatar, capText, Level, levelText, openGovernance, Tag, useNames } from "./parts"
import { drive, governance } from "./store"

// The Share popover of a document, under its Share button: beside a chat and in the Drive's own view. It reads who has
// access when it opens. What the user may change is the instance's to say (`sharing`): on 0.83 every change goes to
// Governance, so the controls are there, shut, with the reason and the way there. Loaded on the client only, as the
// Drive's menus are (`menus.tsx`): Kobalte's popover runs browser-only code when it loads.

/** The levels a grant can have; `own` is the owner's alone. */
const levels = ["view", "comment", "edit", "share"]

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

/** Invite, the people with access and the agents, the reason nothing changes here, and Copy link. */
function ShareBody(props: { doc: Document }) {
  const ctx = usePlugin()
  const names = useNames()
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
  const access = () => read()?.access?.access ?? props.doc.access
  const offer = () => sharing({ access: access(), link: governance(props.doc.id) })
  const reason = () =>
    offer().change === "governance"
      ? ctx.t("drive.share.person")
      : ctx.t("drive.share.level", { level: levelText(ctx.t, access() ?? "") })
  const owner = () => {
    const id = read()?.access?.owner
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
      <ctx.ui.Tooltip value={reason()} placement="bottom">
        <TextInput
          disabled
          appearance="base"
          leadingIcon={<Icon name="plus" size="small" />}
          placeholder={ctx.t("drive.share.invite")}
          aria-label={ctx.t("drive.share.invite")}
        />
      </ctx.ui.Tooltip>
      <div data-slot="drive-share-title">{ctx.t("drive.share.people")}</div>
      <Show when={!read.loading} fallback={<p data-slot="drive-note">{ctx.t("drive.loading")}</p>}>
        <div data-slot="drive-share-people">
          <div data-slot="drive-person">
            <Avatar name={owner()} size="small" />
            <div data-slot="drive-person-name">{owner()}</div>
            <Tag>{ctx.t("drive.level.own")}</Tag>
          </div>
          <For each={read()?.access?.grants ?? []}>
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
                    options={(levels.includes(grant.level) ? levels : [...levels, grant.level]).map((level) => ({
                      value: level,
                      label: levelText(ctx.t, level),
                    }))}
                    value={grant.level}
                    onChange={() => {}}
                    disabled
                  />
                </ctx.ui.Tooltip>
              </div>
            )}
          </For>
          {/* What a folder grants is changed on the folder: shown, never changed here. */}
          <For each={read()?.access?.inherited ?? []}>
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
          <Show when={read()?.cap}>
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
      <p data-slot="drive-note">{reason()}</p>
      <div data-slot="drive-share-foot">
        <Button variant="ghost" size="small" icon="copy" disabled={!offer().copy} onClick={() => void copy()}>
          {ctx.t("drive.share.copy")}
        </Button>
        <span data-slot="drive-grow" />
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
