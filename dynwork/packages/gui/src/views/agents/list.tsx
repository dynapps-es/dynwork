import { usePlugin } from "@opencode/plugin/gui"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { For, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import type { Routine, Run } from "../../routines/contract"
import { duration, instructionsText, runWhen, scheduleText } from "./format"
import { runHref } from "../runs/model"
import { tabs, type AgentsModel } from "./model"
import { openable, routineStatus, statuses, wheres } from "./routine"
import { RunMark, Tag, Unread, WhereBadge } from "./parts"

/** The bar over the list: the tabs, the Local and Remote chips with their counts, the status filter and the search. */
export function Toolbar(props: { model: AgentsModel }) {
  const ctx = usePlugin()
  const model = props.model

  return (
    <div data-slot="agents-toolbar">
      <div data-slot="agents-tabs" role="tablist" aria-label={ctx.t("agents.tab.label")}>
        <For each={tabs}>
          {(tab) => (
            <button
              type="button"
              role="tab"
              data-slot="agents-tab"
              aria-selected={model.state.tab === tab}
              data-state={model.state.tab === tab ? "pressed" : undefined}
              onClick={() => model.setTab(tab)}
            >
              {ctx.t(`agents.tab.${tab}`)}
            </button>
          )}
        </For>
      </div>
      <Show when={model.state.tab !== "templates"}>
        <div data-slot="agents-chips" role="radiogroup" aria-label={ctx.t("agents.where.label")}>
          <For each={wheres}>
            {(where) => (
              <button
                type="button"
                role="radio"
                data-slot="agents-chip"
                aria-checked={model.state.where === where}
                data-state={model.state.where === where ? "pressed" : undefined}
                onClick={() => model.setWhere(where)}
              >
                <Show when={where !== "all"}>
                  <Icon name={where === "remote" ? "cloud-upload" : "monitor"} size="small" />
                </Show>
                {ctx.t(`agents.where.${where}`)}
                <Show when={model.state.tab === "mine"}>
                  <span data-slot="agents-count">{model.count(where)}</span>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={model.state.tab === "mine"}>
        <div data-slot="agents-search-row">
          <label data-slot="agents-select">
            <span data-slot="agents-select-key">{ctx.t("agents.filter.status")}</span>
            <select
              value={model.state.status}
              onChange={(event) => model.setStatus(event.currentTarget.value as (typeof statuses)[number])}
            >
              <For each={statuses}>
                {(status) => (
                  <option value={status} selected={model.state.status === status}>
                    {ctx.t(`agents.filter.${status}`)}
                  </option>
                )}
              </For>
            </select>
          </label>
          <label data-slot="agents-search">
            <Icon name="magnifying-glass" size="small" />
            <input
              type="search"
              value={model.state.search}
              placeholder={ctx.t("agents.search")}
              aria-label={ctx.t("agents.search")}
              onInput={(event) => model.setSearch(event.currentTarget.value)}
            />
          </label>
        </div>
      </Show>
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
          {ctx.t(model.routines().length === 0 ? "agents.list.empty" : "agents.list.none")}
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
        <span data-slot="agents-sep" aria-hidden="true">
          ·
        </span>
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
    props.run.summary ?? duration(ctx.t, props.run, Date.now()) ?? props.run.reason ?? ctx.t("agents.run.outside")

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
      <RunMark state={props.run.state} />
      <span data-slot="agents-activity-name">
        <span>{routine()?.definition.name ?? props.run.title}</span>
        <small>{ctx.t("agents.run.line", { state: ctx.t(`agents.run.${props.run.state}`), detail: detail() })}</small>
      </span>
      <WhereBadge routine={routine()} capabilities={capabilities()} />
      <span data-slot="agents-meta">{runWhen(ctx.locale.locale(), props.run)}</span>
      <Unread show={props.run.unread} />
    </Dynamic>
  )
}
