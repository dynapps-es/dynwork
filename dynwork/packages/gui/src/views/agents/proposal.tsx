import { usePlugin, type Live, type SetupContext } from "@opencode/plugin/gui"
import { BuiltinSlot } from "@opencode/plugin/gui/builtin"
import { DockPrompt } from "@opencode/session-ui/dock-prompt"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { createSignal, For, onCleanup, Show, type Accessor } from "solid-js"
import type definition from "../../accounts/index"
import type { ChatClient } from "../../routines/client"
import type { Card } from "../../routines/contract"
import { scheduleText } from "./format"
import "./proposal.css"

// Routines from a chat: the approval of a proposal of the routines tools (`routines/chat.ts`). It takes the composer's
// place in the conversation that made it, as OpenCode's permission dock does (the `session.composer.dock` slot), and
// is drawn with the same `DockPrompt` and data slots, so the app styles it as one. Only Schedule creates the routine;
// Cancel tells the agent nothing was created.
export function registerChat(ctx: SetupContext<typeof definition>, live: Accessor<Live<ChatClient>>) {
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
        {(current) => <ProposalDock card={current} client={client} />}
      </Show>
    ),
  })
}

function ProposalDock(props: { card: Card; client: () => ChatClient | undefined }) {
  const ctx = usePlugin()
  const [full, setFull] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const options = () => props.card.definition.options
  const decide = async (schedule: boolean) => {
    const client = props.client()
    if (!client || busy()) return
    setBusy(true)
    const failure = await client.decide({ id: props.card.id, schedule }).catch(() => undefined)
    setBusy(false)
    // A card answered elsewhere (another window) is `not-found`: it leaves with the state.
    if (failure && failure.code !== "not-found") setError(failure.message)
  }
  const keys = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return
    event.preventDefault()
    void decide(true)
  }
  document.addEventListener("keydown", keys)
  onCleanup(() => document.removeEventListener("keydown", keys))

  const schedule = () => {
    const words = scheduleText(ctx.t, props.card.definition.schedule)
    const zone = props.card.definition.schedule?.timezone
    return zone ? `${words} (${zone})` : words
  }
  const connectors = () => {
    const value = options().connectors
    if (!Array.isArray(value)) return ctx.t("agents.chat.connectors.all")
    if (value.length === 0) return ctx.t("agents.chat.connectors.none")
    return value.join(", ")
  }
  const rows = () => [
    [ctx.t("agents.chat.row.routine"), props.card.definition.name],
    [ctx.t("agents.chat.row.schedule"), schedule()],
    [ctx.t("agents.chat.row.where"), props.card.label],
    [ctx.t("agents.chat.row.permissions"), ctx.t(`agents.chat.permissions.${String(options().permissions)}`)],
    ...(typeof options().folder === "string" ? [[ctx.t("agents.chat.row.folder"), String(options().folder)]] : []),
    [ctx.t("agents.chat.row.connectors"), connectors()],
    [ctx.t("agents.chat.row.notify"), ctx.t(`agents.chat.notify.${String(options().notify)}`)],
    [ctx.t("agents.chat.row.origin"), ctx.t("agents.chat.origin")],
  ]
  const text = () => {
    const instructions = props.card.definition.instructions
    return instructions.kind === "prompt" ? instructions.text : ""
  }

  return (
    <DockPrompt
      kind="permission"
      header={
        <div data-slot="permission-row" data-variant="header">
          <span data-slot="permission-icon">
            <Icon name="warning" size="normal" />
          </span>
          <div data-slot="permission-header-title">{ctx.t("agents.chat.title")}</div>
        </div>
      }
      footer={
        <>
          <div />
          <div data-slot="permission-footer-actions">
            <Button variant="ghost" size="normal" disabled={busy()} onClick={() => void decide(false)}>
              {ctx.t("agents.chat.cancel")}
            </Button>
            <Button variant="submit" size="normal" disabled={busy()} onClick={() => void decide(true)}>
              {ctx.t("agents.chat.schedule")}
              <kbd data-slot="proposal-key">⌘↵</kbd>
            </Button>
          </div>
        </>
      }
    >
      <div data-slot="permission-row">
        <span data-slot="permission-spacer" aria-hidden="true" />
        <div data-slot="permission-hint">{ctx.t("agents.chat.description")}</div>
      </div>
      <div data-slot="permission-row">
        <span data-slot="permission-spacer" aria-hidden="true" />
        <div data-slot="permission-input" data-scrollable data-component="agents-proposal">
          <pre data-slot="proposal-prompt">{text()}</pre>
          <dl data-slot="proposal-rows">
            <For each={rows()}>
              {(row) => (
                <>
                  <dt>{row[0]}</dt>
                  <dd>{row[1]}</dd>
                </>
              )}
            </For>
          </dl>
          <Show when={options().permissions === "bypass"}>
            <p data-slot="proposal-warning">{ctx.t("agents.chat.bypass")}</p>
          </Show>
          <Button
            variant="ghost"
            size="small"
            data-slot="proposal-toggle"
            aria-expanded={full()}
            onClick={() => setFull(!full())}
          >
            {ctx.t(full() ? "agents.chat.input.hide" : "agents.chat.input.show")}
          </Button>
          <Show when={full()}>
            <pre data-slot="proposal-prompt">{JSON.stringify(props.card.proposal, null, 2)}</pre>
          </Show>
          <Show when={error()}>{(message) => <p data-slot="proposal-error">{message()}</p>}</Show>
        </div>
      </div>
    </DockPrompt>
  )
}
