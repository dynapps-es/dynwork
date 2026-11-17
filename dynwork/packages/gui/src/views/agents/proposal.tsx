import { usePlugin, type Live, type SetupContext } from "@opencode/plugin/gui"
import { BuiltinSlot } from "@opencode/plugin/gui/builtin"
import { DockPrompt } from "@opencode/session-ui/dock-prompt"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { createSignal, For, onCleanup, Show, type Accessor } from "solid-js"
import type definition from "../../accounts/index"
import type { ChatClient } from "../../routines/client"
import type { Card } from "../../routines/contract"
import { cardChanges, cardRows } from "./format"
import "./proposal.css"

// Tasks from a chat: the approval of what the scheduled-task tools ask for (`routines/chat.ts`). One dock with a
// variant per card kind: a new task (`create`), a change (`update`, each changed row as before → after), a deletion
// (`delete`) and a run of a "Don't ask" task (`run`). It takes the composer's place in the conversation that asked, as
// OpenCode's permission dock does (the `session.composer.dock` slot), drawn with the same `DockPrompt` and data slots so
// the app styles it as one. Only the dock's own button acts; Cancel tells the agent nothing changed.
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
        {(current) => <TaskDock card={current} client={client} />}
      </Show>
    ),
  })
}

// The words of each variant: its title, the line under it and its button's.
const copy = {
  create: { title: "agents.chat.title", description: "agents.chat.description", accept: "agents.chat.schedule" },
  update: {
    title: "agents.chat.update.title",
    description: "agents.chat.update.description",
    accept: "agents.chat.update.accept",
  },
  delete: {
    title: "agents.chat.delete.title",
    description: "agents.chat.delete.description",
    accept: "agents.chat.delete.accept",
  },
  run: { title: "agents.chat.run.title", description: "agents.chat.run.description", accept: "agents.chat.run.accept" },
}

// The rows each variant shows besides a change's: the full card for a new task, what identifies it otherwise.
const shown: Record<Card["kind"], readonly string[]> = {
  create: ["name", "schedule", "where", "permissions", "folder", "connectors", "notify"],
  update: [],
  delete: ["name", "schedule", "where"],
  run: ["name", "schedule", "where", "permissions"],
}

function TaskDock(props: { card: Card; client: () => ChatClient | undefined }) {
  const ctx = usePlugin()
  const [full, setFull] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const words = () => copy[props.card.kind]
  const decide = async (accept: boolean) => {
    const client = props.client()
    if (!client || busy()) return
    setBusy(true)
    const failure = await client.decide({ id: props.card.id, accept }).catch(() => undefined)
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

  const all = () => cardRows(ctx.t, props.card.definition, props.card.label)
  const changes = () =>
    props.card.before ? cardChanges(ctx.t, props.card.before, props.card.definition, props.card.label) : []
  const rows = () => [
    ...all()
      .filter((row) => shown[props.card.kind].includes(row.key))
      .filter((row) => row.key !== "folder" || typeof props.card.definition.options.folder === "string")
      .map((row) => [row.label, row.value]),
    ...changes()
      .filter((row) => row.key !== "instructions")
      .map((row) => [row.label, `${row.before} → ${row.value}`]),
    ...(props.card.kind === "create" ? [[ctx.t("agents.chat.row.origin"), ctx.t("agents.chat.origin")]] : []),
  ]
  // The prompt shows for a new task, and for a change only when the change is to it.
  const prompt = () => {
    if (props.card.kind === "create") return all().find((row) => row.key === "instructions")?.value
    return changes().find((row) => row.key === "instructions")?.value
  }
  const bypass = () =>
    props.card.kind !== "run" &&
    props.card.definition.options.permissions === "bypass" &&
    props.card.before?.options.permissions !== "bypass"

  return (
    <DockPrompt
      kind="permission"
      header={
        <div data-slot="permission-row" data-variant="header">
          <span data-slot="permission-icon">
            <Icon name="warning" size="normal" />
          </span>
          <div data-slot="permission-header-title">{ctx.t(words().title)}</div>
        </div>
      }
      footer={
        <>
          <div />
          <div data-slot="permission-footer-actions">
            <Button variant="ghost" size="normal" disabled={busy()} onClick={() => void decide(false)}>
              {ctx.t("agents.chat.cancel")}
            </Button>
            <Button
              variant={props.card.kind === "delete" ? "danger" : "submit"}
              size="normal"
              disabled={busy()}
              onClick={() => void decide(true)}
            >
              {ctx.t(words().accept)}
              <kbd data-slot="proposal-key">⌘↵</kbd>
            </Button>
          </div>
        </>
      }
    >
      <div data-slot="permission-row">
        <span data-slot="permission-spacer" aria-hidden="true" />
        <div data-slot="permission-hint">{ctx.t(words().description)}</div>
      </div>
      <div data-slot="permission-row">
        <span data-slot="permission-spacer" aria-hidden="true" />
        <div data-slot="permission-input" data-scrollable data-component="agents-proposal">
          <Show when={prompt()}>
            {(text) => (
              <>
                <Show when={props.card.kind === "update"}>
                  <p data-slot="proposal-label">{ctx.t("agents.chat.update.instructions")}</p>
                </Show>
                <pre data-slot="proposal-prompt">{text()}</pre>
              </>
            )}
          </Show>
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
          <Show when={bypass()}>
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
            <pre data-slot="proposal-prompt">{props.card.input}</pre>
          </Show>
          <Show when={error()}>{(message) => <p data-slot="proposal-error">{message()}</p>}</Show>
        </div>
      </div>
    </DockPrompt>
  )
}
