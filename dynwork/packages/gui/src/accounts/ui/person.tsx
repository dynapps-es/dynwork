import { Badge } from "@opencode/ui/badge"
import { Button } from "@opencode/ui/button"
import { usePlugin } from "@opencode/plugin/gui"
import { Show } from "solid-js"
import type { Account } from "../contract"
import type definition from "../index"
import type { Client } from "../renderer"
import { AccountsController } from "./controller"
import { AccountsModel } from "./model"

// Settings -> Governance: whether DynWork acts as the person in the active account's Drive, and the way to start or end
// it. The sign-in runs in main and the browser; this row only shows its status and outcome.
export function ActingAs(props: {
  account: Account
  client: () => Pick<Client, "personSignIn" | "personSignOut" | "personCancel"> | undefined
}) {
  const ctx = usePlugin<typeof definition>()
  const controller = AccountsController.person({ client: props.client })
  const view = () => AccountsModel.person(props.account)
  const failure = () => {
    if (controller.state.failed) return "action.error" as const
    const outcome = controller.state.outcome

    return outcome === undefined || controller.state.running ? undefined : AccountsModel.personOutcome(outcome)
  }

  return (
    <Show when={view()}>
      {(value) => (
        <div data-component="settings-row" data-action="accounts-detail-person" data-person={value().badge ?? "off"}>
          <div data-slot="settings-row-copy">
            <div data-slot="settings-row-title">
              {ctx.t("person.title")}{" "}
              <Show when={value().badge}>
                {(badge) => (
                  <Badge appearance="standard" variant={badge() === "on" ? "accent" : "neutral"} data-badge={badge()}>
                    {ctx.t(badge() === "on" ? "person.badge.on" : "person.badge.renewing")}
                  </Badge>
                )}
              </Show>
            </div>
            <div data-slot="settings-row-description">
              {ctx.t(value().key, {
                time: value().until === undefined ? "" : AccountsModel.clock(value().until ?? 0, ctx.locale.locale()),
              })}
            </div>
            <Show when={failure()}>
              {(key) => (
                <div data-slot="accounts-person-error" role="alert">
                  {ctx.t(key(), { user: props.account.user ?? "" })}
                </div>
              )}
            </Show>
          </div>
          <div data-slot="settings-row-control">
            <Show when={value().action === "sign-in"}>
              <Button
                data-action="accounts-person-sign-in"
                variant="neutral"
                disabled={!props.client() || controller.state.running}
                onClick={() => void controller.signIn(props.account.id)}
              >
                {ctx.t("person.signIn")}
              </Button>
            </Show>
            <Show when={value().action === "cancel"}>
              <Button data-action="accounts-person-cancel" variant="ghost" onClick={controller.cancel}>
                {ctx.t("lapse.cancel")}
              </Button>
            </Show>
            <Show when={value().action === "sign-out"}>
              <Button
                data-action="accounts-person-sign-out"
                variant="ghost"
                disabled={!props.client()}
                onClick={() => void controller.signOut(props.account.id)}
              >
                {ctx.t("signOut")}
              </Button>
            </Show>
          </div>
        </div>
      )}
    </Show>
  )
}
