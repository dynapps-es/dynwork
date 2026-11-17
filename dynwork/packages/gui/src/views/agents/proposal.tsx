import { ComposerPill, usePlugin, type Live, type SetupContext } from "@opencode/plugin/gui"
import { Button } from "@opencode/ui/button"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { createEffect, createSignal, For, onCleanup, Show, type Accessor } from "solid-js"
import type definition from "../../accounts/index"
import type { ChatClient } from "../../routines/client"
import type { Card } from "../../routines/contract"
import { scheduleText } from "./format"
import "./proposal.css"

// Routines from a chat: the card of a proposal of the routines tools (`routines/chat.ts`). It opens over the
// conversation that made it when that conversation is on screen, and a pill above its composer opens it again after
// it was dismissed. Only Schedule creates the routine; Cancel tells the agent nothing was created. Dismissing the card
// decides nothing: the agent keeps waiting.
export function registerChat(ctx: SetupContext<typeof definition>, live: Accessor<Live<ChatClient>>) {
  const client = () => {
    const current = live()
    return current.status === "active" ? current.value : undefined
  }
  const cards = () => client()?.state()?.cards ?? []
  const cardOf = (session: string) => cards().find((card) => card.session === session)
  const shown = new Set<string>()
  const open = (card: Card) =>
    ctx.dialogs.open((dialog) => <ProposalCard card={card} client={client} close={dialog.close} />)

  ctx.add(ComposerPill, {
    id: "routine-proposal",
    show: (input) => {
      const card = cardOf(input.session.id)
      if (!card) return undefined
      return { label: ctx.t("agents.chat.pill", { name: card.definition.name }), tone: "warning", run: () => open(card) }
    },
  })

  createEffect(() => {
    const session = ctx.sessions.current()
    const card = session && cardOf(session.id)
    if (!card || shown.has(card.id)) return
    shown.add(card.id)
    open(card)
  })
}

function ProposalCard(props: { card: Card; client: () => ChatClient | undefined; close: () => void }) {
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
    if (failure && failure.code !== "not-found") return setError(failure.message)
    props.close()
  }
  // The card goes when it is decided anywhere: in another window, or by the agent's step being stopped.
  createEffect(() => {
    const client = props.client()
    if (client && !(client.state()?.cards ?? []).some((card) => card.id === props.card.id)) props.close()
  })
  const keys = (event: KeyboardEvent) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      void decide(true)
    }
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
    return Array.isArray(value) ? value.join(", ") : ctx.t("agents.chat.connectors.all")
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
    <Dialog size="large" containerClass="agents-proposal-dialog">
      <DialogHeader>
        <DialogTitleGroup title={ctx.t("agents.chat.title")} description={ctx.t("agents.chat.description")} />
      </DialogHeader>
      <DialogBody>
        <div data-component="agents-proposal">
          <div data-slot="proposal-scroll">
            <div data-slot="proposal-label">{ctx.t("agents.chat.prompt")}</div>
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
            <button type="button" data-slot="proposal-toggle" aria-expanded={full()} onClick={() => setFull(!full())}>
              {ctx.t(full() ? "agents.chat.input.hide" : "agents.chat.input.show")}
            </button>
            <Show when={full()}>
              <pre data-slot="proposal-input">{JSON.stringify(props.card.proposal, null, 2)}</pre>
            </Show>
            <Show when={error()}>{(message) => <p data-slot="proposal-error">{message()}</p>}</Show>
          </div>
          <DialogFooter>
            <Button variant="ghost" disabled={busy()} onClick={() => void decide(false)}>
              {ctx.t("agents.chat.cancel")}
            </Button>
            <Button variant="contrast" disabled={busy()} onClick={() => void decide(true)}>
              {ctx.t("agents.chat.schedule")}
              <kbd data-slot="proposal-key">⌘↵</kbd>
            </Button>
          </DialogFooter>
        </div>
      </DialogBody>
    </Dialog>
  )
}
