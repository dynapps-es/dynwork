import { usePlugin } from "@opencode/plugin/gui"
import { Button } from "@opencode/ui/button"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { Textarea } from "@opencode/ui/textarea"
import { TextInput } from "@opencode/ui/text-input"
import { createEffect, createSignal, For, Match, on, Show, Switch, type JSX } from "solid-js"
import type { Choice, Field, Ref } from "../../routines/contract"
import { choicesOf, control, picked as pickedOf, toggled, valueOf, wide } from "./fields"
import { zones } from "./schedule"
import { backendLine, when, type Translate } from "./format"
import { draftSchedule, problemText, triggers, type FormModel } from "./form"
import type { AgentsModel } from "./model"
import { FormToggle } from "./toggle"
import "./editor.css"

/**
 * The routine form, in the app's dialog: a dialog on a wide window and a full-screen sheet on a narrow one (`editor.css`).
 * The common fields are written here; what belongs to a backend is drawn from its `capabilities().fields`, so the farm
 * adds options without this file changing. It reads and writes `form` and nothing else; `agents` only supplies the
 * labels of the lookups.
 */
export function RoutineForm(props: {
  form: FormModel
  agents: AgentsModel
  close: () => void
  onSaved: (ref: Ref) => void
}) {
  const ctx = usePlugin()
  const form = props.form
  const refs = { scroll: undefined as HTMLDivElement | undefined }
  const [advanced, setAdvanced] = createSignal(false)
  const [tab, setTab] = createSignal("general")
  const capabilities = () => form.capabilities()
  const draft = () => form.state.draft
  const choices = (lookup: string) => props.agents.choices(form.state.backend, lookup)

  // The labels of every lookup the backend's fields use, read once per backend.
  createEffect(
    on(
      () => form.state.backend,
      (backend) => {
        const current = capabilities()
        if (!current) return
        const lookups = new Set([
          ...current.fields.flatMap((field) => (field.lookup ? [field.lookup] : [])),
          ...(current.agent !== "none" || current.instructions.includes("agent") ? ["agents"] : []),
          ...(current.model === "choose" ? ["models"] : []),
          ...(current.instructions.includes("skill") ? ["skills"] : []),
        ])
        lookups.forEach((lookup) => void props.agents.loadChoices(backend, lookup))
      },
    ),
  )

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    const ref = await form.save()
    if (ref) {
      props.onSaved(ref)
      props.close()
      return
    }
    reveal(form.firstError())
  }

  // Takes the user to the first field with a problem, opening the advanced settings when it is in them.
  const reveal = (key?: string) => {
    if (!key) return
    const tabs = advancedTabs()
    const holder = tabs.find((candidate) => candidate.fields.some((field) => field.key === key))
    if (holder) {
      setAdvanced(true)
      setTab(holder.id)
    }
    queueMicrotask(() => {
      const target = refs.scroll?.querySelector<HTMLElement>(`[data-key="${key}"]`)
      target?.scrollIntoView?.({ block: "center" })
      target?.querySelector<HTMLElement>("input, textarea, select, button")?.focus({ preventScroll: true })
    })
  }

  const advancedTabs = () => {
    const fields = form.fields()
    return [
      { id: "general", fields: fields.advanced },
      { id: "connectors", fields: fields.connectors },
      { id: "notifications", fields: fields.notifications },
    ].filter((candidate) => candidate.fields.length > 0 || candidate.id === "connectors")
  }

  return (
    <Dialog size="x-large" containerClass="agents-form-dialog">
      <DialogHeader>
        <DialogTitleGroup
          title={ctx.t(form.mode === "edit" ? "agents.form.title.edit" : "agents.form.title.create")}
          description={ctx.t("agents.form.description")}
        />
      </DialogHeader>
      <DialogBody>
        <form data-component="agents-form" onSubmit={(event) => void submit(event)} noValidate>
          <div data-slot="form-scroll" ref={(element) => (refs.scroll = element)}>
            <Where form={form} agents={props.agents} />
            <Row id="name" label={ctx.t("agents.form.name")} error={said(ctx.t, form, "name")}>
              <TextInput
                id="agents-form-name"
                autofocus={form.mode === "create"}
                value={draft().name}
                placeholder={ctx.t("agents.form.name.placeholder")}
                invalid={form.error("name") !== undefined}
                onInput={(event) => form.set({ name: event.currentTarget.value })}
              />
            </Row>
            <What form={form} choices={choices} />
            <Notice form={form} />
            <Trigger form={form} />
            <div data-slot="form-field" data-key="enabled" data-wide="">
              <FormToggle
                checked={draft().enabled}
                label={ctx.t("agents.form.active")}
                description={ctx.t("agents.form.active.hint")}
                onChange={(enabled) => form.set({ enabled })}
              />
            </div>
            <Block form={form} choices={choices} />
            <Show when={form.fields().extra.length > 0}>
              <Extra form={form} choices={choices} />
            </Show>
            <section data-slot="form-advanced">
              <button
                type="button"
                data-slot="form-advanced-head"
                aria-expanded={advanced()}
                onClick={() => setAdvanced(!advanced())}
              >
                <Icon name={advanced() ? "chevron-down" : "chevron-right"} size="small" />
                {ctx.t("agents.form.advanced")}
              </button>
              <Show when={advanced()}>
                <div data-slot="form-tabs" role="tablist">
                  <For each={advancedTabs()}>
                    {(item) => (
                      <button
                        type="button"
                        role="tab"
                        aria-selected={tab() === item.id}
                        data-state={tab() === item.id ? "pressed" : undefined}
                        onClick={() => setTab(item.id)}
                      >
                        {ctx.t(`agents.form.advanced.${item.id}`)}
                      </button>
                    )}
                  </For>
                </div>
                <Show
                  when={
                    // A connectors tab with nothing to choose from (no servers, or the service unreachable) is empty.
                    advancedTabs()
                      .find((item) => item.id === tab())
                      ?.fields.some((field) => tab() !== "connectors" || choicesOf(field, choices).length > 0)
                  }
                  fallback={<p data-slot="form-hint">{ctx.t("agents.form.connectors.empty")}</p>}
                >
                  <FieldGrid
                    form={form}
                    fields={advancedTabs().find((item) => item.id === tab())?.fields ?? []}
                    choices={choices}
                  />
                </Show>
              </Show>
            </section>
          </div>
          <Show
            when={
              form.state.failure ??
              (form.orphans().length > 0 ? { message: ctx.t("agents.form.attention") } : undefined)
            }
          >
            {(failure) => (
              <div data-slot="form-notice" data-tone="danger" role="alert">
                <Icon name="warning" size="small" />
                <span>
                  {failure().message}
                  <For each={form.orphans()}>
                    {(key) => <span data-slot="form-orphan">{said(ctx.t, form, key)}</span>}
                  </For>
                </span>
              </div>
            )}
          </Show>
          <DialogFooter>
            <Show when={form.replaces()}>
              <span data-slot="form-footnote">{ctx.t("agents.reason.replace")}</span>
            </Show>
            <Button variant="ghost" onClick={props.close}>
              {ctx.t("agents.form.cancel")}
            </Button>
            <Button type="submit" variant="contrast" disabled={form.state.saving}>
              {ctx.t(form.state.saving ? "agents.form.saving" : "agents.form.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogBody>
    </Dialog>
  )
}

// The message of the problem in a field, in the window's language, or undefined.
function said(t: Translate, form: FormModel, key: string) {
  const found = form.error(key)
  return found === undefined ? undefined : problemText(t, found)
}

// One labelled field: its label, the control, a hint and the problem found in it. `group` is for controls made of
// several buttons, which have no single input for the label to point at.
function Row(props: {
  id: string
  label: string
  hint?: string
  /** A warning under the control, as the chosen option says. */
  warning?: string
  error?: string
  wide?: boolean
  group?: boolean
  children: JSX.Element
}) {
  return (
    <div data-slot="form-field" data-key={props.id} data-wide={props.wide ? "" : undefined}>
      <Show
        when={props.group}
        fallback={
          <label data-slot="form-label" for={`agents-form-${props.id}`}>
            {props.label}
          </label>
        }
      >
        <span data-slot="form-label" id={`agents-form-${props.id}-label`}>
          {props.label}
        </span>
      </Show>
      {props.children}
      <Show when={props.hint}>
        <span data-slot="form-hint">{props.hint}</span>
      </Show>
      <Show when={props.warning}>
        <span data-slot="form-hint" data-tone="warning">
          {props.warning}
        </span>
      </Show>
      <Show when={props.error}>
        <span data-slot="form-error" role="alert">
          {props.error}
        </span>
      </Show>
    </div>
  )
}

function Select(props: {
  id: string
  label: string
  value: string
  options: readonly Choice[]
  blank?: string
  invalid?: boolean
  onChange: (value: string) => void
}) {
  return (
    <select
      id={props.id}
      data-slot="form-select"
      aria-label={props.label}
      aria-invalid={props.invalid ? true : undefined}
      value={props.value}
      onChange={(event) => props.onChange(event.currentTarget.value)}
    >
      <Show when={props.blank !== undefined}>
        <option value="" selected={props.value === ""}>
          {props.blank}
        </option>
      </Show>
      <For each={props.options}>
        {(option) => (
          <option value={option.value} selected={props.value === option.value}>
            {option.label}
          </option>
        )}
      </For>
      {/* A stored value the lookup does not list, or has not loaded yet, stays selectable instead of vanishing. */}
      <Show when={props.value !== "" && !props.options.some((option) => option.value === props.value)}>
        <option value={props.value} selected>
          {props.value}
        </option>
      </Show>
    </select>
  )
}

// Where the routine runs: a choice between the backends for a new routine, a fixed line for an edit.
function Where(props: { form: FormModel; agents: AgentsModel }) {
  const ctx = usePlugin()
  const form = props.form

  return (
    <Show
      when={form.mode === "create" && props.agents.backends().length > 1}
      fallback={
        <Show when={form.capabilities()}>
          {(current) => (
            <p data-slot="form-where-fixed">
              <Icon name={current().kind === "remote" ? "cloud-upload" : "monitor"} size="small" />
              {ctx.t(current().kind === "remote" ? "agents.detail.remote" : "agents.detail.local", {
                device: current().label,
                label: current().label,
              })}
            </p>
          )}
        </Show>
      }
    >
      <Row id="backend" label={ctx.t("agents.form.where")} group wide>
        <div data-slot="form-where" role="radiogroup" aria-labelledby="agents-form-backend-label">
          <For each={props.agents.backends()}>
            {(backend) => (
              <button
                type="button"
                role="radio"
                aria-checked={form.state.backend === backend.backend}
                data-state={form.state.backend === backend.backend ? "pressed" : undefined}
                onClick={() => form.choose(backend.backend)}
              >
                <Icon name={backend.kind === "remote" ? "cloud-upload" : "monitor"} />
                <span>
                  <b>{ctx.t(`agents.form.where.${backend.kind}.title`, { label: backend.label })}</b>
                  {ctx.t(`agents.form.where.${backend.kind}.text`)}
                  <small>{backendLine(ctx.t, backend)}</small>
                </span>
              </button>
            )}
          </For>
        </div>
      </Row>
    </Show>
  )
}

const textLabel = {
  prompt: "agents.form.prompt",
  skill: "agents.form.skill.text",
  agent: "agents.form.agentRef.input",
} as const

// What it does: the kind of instructions, the text, and the agent and model where the backend takes them.
function What(props: { form: FormModel; choices: (lookup: string) => readonly Choice[] }) {
  const ctx = usePlugin()
  const form = props.form
  const draft = () => form.state.draft
  const kinds = () => form.capabilities()?.instructions ?? []

  return (
    <>
      <Row id="instructions" label={ctx.t("agents.form.what")} group wide error={said(ctx.t, form, "instructions")}>
        <Show when={kinds().length > 1}>
          <div data-slot="form-segments" role="radiogroup" aria-labelledby="agents-form-instructions-label">
            <For each={kinds()}>
              {(kind) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={draft().what === kind}
                  data-state={draft().what === kind ? "pressed" : undefined}
                  onClick={() => form.set({ what: kind })}
                >
                  {ctx.t(`agents.form.what.${kind}`)}
                </button>
              )}
            </For>
          </div>
        </Show>
        <Show when={draft().what === "skill"}>
          <Select
            id="agents-form-skill"
            label={ctx.t("agents.form.skill")}
            value={draft().skill}
            options={props.choices("skills")}
            blank={ctx.t("agents.form.choose")}
            invalid={form.error("instructions") !== undefined}
            onChange={(skill) => form.set({ skill })}
          />
        </Show>
        <Show when={draft().what === "agent"}>
          <Select
            id="agents-form-agentRef"
            label={ctx.t("agents.form.agentRef")}
            value={draft().agentRef}
            options={props.choices("agents")}
            blank={ctx.t("agents.form.choose")}
            invalid={form.error("instructions") !== undefined}
            onChange={(agentRef) => form.set({ agentRef })}
          />
        </Show>
        <Textarea
          id="agents-form-text"
          rows={6}
          value={draft().text}
          aria-label={ctx.t(textLabel[draft().what])}
          placeholder={draft().what === "prompt" ? ctx.t("agents.form.prompt.placeholder") : undefined}
          invalid={form.error("instructions") !== undefined}
          onInput={(event) => form.set({ text: event.currentTarget.value })}
        />
      </Row>
      <div data-slot="form-grid">
        <Show when={form.capabilities()?.agent !== "none" && form.capabilities()}>
          {(current) => (
            <Row id="agent" label={ctx.t("agents.form.agent")} error={said(ctx.t, form, "agent")}>
              <Select
                id="agents-form-agent"
                label={ctx.t("agents.form.agent")}
                value={draft().agent}
                options={props.choices("agents")}
                blank={current().agent === "optional" ? ctx.t("agents.form.default") : ctx.t("agents.form.choose")}
                invalid={form.error("agent") !== undefined}
                onChange={(agent) => form.set({ agent })}
              />
            </Row>
          )}
        </Show>
        <Switch>
          <Match when={form.capabilities()?.model === "choose"}>
            <Row id="model" label={ctx.t("agents.form.model")} error={said(ctx.t, form, "model")}>
              <Select
                id="agents-form-model"
                label={ctx.t("agents.form.model")}
                value={draft().model}
                options={props.choices("models")}
                blank={ctx.t("agents.form.default")}
                invalid={form.error("model") !== undefined}
                onChange={(model) => form.set({ model })}
              />
            </Row>
          </Match>
          <Match when={form.capabilities()?.model === "agent"}>
            <Row id="model" label={ctx.t("agents.form.model")} group>
              <span data-slot="form-static">{ctx.t("agents.form.model.byAgent")}</span>
            </Row>
          </Match>
        </Switch>
      </div>
    </>
  )
}

function Notice(props: { form: FormModel }) {
  const ctx = usePlugin()

  return (
    <Show when={props.form.capabilities()}>
      {(current) => (
        <div data-slot="form-notice" data-tone={current().kind === "remote" ? "warning" : "info"}>
          <Icon name={current().kind === "remote" ? "warning" : "shield"} size="small" />
          <span>{ctx.t(`agents.form.notice.${current().kind}`)}</span>
        </div>
      )}
    </Show>
  )
}

// The trigger: nothing, or a preset or a cron, in a zone, with the next three runs as a preview.
function Trigger(props: { form: FormModel }) {
  const ctx = usePlugin()
  const form = props.form
  const draft = () => form.state.draft
  const order = [1, 2, 3, 4, 5, 6, 0]
  // The cron a preset writes, shown beside it; a custom cron is its own.
  const equivalent = () =>
    draft().trigger === "none" || draft().trigger === "cron" ? undefined : draftSchedule(draft())?.cron
  const window = () => form.capabilities()?.schedule.window === true

  return (
    <div data-slot="form-field" data-key="schedule" data-wide="">
      <label data-slot="form-label" for="agents-form-trigger">
        {ctx.t("agents.form.trigger")}
      </label>
      <div data-slot="form-trigger">
        <Select
          id="agents-form-trigger"
          label={ctx.t("agents.form.trigger")}
          value={draft().trigger}
          options={triggers.map((value) => ({ value, label: ctx.t(`agents.form.trigger.${value}`) }))}
          onChange={(value) => form.setTrigger(triggers.find((trigger) => trigger === value) ?? "none")}
        />
        <Show when={draft().trigger !== "none" && draft().trigger !== "cron"}>
          <TextInput
            type="time"
            aria-label={ctx.t("agents.form.time")}
            value={draft().time}
            invalid={form.error("schedule") !== undefined}
            onInput={(event) => form.set({ time: event.currentTarget.value })}
          />
        </Show>
        <Show when={draft().trigger === "monthly"}>
          <TextInput
            type="number"
            min="1"
            max="31"
            numeric
            aria-label={ctx.t("agents.form.day")}
            value={String(draft().day)}
            onInput={(event) => form.set({ day: Number(event.currentTarget.value) })}
          />
        </Show>
        <Show when={draft().trigger === "cron"}>
          <TextInput
            aria-label={ctx.t("agents.form.cron")}
            value={draft().cron}
            placeholder="45 8 * * 1"
            spellcheck={false}
            invalid={form.error("schedule") !== undefined}
            onInput={(event) => form.set({ cron: event.currentTarget.value })}
          />
        </Show>
        <Show when={draft().trigger !== "none"}>
          <Select
            id="agents-form-zone"
            label={ctx.t("agents.form.zone")}
            value={draft().timezone}
            options={zones(draft().timezone).map((value) => ({ value, label: value }))}
            onChange={(timezone) => form.set({ timezone })}
          />
        </Show>
      </div>
      <Show when={draft().trigger === "weekly"}>
        <div data-slot="form-pills" role="group" aria-label={ctx.t("agents.form.days")}>
          <For each={order}>
            {(day) => (
              <button
                type="button"
                aria-pressed={draft().days.includes(day)}
                onClick={() =>
                  form.set({
                    days: draft().days.includes(day)
                      ? draft().days.filter((other) => other !== day)
                      : [...draft().days, day],
                  })
                }
              >
                {ctx.t(`agents.day.short.${day}`)}
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={draft().trigger === "cron"}>
        <span data-slot="form-hint">{ctx.t("agents.form.cron.hint")}</span>
      </Show>
      <Show when={draft().trigger !== "none"}>
        <Show when={equivalent()}>
          {(text) => <span data-slot="form-hint">{ctx.t("agents.form.cron.equivalent", { cron: text() })}</span>}
        </Show>
        <p data-slot="form-preview">
          <span data-slot="form-hint">{ctx.t("agents.form.next")}</span>
          <Show
            when={form.preview().length > 0}
            fallback={<span data-slot="form-hint">{ctx.t("agents.form.next.none")}</span>}
          >
            <For each={form.preview()}>
              {(at) => <span data-slot="form-chip">{when(ctx.locale.locale(), at, draft().timezone)}</span>}
            </For>
          </Show>
        </p>
        <Show when={form.late()}>
          <span data-slot="form-hint" data-tone="warning">
            {ctx.t("agents.form.late")}
          </span>
        </Show>
        <Show when={window()}>
          {/* JESÚS: `starts`, `ends` and `max` are the farm's `schedule.window`; the form shows them only where
              `capabilities().schedule.window` is true, so a backend without a window never sees them. */}
          <div data-slot="form-grid" data-compact="">
            <Row id="starts" label={ctx.t("agents.form.starts")}>
              <TextInput
                id="agents-form-starts"
                type="date"
                value={draft().starts}
                onInput={(event) => form.set({ starts: event.currentTarget.value })}
              />
            </Row>
            <Row id="ends" label={ctx.t("agents.form.ends")}>
              <TextInput
                id="agents-form-ends"
                type="date"
                value={draft().ends}
                onInput={(event) => form.set({ ends: event.currentTarget.value })}
              />
            </Row>
            <Row id="max" label={ctx.t("agents.form.max")}>
              <TextInput
                id="agents-form-max"
                type="number"
                min="1"
                numeric
                value={draft().max}
                placeholder={ctx.t("agents.form.max.placeholder")}
                onInput={(event) => form.set({ max: event.currentTarget.value })}
              />
            </Row>
          </div>
        </Show>
      </Show>
      <Show when={said(ctx.t, form, "schedule")}>
        {(text) => (
          <span data-slot="form-error" role="alert">
            {text()}
          </span>
        )}
      </Show>
    </div>
  )
}

// The backend's own block: workspace, permissions, plugins and limits, from its fields.
function Block(props: { form: FormModel; choices: (lookup: string) => readonly Choice[] }) {
  const ctx = usePlugin()
  const form = props.form

  return (
    <Show when={form.capabilities()}>
      {(current) => (
        <section data-slot="form-block" data-kind={current().kind}>
          <h3 data-slot="form-block-head">
            <Icon name={current().kind === "remote" ? "cloud-upload" : "monitor"} size="small" />
            {ctx.t(`agents.form.block.${current().kind}`, { label: current().label })}
          </h3>
          <Show when={current().kind === "local"}>
            <Row id="device" label={ctx.t("agents.form.device")} group hint={ctx.t("agents.form.device.hint")}>
              <span data-slot="form-static">{current().label}</span>
            </Row>
          </Show>
          <FieldGrid form={form} fields={form.fields().where} choices={props.choices} />
        </section>
      )}
    </Show>
  )
}

// Everything else the backend declares, drawn as it declares it. The farm's own options end up here.
function Extra(props: { form: FormModel; choices: (lookup: string) => readonly Choice[] }) {
  const ctx = usePlugin()

  return (
    <Show when={props.form.capabilities()}>
      {(current) => (
        // JESÚS: nothing to write here. Every field you declare in `capabilities().fields` whose section is not one of
        // workspace, permissions, plugins, limits, advanced, notifications or connectors is drawn in this block, with
        // `when` hiding it and `Failure.fields` marking it, as the mockup's dashed zone shows.
        <section data-slot="form-block" data-kind={current().kind} data-extra="">
          <h3 data-slot="form-block-head">{ctx.t("agents.detail.options", { label: current().label })}</h3>
          <p data-slot="form-hint">{ctx.t("agents.form.options.hint")}</p>
          <FieldGrid form={props.form} fields={props.form.fields().extra} choices={props.choices} />
        </section>
      )}
    </Show>
  )
}

function FieldGrid(props: {
  form: FormModel
  fields: readonly Field[]
  choices: (lookup: string) => readonly Choice[]
}) {
  return (
    <div data-slot="form-grid">
      <For each={props.fields}>
        {(field) => <FieldControl form={props.form} field={field} choices={props.choices} />}
      </For>
    </div>
  )
}

// One backend field, with the control its kind calls for.
function FieldControl(props: { form: FormModel; field: Field; choices: (lookup: string) => readonly Choice[] }) {
  const ctx = usePlugin()
  const form = props.form
  const field = () => props.field
  const options = () => choicesOf(field(), props.choices)
  const kind = () => control(field(), options())
  const id = () => `agents-form-${field().key}`
  const value = () => valueOf(field(), form.state.draft.options)
  // What is typed, not what is saved: a cleared field is empty, and its default shows as the placeholder.
  const typed = () => String(form.state.draft.options[field().key] ?? "")
  const placeholder = () => (field().default === undefined ? undefined : String(field().default))
  const invalid = () => form.error(field().key) !== undefined
  const set = (next: Parameters<FormModel["option"]>[1]) => form.option(field().key, next)
  const picked = () => pickedOf(field(), value(), options())

  return (
    <Row
      id={field().key}
      label={field().label}
      hint={field().help}
      warning={options().find((choice) => choice.value === value())?.warning}
      error={said(ctx.t, form, field().key)}
      wide={wide(kind())}
      group={["radio", "choices", "list", "toggle"].includes(kind())}
    >
      <Switch>
        <Match when={kind() === "toggle"}>
          <FormToggle checked={value() === true} label={field().label} onChange={set} />
        </Match>
        <Match when={kind() === "textarea"}>
          <Textarea
            id={id()}
            rows={4}
            value={typed()}
            placeholder={placeholder()}
            invalid={invalid()}
            onInput={(event) => set(event.currentTarget.value)}
          />
        </Match>
        <Match when={kind() === "number"}>
          <TextInput
            id={id()}
            type="number"
            numeric
            min={field().min}
            max={field().max}
            value={typed()}
            placeholder={placeholder()}
            invalid={invalid()}
            onInput={(event) => {
              const text = event.currentTarget.value.trim()
              set(text === "" ? undefined : Number.isFinite(Number(text)) ? Number(text) : text)
            }}
          />
        </Match>
        <Match when={kind() === "radio"}>
          <div data-slot="form-radios" role="radiogroup" aria-labelledby={`${id()}-label`}>
            <For each={options()}>
              {(option) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={value() === option.value}
                  data-state={value() === option.value ? "pressed" : undefined}
                  onClick={() => set(option.value)}
                >
                  <span data-slot="form-dot" />
                  {option.label}
                </button>
              )}
            </For>
          </div>
        </Match>
        <Match when={kind() === "select"}>
          <Select
            id={id()}
            label={field().label}
            value={String(value() ?? "")}
            options={options()}
            blank={field().required ? ctx.t("agents.form.choose") : ctx.t("agents.form.default")}
            invalid={invalid()}
            onChange={(next) => set(next === "" ? undefined : next)}
          />
        </Match>
        <Match when={kind() === "choices"}>
          <div data-slot="form-pills" role="group" aria-labelledby={`${id()}-label`}>
            <For each={options()} fallback={<span data-slot="form-hint">{ctx.t("agents.form.choices.none")}</span>}>
              {(option) => (
                <button
                  type="button"
                  aria-pressed={picked().includes(option.value)}
                  disabled={
                    !picked().includes(option.value) &&
                    field().max !== undefined &&
                    picked().length >= (field().max ?? 0)
                  }
                  onClick={() => set(toggled(field(), value(), options(), option.value))}
                >
                  {option.label}
                </button>
              )}
            </For>
          </div>
        </Match>
        <Match when={kind() === "list"}>
          <ListControl
            id={id()}
            label={field().label}
            items={picked()}
            invalid={invalid()}
            onChange={(items) => set(items.length === 0 ? undefined : items)}
          />
        </Match>
        <Match when={kind() === "folder"}>
          <div data-slot="form-inline">
            <TextInput
              id={id()}
              value={typed()}
              placeholder={placeholder()}
              invalid={invalid()}
              spellcheck={false}
              onInput={(event) => set(event.currentTarget.value)}
            />
            <Show when={ctx.desktop}>
              {(desktop) => (
                <Button
                  icon="folder"
                  onClick={() =>
                    void desktop()
                      .pick({ directory: true, title: ctx.t("agents.form.folder.title") })
                      .then(([folder]) => folder && set(folder))
                      .catch(() => undefined)
                  }
                >
                  {ctx.t("agents.form.folder.choose")}
                </Button>
              )}
            </Show>
          </div>
        </Match>
        <Match when={kind() === "repo" || kind() === "text"}>
          <TextInput
            id={id()}
            type={kind() === "repo" ? "url" : "text"}
            value={typed()}
            placeholder={placeholder()}
            invalid={invalid()}
            spellcheck={false}
            onInput={(event) => set(event.currentTarget.value)}
          />
        </Match>
      </Switch>
    </Row>
  )
}

// A list of strings: the items as removable tokens, and a field to add one.
function ListControl(props: {
  id: string
  label: string
  items: readonly string[]
  invalid: boolean
  onChange: (items: string[]) => void
}) {
  const ctx = usePlugin()
  const [text, setText] = createSignal("")
  const add = () => {
    const item = text().trim()
    if (item === "" || props.items.includes(item)) return
    props.onChange([...props.items, item])
    setText("")
  }

  return (
    <div data-slot="form-list">
      <div data-slot="form-pills">
        <For each={props.items}>
          {(item) => (
            <span data-slot="form-token">
              {item}
              <button
                type="button"
                aria-label={ctx.t("agents.form.list.remove", { item })}
                onClick={() => props.onChange(props.items.filter((other) => other !== item))}
              >
                <Icon name="close-small" size="small" />
              </button>
            </span>
          )}
        </For>
      </div>
      <div data-slot="form-inline">
        <TextInput
          id={props.id}
          value={text()}
          placeholder={ctx.t("agents.form.list.placeholder")}
          invalid={props.invalid}
          onInput={(event) => setText(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return
            event.preventDefault()
            add()
          }}
        />
        <Button onClick={add}>{ctx.t("agents.form.list.add")}</Button>
      </div>
    </div>
  )
}
