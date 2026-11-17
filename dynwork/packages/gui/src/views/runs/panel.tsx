import { usePlugin, type MountedSession } from "@opencode/plugin/gui"
import { builtinContext } from "@opencode/plugin/gui/builtin"
import { Button } from "@opencode/ui/button"
import { createEffect, For, on, onCleanup, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import { RoutinesClient } from "../../routines/client"
import type { Routine, Run } from "../../routines/contract"
import { focus } from "../agents/focus"
import { duration, fromMain, scheduleText, when } from "../agents/format"
import { refKey } from "../agents/model"
import { stateKey } from "../agents/routine"
import { RunMark, Unread } from "../agents/parts"
import { createRunsModel, days, routineOf, runHref, type RunsModel } from "./model"
import "./runs.css"

/**
 * The Runs panel, on a routine's conversation (its anchor and each of its runs): the routine in a line, Run now, Pause
 * and Edit, and its runs by day with their state and an unread dot. A run is a link the app's router opens in place,
 * inside the anchor's tab, where the app's own composer continues it.
 */
export function RunsPanel(props: { session: MountedSession }) {
  const ctx = usePlugin()
  const live = () => RoutinesClient.connection()
  const client = () => {
    const current = live()
    return current?.status === "active" ? current.value : undefined
  }
  const routine = () => {
    const info = props.session.server.data.session.get(props.session.id)
    return routineOf({
      session: props.session.id,
      metadata: info?.metadata,
      parent: info?.parentID,
      routines: client()?.state()?.routines ?? [],
    })
  }
  const model = createRunsModel({ client, routine, routed: () => props.session.id })

  // While the panel is on screen it watches, so runs move as they happen.
  createEffect(() => {
    const current = client()
    if (!current) return
    const watching = new AbortController()
    void current.watch({ signal: watching.signal })
    current.on("run", model.received)
    onCleanup(() => watching.abort())
  })

  createEffect(
    on([client, () => routine() && refKey(routine()!.ref)], ([current, key]) => {
      if (current && key) void model.load()
    }),
  )

  // A finished run that is on screen has been read.
  createEffect(
    on(
      () => model.current()?.unread,
      (unread) => {
        if (unread) void model.seen()
      },
    ),
  )

  return (
    <div data-component="dynwork-runs">
      <Show when={client()} fallback={<p data-slot="runs-empty">{ctx.t("runs.unavailable")}</p>}>
        <Show when={routine()}>{(current) => <Head routine={current()} model={model} />}</Show>
        <Show when={model.state.failure}>
          {(failure) => (
            <div data-slot="runs-notice" role="alert">
              <span>{fromMain(ctx.t, failure().message)}</span>
              <Button variant="ghost" size="small" onClick={model.dismiss}>
                {ctx.t("runs.dismiss")}
              </Button>
            </div>
          )}
        </Show>
        <div data-slot="runs-list" role="list" aria-label={ctx.t("runs.title")}>
          <Show
            when={model.runs().length > 0}
            fallback={<p data-slot="runs-empty">{ctx.t(model.state.loading ? "runs.loading" : "runs.empty")}</p>}
          >
            <For each={days(model.runs(), Date.now(), routine()?.definition.schedule?.timezone)}>
              {(group) => (
                <>
                  <h3 data-slot="runs-day">{dayName(ctx.t, ctx.locale.locale(), group.day)}</h3>
                  <For each={group.runs}>
                    {(run) => <RunRow run={run} current={model.current()?.ref.id === run.ref.id} />}
                  </For>
                </>
              )}
            </For>
            <Show when={model.state.next !== undefined}>
              <Button variant="ghost" size="small" disabled={model.state.loading} onClick={() => void model.load(true)}>
                {ctx.t("runs.more")}
              </Button>
            </Show>
          </Show>
        </div>
      </Show>
    </div>
  )
}

// The routine in a line: where and when it runs, Run now, Pause or Resume, and Edit, which opens its detail in the
// Agents view, where the form is.
function Head(props: { routine: Routine; model: RunsModel }) {
  const ctx = usePlugin()
  const zone = () => props.routine.definition.schedule?.timezone
  const edit = () => {
    focus(props.routine.ref)
    builtinContext(ctx).layout.page("agents")
  }

  return (
    <header data-slot="runs-head">
      <h2>{props.routine.definition.name}</h2>
      <p>
        {[
          props.routine.owner?.unclaimed
            ? ctx.t("agents.detail.unclaimed")
            : ctx.t("runs.where", { device: props.routine.owner?.label ?? "" }),
          scheduleText(ctx.t, props.routine.definition.schedule),
        ].join(" · ")}
      </p>
      <Show when={props.routine.next}>
        {(next) => <p>{ctx.t("runs.next", { when: when(ctx.locale.locale(), next(), zone()) })}</p>}
      </Show>
      <div data-slot="runs-actions">
        <Button
          variant="neutral"
          icon="outline-video"
          disabled={props.model.busy("start")}
          onClick={() => void props.model.start()}
        >
          {ctx.t("runs.start")}
        </Button>
        <Button variant="ghost" disabled={props.model.busy("toggle")} onClick={() => void props.model.toggle()}>
          {ctx.t(props.routine.state === "paused" ? "runs.resume" : "runs.pause")}
        </Button>
        <Button variant="ghost" icon="edit" onClick={edit}>
          {ctx.t("runs.edit")}
        </Button>
      </div>
    </header>
  )
}

function RunRow(props: { run: Run; current: boolean }) {
  const ctx = usePlugin()
  const at = () => props.run.started ?? props.run.due ?? props.run.finished

  return (
    <Dynamic
      component={runHref(props.run) ? "a" : "div"}
      href={runHref(props.run)}
      role="listitem"
      data-slot="runs-run"
      aria-current={props.current ? "page" : undefined}
    >
      <RunMark state={props.run.state} reason={props.run.reason} />
      <span data-slot="runs-run-text">
        <span>{at() === undefined ? props.run.title : time(ctx.locale.locale(), at()!)}</span>
        <small>
          {[ctx.t(stateKey(props.run)), duration(ctx.t, props.run, Date.now())].filter(Boolean).join(" · ")}
        </small>
      </span>
      <Unread show={props.run.unread} />
    </Dynamic>
  )
}

function time(locale: string, at: number) {
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(at)
}

function dayName(t: (key: string) => string, locale: string, day: string) {
  if (day === "today") return t("runs.today")
  if (day === "yesterday") return t("runs.yesterday")
  return new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(
    new Date(`${day}T12:00:00Z`),
  )
}
