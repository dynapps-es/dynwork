import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { usePlugin } from "@opencode/plugin/gui"
import { Show } from "solid-js"
import type { Account } from "../contract"
import type definition from "../index"
import type { Client } from "../renderer"
import { AccountsController } from "./controller"
import { AccountsModel } from "./model"
import "./accounts.css"

// An account whose sign-in the instance refused for good: why, and the way back, which is the same browser sign-in as
// the first one, for that instance. The Governance page, the pill's menu and the Drive show it. `signingIn` is the
// instance of the browser sign-in under way in any window, so each place that shows the account says it is waiting.
export function Lapsed(props: {
  account: Account
  name: string
  client: () => Pick<Client, "signInBrowser" | "cancel"> | undefined
  signingIn: string | undefined
  variant?: "inline"
}) {
  const ctx = usePlugin<typeof definition>()
  const reconnect = AccountsController.reconnect({ client: props.client })
  const waiting = () => reconnect.state.running || props.signingIn === props.account.url
  const failure = () => {
    const outcome = reconnect.state.outcome

    return outcome === undefined || waiting() ? undefined : AccountsModel.outcome(outcome)
  }

  return (
    <div data-component="accounts-lapse" data-variant={props.variant} role="group">
      <Icon name="circle-exclamation" size="small" />
      <div data-slot="accounts-lapse-copy">
        <p data-slot="accounts-lapse-title">
          {ctx.t(`lapse.${props.account.lapse ?? "refused"}`, { label: props.name })}{" "}
          <span data-slot="accounts-lapse-body">{ctx.t("lapse.body", { label: props.name })}</span>
        </p>
        <Show when={waiting()}>
          <p data-slot="accounts-lapse-waiting" role="status">
            {ctx.t("lapse.waiting")}
          </p>
        </Show>
        <Show when={failure()}>
          {(key) => (
            <p data-slot="accounts-lapse-error" role="alert">
              {ctx.t(key())}
            </p>
          )}
        </Show>
        <div data-slot="accounts-lapse-actions">
          <Show
            when={waiting()}
            fallback={
              <Button
                data-action="accounts-sign-in-again"
                variant="warning"
                disabled={!props.client()}
                onClick={() => void reconnect.run(props.account)}
              >
                {ctx.t("signInAgain")}
              </Button>
            }
          >
            <Button variant="ghost" onClick={reconnect.cancel}>
              {ctx.t("lapse.cancel")}
            </Button>
          </Show>
        </div>
      </div>
    </div>
  )
}
