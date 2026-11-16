import { usePlugin } from "@opencode/plugin/gui"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { Show } from "solid-js"
import { duration, money, reasonText, runWhen } from "./format"
import type { AgentsModel, Viewer } from "./model"
import { Tag } from "./parts"
import { isLive, runTone } from "./routine"

/**
 * A remote run, read only, in the view's drawer: its state, cost and turns, the result in Markdown, the last lines of
 * its log, and Continue where the backend resumes sessions. It reads `transcript(run)`; it never writes to the run.
 */
export function RunViewer(props: { viewer: Viewer; model: AgentsModel }) {
  const ctx = usePlugin()
  const run = () => props.viewer.run
  const routine = () => props.model.routineOf(run())
  const capabilities = () => props.model.capabilities(run().ref.backend)
  const facts = () => {
    const cost = props.viewer.transcript?.usage?.cost ?? run().cost
    const turns = props.viewer.transcript?.usage?.turns
    return [
      duration(ctx.t, run(), Date.now()),
      cost ? money(ctx.locale.locale(), cost) : undefined,
      turns === undefined ? undefined : ctx.t("agents.viewer.turns", { turns }),
    ]
      .filter(Boolean)
      .join(" · ")
  }
  const save = () => {
    const log = props.viewer.transcript?.log
    if (!log) return
    void ctx.system.save({ name: `${run().ref.id}.log`, content: log })
  }

  return (
    <div data-slot="agents-viewer">
      <div data-slot="agents-viewer-head">
        <Tag>{ctx.t("agents.viewer.readOnly")}</Tag>
      </div>
      <nav data-slot="agents-crumbs">
        <span>{routine()?.definition.name ?? capabilities()?.label}</span>
        <Icon name="chevron-right" size="small" />
        <span data-slot="agents-crumb-current">
          {ctx.t("agents.viewer.title", { when: runWhen(ctx.locale.locale(), run()) })}
        </span>
      </nav>
      <div data-slot="agents-detail-chips">
        <Tag tone={runTone(run().state)}>
          {ctx.t(`agents.run.${run().state}`)}
          <Show when={run().reason}>{(reason) => ` · ${reasonText(ctx.t, reason())}`}</Show>
        </Tag>
        <Show when={facts()}>{(text) => <span>{text()}</span>}</Show>
      </div>
      <Show when={!props.viewer.loading} fallback={<p data-slot="agents-empty">{ctx.t("agents.viewer.loading")}</p>}>
        <Show when={props.viewer.failure}>
          {(failure) => (
            <div data-slot="agents-notice" data-tone="danger" role="alert">
              <Icon name="circle-exclamation" size="small" />
              <span>{failure().message}</span>
            </div>
          )}
        </Show>
        <Show
          when={props.viewer.transcript?.result}
          fallback={
            <Show when={!props.viewer.failure}>
              <div data-slot="agents-notice" data-tone="info">
                <Icon name="info" size="small" />
                <span>{ctx.t(isLive(run()) ? "agents.viewer.pending" : "agents.viewer.none")}</span>
              </div>
            </Show>
          }
        >
          {(result) => (
            <section data-slot="agents-viewer-result">
              <h2 data-slot="agents-section-title">{ctx.t("agents.viewer.result")}</h2>
              <ctx.ui.Markdown text={result()} />
            </section>
          )}
        </Show>
        <Show when={props.viewer.transcript?.log}>
          {(log) => (
            <section data-slot="agents-viewer-log">
              <div data-slot="agents-viewer-log-head">
                <h2 data-slot="agents-section-title">
                  {ctx.t("agents.viewer.log")} <span data-slot="agents-hint">{ctx.t("agents.viewer.logHint")}</span>
                </h2>
                {/* JESÚS: this saves the tail the transcript carries. The farm's full log is a signed URL from
                    `GET /tasks/{id}/logs`, valid ~5 min: add it to `Transcript` (or a `log(run)` method) and open it
                    with `ctx.system.openExternal` on click, so the URL is fresh. */}
                <Button variant="ghost" size="small" icon="download" onClick={save}>
                  {ctx.t("agents.viewer.save")}
                </Button>
              </div>
              <pre data-slot="agents-log" tabIndex={0}>
                {log()}
              </pre>
            </section>
          )}
        </Show>
      </Show>
      <Show when={capabilities()?.actions.reply === "resume"}>
        <div data-slot="agents-viewer-foot">
          <span data-slot="agents-hint">{ctx.t("agents.viewer.continueHint")}</span>
          {/* JESÚS: Continue is the farm's `Capabilities.actions.reply` `resume`: a farm task with `session_ref` of
              this run (`resumable`), which comes back as a new `Run` of the routine. The contract has no method for
              it yet: add one (for example `reply({ backend, run, text })`, as phase 04 does for local runs) and call
              it here. */}
          <Button variant="contrast" icon="outline-video" disabled title={ctx.t("agents.reason.soon")}>
            {ctx.t("agents.viewer.continue")}
          </Button>
        </div>
      </Show>
    </div>
  )
}
