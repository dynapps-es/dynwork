import { usePlugin } from "@opencode/plugin/gui"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { Switch } from "@opencode/ui/switch"
import { For, Show, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import type { Capabilities, Routine, Run } from "../../routines/contract"
import { duration, instructionsText, money, runWhen, scheduleText, when } from "./format"
import type { AgentsModel } from "./model"
import { routineHref, runHref } from "../runs/model"
import { LinkButton, RunMark, Tag, Unread, WhereBadge } from "./parts"
import { actions, facts, isLive, openable, routineStatus, type Allowed, type Fact } from "./routine"
import { upcoming } from "./schedule"

/**
 * One routine, laid out the same for both kinds: the head with where it runs, its next run and its actions; History on
 * the left; Instructions, Repeats, Where and with what, Permissions, the backend's own options and Notifications on the
 * right. The columns stack in a narrow pane.
 */
export function RoutineDetail(props: {
  routine: Routine
  model: AgentsModel
  open: (run: Run) => void
  edit: (routine: Routine) => void
  remove: (routine: Routine) => void
}) {
  const ctx = usePlugin()
  const capabilities = () => props.model.capabilities(props.routine.ref.backend)
  const allowed = () => actions(props.routine, capabilities())
  const status = () => routineStatus(props.routine, capabilities())
  const remote = () => capabilities()?.kind === "remote"
  const busy = (action: string) => props.model.busy(`${action}/${props.routine.ref.backend}/${props.routine.ref.id}`)
  const reason = (action: Allowed) => (action.reason ? ctx.t(action.reason.key, action.reason.params) : undefined)
  const next = () => props.routine.next
  const zone = () => props.routine.definition.schedule?.timezone

  return (
    <div data-slot="agents-detail">
      <nav data-slot="agents-crumbs" aria-label={ctx.t("agents.detail.back")}>
        <button type="button" data-slot="agents-crumb" onClick={props.model.deselect}>
          <Icon name="arrow-left" size="small" />
          {ctx.t("agents.detail.back")}
        </button>
        <Icon name="chevron-right" size="small" />
        <span data-slot="agents-crumb-current">{props.routine.definition.name}</span>
      </nav>
      <header data-slot="agents-detail-head">
        <div data-slot="agents-detail-heading">
          <h1 data-slot="agents-detail-title">{props.routine.definition.name}</h1>
          <div data-slot="agents-detail-chips">
            <WhereBadge
              routine={props.routine}
              capabilities={capabilities()}
              text={
                remote()
                  ? ctx.t("agents.detail.remote", { label: capabilities()?.label ?? "" })
                  : ctx.t("agents.detail.local", {
                      device: props.routine.owner?.label ?? capabilities()?.label ?? "",
                    })
              }
            />
            <Tag tone={status().tone}>{ctx.t(status().key, status().params)}</Tag>
            <Show when={props.routine.state === "active" ? next() : undefined}>
              {(at) => (
                <>
                  <span>{ctx.t("agents.detail.next", { when: when(ctx.locale.locale(), at(), zone()) })}</span>
                  <Show when={zone()}>{(name) => <Tag>{name()}</Tag>}</Show>
                </>
              )}
            </Show>
          </div>
        </div>
        <div data-slot="agents-detail-actions">
          <Show
            when={props.routine.conversation.kind === "session"}
            fallback={
              <Button
                variant="neutral"
                icon="eye"
                disabled={!allowed().open.enabled || !props.routine.last || !openable(props.routine.last)}
                title={reason(allowed().open)}
                onClick={() => props.routine.last && props.open(props.routine.last)}
              >
                {ctx.t("agents.detail.open")}
              </Button>
            }
          >
            <Show
              when={allowed().open.enabled ? routineHref(props.routine) : undefined}
              fallback={
                <Button variant="neutral" icon="speech-bubble" disabled title={reason(allowed().open)}>
                  {ctx.t("agents.detail.openLocal")}
                </Button>
              }
            >
              {(href) => (
                <LinkButton href={href()} icon="speech-bubble">
                  {ctx.t("agents.detail.openLocal")}
                </LinkButton>
              )}
            </Show>
          </Show>
          <Show
            when={isLive(props.routine.last) ? props.routine.last : undefined}
            fallback={
              <Button
                variant="neutral"
                icon="outline-video"
                disabled={!allowed().start.enabled || busy("start")}
                title={reason(allowed().start)}
                onClick={() => void props.model.start(props.routine)}
              >
                {ctx.t("agents.detail.run")}
              </Button>
            }
          >
            {(run) => (
              <Button
                variant="neutral"
                icon="stop"
                disabled={!allowed().cancel.enabled || props.model.busy(`cancel/${run().ref.backend}/${run().ref.id}`)}
                title={reason(allowed().cancel)}
                onClick={() => void props.model.cancel(run())}
              >
                {ctx.t("agents.detail.stop")}
              </Button>
            )}
          </Show>
          <Button
            variant="ghost"
            icon="edit"
            disabled={!allowed().edit.enabled}
            title={reason(allowed().edit)}
            onClick={() => props.edit(props.routine)}
          >
            {ctx.t("agents.detail.edit")}
          </Button>
          <span data-slot="agents-switch" title={reason(allowed().toggle)}>
            <Switch
              checked={props.routine.state === "active"}
              disabled={!allowed().toggle.enabled || busy("toggle")}
              onChange={() => void props.model.toggle(props.routine)}
            >
              {ctx.t("agents.detail.active")}
            </Switch>
          </span>
          <Button
            variant="ghost-danger"
            icon="outline-trash"
            disabled={!allowed().remove.enabled || busy("remove")}
            title={reason(allowed().remove)}
            onClick={() => props.remove(props.routine)}
          >
            {ctx.t("agents.detail.remove")}
          </Button>
        </div>
      </header>
      <Show when={props.model.state.failure}>
        {(failure) => (
          <div data-slot="agents-notice" data-tone="danger" role="alert">
            <Icon name="circle-exclamation" size="small" />
            <span>{failure().message}</span>
            <Button variant="ghost" size="small" onClick={props.model.dismiss}>
              {ctx.t("agents.dismiss")}
            </Button>
          </div>
        )}
      </Show>
      <div data-slot="agents-detail-columns">
        <section data-slot="agents-history" aria-label={ctx.t("agents.detail.history")}>
          <h2 data-slot="agents-section-title">{ctx.t("agents.detail.history")}</h2>
          <History routine={props.routine} model={props.model} open={props.open} />
        </section>
        <Facts routine={props.routine} capabilities={capabilities()} model={props.model} />
      </div>
    </div>
  )
}

function History(props: { routine: Routine; model: AgentsModel; open: (run: Run) => void }) {
  const ctx = usePlugin()
  const page = () => props.model.history(props.routine.ref)

  return (
    <>
      <Show when={page().failure}>{(failure) => <p data-slot="agents-error">{failure().message}</p>}</Show>
      <Show
        when={page().runs.length > 0}
        fallback={
          <p data-slot="agents-empty">{ctx.t(page().loading ? "agents.loading" : "agents.detail.history.empty")}</p>
        }
      >
        <div data-slot="agents-runs" role="list">
          <For each={page().runs}>{(run) => <HistoryRow run={run} open={props.open} />}</For>
        </div>
      </Show>
      <Show when={page().next !== undefined}>
        <Button variant="ghost" onClick={() => void props.model.loadHistory(props.routine.ref, true)}>
          {ctx.t("agents.more")}
        </Button>
      </Show>
      <Show when={props.model.capabilities(props.routine.ref.backend)?.kind === "remote"}>
        <p data-slot="agents-hint">{ctx.t("agents.detail.history.hint")}</p>
      </Show>
    </>
  )
}

function HistoryRow(props: { run: Run; open: (run: Run) => void }) {
  const ctx = usePlugin()
  const spent = () =>
    [duration(ctx.t, props.run, Date.now()), props.run.cost && money(ctx.locale.locale(), props.run.cost)]
      .filter(Boolean)
      .join(" · ")

  return (
    // A run read in a session is a link the app's router opens in place, under the routine's anchor.
    <Dynamic
      component={runHref(props.run) ? "a" : "button"}
      href={runHref(props.run)}
      type={runHref(props.run) ? undefined : "button"}
      role="listitem"
      data-slot="agents-run"
      disabled={runHref(props.run) ? undefined : !openable(props.run)}
      onClick={() => !runHref(props.run) && props.open(props.run)}
    >
      <RunMark state={props.run.state} />
      <span data-slot="agents-run-text">
        <span data-slot="agents-run-when">{runWhen(ctx.locale.locale(), props.run)}</span>
        <small>
          {ctx.t(`agents.run.${props.run.state}`)}
          <Show when={props.run.summary ?? props.run.reason}>{(detail) => ` · ${detail()}`}</Show>
        </small>
      </span>
      <span data-slot="agents-meta">{spent() || "—"}</span>
      <Unread show={props.run.unread} />
    </Dynamic>
  )
}

function Facts(props: { routine: Routine; capabilities?: Capabilities; model: AgentsModel }) {
  const ctx = usePlugin()
  const backend = () => props.routine.ref.backend
  const definition = () => props.routine.definition
  const grouped = () => facts(props.routine, props.capabilities, (lookup) => props.model.choices(backend(), lookup))
  const label = (lookup: string, value: string) =>
    props.model.choices(backend(), lookup).find((choice) => choice.value === value)?.label ?? value
  const remote = () => props.capabilities?.kind === "remote"
  const next = () => {
    const schedule = definition().schedule
    return props.routine.state === "active" && schedule ? upcoming(schedule, Date.now()) : []
  }

  return (
    <div data-slot="agents-facts">
      <FactBlock title={ctx.t("agents.detail.instructions")}>
        <p data-slot="agents-fact-text">{instructionsText(ctx.t, definition().instructions)}</p>
      </FactBlock>
      <FactBlock title={ctx.t("agents.detail.repeats")}>
        <span data-slot="agents-fact-row">
          <Icon name="status" size="small" />
          <span>
            {scheduleText(ctx.t, definition().schedule)}
            <Show when={definition().schedule}>
              {(schedule) => (
                <>
                  {" · "}
                  {schedule().timezone} · <code>{schedule().cron}</code>
                </>
              )}
            </Show>
          </span>
        </span>
        <Show when={next().length > 0}>
          <div data-slot="agents-upcoming" aria-label={ctx.t("agents.detail.upcoming")}>
            <For each={next()}>
              {(at) => <span>{when(ctx.locale.locale(), at, definition().schedule?.timezone)}</span>}
            </For>
          </div>
        </Show>
      </FactBlock>
      <FactBlock title={ctx.t("agents.detail.where")}>
        <span data-slot="agents-fact-row">
          <Icon name={remote() ? "cloud-upload" : "monitor"} size="small" />
          {remote()
            ? ctx.t("agents.detail.whereRemote", { label: props.capabilities?.label ?? "" })
            : ctx.t("agents.detail.whereLocal", {
                device: props.routine.owner?.label ?? props.capabilities?.label ?? "",
              })}
        </span>
        <For each={grouped().where}>{(fact) => <FactRow fact={fact} />}</For>
        <Show when={definition().agent}>
          {(agent) => (
            <span data-slot="agents-fact-row">
              <Icon name="task" size="small" />
              {ctx.t("agents.detail.agent", { agent: label("agents", agent()) })}
            </span>
          )}
        </Show>
        <Show when={props.capabilities?.model === "agent"}>
          <span data-slot="agents-fact-row">
            <Icon name="models" size="small" />
            {ctx.t("agents.detail.modelByAgent")}
          </span>
        </Show>
        <Show when={props.capabilities?.model === "choose" ? definition().model : undefined}>
          {(model) => (
            <span data-slot="agents-fact-row">
              <Icon name="models" size="small" />
              {ctx.t("agents.detail.model", { model: label("models", model()) })}
            </span>
          )}
        </Show>
      </FactBlock>
      <FactBlock title={ctx.t("agents.detail.permissions")}>
        <Show
          when={grouped().permissions.length > 0}
          fallback={<p data-slot="agents-fact-text">{ctx.t("agents.detail.permissionsRemote")}</p>}
        >
          <For each={grouped().permissions}>{(fact) => <FactRow fact={fact} />}</For>
        </Show>
      </FactBlock>
      {/* JESÚS: this block paints the farm's own fields from `capabilities().fields` (every section the detail does not
          place elsewhere: schedule, advanced, ...). Declare a field there and it shows here, read only; nothing to add. */}
      <Show when={grouped().options.length > 0}>
        <FactBlock title={ctx.t("agents.detail.options", { label: props.capabilities?.label ?? "" })} own={remote()}>
          <For each={grouped().options}>{(fact) => <FactRow fact={fact} />}</For>
        </FactBlock>
      </Show>
      <Show when={grouped().notifications.length > 0}>
        <FactBlock title={ctx.t("agents.detail.notifications")}>
          <For each={grouped().notifications}>{(fact) => <FactRow fact={fact} />}</For>
        </FactBlock>
      </Show>
    </div>
  )
}

function FactBlock(props: { title: string; own?: boolean; children: JSX.Element }) {
  return (
    <section data-slot="agents-fact" data-own={props.own ? "" : undefined}>
      <h2 data-slot="agents-section-title">{props.title}</h2>
      {props.children}
    </section>
  )
}

function FactRow(props: { fact: Fact }) {
  const ctx = usePlugin()
  const value = () => {
    const raw = props.fact.value
    if (typeof raw === "boolean") return ctx.t(raw ? "agents.detail.yes" : "agents.detail.no")
    if (typeof raw === "string") return raw
    return raw.join(", ")
  }
  const code = () => ["folder", "repo"].includes(props.fact.kind)

  return (
    <span data-slot="agents-fact-row" data-field={props.fact.key}>
      <span data-slot="agents-fact-label">{props.fact.label}</span>
      <Show when={code()} fallback={<span data-slot="agents-fact-value">{value()}</span>}>
        <code data-slot="agents-fact-value">{value()}</code>
      </Show>
    </span>
  )
}
