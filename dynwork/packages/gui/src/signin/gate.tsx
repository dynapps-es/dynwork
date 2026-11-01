import { Lockup } from "@dynwork/branding/lockup"
import { Button } from "@opencode/ui/button"
import { Checkbox } from "@opencode/ui/checkbox"
import { Collapsible } from "@opencode/ui/collapsible"
import { Icon } from "@opencode/ui/icon"
import { Loader } from "@opencode/ui/loader"
import { prefersReducedMotion } from "@opencode/ui/motion"
import { RadioGroup, RadioItem } from "@opencode/ui/radio"
import { TextInput } from "@opencode/ui/text-input"
import { createEffect, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { connection } from "../accounts/renderer"
import type { SignInAccounts } from "./accounts"
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

  SignInFlag.migrate()

  return (
    <Show when={visibility.known()} fallback={<div data-component="dynwork-signin-cover" />}>
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
  const [ui, setUi] = createStore({ token: false, leaving: false })
  const last = { current: undefined as HTMLElement | undefined }
  const refs = { root: undefined as HTMLDivElement | undefined, browser: undefined as HTMLButtonElement | undefined }

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

  const status = () => {
    if (flow.state.status === "checking") return { tone: "checking", text: SignInCopy.connect.checking }

    if (flow.state.status === "valid") return { tone: "valid", text: SignInCopy.connect.valid(flow.state.host) }

    if (flow.state.status === "invalid")
      return { tone: "invalid", text: SignInCopy.connect.invalid[flow.state.problem] }

    return { tone: "idle", text: SignInCopy.connect.empty }
  }

  const valid = () => flow.state.status === "valid"

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
              <Show
                when={flow.state.step === "choose"}
                fallback={
                  <>
                    <form
                      data-slot="signin-form"
                      onSubmit={(event) => {
                        event.preventDefault()
                        void flow.signInBrowser()
                      }}
                    >
                      <div data-slot="signin-field">
                        <label for="dynwork-signin-url">{SignInCopy.connect.label}</label>
                        <TextInput
                          ref={(element: HTMLInputElement) => queueMicrotask(() => element.focus())}
                          id="dynwork-signin-url"
                          name="url"
                          dir="ltr"
                          type="text"
                          inputMode="url"
                          autocomplete="url"
                          autocapitalize="off"
                          spellcheck={false}
                          appearance="large"
                          placeholder={SignInCopy.connect.placeholder}
                          value={flow.state.url}
                          invalid={flow.state.status === "invalid"}
                          disabled={!!flow.state.pending}
                          aria-describedby="dynwork-signin-url-status"
                          onInput={(event) => flow.input(event.currentTarget.value)}
                          onBlur={() => void flow.settle()}
                        />
                        <p
                          id="dynwork-signin-url-status"
                          data-slot="signin-status"
                          data-tone={status().tone}
                          role="status"
                          aria-live="polite"
                        >
                          <span data-slot="signin-dot" aria-hidden="true" />
                          <span>{status().text}</span>
                        </p>
                      </div>
                      <div data-slot="signin-actions">
                        <Button
                          ref={(element: HTMLButtonElement) => (refs.browser = element)}
                          type="submit"
                          size="large"
                          variant={flow.state.pending === "browser" ? "loading" : "contrast"}
                          disabled={!valid() || !!flow.state.pending}
                          aria-describedby={valid() ? undefined : "dynwork-signin-browser-hint"}
                        >
                          <Show when={flow.state.pending === "browser"} fallback={SignInCopy.connect.browser}>
                            <Loader />
                            {SignInCopy.connect.waiting}
                          </Show>
                        </Button>
                        <Show when={flow.state.pending === "browser"}>
                          <Button
                            ref={(element: HTMLButtonElement) => queueMicrotask(() => element.focus())}
                            type="button"
                            size="large"
                            variant="ghost"
                            onClick={() => {
                              flow.cancel()
                              queueMicrotask(() => refs.browser?.focus())
                            }}
                          >
                            {SignInCopy.connect.cancel}
                          </Button>
                        </Show>
                      </div>
                      <Show when={flow.state.error?.from === "browser" ? flow.state.error : undefined}>
                        {(error) => (
                          <p id="dynwork-signin-browser-error" data-slot="signin-error" role="alert">
                            {SignInCopy.failure[error().kind]}
                          </p>
                        )}
                      </Show>
                      <Show when={!valid() && !flow.state.pending}>
                        <p id="dynwork-signin-browser-hint" data-slot="signin-hint">
                          {SignInCopy.connect.disabled}
                        </p>
                      </Show>
                      <Checkbox
                        checked={flow.state.keep}
                        disabled={!!flow.state.pending}
                        onChange={(keep: boolean) => flow.keep(keep)}
                      >
                        {SignInCopy.connect.keep}
                      </Checkbox>
                      <p data-slot="signin-hint">{SignInCopy.connect.hint}</p>
                    </form>
                    <Collapsible
                      data-slot="signin-token"
                      variant="ghost"
                      open={ui.token}
                      onOpenChange={(open) => setUi("token", open)}
                    >
                      <Collapsible.Trigger data-slot="signin-token-toggle">
                        <span>{SignInCopy.token.toggle}</span>
                        <Icon name="chevron-down" size="small" />
                      </Collapsible.Trigger>
                      <Collapsible.Content>
                        <form
                          data-slot="signin-form"
                          onSubmit={(event) => {
                            event.preventDefault()
                            void flow.signInToken()
                          }}
                        >
                          <div data-slot="signin-field">
                            <label for="dynwork-signin-token">{SignInCopy.token.label}</label>
                            <TextInput
                              id="dynwork-signin-token"
                              name="token"
                              dir="ltr"
                              type="password"
                              autocomplete="off"
                              appearance="large"
                              placeholder={SignInCopy.token.placeholder}
                              value={flow.state.token}
                              invalid={flow.state.tokenError}
                              disabled={!!flow.state.pending}
                              aria-describedby={
                                flow.state.tokenError || flow.state.error?.from === "token"
                                  ? "dynwork-signin-token-error"
                                  : undefined
                              }
                              onInput={(event) => flow.token(event.currentTarget.value)}
                            />
                            <Show when={flow.state.tokenError}>
                              <p id="dynwork-signin-token-error" data-slot="signin-error" role="alert">
                                {SignInCopy.token.empty}
                              </p>
                            </Show>
                            <Show when={flow.state.error?.from === "token" ? flow.state.error : undefined}>
                              {(error) => (
                                <p id="dynwork-signin-token-error" data-slot="signin-error" role="alert">
                                  {SignInCopy.failure[error().kind]}
                                </p>
                              )}
                            </Show>
                          </div>
                          <div data-slot="signin-token-row">
                            <p data-slot="signin-hint">
                              {SignInCopy.token.missing}{" "}
                              <a
                                href={valid() ? flow.state.login : undefined}
                                target="_blank"
                                rel="noreferrer"
                                aria-disabled={valid() ? undefined : "true"}
                              >
                                {SignInCopy.token.login}
                              </a>
                            </p>
                            <Button
                              type="submit"
                              size="large"
                              variant={flow.state.pending === "token" ? "loading" : "ghost"}
                              disabled={!valid() || !!flow.state.pending}
                            >
                              <Show when={flow.state.pending === "token"} fallback={SignInCopy.token.connect}>
                                <Loader />
                                {SignInCopy.token.connecting}
                              </Show>
                            </Button>
                          </div>
                        </form>
                      </Collapsible.Content>
                    </Collapsible>
                  </>
                }
              >
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
