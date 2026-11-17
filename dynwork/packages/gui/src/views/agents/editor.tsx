import { usePlugin } from "@opencode/plugin/gui"
import { Button } from "@opencode/ui/button"
import { Checkbox } from "@opencode/ui/checkbox"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { RadioGroup, RadioItem } from "@opencode/ui/radio"
import { SegmentedControl, SegmentedControlItem } from "@opencode/ui/segmented-control"
import { Tabs } from "@opencode/ui/tabs"
import { Textarea } from "@opencode/ui/textarea"
import { TextInput } from "@opencode/ui/text-input"
import { createEffect, createSignal, For, lazy, Match, on, Show, Switch, type JSX } from "solid-js"
import { isServer } from "solid-js/web"
import type { Choice, Field, Ref, Template } from "../../routines/contract"
import { choicesOf, control, fromSelect, inline, picked as pickedOf, selectChoices, toggled, valueOf } from "./fields"
import { zones } from "./schedule"
import { backendLine, fromMain, instructionsText, scheduleText, when, type Translate } from "./format"
import { draftSchedule, problemText, triggers, type FormModel } from "./form"
import type { AgentsModel } from "./model"
import { device } from "../device"
import "./editor.css"

const PromptSelect = lazy(() => import("./prompt-select"))

/**
 * The routine form, in the app's dialog: a dialog on a wide window and a full-screen sheet on a narrow one (`editor.css`).
 * Every control is the app's own, laid out as Settings lays out its rows: the label and its hint on the left and the
 * control on the right, or under the label when the control holds long content.
 * The common fields are written here; what belongs to a backend is drawn from its `capabilities().fields`, so the farm
 * adds options without this file changing. It reads and writes `form` and nothing else; `agents` only supplies the
 * labels of the lookups. Activating a template is this same form with the rows the template sets read only
 * (`Activation`).
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
      target
        ?.querySelector<HTMLElement>('input, textarea, button, [data-component="select-v2"]')
        ?.focus({ preventScroll: true })
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
          title={
            form.template
              ? ctx.t("agents.template.form.title", { name: form.template.name })
              : ctx.t(form.mode === "edit" ? "agents.form.title.edit" : "agents.form.title.create")
          }
          description={form.template ? ctx.t("agents.template.form.description") : ctx.t("agents.form.description")}
        />
      </DialogHeader>
      <DialogBody>
        <form data-component="agents-form" onSubmit={(event) => void submit(event)} noValidate>
          <Show
            when={form.template}
            fallback={
              <div data-slot="form-scroll" ref={(element) => (refs.scroll = element)}>
                <Where form={form} agents={props.agents} />
                <Locks form={form} />
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
                <Trigger form={form} lock={form.locks.schedule} />
                <Row id="enabled" label={ctx.t("agents.form.active")} hint={ctx.t("agents.form.active.hint")} inline>
                  <ctx.ui.Switch
                    checked={draft().enabled}
                    label={ctx.t("agents.form.active")}
                    hideLabel
                    onChange={(enabled) => form.set({ enabled })}
                  />
                </Row>
                <Block form={form} choices={choices} />
                <Show when={form.fields().extra.length > 0}>
                  <Extra form={form} choices={choices} />
                </Show>
                <section data-slot="form-advanced">
                  <Button
                    variant="ghost"
                    size="small"
                    icon={advanced() ? "chevron-down" : "chevron-right"}
                    data-slot="form-advanced-head"
                    aria-expanded={advanced()}
                    onClick={() => setAdvanced(!advanced())}
                  >
                    {ctx.t("agents.form.advanced")}
                  </Button>
                  <Show when={advanced()}>
                    <Tabs variant="pill" value={tab()} onChange={setTab}>
                      <Tabs.List>
                        <For each={advancedTabs()}>
                          {(item) => (
                            <Tabs.Trigger value={item.id}>{ctx.t(`agents.form.advanced.${item.id}`)}</Tabs.Trigger>
                          )}
                        </For>
                      </Tabs.List>
                    </Tabs>
                    <Show
                      when={// A connectors tab with nothing to choose from (no servers, or the service unreachable) is empty.
                      advancedTabs()
                        .find((item) => item.id === tab())
                        ?.fields.some((field) => tab() !== "connectors" || choicesOf(field, choices).length > 0)}
                      fallback={<p data-slot="form-hint">{ctx.t("agents.form.connectors.empty")}</p>}
                    >
                      <FieldRows
                        form={form}
                        fields={advancedTabs().find((item) => item.id === tab())?.fields ?? []}
                        choices={choices}
                      />
                    </Show>
                  </Show>
                </section>
              </div>
            }
          >
            {(template) => (
              <div data-slot="form-scroll" ref={(element) => (refs.scroll = element)}>
                <Activation form={form} template={template()} agents={props.agents} choices={choices} />
              </div>
            )}
          </Show>
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
                  {fromMain(ctx.t, failure().message)}
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
              {ctx.t(
                form.state.saving ? "agents.form.saving" : form.template ? "agents.template.use" : "agents.form.save",
              )}
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

// One labelled field, as a Settings row: an `inline` control sits on the right of its label and hint, any other under
// them. `group` is for controls with no single input for the label to point at, such as a select or a radio group.
function Row(props: {
  id: string
  label: string
  hint?: string
  /** A warning under the control, as the chosen option says. */
  warning?: string
  error?: string
  inline?: boolean
  group?: boolean
  children: JSX.Element
}) {
  return (
    <div data-slot="form-field" data-key={props.id} data-inline={props.inline ? "" : undefined}>
      <div data-slot="form-copy">
        <Show
          when={props.group || props.inline}
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
        <Show when={props.hint}>
          <span data-slot="form-hint">{props.hint}</span>
        </Show>
      </div>
      <div data-slot="form-control">{props.children}</div>
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

// The app's select over a field's choices; `blank` and stored values as `selectChoices` says.
function Choose(props: {
  label: string
  value: string
  options: readonly Choice[]
  blank?: string
  invalid?: boolean
  disabled?: boolean
  onChange: (value: string) => void
}) {
  const ctx = usePlugin()
  const choices = () => selectChoices(props.value, props.options, props.blank)

  return (
    <ctx.ui.Select
      label={props.label}
      value={choices().value}
      options={choices().options}
      invalid={props.invalid}
      disabled={props.disabled}
      onChange={(value) => props.onChange(fromSelect(value))}
    />
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
      <Row id="backend" label={ctx.t("agents.form.where")} group>
        <RadioGroup
          value={form.state.backend}
          aria-labelledby="agents-form-backend-label"
          onChange={(backend) => form.choose(backend)}
        >
          <For each={props.agents.backends()}>
            {(backend) => (
              <RadioItem
                value={backend.backend}
                label={ctx.t(`agents.form.where.${backend.kind}.title`, { label: backend.label, device: device(ctx).label })}
                description={`${ctx.t(`agents.form.where.${backend.kind}.text`)} ${backendLine(ctx.t, backend)}`}
              />
            )}
          </For>
        </RadioGroup>
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
  // Under the box: the warning of the chosen permission mode, and the problems of the footer's selects.
  const promptNotes = () => [
    ...form.fields().prompt.flatMap((field) => {
      const warning = field.choices?.find((choice) => choice.value === valueOf(field, draft().options))?.warning
      return warning ? [{ text: warning, error: false }] : []
    }),
    ...[...form.fields().prompt.map((field) => field.key), "agent", "model"].flatMap((key) => {
      const text = said(ctx.t, form, key)
      return text ? [{ text, error: true }] : []
    }),
  ]

  return (
    <>
      <Row
        id="instructions"
        label={ctx.t("agents.form.what")}
        hint={form.locks.instructions ? lockedBy(ctx.t, form) : undefined}
        group
        error={said(ctx.t, form, "instructions")}
      >
        <Show when={kinds().length > 1}>
          <SegmentedControl
            value={draft().what}
            disabled={form.locks.instructions}
            aria-labelledby="agents-form-instructions-label"
            onChange={(value) => {
              const what = kinds().find((kind) => kind === value)
              if (what) form.set({ what })
            }}
          >
            <For each={kinds()}>
              {(kind) => <SegmentedControlItem value={kind}>{ctx.t(`agents.form.what.${kind}`)}</SegmentedControlItem>}
            </For>
          </SegmentedControl>
        </Show>
        <Show when={draft().what === "skill"}>
          <Choose
            label={ctx.t("agents.form.skill")}
            value={draft().skill}
            options={props.choices("skills")}
            blank={ctx.t("agents.form.choose")}
            invalid={form.error("instructions") !== undefined}
            disabled={form.locks.instructions}
            onChange={(skill) => form.set({ skill })}
          />
        </Show>
        <Show when={draft().what === "agent"}>
          <Choose
            label={ctx.t("agents.form.agentRef")}
            value={draft().agentRef}
            options={props.choices("agents")}
            blank={ctx.t("agents.form.choose")}
            invalid={form.error("instructions") !== undefined}
            disabled={form.locks.instructions}
            onChange={(agentRef) => form.set({ agentRef })}
          />
        </Show>
        <div data-slot="form-prompt" data-invalid={form.error("instructions") !== undefined ? "" : undefined}>
          <Textarea
            id="agents-form-text"
            rows={6}
            value={draft().text}
            aria-label={ctx.t(textLabel[draft().what])}
            placeholder={draft().what === "prompt" ? ctx.t("agents.form.prompt.placeholder") : undefined}
            invalid={form.error("instructions") !== undefined}
            disabled={form.locks.instructions}
            onInput={(event) => form.set({ text: event.currentTarget.value })}
          />
          <PromptFooter form={form} choices={props.choices} />
        </div>
        <For each={promptNotes()}>
          {(note) => (
            <span data-slot={note.error ? "form-error" : "form-hint"} data-tone={note.error ? undefined : "warning"}>
              {note.text}
            </span>
          )}
        </For>
      </Row>
    </>
  )
}

// The footer of the instructions box, as Claude's task form draws it: the permission mode and the agent on the left,
// the model on the right, each a compact select. The selects load on the client only (`prompt-select.tsx`).
function PromptFooter(props: { form: FormModel; choices: (lookup: string) => readonly Choice[] }) {
  const ctx = usePlugin()
  const form = props.form
  const draft = () => form.state.draft

  return (
    <div data-slot="form-prompt-footer">
      <Show when={!isServer}>
        <div data-slot="form-prompt-side">
          <For each={form.fields().prompt}>
            {(field) => (
              <span data-key={field.key}>
                <PromptSelect
                  label={field.label}
                  value={String(valueOf(field, draft().options) ?? "")}
                  options={field.choices ?? []}
                  icon={valueOf(field, draft().options) === "bypass" ? "warning" : "shield"}
                  invalid={form.error(field.key) !== undefined}
                  disabled={form.locks.option(field.key)}
                  onChange={(next) => form.option(field.key, next)}
                />
              </span>
            )}
          </For>
          <Show when={form.capabilities()?.agent !== "none" && form.capabilities()}>
            {(current) => (
              <span data-key="agent">
                <PromptSelect
                  label={ctx.t("agents.form.agent")}
                  value={draft().agent}
                  options={props.choices("agents")}
                  blank={
                    current().agent === "optional" ? ctx.t("agents.form.agent.default") : ctx.t("agents.form.choose")
                  }
                  invalid={form.error("agent") !== undefined}
                  disabled={form.locks.agent}
                  onChange={(agent) => form.set({ agent })}
                />
              </span>
            )}
          </Show>
        </div>
        <div data-slot="form-prompt-side">
          <Switch>
            <Match when={form.capabilities()?.model === "choose"}>
              <span data-key="model">
                <PromptSelect
                  label={ctx.t("agents.form.model")}
                  value={draft().model}
                  options={props.choices("models")}
                  blank={ctx.t("agents.form.model.default")}
                  invalid={form.error("model") !== undefined}
                  disabled={form.locks.model}
                  placement="top-end"
                  onChange={(model) => form.set({ model })}
                />
              </span>
            </Match>
            <Match when={form.capabilities()?.model === "agent"}>
              <span data-slot="form-hint">{ctx.t("agents.form.model.byAgent")}</span>
            </Match>
          </Switch>
        </div>
      </Show>
    </div>
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

// What a routine made from a template cannot change: said once at the top, and again on each row it locks.
function Locks(props: { form: FormModel }) {
  const ctx = usePlugin()

  return (
    <Show when={props.form.locks.template}>
      {(name) => (
        <div data-slot="form-notice" data-tone="info">
          <Icon name="lock" size="small" />
          <span>{ctx.t("agents.template.locks", { name: name() })}</span>
        </div>
      )}
    </Show>
  )
}

const lockedBy = (t: Translate, form: FormModel) => t("agents.template.lockedBy", { name: form.locks.template ?? "" })

// The trigger: nothing, or a preset or a cron, in a zone, with the next three runs as a preview. A template's `lock`
// keeps how often it runs (`time`: the time stays the person's) or all of it (`locked`); the zone is always theirs.
function Trigger(props: { form: FormModel; lock?: "time" | "locked" }) {
  const ctx = usePlugin()
  const form = props.form
  const draft = () => form.state.draft
  const order = [1, 2, 3, 4, 5, 6, 0]
  // The cron a preset writes, shown beside it; a custom cron is its own.
  const equivalent = () =>
    draft().trigger === "none" || draft().trigger === "cron" ? undefined : draftSchedule(draft())?.cron
  const window = () => form.capabilities()?.schedule.window === true

  return (
    <div data-slot="form-rows" data-key="schedule">
      <Row
        id="trigger"
        label={ctx.t("agents.form.trigger")}
        hint={
          props.lock === "locked" && form.locks.template
            ? lockedBy(ctx.t, form)
            : props.lock
              ? ctx.t(`agents.template.schedule.${props.lock}`)
              : undefined
        }
        inline
      >
        <Choose
          label={ctx.t("agents.form.trigger")}
          value={draft().trigger}
          options={form.triggers().map((value) => ({ value, label: ctx.t(`agents.form.trigger.${value}`) }))}
          disabled={props.lock !== undefined}
          onChange={(value) => form.setTrigger(triggers.find((trigger) => trigger === value) ?? "none")}
        />
      </Row>
      <Show when={draft().trigger === "weekly"}>
        <Row id="days" label={ctx.t("agents.form.days")} group>
          <div data-slot="form-days" role="group" aria-labelledby="agents-form-days-label">
            <For each={order}>
              {(day) => (
                <Checkbox
                  appearance="compact"
                  disabled={props.lock !== undefined}
                  checked={draft().days.includes(day)}
                  onChange={(checked) =>
                    form.set({
                      days: checked ? [...draft().days, day] : draft().days.filter((other) => other !== day),
                    })
                  }
                >
                  {ctx.t(`agents.day.short.${day}`)}
                </Checkbox>
              )}
            </For>
          </div>
        </Row>
      </Show>
      <Show when={draft().trigger === "monthly"}>
        <Row id="day" label={ctx.t("agents.form.day")} inline>
          <TextInput
            id="agents-form-day"
            type="number"
            min="1"
            max="31"
            numeric
            disabled={props.lock !== undefined}
            aria-label={ctx.t("agents.form.day")}
            value={String(draft().day)}
            onInput={(event) => form.set({ day: Number(event.currentTarget.value) })}
          />
        </Row>
      </Show>
      <Show when={draft().trigger !== "none" && draft().trigger !== "cron"}>
        <Row id="time" label={ctx.t("agents.form.time")} inline>
          <TextInput
            id="agents-form-time"
            type="time"
            disabled={props.lock === "locked"}
            aria-label={ctx.t("agents.form.time")}
            value={draft().time}
            invalid={form.error("schedule") !== undefined}
            onInput={(event) => form.set({ time: event.currentTarget.value })}
          />
        </Row>
      </Show>
      <Show when={draft().trigger === "cron"}>
        <Row id="cron" label={ctx.t("agents.form.cron")} hint={ctx.t("agents.form.cron.hint")}>
          <TextInput
            id="agents-form-cron"
            aria-label={ctx.t("agents.form.cron")}
            value={draft().cron}
            placeholder="45 8 * * 1"
            spellcheck={false}
            disabled={props.lock === "locked"}
            invalid={form.error("schedule") !== undefined}
            onInput={(event) => form.set({ cron: event.currentTarget.value })}
          />
        </Row>
      </Show>
      <Show when={draft().trigger !== "none"}>
        <Row id="zone" label={ctx.t("agents.form.zone")} inline>
          <Choose
            label={ctx.t("agents.form.zone")}
            value={draft().timezone}
            options={zones(draft().timezone).map((value) => ({ value, label: value }))}
            onChange={(timezone) => form.set({ timezone })}
          />
        </Row>
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
          <Row id="starts" label={ctx.t("agents.form.starts")} inline>
            <TextInput
              id="agents-form-starts"
              type="date"
              aria-label={ctx.t("agents.form.starts")}
              value={draft().starts}
              onInput={(event) => form.set({ starts: event.currentTarget.value })}
            />
          </Row>
          <Row id="ends" label={ctx.t("agents.form.ends")} inline>
            <TextInput
              id="agents-form-ends"
              type="date"
              aria-label={ctx.t("agents.form.ends")}
              value={draft().ends}
              onInput={(event) => form.set({ ends: event.currentTarget.value })}
            />
          </Row>
          <Row id="max" label={ctx.t("agents.form.max")} inline>
            <TextInput
              id="agents-form-max"
              type="number"
              min="1"
              numeric
              aria-label={ctx.t("agents.form.max")}
              value={draft().max}
              placeholder={ctx.t("agents.form.max.placeholder")}
              onInput={(event) => form.set({ max: event.currentTarget.value })}
            />
          </Row>
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

// Activating a template: the rows the template sets are read only, with a lock and "Set by Dynapps"; the person chooses
// only what is theirs (`form.asks()`): the schedule as far as the template lets them, the zone, the folder it needs (with
// its hint), a model where the template's is not on this computer, and the confirmation of one that runs without asking.
function Activation(props: {
  form: FormModel
  template: Template
  agents: AgentsModel
  choices: (lookup: string) => readonly Choice[]
}) {
  const ctx = usePlugin()
  const form = props.form
  const source = () => props.template.definition
  const asked = () => form.asks()
  const field = (key: string) => form.capabilities()?.fields.find((candidate) => candidate.key === key)
  const label = (lookup: string, value: string) =>
    props.choices(lookup).find((choice) => choice.value === value)?.label ?? value
  const folder = () => {
    const found = field("folder")
    return found && { ...found, required: true, help: asked()?.hint ?? found.help }
  }
  const permission = () =>
    field("permissions")?.choices?.find((choice) => choice.value === source().options.permissions)
  const lock = () => {
    const schedule = asked()?.schedule
    return schedule === "free" ? undefined : schedule
  }

  return (
    <>
      <Where form={form} agents={props.agents} />
      <Show when={props.template.description}>
        <p data-slot="form-hint">{props.template.description}</p>
      </Show>
      <Locked id="instructions" label={ctx.t("agents.form.what")}>
        {instructionsText(ctx.t, source().instructions)}
      </Locked>
      <Show when={source().agent}>
        {(agent) => (
          <Locked id="agent" label={ctx.t("agents.form.agent")}>
            {label("agents", agent())}
          </Locked>
        )}
      </Show>
      <Show
        when={asked()?.model}
        fallback={
          <Show when={source().model}>
            {(model) => (
              <Locked id="model" label={ctx.t("agents.form.model")}>
                {label("models", model())}
              </Locked>
            )}
          </Show>
        }
      >
        <Row
          id="model"
          label={ctx.t("agents.form.model")}
          hint={ctx.t("agents.template.model.missing")}
          error={said(ctx.t, form, "model")}
          inline
        >
          <Choose
            label={ctx.t("agents.form.model")}
            value={form.state.draft.model}
            options={props.choices("models")}
            blank={ctx.t("agents.form.choose")}
            invalid={form.error("model") !== undefined}
            onChange={(model) => form.set({ model })}
          />
        </Row>
      </Show>
      <Notice form={form} />
      <Show
        when={source().schedule}
        fallback={
          <Locked id="schedule" label={ctx.t("agents.form.trigger")}>
            {scheduleText(ctx.t, undefined)}
          </Locked>
        }
      >
        <Trigger form={form} lock={lock()} />
      </Show>
      <Show when={asked()?.folder && folder()}>
        {(found) => <FieldControl form={form} field={found()} choices={props.choices} />}
      </Show>
      <Locked id="connectors" label={field("connectors")?.label ?? ctx.t("agents.form.advanced.connectors")}>
        {source()
          .options.connectors.map((name) => label("connectors", name))
          .join(", ") || ctx.t("agents.template.connectors.none")}
      </Locked>
      <Row
        id="permissions"
        label={field("permissions")?.label ?? ctx.t("agents.template.permissions")}
        hint={ctx.t("agents.template.locked")}
        warning={permission()?.warning}
        error={said(ctx.t, form, "permissions")}
        group
      >
        <span data-slot="form-static" data-locked="">
          <Icon name="lock" size="small" />
          <span>{permission()?.label ?? source().options.permissions}</span>
        </span>
        <Show when={asked()?.confirm}>
          <Checkbox checked={form.state.approved} onChange={(approved: boolean) => form.approve(approved)}>
            {ctx.t("agents.template.confirm")}
          </Checkbox>
        </Show>
      </Row>
    </>
  )
}

// A value the template sets: read only, with a lock, and "Set by Dynapps".
function Locked(props: { id: string; label: string; children: JSX.Element }) {
  const ctx = usePlugin()

  return (
    <Row id={props.id} label={props.label} hint={ctx.t("agents.template.locked")} group>
      <span data-slot="form-static" data-locked="">
        <Icon name="lock" size="small" />
        <span>{props.children}</span>
      </span>
    </Row>
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
            {ctx.t(`agents.form.block.${current().kind}`, { label: current().label, device: device(ctx).inline })}
          </h3>
          <Show when={current().kind === "local"}>
            <Row id="device" label={ctx.t("agents.form.device")} group hint={ctx.t("agents.form.device.hint")}>
              <span data-slot="form-static">{current().label}</span>
            </Row>
          </Show>
          <FieldRows form={form} fields={form.fields().where} choices={props.choices} />
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
          <FieldRows form={props.form} fields={props.form.fields().extra} choices={props.choices} />
        </section>
      )}
    </Show>
  )
}

function FieldRows(props: {
  form: FormModel
  fields: readonly Field[]
  choices: (lookup: string) => readonly Choice[]
}) {
  return (
    <div data-slot="form-rows">
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
  const off = () => form.locks.option(field().key)

  return (
    <Row
      id={field().key}
      label={field().label}
      hint={off() ? lockedBy(ctx.t, form) : field().help}
      warning={options().find((choice) => choice.value === value())?.warning}
      error={said(ctx.t, form, field().key)}
      inline={inline(kind())}
      group={["radio", "choices", "list"].includes(kind())}
    >
      <Switch>
        <Match when={kind() === "toggle"}>
          <ctx.ui.Switch checked={value() === true} label={field().label} hideLabel disabled={off()} onChange={set} />
        </Match>
        <Match when={kind() === "textarea"}>
          <Textarea
            id={id()}
            rows={4}
            value={typed()}
            placeholder={placeholder()}
            invalid={invalid()}
            disabled={off()}
            onInput={(event) => set(event.currentTarget.value)}
          />
        </Match>
        <Match when={kind() === "number"}>
          <TextInput
            id={id()}
            type="number"
            numeric
            aria-label={field().label}
            min={field().min}
            max={field().max}
            value={typed()}
            placeholder={placeholder()}
            invalid={invalid()}
            disabled={off()}
            onInput={(event) => {
              const text = event.currentTarget.value.trim()
              set(text === "" ? undefined : Number.isFinite(Number(text)) ? Number(text) : text)
            }}
          />
        </Match>
        <Match when={kind() === "radio"}>
          <RadioGroup
            value={String(value() ?? "")}
            aria-labelledby={`${id()}-label`}
            disabled={off()}
            onChange={(next) => set(next)}
          >
            <For each={options()}>{(option) => <RadioItem value={option.value} label={option.label} />}</For>
          </RadioGroup>
        </Match>
        <Match when={kind() === "select"}>
          <Choose
            label={field().label}
            value={String(value() ?? "")}
            options={options()}
            blank={field().required ? ctx.t("agents.form.choose") : ctx.t("agents.form.default")}
            invalid={invalid()}
            disabled={off()}
            onChange={(next) => set(next === "" ? undefined : next)}
          />
        </Match>
        <Match when={kind() === "choices"}>
          {/* One row per choice with the app's switch, as Settings lists the MCP servers. */}
          <div data-slot="form-switches" role="group" aria-labelledby={`${id()}-label`}>
            <For each={options()} fallback={<span data-slot="form-hint">{ctx.t("agents.form.choices.none")}</span>}>
              {(option) => (
                <div data-slot="form-switch">
                  <span data-slot="form-switch-label">{option.label}</span>
                  <ctx.ui.Switch
                    checked={picked().includes(option.value)}
                    label={option.label}
                    hideLabel
                    disabled={
                      off() ||
                      (!picked().includes(option.value) &&
                        field().max !== undefined &&
                        picked().length >= (field().max ?? 0))
                    }
                    onChange={() => set(toggled(field(), value(), options(), option.value))}
                  />
                </div>
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
            disabled={off()}
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
              disabled={off()}
              spellcheck={false}
              onInput={(event) => set(event.currentTarget.value)}
            />
            <Show when={ctx.desktop}>
              {(desktop) => (
                <Button
                  icon="folder"
                  disabled={off()}
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
            disabled={off()}
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
  disabled?: boolean
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
      <div data-slot="form-tokens">
        <For each={props.items}>
          {(item) => (
            <span data-slot="form-token">
              {item}
              <IconButton
                variant="ghost"
                size="small"
                icon={<Icon name="close-small" size="small" />}
                aria-label={ctx.t("agents.form.list.remove", { item })}
                disabled={props.disabled}
                onClick={() => props.onChange(props.items.filter((other) => other !== item))}
              />
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
          disabled={props.disabled}
          onInput={(event) => setText(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return
            event.preventDefault()
            add()
          }}
        />
        <Button disabled={props.disabled} onClick={add}>
          {ctx.t("agents.form.list.add")}
        </Button>
      </div>
    </div>
  )
}
