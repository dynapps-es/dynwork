import { usePlugin } from "@opencode/plugin/gui"
import { Button } from "@opencode/ui/button"
import { Dialog, DialogBody, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { TextInput } from "@opencode/ui/text-input"
import { Textarea } from "@opencode/ui/textarea"
import { createSignal, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { catalog, instance, savedAccess, schedules } from "./demo"
import { emptyNewAgent, type AgentsModel, type NewAgentError } from "./model"
import "./agents.css"

/** The New agent form (mockup). Starting adds the agent to the view's in-memory list and closes the dialog. */
export function NewAgentDialog(props: { model: AgentsModel; close: () => void }) {
  const ctx = usePlugin()
  const [form, setForm] = createStore(emptyNewAgent())
  const [error, setError] = createSignal<NewAgentError>()

  return (
    <Dialog size="large">
      <DialogHeader>
        <DialogTitleGroup title={ctx.t("agents.new.title")} description={ctx.t("agents.new.description")} />
      </DialogHeader>
      <DialogBody>
        <form
          data-component="dynwork-agents-form"
          onSubmit={(event) => {
            event.preventDefault()
            const result = props.model.add(form)
            if ("error" in result) return setError(result.error)
            props.close()
          }}
        >
          <div data-slot="agents-segments" role="radiogroup">
            <For each={["agent", "prompt"] as const}>
              {(mode) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={form.mode === mode}
                  data-state={form.mode === mode ? "pressed" : undefined}
                  onClick={() => setForm("mode", mode)}
                >
                  {ctx.t(`agents.new.mode.${mode}`)}
                </button>
              )}
            </For>
          </div>
          <label data-slot="agents-field">
            <span>{ctx.t("agents.new.name")}</span>
            <TextInput
              value={form.name}
              placeholder={ctx.t("agents.new.name.placeholder")}
              invalid={error() === "name"}
              onInput={(event) => setForm("name", event.currentTarget.value)}
            />
          </label>
          <label data-slot="agents-field">
            <span>{ctx.t("agents.new.instance")}</span>
            <select disabled>
              <option>{instance}</option>
            </select>
          </label>
          <Show when={form.mode === "agent"}>
            <label data-slot="agents-field">
              <span>{ctx.t("agents.new.agent")}</span>
              <select value={form.agent} onChange={(event) => setForm("agent", event.currentTarget.value)}>
                <For each={catalog}>
                  {(item) => (
                    <option value={item.id} selected={form.agent === item.id}>
                      {item.id} - {item.description}
                    </option>
                  )}
                </For>
              </select>
            </label>
          </Show>
          <div data-slot="agents-pair">
            <label data-slot="agents-field">
              <span>{ctx.t("agents.new.repo")}</span>
              <TextInput
                value={form.repo}
                placeholder={ctx.t("agents.new.repo.placeholder")}
                invalid={error() === "repo"}
                onInput={(event) => setForm("repo", event.currentTarget.value)}
              />
              <small>{ctx.t("agents.new.repo.hint")}</small>
            </label>
            <label data-slot="agents-field">
              <span>{ctx.t("agents.new.branch")}</span>
              <TextInput value={form.branch} onInput={(event) => setForm("branch", event.currentTarget.value)} />
            </label>
          </div>
          <label data-slot="agents-field">
            <span>{ctx.t("agents.new.access")}</span>
            <select value={form.access} onChange={(event) => setForm("access", event.currentTarget.value)}>
              <For each={savedAccess}>
                {(item) => (
                  <option value={item} selected={form.access === item}>
                    {item}
                  </option>
                )}
              </For>
            </select>
            <small>{ctx.t("agents.new.access.hint")}</small>
          </label>
          <label data-slot="agents-field">
            <span>{form.mode === "agent" ? ctx.t("agents.new.input") : ctx.t("agents.new.prompt")}</span>
            <Textarea
              rows={3}
              value={form.input}
              invalid={error() === "input"}
              onInput={(event) => setForm("input", event.currentTarget.value)}
            />
          </label>
          <div data-slot="agents-field">
            <span>{ctx.t("agents.new.when")}</span>
            <div data-slot="agents-segments" role="radiogroup">
              <For each={[false, true]}>
                {(repeat) => (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={form.repeat === repeat}
                    data-state={form.repeat === repeat ? "pressed" : undefined}
                    onClick={() => setForm("repeat", repeat)}
                  >
                    {repeat ? ctx.t("agents.new.when.repeat") : ctx.t("agents.new.when.now")}
                  </button>
                )}
              </For>
            </div>
            <Show when={form.repeat}>
              <select
                aria-label={ctx.t("agents.new.when.repeat")}
                value={form.schedule}
                onChange={(event) => setForm("schedule", event.currentTarget.selectedIndex)}
              >
                <For each={schedules}>
                  {(item, index) => (
                    <option value={index()} selected={form.schedule === index()}>
                      {ctx.t("agents.new.timezone", { words: item.words })} ({item.cron})
                    </option>
                  )}
                </For>
              </select>
            </Show>
          </div>
          <div data-slot="agents-notice">
            <Icon name="info" />
            <span>{ctx.t("agents.new.notice")}</span>
          </div>
          <Show when={error()}>
            {(key) => (
              <p data-slot="agents-error" role="alert">
                {ctx.t(`agents.new.error.${key()}`)}
              </p>
            )}
          </Show>
          <div data-slot="agents-form-actions">
            <Button type="button" variant="ghost" onClick={props.close}>
              {ctx.t("agents.new.cancel")}
            </Button>
            <Button type="submit" variant="contrast">
              {ctx.t("agents.new.submit")}
            </Button>
          </div>
        </form>
      </DialogBody>
    </Dialog>
  )
}
