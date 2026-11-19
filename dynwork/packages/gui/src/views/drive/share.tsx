import { usePlugin, type SetupContext } from "@opencode/plugin/gui"
import { BuiltinSlot } from "@opencode/plugin/gui/builtin"
import { DockPrompt } from "@opencode/session-ui/dock-prompt"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { createSignal, For, Show } from "solid-js"
import type definition from "../../accounts/index"
import { emphasized } from "./model"
import { Shares, type Failure, type ShareCard, type ShareDecision } from "../../drive/contract"

// The agent's shares (D24): before a `documents_share` call runs, its card takes the composer's place in the
// conversation, as OpenCode's permission dock does (the `session.composer.dock` slot), drawn with the same `DockPrompt`
// and data slots so the app styles it as one. Reject, Allow in this conversation and Allow once, in the permission
// dock's order; the call waits for the answer (`drive/share.ts`).
export function registerShares(ctx: SetupContext<typeof definition>) {
  const live = ctx.use(Shares)
  const client = () => {
    const current = live()
    return current.status === "active" ? current.value : undefined
  }
  const card = () => {
    const session = ctx.sessions.current()
    return session && (client()?.state()?.cards ?? []).find((item) => item.session === session.id)
  }
  ctx.add(BuiltinSlot, {
    at: "session.composer.dock",
    render: () => (
      <Show when={card()} keyed>
        {(current) => (
          <ShareDock card={current} decide={(decision) => client()?.decide({ id: current.id, decision })} />
        )}
      </Show>
    ),
  })
}

const titles = {
  grant: "drive.share.grant.title",
  transfer: "drive.share.transfer.title",
  revoke: "drive.share.revoke.title",
} as const

// The levels a grant gives, named as the Share tab names them; another value shows as the agent gave it.
const levels = ["view", "comment", "edit", "share"]

function ShareDock(props: {
  card: ShareCard
  decide: (decision: ShareDecision) => Promise<Failure | undefined> | undefined
}) {
  const ctx = usePlugin()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const decide = async (decision: ShareDecision) => {
    if (busy()) return
    setBusy(true)
    const failure = await props.decide(decision)?.catch(() => undefined)
    setBusy(false)
    // A card decided elsewhere (another window) is `not-found`: it leaves with the state.
    if (failure && failure.code !== "not-found") setError(failure.message)
  }

  const missing = () => ctx.t("drive.share.missing")
  const target = () => props.card.target?.name ?? props.card.target?.id ?? missing()
  const subject = () => {
    const given = props.card.subject
    if (!given) return missing()
    const shown = given.name ?? given.value
    return given.kind === "user" ? shown : `${shown} (${given.kind})`
  }
  const level = () => {
    const given = props.card.level
    if (given === undefined) return missing()
    return levels.includes(given) ? ctx.t(`drive.level.${given}`) : given
  }
  const sentence = () => {
    if (props.card.kind === "transfer") return "drive.share.transfer.text"
    if (props.card.kind === "revoke") return "drive.share.revoke.text"
    return props.card.target?.kind === "folder" ? "drive.share.grant.folder" : "drive.share.grant.text"
  }

  return (
    <DockPrompt
      kind="permission"
      header={
        <div data-slot="permission-row" data-variant="header">
          <span data-slot="permission-icon">
            <Icon name="warning" size="normal" />
          </span>
          <div data-slot="permission-header-title">{ctx.t(titles[props.card.kind])}</div>
        </div>
      }
      footer={
        <>
          <div />
          <div data-slot="permission-footer-actions">
            <Button variant="ghost" size="normal" disabled={busy()} onClick={() => void decide("reject")}>
              {ctx.t("drive.share.reject")}
            </Button>
            <Button variant="neutral" size="normal" disabled={busy()} onClick={() => void decide("conversation")}>
              {ctx.t("drive.share.conversation")}
            </Button>
            <Button variant="submit" size="normal" disabled={busy()} onClick={() => void decide("once")}>
              {ctx.t("drive.share.once")}
            </Button>
          </div>
        </>
      }
    >
      <div data-slot="permission-row">
        <span data-slot="permission-spacer" aria-hidden="true" />
        <div data-slot="permission-hint">
          <For each={emphasized(ctx.t(sentence()), { target: target(), subject: subject(), level: level() })}>
            {(part) => (part.strong ? <strong>{part.text}</strong> : part.text)}
          </For>
        </div>
      </div>
      <Show when={props.card.until}>
        {(until) => (
          <div data-slot="permission-row">
            <span data-slot="permission-spacer" aria-hidden="true" />
            <div data-slot="permission-hint">{ctx.t("drive.share.until", { until: until() })}</div>
          </div>
        )}
      </Show>
      <Show when={error()}>
        {(message) => (
          <div data-slot="permission-row">
            <span data-slot="permission-spacer" aria-hidden="true" />
            <div data-slot="permission-hint">{message()}</div>
          </div>
        )}
      </Show>
    </DockPrompt>
  )
}
