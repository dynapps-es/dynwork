export * as SignInFlow from "./flow"

import { createStore } from "solid-js/store"
import { SignInAccounts } from "./accounts"

// "typing" waits for the field to settle; the other statuses are the colored dot under the instance URL.
export type Status = "empty" | "typing" | "checking" | "valid" | "invalid"

export type Step = "connect" | "choose" | "finalizing" | "done"

// The field settles after this much idle typing, or at once on blur.
const idle = 500

export function create(accounts: SignInAccounts.Interface) {
  const [state, setState] = createStore({
    step: "connect" as Step,
    url: "",
    // The typed URL once checked, normalized: the sign-ins and the stored account use it, not what was typed.
    target: "",
    status: "empty" as Status,
    host: "",
    // Why the URL is invalid, and the instance's page that shows a one-time code
    problem: "format" as SignInAccounts.Problem,
    login: undefined as string | undefined,
    // The sign-in that failed: it shows under the browser button or under the token field
    error: undefined as { from: "browser" | "token"; kind: SignInAccounts.Failure } | undefined,
    pending: undefined as "browser" | "token" | undefined,
    keep: true,
    token: "",
    tokenError: false,
    instances: [] as SignInAccounts.Instance[],
    selected: "",
    synced: 0,
  })
  // Each sign-in attempt takes a number; an answer for an attempt that was cancelled or replaced is dropped.
  const attempts = { current: 0 }
  const timer = { current: undefined as ReturnType<typeof setTimeout> | undefined }

  const selected = () => state.instances.find((instance) => instance.id === state.selected)

  // A check answers for the value it started from; an edit while it runs makes the answer stale.
  const settle = async () => {
    clearTimeout(timer.current)
    const url = state.url

    if (!url.trim()) return setState({ status: "empty", host: "", login: undefined })

    if (state.status !== "typing") return
    setState("status", "checking")
    const target = SignInAccounts.normalizeURL(url) ?? url.trim()
    const probe = await accounts.probe(target)

    if (state.url !== url) return

    if (!probe.reachable) return setState({ status: "invalid", host: "", login: undefined, problem: probe.reason })
    setState({ status: "valid", target, host: probe.host, login: probe.login })
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
      setState({
        url,
        target: "",
        status: url.trim() ? "typing" : "empty",
        host: "",
        login: undefined,
        error: undefined,
      })

      if (url.trim()) timer.current = setTimeout(() => void settle(), idle)
    },
    settle,
    keep: (keep: boolean) => setState("keep", keep),
    async signInBrowser() {
      if (state.pending) return

      if (state.status !== "valid") return settle()
      setState({ pending: "browser", error: undefined })
      const attempt = ++attempts.current
      const answer = await accounts.signInBrowser(state.target, state.keep)

      if (attempt !== attempts.current) return

      if (answer === "cancelled") return setState("pending", undefined)
      if (answer !== "signed-in") return setState({ pending: undefined, error: { from: "browser", kind: answer } })
      await enter()
    },
    cancel() {
      if (state.pending !== "browser") return
      attempts.current++
      setState("pending", undefined)
      accounts.cancel()
    },
    token: (token: string) => setState({ token, tokenError: false, error: undefined }),
    async signInToken() {
      if (state.pending || state.status !== "valid") return

      if (!state.token.trim()) return setState("tokenError", true)
      setState({ pending: "token", error: undefined })
      const attempt = ++attempts.current
      const answer = await accounts.signInToken(state.target, state.token.trim(), state.keep)

      if (attempt !== attempts.current) return

      if (answer === "cancelled") return setState("pending", undefined)
      if (answer !== "signed-in") return setState({ pending: undefined, error: { from: "token", kind: answer } })
      await enter()
    },
    select: (id: string) => setState("selected", id),
    back() {
      attempts.current++
      setState({ step: "connect", pending: undefined, token: "", tokenError: false, error: undefined })
    },
    async finish() {
      const instance = selected()

      if (state.step !== "choose" || !instance) return
      setState({ step: "finalizing", synced: 0 })
      await accounts.finish(instance, (synced) => setState("synced", synced))
      setState("step", "done")
    },
  }
}
