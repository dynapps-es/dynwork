export * as SignInFlow from "./flow"

import { createStore } from "solid-js/store"
import type { SignInAccounts } from "./accounts"
import { SignInFlag } from "./flag"

// "typing" waits for the field to settle; the other statuses are the colored dot under the instance URL.
export type Status = "empty" | "typing" | "checking" | "valid" | "invalid"

export type Step = "connect" | "choose" | "finalizing" | "done"

// The field settles after this much idle typing, or at once on blur.
const idle = 500

export function create(accounts: SignInAccounts.Interface) {
  const [state, setState] = createStore({
    step: "connect" as Step,
    url: "",
    status: "empty" as Status,
    host: "",
    pending: undefined as "browser" | "token" | undefined,
    keep: true,
    token: "",
    tokenError: false,
    instances: [] as SignInAccounts.Instance[],
    selected: "",
    synced: 0,
  })
  const timer = { current: undefined as ReturnType<typeof setTimeout> | undefined }

  const selected = () => state.instances.find((instance) => instance.id === state.selected)

  // A check answers for the value it started from; an edit while it runs makes the answer stale.
  const settle = async () => {
    clearTimeout(timer.current)
    const url = state.url

    if (!url.trim()) return setState({ status: "empty", host: "" })

    if (state.status !== "typing") return
    setState("status", "checking")
    const probe = await accounts.probe(url)

    if (state.url !== url) return

    if (!probe.reachable) return setState({ status: "invalid", host: "" })
    setState({ status: "valid", host: probe.host })
  }

  const enter = async () => {
    const instances = await accounts.instances()

    setState({ step: "choose", pending: undefined, instances, selected: instances[0]?.id ?? "" })
  }

  return {
    state,
    selected,
    input(url: string) {
      clearTimeout(timer.current)
      setState({ url, status: url.trim() ? "typing" : "empty", host: "" })

      if (url.trim()) timer.current = setTimeout(() => void settle(), idle)
    },
    settle,
    keep: (keep: boolean) => setState("keep", keep),
    async signInBrowser() {
      if (state.pending) return

      if (state.status !== "valid") return settle()
      setState("pending", "browser")

      if ((await accounts.signInBrowser(state.url)) !== "signed-in") return
      await enter()
    },
    cancel() {
      if (state.pending !== "browser") return
      setState("pending", undefined)
      accounts.cancel()
    },
    token: (token: string) => setState({ token, tokenError: false }),
    async signInToken() {
      if (state.pending || state.status !== "valid") return

      if (!state.token.trim()) return setState("tokenError", true)
      setState("pending", "token")

      if ((await accounts.signInToken(state.url, state.token.trim())) !== "signed-in")
        return setState("pending", undefined)
      await enter()
    },
    select: (id: string) => setState("selected", id),
    back: () => setState({ step: "connect", pending: undefined, token: "", tokenError: false }),
    async finish() {
      const instance = selected()

      if (state.step !== "choose" || !instance) return
      setState({ step: "finalizing", synced: 0 })
      await accounts.finish(instance, (synced) => setState("synced", synced))
      SignInFlag.store({ url: state.url.trim(), instance, keep: state.keep })
      setState("step", "done")
    },
  }
}
