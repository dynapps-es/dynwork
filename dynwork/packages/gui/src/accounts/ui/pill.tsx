import { Button } from "@opencode/ui/button"
import { Dialog, DialogBody, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { usePlugin } from "@opencode/plugin/gui"
import { For, Show } from "solid-js"
import type { State } from "../contract"
import type definition from "../index"
import { AccountsModel } from "./model"
import { AccountsText } from "./text"

// What the titlebar pill opens: the instances to switch to, Sync now, and the way to the Accounts page. The titlebar
// item is only a pill, so the menu of the mockup is this small dialog.
export default function PillMenu(props: {
  state: () => State | undefined
  now: () => number
  switchTo: (id: string) => void
  syncNow: () => void
  manage: () => void
}) {
  const ctx = usePlugin<typeof definition>()
  const state = () => props.state()
  const rows = () => {
    const value = state()

    return value ? AccountsModel.rows(value).filter((row) => row.account.status === "signedIn") : []
  }
  const current = () => rows().find((row) => row.account.active)

  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitleGroup title={ctx.t("pill.dialog.title")} description={ctx.t("pill.dialog.description")} />
      </DialogHeader>
      <DialogBody>
        <div data-component="accounts-pill-menu">
          <ul data-slot="accounts-pill-list" aria-label={ctx.t("instances.label")}>
            <For each={rows()}>
              {(row) => (
                <li>
                  <button
                    type="button"
                    data-slot="accounts-pill-item"
                    data-active={row.account.active ? "" : undefined}
                    aria-current={row.account.active ? "true" : undefined}
                    aria-label={row.account.active ? undefined : ctx.t("pill.switch", { label: row.account.label })}
                    disabled={row.account.active}
                    onClick={() => props.switchTo(row.account.id)}
                  >
                    <span data-slot="accounts-pill-name">{row.account.label}</span>
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
