import { usePlugin } from "@opencode/plugin/gui"
import { Button } from "@opencode/ui/button"
import { For, Show } from "solid-js"
import { scheduleText } from "./schedule"
import { isRunning, summary, type Routine } from "./store"

/** One routine: what it runs, where and when, its run history, and the actions Run now, Pause and Remove. */
export function RoutineDetail(props: { routine: Routine; run(): void; toggle(): void; remove(): void }) {
  const ctx = usePlugin()
  const running = () => isRunning(props.routine)

  return (
    <div data-component="dynwork-routine-detail">
      <div data-slot="routine-head">
        <div data-slot="routine-title-row">
          <h2 data-slot="routine-title">{props.routine.name}</h2>
          <span data-slot="routine-tag" data-tone={props.routine.enabled ? "success" : undefined}>
            {ctx.t(props.routine.enabled ? "routines.detail.on" : "routines.detail.paused")}
          </span>
        </div>
        <span data-slot="routines-sub">{ctx.t("routines.detail.runsOn")}</span>
      </div>
      <div data-slot="routine-actions">
        <Button variant="neutral" icon="outline-video" disabled={running()} onClick={() => props.run()}>
          {ctx.t(running() ? "routines.detail.running" : "routines.detail.run")}
        </Button>
        <Button variant="neutral" onClick={() => props.toggle()}>
          {ctx.t(props.routine.enabled ? "routines.detail.pause" : "routines.detail.resume")}
        </Button>
        <Button variant="ghost-danger" icon="outline-trash" onClick={() => props.remove()}>
          {ctx.t("routines.detail.remove")}
        </Button>
      </div>
      <dl data-slot="routine-facts">
        <dt>{ctx.t("routines.detail.runs")}</dt>
        <dd>{summary(props.routine)}</dd>
        <dt>{ctx.t("routines.detail.prompt")}</dt>
        <dd>{props.routine.prompt}</dd>
        <dt>{ctx.t("routines.detail.folder")}</dt>
        <dd>
          <Show
            when={props.routine.folder}
            fallback={<span data-slot="routines-sub">{ctx.t("routines.detail.noFolder")}</span>}
          >
            {(folder) => <span data-slot="routine-path">{folder()}</span>}
          </Show>
        </dd>
        <dt>{ctx.t("routines.detail.agent")}</dt>
        <dd>{props.routine.agent}</dd>
        <dt>{ctx.t("routines.detail.model")}</dt>
        <dd>{props.routine.model}</dd>
        <dt>{ctx.t("routines.detail.schedule")}</dt>
        <dd>
          {scheduleText(props.routine.schedule)}
          <br />
          <span data-slot="routines-sub">
            {props.routine.enabled
              ? ctx.t("routines.detail.nextRun", { when: props.routine.next })
              : ctx.t("routines.detail.turnedOff")}
          </span>
        </dd>
      </dl>
      <h3 data-slot="routine-section">{ctx.t("routines.detail.history")}</h3>
      <Show
        when={props.routine.history.length > 0}
        fallback={<p data-slot="routines-sub">{ctx.t("routines.detail.noHistory")}</p>}
      >
        <ul data-slot="routine-runs">
          <For each={props.routine.history}>
            {(run) => (
              <li data-slot="routine-run">
                <span
                  data-slot="routine-run-mark"
                  data-state={run.state}
                  aria-label={ctx.t(`routines.state.${run.state}`)}
                />
                <span data-slot="routine-run-text">
                  <span>{run.when}</span>
                  <span data-slot="routines-sub">{run.note}</span>
                </span>
                <Show when={run.state === "succeeded" || run.state === "failed"}>
                  <span data-slot="routine-run-link">{ctx.t("routines.detail.session")}</span>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  )
}
