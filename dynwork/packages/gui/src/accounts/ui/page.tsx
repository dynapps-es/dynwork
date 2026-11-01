import { Badge } from "@opencode/ui/badge"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { usePlugin, type Live } from "@opencode/plugin/gui"
import { createSignal, For, onCleanup, Show, type Accessor } from "solid-js"
import type { Account } from "../contract"
import type definition from "../index"
import type { Client } from "../renderer"
import AddInstance from "./add"
import { AccountsController } from "./controller"
import { AccountsModel } from "./model"
import { AccountsText } from "./text"
import "./accounts.css"

// Settings -> systemprompt: the instances this device is signed in to, which one is active, and what the active one
// syncs. Everything it shows comes from the accounts' state in main; tokens never reach the window.
export default function AccountsPage(props: { accounts: Accessor<Live<Client>>; now: Accessor<number> }) {
  const ctx = usePlugin<typeof definition>()
  const client = () => {
    const live = props.accounts()

    return live.status === "active" ? live.value : undefined
  }
  const state = () => client()?.state()
  const rows = () => {
    const value = state()

    return value ? AccountsModel.rows(value) : []
  }
  const active = () => rows().find((row) => row.account.active && row.account.status === "signedIn")

  const controller = AccountsController.create({
    client,
    confirm: (question, account) =>
      ctx.dialogs.confirm({
        title: ctx.t(question === "sign-out" ? "signOut.title" : "remove.title", { label: account.label }),
        description: ctx.t(question === "sign-out" ? "signOut.description" : "remove.description"),
        confirm: ctx.t(question === "sign-out" ? "signOut" : "remove"),
        danger: true,
      }),
  })

  const add = (url?: string) => {
    const live = client()

    if (!live) return
    ctx.dialogs.open((dialog) => <AddInstance accounts={live} url={url} close={dialog.close} />)
  }

  return (
    <>
      <div class="settings-tab-header">
        <div class="settings-tab-header-row">
          <div data-slot="accounts-heading">
            <h2 class="settings-tab-title">{ctx.t("title")}</h2>
            <p data-slot="accounts-description">{ctx.t("description")}</p>
          </div>
          <div class="settings-tab-header-actions">
            <Button data-action="accounts-add" variant="neutral" icon="plus" disabled={!client()} onClick={() => add()}>
              {ctx.t("add")}
            </Button>
          </div>
        </div>
      </div>

      <div class="settings-tab-body settings-tab-body--sectioned">
        <section class="settings-section" aria-labelledby="accounts-instances-title">
          <h3 id="accounts-instances-title" class="settings-section-title">
            {ctx.t("instances.title")}
          </h3>
          <Show
            when={state()}
            fallback={
              <p data-slot="accounts-note" role="status">
                {ctx.t(props.accounts().status === "inactive" ? "unavailable" : "loading")}
              </p>
            }
          >
            <div data-component="settings-list" data-variant="accounts" aria-label={ctx.t("instances.label")}>
              <For each={rows()}>
                {(row) => (
                  <Instance
                    row={row}
                    now={props.now()}
                    pending={
                      controller.state.pending?.id === row.account.id ? controller.state.pending.action : undefined
                    }
                    busy={!!controller.state.pending}
                    failed={controller.state.failed?.id === row.account.id}
                    run={(action) => (action === "sign-in" ? add(row.account.url) : void controller.run(action, row))}
                  />
                )}
              </For>
            </div>
          </Show>
        </section>

        <Show when={active()}>{(row) => <Detail row={row()} />}</Show>
      </div>
    </>
  )
}

function Instance(props: {
  row: AccountsModel.Row
  now: number
  pending: AccountsModel.Action | undefined
  busy: boolean
  failed: boolean
  run: (action: AccountsModel.Action) => void
}) {
  const ctx = usePlugin<typeof definition>()
  const [full, setFull] = createSignal(false)
  const row = () => props.row
  const label = (action: AccountsModel.Action) => {
    if (action === "make-active") return ctx.t("makeActive")
    if (action === "sync-now") return ctx.t("syncNow")
    if (action === "sign-in") return ctx.t("signIn")
    if (action === "sign-out") return ctx.t("signOut")
    if (action === "remove") return ctx.t("remove")
    return ctx.t(row().key?.pinned === undefined ? "key.trustFirst" : "key.trust")
  }
  const badge = (value: AccountsModel.Badge) => {
    if (value === "active") return { text: ctx.t("badge.active"), variant: "accent" as const }
    if (value === "signed-out") return { text: ctx.t("badge.signedOut"), variant: "neutral" as const }
    if (value === "key-changed") return { text: ctx.t("badge.keyChanged"), variant: "neutral" as const }
    return { text: ctx.t("badge.newKey"), variant: "neutral" as const }
  }

  return (
    <div
      data-component="accounts-instance"
      data-account={row().account.id}
      data-active={row().account.active ? "" : undefined}
    >
      <div data-slot="accounts-instance-main">
        <span data-slot="accounts-avatar" aria-hidden="true">
          {row().initial}
        </span>
        <div data-slot="accounts-instance-copy">
          <div data-slot="accounts-instance-name">
            <span data-slot="accounts-instance-label">{row().name}</span>
            <For each={row().badges}>
              {(value) => (
                <Badge
                  data-slot="accounts-badge"
                  data-badge={value}
                  appearance="standard"
                  variant={badge(value).variant}
                >
                  {badge(value).text}
                </Badge>
              )}
            </For>
          </div>
          <div data-slot="accounts-instance-url">{row().account.url}</div>
          <div data-slot="accounts-instance-meta">
            <span>
              <Icon name="eye" size="small" />
              {AccountsText.user(ctx, row().account)}
            </span>
            <Show when={row().account.org}>{(org) => <span>{org()}</span>}</Show>
            <span data-slot="accounts-sync" data-tone={row().sync.kind}>
              <Icon name="refresh" size="small" />
              {AccountsText.sync(ctx, row().sync, props.now)}
            </span>
          </div>
        </div>
        <div data-slot="accounts-instance-actions">
          <For each={row().actions.filter((action) => action !== "trust")}>
            {(action) => (
              <Button
                data-action={`accounts-${action}`}
                variant={action === "remove" ? "ghost-danger" : action === "sign-in" ? "neutral" : "ghost"}
                icon={action === "sync-now" ? "refresh" : action === "remove" ? "trash" : undefined}
                aria-label={action === "remove" ? ctx.t("remove.label", { label: row().name }) : undefined}
                disabled={props.busy}
                onClick={() => props.run(action)}
              >
                {action === "remove" ? undefined : label(action)}
              </Button>
            )}
          </For>
        </div>
      </div>
      <Show when={row().key}>
        {(key) => (
          <div data-slot="accounts-key" data-kind={key().pinned === undefined ? "new" : "changed"} role="group">
            <Icon name="circle-exclamation" size="small" />
            <div data-slot="accounts-key-copy">
              <p data-slot="accounts-key-title">
                {ctx.t(key().pinned === undefined ? "key.newTitle" : "key.changedTitle")}{" "}
                <span data-slot="accounts-key-body">
                  {ctx.t(key().pinned === undefined ? "key.newBody" : "key.changedBody")}
                </span>
              </p>
              <dl data-slot="accounts-key-prints">
                <Show when={key().pinned}>
                  {(pinned) => (
                    <div>
                      <dt>{ctx.t("key.pinned")}</dt>
                      <dd data-slot="accounts-fingerprint" data-kind="pinned">
                        {full() ? pinned() : AccountsModel.short(pinned())}
                      </dd>
                    </div>
                  )}
                </Show>
                <div>
                  <dt>{ctx.t("key.offered")}</dt>
                  <dd data-slot="accounts-fingerprint" data-kind="offered">
                    {full() ? key().offered : AccountsModel.short(key().offered)}
                  </dd>
                </div>
              </dl>
              <div data-slot="accounts-key-actions">
                <Button
                  data-action="accounts-trust"
                  variant="warning"
                  disabled={props.busy}
                  onClick={() => props.run("trust")}
                >
                  {label("trust")}
                </Button>
                <Button variant="ghost" onClick={() => setFull(!full())}>
                  {ctx.t(full() ? "key.hideFull" : "key.showFull")}
                </Button>
              </div>
            </div>
          </div>
        )}
      </Show>
      <Show when={props.failed}>
        <p data-slot="accounts-error" role="alert">
          {ctx.t("action.error")}
        </p>
      </Show>
    </div>
  )
}

// What the active instance brings and which key vouches for it. The rules are listed here because they reach every
// session's system context.
function Detail(props: { row: AccountsModel.Row }) {
  const ctx = usePlugin<typeof definition>()
  const [copied, setCopied] = createSignal(false)
  const row = () => props.row
  const account = (): Account => row().account
  const timer = { current: undefined as ReturnType<typeof setTimeout> | undefined }
  onCleanup(() => clearTimeout(timer.current))

  const copy = async (value: string) => {
    await ctx.system.copy(value)
    setCopied(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 2000)
  }
  const counts = () => {
    const sync = row().sync

    return sync.kind === "synced" ? sync.counts : undefined
  }

  return (
    <section class="settings-section" aria-labelledby="accounts-detail-title">
      <h3 id="accounts-detail-title" class="settings-section-title">
        {account().label}
      </h3>
      <div data-component="settings-list" data-variant="accounts">
        <div data-component="settings-row" data-action="accounts-detail-user">
          <div data-slot="settings-row-copy">
            <div data-slot="settings-row-title">{ctx.t("detail.user")}</div>
            <div data-slot="settings-row-description">
              {[account().user, account().org].filter((part) => !!part).join(", ")}
            </div>
          </div>
        </div>
        <Show when={counts()}>
          {(value) => (
            <div data-component="settings-row" data-action="accounts-detail-content">
              <div data-slot="settings-row-copy">
                <div data-slot="settings-row-title">{ctx.t("detail.content")}</div>
                <div data-slot="settings-row-description">{AccountsText.counts(ctx, value())}</div>
              </div>
            </div>
          )}
        </Show>
        <Show when={counts()}>
          {(value) => (
            <div data-component="settings-row" data-action="accounts-detail-rules">
              <div data-slot="settings-row-copy">
                <div data-slot="settings-row-title">{ctx.t("detail.rules")}</div>
                <div data-slot="settings-row-description">{ctx.t("detail.rulesBody", { count: value().rules })}</div>
              </div>
            </div>
          )}
        </Show>
        <div data-component="settings-row" data-action="accounts-detail-key">
          <div data-slot="settings-row-copy">
            <div data-slot="settings-row-title">
              {ctx.t("detail.key")}{" "}
              <Badge appearance="standard" variant="neutral" data-badge={account().trusted ? "trusted" : "waiting"}>
                {ctx.t(
                  account().trusted
                    ? "detail.keyTrusted"
                    : account().fingerprint
                      ? "detail.keyWaiting"
                      : "detail.keyNone",
                )}
              </Badge>
            </div>
            <Show when={account().fingerprint}>
              {(print) => (
                <div data-slot="settings-row-description">
                  <code data-slot="accounts-fingerprint">{print()}</code>
                </div>
              )}
            </Show>
          </div>
          <Show when={account().fingerprint}>
            {(print) => (
              <div data-slot="settings-row-control">
                <Button variant="ghost" icon={copied() ? "check" : "copy"} onClick={() => void copy(print())}>
                  {ctx.t(copied() ? "copy.done" : "copy.label")}
                </Button>
              </div>
            )}
          </Show>
        </div>
      </div>
    </section>
  )
}
