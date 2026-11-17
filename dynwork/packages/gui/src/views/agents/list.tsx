import { usePlugin } from "@opencode/plugin/gui"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { SegmentedControl, SegmentedControlItem } from "@opencode/ui/segmented-control"
import { Tabs } from "@opencode/ui/tabs"
import { TextInput } from "@opencode/ui/text-input"
import { For, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import type { Routine, Run } from "../../routines/contract"
import { device } from "../device"
import { duration, instructionsText, reasonText, runWhen, scheduleText } from "./format"
import { runHref } from "../runs/model"
import { tabs, type AgentsModel } from "./model"
import { openable, routineStatus, stateKey, statuses, waiting, wheres } from "./routine"
import { RunMark, Tag, Unread, WhereBadge } from "./parts"

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
            <For each={wheres}>
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
          {ctx.t(model.routines().length === 0 ? "agents.list.empty" : "agents.list.none", { device: device(ctx).inline })}
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

/** Templates: published by Governance; until there are any, what they will be. */
export function Templates() {
  const ctx = usePlugin()

  // The contract has no templates yet: they come with the Governance sync of routines (Q2 of the plan).
  return <p data-slot="agents-empty">{ctx.t("agents.templates.empty")}</p>
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
      <For each={model.activityPage().failures}>{(failure) => <p data-slot="agents-error">{failure.message}</p>}</For>
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
