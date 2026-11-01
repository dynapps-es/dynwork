import { Button } from "@opencode/ui/button"
import { Checkbox } from "@opencode/ui/checkbox"
import { Collapsible } from "@opencode/ui/collapsible"
import { Icon } from "@opencode/ui/icon"
import { Loader } from "@opencode/ui/loader"
import { TextInput } from "@opencode/ui/text-input"
import { Show } from "solid-js"
import { createStore } from "solid-js/store"
import { SignInCopy } from "./copy"
import type { SignInFlow } from "./flow"
import "./connect.css"

// The first step of signing in: the instance URL, the browser button and the token field. The sign-in screen and the
// Accounts page's Add instance dialog both show it over their own `SignInFlow`.
export function ConnectForm(props: { flow: ReturnType<typeof SignInFlow.create> }) {
  const flow = props.flow
  const [ui, setUi] = createStore({ token: false })
  const refs = { browser: undefined as HTMLButtonElement | undefined }

  const status = () => {
    if (flow.state.status === "checking") return { tone: "checking", text: SignInCopy.connect.checking }

    if (flow.state.status === "valid") return { tone: "valid", text: SignInCopy.connect.valid(flow.state.host) }

    if (flow.state.status === "invalid")
      return { tone: "invalid", text: SignInCopy.connect.invalid[flow.state.problem] }

    return { tone: "idle", text: SignInCopy.connect.empty }
  }

  const valid = () => flow.state.status === "valid"

  return (
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
                  flow.state.tokenError || flow.state.error?.from === "token" ? "dynwork-signin-token-error" : undefined
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
  )
}
