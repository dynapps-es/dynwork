import { Dialog, DialogBody, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { usePlugin } from "@opencode/plugin/gui"
import { createEffect, onCleanup } from "solid-js"
import { ConnectForm } from "../../signin/connect"
import { SignInFlow } from "../../signin/flow"
import { SignInReal } from "../../signin/real"
import type definition from "../index"

// The sign-in screen's connect form in a dialog. The account joins the list when it signs in; the user decides in the
// list when to make it active, so the dialog closes there and skips the instance choice.
export default function AddInstance(props: { accounts: SignInReal.Accounts; url?: string; close: () => void }) {
  const ctx = usePlugin<typeof definition>()
  const flow = SignInFlow.create({ ...SignInReal.create(props.accounts), instances: async () => [] })

  // A signed-out instance's "Sign in" starts with its URL typed in.
  if (props.url) flow.input(props.url)

  createEffect(() => {
    if (flow.state.step === "choose") props.close()
  })
  // A browser sign-in the user walks away from stops listening.
  onCleanup(() => flow.cancel())

  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitleGroup title={ctx.t("add.title")} description={ctx.t("add.description")} />
      </DialogHeader>
      <DialogBody>
        <div data-component="dynwork-signin-form" data-variant="dialog">
          <ConnectForm flow={flow} />
        </div>
      </DialogBody>
    </Dialog>
  )
}
