import { Button } from "@opencode/ui/button"
import { Dialog, DialogBody, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { usePlugin } from "@opencode/plugin/gui"
import { For, Show } from "solid-js"
import type { State } from "../contract"
import type definition from "../index"
import type { Client } from "../renderer"
import { Lapsed } from "./lapse"
import { AccountsModel } from "./model"
import { AccountsText } from "./text"

// What the titlebar pill opens: the instances to switch to, Sync now, and the way to the Accounts page. The titlebar
// item is only a pill, so the menu of the mockup is this small dialog. When the instance refused the active account's
// sign-in for good, it leads with the way to sign in again.
export default function PillMenu(props: {
  state: () => State | undefined
  now: () => number
  switchTo: (id: string) => void
  syncNow: () => void
  manage: () => void
  client: () => Pick<Client, "signInBrowser" | "cancel"> | undefined
}) {
  const ctx = usePlugin<typeof definition>()
  const state = () => props.state()
  const rows = () => {
    const value = state()

    return value
      ? AccountsModel.rows(value).filter(
          (row) => row.account.status === "signedIn" || (row.account.active && row.account.status === "needsSignIn"),
        )
      : []
  }
  const current = () => rows().find((row) => row.account.active)
  const lapsed = () => {
    const row = current()

    return row?.account.status === "needsSignIn" ? row : undefined
  }

  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitleGroup title={ctx.t("pill.dialog.title")} description={ctx.t("pill.dialog.description")} />
      </DialogHeader>
      <DialogBody>
        <div data-component="accounts-pill-menu">
          <Show when={lapsed()}>
            {(row) => (
              <Lapsed account={row().account} name={row().name} client={props.client} signingIn={state()?.signingIn} />
            )}
          </Show>
          <ul data-slot="accounts-pill-list" aria-label={ctx.t("instances.label")}>
            <For each={rows()}>
              {(row) => (
                <li>
                  <button
                    type="button"
                    data-slot="accounts-pill-item"
                    data-active={row.account.active ? "" : undefined}
                    aria-current={row.account.active ? "true" : undefined}
                    aria-label={row.account.active ? undefined : ctx.t("pill.switch", { label: row.name })}
                    disabled={row.account.active}
                    onClick={() => props.switchTo(row.account.id)}
                  >
                    <span data-slot="accounts-pill-name">{row.name}</span>
                    <span data-slot="accounts-pill-status" data-tone={row.sync.kind}>
                      {row.badges.includes("key-changed") || row.badges.includes("new-key")
                        ? ctx.t(row.badges.includes("key-changed") ? "badge.keyChanged" : "badge.newKey")
                        : AccountsText.sync(ctx, row.sync, props.now())}
                    </span>
                  </button>
                </li>
              )}
            </For>
          </ul>
          <div data-slot="accounts-pill-actions">
            <Show when={current()?.actions.includes("sync-now")}>
              <Button variant="neutral" icon="refresh" onClick={props.syncNow}>
                {ctx.t("syncNow")}
              </Button>
            </Show>
            <Button variant="ghost" onClick={props.manage}>
              {ctx.t("pill.manage")}
            </Button>
          </div>
        </div>
      </DialogBody>
    </Dialog>
  )
}
