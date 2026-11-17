import { usePlugin } from "@opencode/plugin/gui"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { SegmentedControl, SegmentedControlItem } from "@opencode/ui/segmented-control"
import { Tabs } from "@opencode/ui/tabs"
import { TextInput } from "@opencode/ui/text-input"
import { For, Match, Show, Switch } from "solid-js"
import { Dynamic } from "solid-js/web"
import type { Routine, Run, Template } from "../../routines/contract"
import { device } from "../device"
import { duration, fromMain, instructionsText, reasonText, runWhen, scheduleText } from "./format"
import { runHref } from "../runs/model"
import { tabs, type AgentsModel, type TemplateCard } from "./model"
import { openable, routineStatus, stateKey, statuses, waiting, wheres } from "./routine"
import { LinkButton, RunMark, Tag, Unread, WhereBadge } from "./parts"

// Settings → Extensions → MCP, where the connectors are (`packages/app/src/settings/route.ts`).
const CONNECTORS = "/settings?tab=extensions&subtab=mcps"

/**
 * The bar over the list, in the app's own controls: the tabs, the Local and Remote filter with its counts, the status
 * select and the search.
 */
export function Toolbar(props: { model: AgentsModel }) {
  const ctx = usePlugin()
  const model = props.model

  return (
    <div data-slot="agents-toolbar">
      <Tabs
        variant="pill"
        value={model.state.tab}
        onChange={(value) => model.setTab(tabs.find((tab) => tab === value) ?? "mine")}
      >
        <Tabs.List aria-label={ctx.t("agents.tab.label")}>
          <For each={tabs}>{(tab) => <Tabs.Trigger value={tab}>{ctx.t(`agents.tab.${tab}`)}</Tabs.Trigger>}</For>
        </Tabs.List>
      </Tabs>
      <div data-slot="agents-filters">
        <Show when={model.state.tab !== "templates"}>
          <SegmentedControl
            value={model.state.where}
            aria-label={ctx.t("agents.where.label")}
            onChange={(value) => model.setWhere(wheres.find((where) => where === value) ?? "all")}
          >
            {/* Cloud shows once a remote backend is registered (the farm); until then every task is on this Mac. */}
            <For
              each={wheres.filter(
                (where) => where !== "remote" || model.backends().some((backend) => backend.kind === "remote"),
              )}
            >
              {(where) => (
                <SegmentedControlItem value={where}>
                  {ctx.t(`agents.where.${where}`, { device: device(ctx).label })}
                  <Show when={model.state.tab === "mine"}>
                    <span data-slot="agents-count">{model.count(where)}</span>
                  </Show>
                </SegmentedControlItem>
              )}
            </For>
          </SegmentedControl>
        </Show>
        <Show when={model.state.tab === "mine"}>
          <div data-slot="agents-search-row">
            <span data-slot="agents-select-key">{ctx.t("agents.filter.status")}</span>
            <ctx.ui.Select
              label={ctx.t("agents.filter.status")}
              value={model.state.status}
              options={statuses.map((status) => ({ value: status, label: ctx.t(`agents.filter.${status}`) }))}
              onChange={model.setStatus}
            />
            <TextInput
              type="search"
              class="agents-search"
              leadingIcon={<Icon name="magnifying-glass" size="small" />}
              value={model.state.search}
              placeholder={ctx.t("agents.search")}
              aria-label={ctx.t("agents.search")}
              onInput={(event) => model.setSearch(event.currentTarget.value)}
            />
          </div>
        </Show>
      </div>
    </div>
  )
}

/** My routines: a card per routine, in a grid that drops to one column in a narrow window. */
export function RoutineCards(props: { model: AgentsModel }) {
  const ctx = usePlugin()
  const model = props.model

  return (
    <Show
      when={model.visible().length > 0}
      fallback={
        <p data-slot="agents-empty">
          {ctx.t(model.routines().length === 0 ? "agents.list.empty" : "agents.list.none", {
            device: device(ctx).inline,
          })}
        </p>
      }
    >
      <div data-slot="agents-grid" role="list" aria-label={ctx.t("agents.list.label")}>
        <For each={model.visible()}>{(routine) => <RoutineCard routine={routine} model={model} />}</For>
      </div>
    </Show>
  )
}

function RoutineCard(props: { routine: Routine; model: AgentsModel }) {
  const ctx = usePlugin()
  const capabilities = () => props.model.capabilities(props.routine.ref.backend)
  const status = () => routineStatus(props.routine, capabilities())

  return (
    <button type="button" role="listitem" data-slot="agents-card" onClick={() => props.model.select(props.routine.ref)}>
      <span data-slot="agents-card-top">
        <span data-slot="agents-card-name">{props.routine.definition.name}</span>
        <Unread show={props.routine.unread > 0} />
      </span>
      <span data-slot="agents-card-text">{instructionsText(ctx.t, props.routine.definition.instructions)}</span>
      <span data-slot="agents-card-meta">
        <Tag tone={status().tone}>{ctx.t(status().key, status().params)}</Tag>
        <span>{scheduleText(ctx.t, props.routine.definition.schedule)}</span>
        <WhereBadge routine={props.routine} capabilities={capabilities()} />
      </span>
    </button>
  )
}

/** Templates: what Governance offers the person, a card each with what it does and what it offers (`templateCard`). */
export function Templates(props: { model: AgentsModel; use: (backend: string, template: Template) => void }) {
  const ctx = usePlugin()
  const model = props.model

  return (
    <>
      <For each={model.offeredPage().failures}>
        {(failure) => <p data-slot="agents-error">{fromMain(ctx.t, failure.message)}</p>}
      </For>
      <Show
        when={model.offered().length > 0}
        fallback={
          <p data-slot="agents-empty">
            {ctx.t(model.offeredPage().loading ? "agents.loading" : "agents.templates.empty")}
          </p>
        }
      >
        <div data-slot="agents-grid" role="list" aria-label={ctx.t("agents.tab.templates")}>
          <For each={model.offered()}>
            {(item) => (
              <TemplateTile
                backend={item.backend}
                template={item.template}
                card={item.card}
                model={model}
                use={props.use}
              />
            )}
          </For>
        </div>
      </Show>
    </>
  )
}

function TemplateTile(props: {
  backend: string
  template: Template
  card: TemplateCard
  model: AgentsModel
  use: (backend: string, template: Template) => void
}) {
  const ctx = usePlugin()
  const capabilities = () => props.model.capabilities(props.backend)
  const cron = () => props.template.definition.schedule?.cron
  const routine = () =>
    props.card.kind === "active" || props.card.kind === "assigned" ? props.card.routine : undefined
  // Where its routine is: this computer, another one by name, or one Governance links that is not here yet.
  const active = () => {
    const owner = routine()?.owner
    if (owner?.here) return ctx.t("agents.template.active", { device: device(ctx).inline })
    if (owner?.label) return ctx.t("agents.template.active", { device: owner.label })
    return ctx.t("agents.template.active.elsewhere")
  }

  return (
    <div role="listitem" data-slot="agents-card" data-static="">
      <span data-slot="agents-card-top">
        <span data-slot="agents-card-name">{props.template.name}</span>
        <WhereBadge
          capabilities={capabilities()}
          text={capabilities()?.kind === "remote" ? undefined : device(ctx).label}
        />
      </span>
      <span data-slot="agents-card-text">{props.template.description}</span>
      <span data-slot="agents-card-meta">
        <Show when={props.template.mandatory}>
          <Tag tone="info">{ctx.t("agents.template.assigned")}</Tag>
        </Show>
        <span>{scheduleText(ctx.t, cron() === undefined ? undefined : { cron: cron() ?? "", timezone: "" })}</span>
        <span data-slot="agents-card-action">
          <Switch>
            <Match when={props.card.kind === "available"}>
              <Button size="small" onClick={() => props.use(props.backend, props.template)}>
                {ctx.t("agents.template.use")}
              </Button>
            </Match>
            <Match when={props.card.kind === "requires" && props.card}>
              {(card) => (
                <>
                  <Tag tone="warning">{ctx.t("agents.template.requires", { server: card().server })}</Tag>
                  <LinkButton href={CONNECTORS} icon="settings-gear">
                    {ctx.t("agents.template.connectors")}
                  </LinkButton>
                </>
              )}
            </Match>
            <Match when={props.card.kind === "active"}>
              <span>{active()}</span>
            </Match>
          </Switch>
          <Show when={routine()}>
            {(found) => (
              <Button size="small" variant="ghost" onClick={() => props.model.select(found().ref)}>
                {ctx.t("agents.template.open")}
              </Button>
            )}
          </Show>
        </span>
      </span>
    </div>
  )
}

/** Activity: every backend's runs, newest first, filtered by the same chips. */
// JESÚS: Activity calls `runs({ backend })` without a routine, page by page (`next`): answer every task of the user there
// (`GET /tasks`), including those started outside DynWork, with `routine` absent when no schedule owns them.
export function Activity(props: { model: AgentsModel; open: (run: Run) => void }) {
  const ctx = usePlugin()
  const model = props.model

  return (
    <div data-slot="agents-activity">
      <p data-slot="agents-hint">{ctx.t("agents.activity.hint")}</p>
      <For each={model.activityPage().failures}>
        {(failure) => <p data-slot="agents-error">{fromMain(ctx.t, failure.message)}</p>}
      </For>
      <Show
        when={model.activity().length > 0}
        fallback={
          <p data-slot="agents-empty">
            {ctx.t(model.activityPage().loading ? "agents.loading" : "agents.activity.empty")}
          </p>
        }
      >
        <div data-slot="agents-activity-list" role="list">
          <For each={model.activity()}>{(run) => <ActivityRow run={run} model={model} open={props.open} />}</For>
        </div>
      </Show>
      <Show when={model.activityPage().more}>
        <Button variant="ghost" onClick={() => void model.loadActivity(true)}>
          {ctx.t("agents.more")}
        </Button>
      </Show>
    </div>
  )
}

function ActivityRow(props: { run: Run; model: AgentsModel; open: (run: Run) => void }) {
  const ctx = usePlugin()
  const routine = () => props.model.routineOf(props.run)
  const capabilities = () => props.model.capabilities(props.run.ref.backend)
  const detail = () =>
    props.run.summary ??
    duration(ctx.t, props.run, Date.now()) ??
    (props.run.reason && !waiting(props.run) ? reasonText(ctx.t, props.run.reason) : ctx.t("agents.run.outside"))

  return (
    // A run read in a session is a link the app's router opens in place, under the routine's anchor.
    <Dynamic
      component={runHref(props.run) ? "a" : "button"}
      href={runHref(props.run)}
      type={runHref(props.run) ? undefined : "button"}
      role="listitem"
      data-slot="agents-activity-row"
      disabled={runHref(props.run) ? undefined : !openable(props.run)}
      onClick={() => !runHref(props.run) && props.open(props.run)}
    >
      <RunMark state={props.run.state} reason={props.run.reason} />
      <span data-slot="agents-activity-name">
        <span>{routine()?.definition.name ?? props.run.title}</span>
        <small>{ctx.t("agents.run.line", { state: ctx.t(stateKey(props.run)), detail: detail() })}</small>
      </span>
      <WhereBadge routine={routine()} capabilities={capabilities()} />
      <span data-slot="agents-meta">{runWhen(ctx.locale.locale(), props.run)}</span>
      <Unread show={props.run.unread} />
    </Dynamic>
  )
}
