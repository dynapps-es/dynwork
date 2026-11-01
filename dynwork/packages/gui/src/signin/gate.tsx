import { Lockup } from "@dynwork/branding/lockup"
import { Button } from "@opencode/ui/button"
import { Loader } from "@opencode/ui/loader"
import { prefersReducedMotion } from "@opencode/ui/motion"
import { RadioGroup, RadioItem } from "@opencode/ui/radio"
import { createEffect, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { connection } from "../accounts/renderer"
import type { SignInAccounts } from "./accounts"
import { ConnectForm } from "./connect"
import { SignInCopy } from "./copy"
import { SignInFlag } from "./flag"
import { SignInFlow } from "./flow"
import { SignInReal } from "./real"
import { SignInVisibility } from "./visibility"
import "./signin.css"

// Covers the window until this device has an active signed-in instance. It sits under the startup splash, so it shows
// when the splash fades, while the shell keeps loading underneath and is ready the moment the gate fades out. Until
// main's accounts answer for the first time, a plain cover keeps the shell from showing for a moment.
export function SignInGate(props: { version: string; accounts?: SignInAccounts.Interface }) {
  const live = () => connection()
  const client = () => {
    const current = live()

    return current?.status === "active" ? current.value : undefined
  }
  const visibility = SignInVisibility.create(() => client()?.state())

  const [waited, setWaited] = createSignal(false)
  const stall = setTimeout(() => setWaited(true), SignInVisibility.stall)
  const cover = () => SignInVisibility.cover({ known: visibility.known(), link: live()?.status, waited: waited() })

  onCleanup(() => clearTimeout(stall))

  SignInFlag.migrate()

  return (
    <Show
      when={cover() === "ready"}
      fallback={
        <div data-component="dynwork-signin-cover" data-state={cover()}>
          <Show when={cover() === "failed"}>
            <div data-slot="signin-cover-failed" role="alert">
              <p>{SignInCopy.cover.failed}</p>
              <Button type="button" variant="neutral" onClick={() => location.reload()}>
                {SignInCopy.cover.retry}
              </Button>
            </div>
          </Show>
        </div>
      }
    >
      <Show when={visibility.open() ? client() : undefined}>
        {(accounts) => (
          <SignInScreen
            version={props.version}
            accounts={props.accounts ?? SignInReal.create(accounts())}
            onClose={visibility.dismiss}
          />
        )}
      </Show>
    </Show>
  )
}

function SignInScreen(props: { version: string; accounts: SignInAccounts.Interface; onClose: () => void }) {
  const flow = SignInFlow.create(props.accounts)
  const [ui, setUi] = createStore({ leaving: false })
  const last = { current: undefined as HTMLElement | undefined }
  const refs = { root: undefined as HTMLDivElement | undefined }

  // The shell mounts underneath and may focus its own controls or bind keys; both stay with the gate while it shows.
  // The key listener is the window's first capture listener, so stopping it there keeps every app shortcut out while
  // typing, Tab, Enter and Space keep their default actions.
  onMount(() => {
    const focusin = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement && refs.root?.contains(event.target)) {
        last.current = event.target

        return
      }
      const target = last.current?.isConnected ? last.current : refs.root
      target?.focus()
    }
    const keydown = (event: KeyboardEvent) => event.stopImmediatePropagation()

    document.addEventListener("focusin", focusin)
    window.addEventListener("keydown", keydown, true)
    onCleanup(() => {
      document.removeEventListener("focusin", focusin)
      window.removeEventListener("keydown", keydown, true)
    })
  })

  createEffect(() => {
    if (flow.state.step !== "done") return

    if (prefersReducedMotion()) return props.onClose()
    setUi("leaving", true)
  })

  return (
    <div
      ref={(element) => (refs.root = element)}
      data-component="dynwork-signin"
      data-leaving={ui.leaving ? "" : undefined}
      role="dialog"
      aria-modal="true"
      aria-label={SignInCopy.panel.label}
      tabIndex={-1}
      onTransitionEnd={(event) => {
        if (event.target !== event.currentTarget || !ui.leaving) return
        props.onClose()
      }}
    >
      <div data-slot="signin-drag" aria-hidden="true" />
      <aside data-slot="signin-brand">
        <Lockup />
        <div data-slot="signin-pitch">
          <p data-slot="signin-pitch-head">{SignInCopy.brand.head}</p>
          <p data-slot="signin-pitch-body">{SignInCopy.brand.body}</p>
        </div>
        <footer data-slot="signin-footer">
          <span>{SignInCopy.brand.version(props.version)}</span>
          <span aria-hidden="true">·</span>
          <a href={SignInCopy.brand.docsURL} target="_blank" rel="noreferrer">
            {SignInCopy.brand.docs}
          </a>
          <span aria-hidden="true">·</span>
          <a href={SignInCopy.brand.supportURL}>{SignInCopy.brand.support}</a>
        </footer>
      </aside>
      <main data-slot="signin-panel">
        <div data-slot="signin-content">
          <Switch>
            <Match when={flow.state.step === "connect" || flow.state.step === "choose"}>
              <header data-slot="signin-header">
                <p data-slot="signin-eyebrow">
                  {SignInCopy.panel.eyebrow(props.version, flow.state.step === "connect" ? 1 : 2)}
                </p>
                <h1>{SignInCopy.panel.heading}</h1>
                <p data-slot="signin-lede">
                  {flow.state.step === "connect" ? SignInCopy.panel.lede : SignInCopy.choose.lede}
                </p>
              </header>
              <Show when={flow.state.step === "choose"} fallback={<ConnectForm flow={flow} />}>
                <form
                  data-slot="signin-form"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void flow.finish()
                  }}
                >
                  <RadioGroup
                    data-slot="signin-instances"
                    label={SignInCopy.choose.label}
                    hideLabel
                    value={flow.state.selected}
                    onChange={(id: string) => flow.select(id)}
                  >
                    <For each={flow.state.instances}>
                      {(instance) => (
                        <RadioItem
                          value={instance.id}
                          label={instance.name}
                          description={instance.role ? `${instance.host} · ${instance.role}` : instance.host}
                        />
                      )}
                    </For>
                  </RadioGroup>
                  <Show when={flow.selected()}>
                    {(instance) => <p data-slot="signin-hint">{SignInCopy.choose.sync(instance())}</p>}
                  </Show>
                  <div data-slot="signin-actions">
                    <Button
                      ref={(element: HTMLButtonElement) => queueMicrotask(() => element.focus())}
                      type="submit"
                      size="large"
                      variant="contrast"
                    >
                      {SignInCopy.choose.finish}
                    </Button>
                    <Button type="button" size="large" variant="ghost" onClick={() => flow.back()}>
                      {SignInCopy.choose.back}
                    </Button>
                  </div>
                </form>
              </Show>
            </Match>
            <Match when={flow.state.step === "finalizing" || flow.state.step === "done"}>
              <div data-slot="signin-finalizing">
                <Loader width={20} height={20} />
                <p data-slot="signin-finalizing-title" role="status">
                  {SignInCopy.finalizing.title}
                </p>
                <p data-slot="signin-hint">
                  {SignInCopy.finalizing.progress(flow.state.synced, flow.selected()?.skills ?? 0)}
                </p>
              </div>
            </Match>
          </Switch>
        </div>
      </main>
    </div>
  )
}
