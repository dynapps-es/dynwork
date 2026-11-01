import { usePlugin } from "@opencode/plugin/gui"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { createEffect, createSignal, For, Show } from "solid-js"
import { StatusMark } from "./parts"
import type { Agent } from "./demo"
import { statusTone, tabs, type AgentsModel } from "./model"

/** The selected agent: title, actions, and the Overview, Logs, Runs and Schedule tabs. */
export function AgentDetail(props: { agent: Agent; model: AgentsModel; add: () => void }) {
  const ctx = usePlugin()
  const [menu, setMenu] = createSignal(false)
  const status = () =>
    props.agent.status === "failed"
      ? ctx.t("agents.failed.reason", { reason: (props.agent.failure ?? "").toLowerCase() })
      : ctx.t(`agents.status.${props.agent.status}`)

  return (
    <div data-slot="agents-detail">
      <div data-slot="agents-detail-head">
        <div data-slot="agents-detail-title">
          <span data-slot="agents-detail-name">{props.agent.name}</span>
          <span data-slot="agents-tag" data-tone={statusTone(props.agent.status)}>
            {status()}
          </span>
        </div>
        <span data-slot="agents-slug">{props.agent.slug}</span>
      </div>
      <div data-slot="agents-actions">
        <Show when={props.agent.status === "running" || props.agent.status === "queued"}>
          <Button
            variant="danger"
            icon={props.agent.status === "running" ? "stop" : "close"}
            onClick={() => props.model.stop(props.agent.id)}
          >
            {props.agent.status === "running" ? ctx.t("agents.action.stop") : ctx.t("agents.action.cancel")}
          </Button>
        </Show>
        <Show when={props.agent.status === "idle" || props.agent.status === "failed"}>
          <Button variant="outline" icon="outline-video" onClick={() => props.model.start(props.agent.id)}>
            {props.agent.status === "failed" ? ctx.t("agents.action.retry") : ctx.t("agents.action.start")}
          </Button>
        </Show>
        <Show when={props.agent.status !== "queued"}>
          <Button variant="outline" icon="outline-console" onClick={() => props.model.tab("logs")}>
            {ctx.t("agents.action.logs")}
          </Button>
        </Show>
        <Show when={props.agent.schedule}>
          {(schedule) => (
            <Show
              when={schedule().state === "paused"}
              fallback={
                <Button variant="outline" onClick={() => props.model.pause(props.agent.id)}>
                  {ctx.t("agents.action.pause")}
                </Button>
              }
            >
              <Button variant="outline" onClick={() => props.model.resume(props.agent.id)}>
                {ctx.t("agents.action.resume")}
              </Button>
            </Show>
          )}
        </Show>
        <div
          data-slot="agents-more"
          onFocusOut={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMenu(false)
          }}
        >
          <Button
            variant="ghost"
            icon="outline-dots"
            aria-label={ctx.t("agents.action.more")}
            onClick={() => setMenu(!menu())}
          />
          <Show when={menu()}>
            <div data-slot="agents-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  void navigator.clipboard?.writeText(props.agent.slug)
                  setMenu(false)
                }}
              >
                <Icon name="copy" />
                {ctx.t("agents.action.copy")}
              </button>
              <button type="button" role="menuitem" onClick={() => props.model.remove(props.agent.id)}>
                <Icon name="trash" />
                {ctx.t("agents.action.remove")}
              </button>
            </div>
          </Show>
        </div>
      </div>
      <div data-slot="agents-tabs" role="tablist" aria-label={ctx.t("agents.tab.label")}>
        <For each={tabs}>
          {(tab) => (
            <button
              type="button"
              role="tab"
              data-slot="agents-tab"
              aria-selected={props.model.state.tab === tab}
              data-state={props.model.state.tab === tab ? "pressed" : undefined}
              onClick={() => props.model.tab(tab)}
            >
              {ctx.t(`agents.tab.${tab}`)}
            </button>
          )}
        </For>
      </div>
      <div data-slot="agents-body" role="tabpanel">
        <Show when={props.model.state.tab === "overview"}>
          <Overview agent={props.agent} />
        </Show>
        <Show when={props.model.state.tab === "logs"}>
          <Logs agent={props.agent} />
        </Show>
        <Show when={props.model.state.tab === "runs"}>
          <Runs agent={props.agent} model={props.model} />
        </Show>
        <Show when={props.model.state.tab === "schedule"}>
          <Schedule agent={props.agent} add={props.add} />
        </Show>
      </div>
    </div>
  )
}

function Overview(props: { agent: Agent }) {
  const ctx = usePlugin()
  const live = () => props.agent.status === "running" || props.agent.status === "queued"

  return (
    <dl data-slot="agents-kv">
      <dt>{live() ? ctx.t("agents.overview.currentTask") : ctx.t("agents.overview.lastTask")}</dt>
      <dd>{props.agent.task}</dd>
      <dt>{ctx.t("agents.overview.repository")}</dt>
      <dd>
        <Show when={props.agent.branch} fallback={<span data-faint>{props.agent.repo}</span>}>
          <span data-mono>{props.agent.repo}</span>
          <br />
          <span data-faint>{ctx.t("agents.overview.branch", { branch: props.agent.branch })}</span>
        </Show>
      </dd>
      <dt>{ctx.t("agents.overview.skills")}</dt>
      <dd>
        {ctx.t("agents.overview.skillsSource")} <span data-faint>{ctx.t("agents.overview.skillsVia")}</span>
      </dd>
      <dt>{ctx.t("agents.overview.plugins")}</dt>
      <dd>{props.agent.plugins}</dd>
      <dt>{ctx.t("agents.overview.access")}</dt>
      <dd>{props.agent.access}</dd>
      <dt>{props.agent.status === "running" ? ctx.t("agents.overview.started") : ctx.t("agents.overview.ran")}</dt>
      <dd>{props.agent.started}</dd>
      <dt>{ctx.t("agents.overview.cost")}</dt>
      <dd>{props.agent.cost}</dd>
    </dl>
  )
}

function Logs(props: { agent: Agent }) {
  const ctx = usePlugin()
  let pane: HTMLPreElement | undefined

  // A running agent keeps writing: follow its last line.
  createEffect(() => {
    void props.agent.log.length
    if (pane) pane.scrollTop = pane.scrollHeight
  })

  return (
    <pre data-slot="agents-log" ref={pane} tabIndex={0}>
      <For each={props.agent.log} fallback={ctx.t("agents.logs.empty")}>
        {(line) => (
          <span data-slot="agents-log-line" data-level={line.level}>
            <span data-slot="agents-log-time">{line.time}</span> {line.text}
            {"\n"}
          </span>
        )}
      </For>
      <Show when={props.agent.status === "running"}>
        <span data-slot="agents-caret" />
      </Show>
    </pre>
  )
}

function Runs(props: { agent: Agent; model: AgentsModel }) {
  const ctx = usePlugin()

  return (
    <div data-slot="agents-runs">
      <For each={props.agent.runs}>
        {(run) => (
          <div data-slot="agents-run">
            <StatusMark status={run.status} label={ctx.t(`agents.status.${run.status}`)} />
            <span data-slot="agents-run-text">
              <span>{run.title}</span>
              <span data-faint>{run.detail}</span>
            </span>
            <button type="button" data-slot="agents-link" onClick={() => props.model.tab("logs")}>
              {ctx.t("agents.runs.logs")}
            </button>
          </div>
        )}
      </For>
    </div>
  )
}

function Schedule(props: { agent: Agent; add: () => void }) {
  const ctx = usePlugin()

  return (
    <Show
      when={props.agent.schedule}
      fallback={
        <div data-slot="agents-notice">
          <Icon name="info" />
          <span>
            {ctx.t("agents.schedule.none")}
            <br />
            <button type="button" data-slot="agents-link" onClick={props.add}>
              {ctx.t("agents.schedule.add")}
            </button>
          </span>
        </div>
      }
    >
      {(schedule) => (
        <dl data-slot="agents-kv">
          <dt>{ctx.t("agents.schedule.repeats")}</dt>
          <dd>
            {schedule().words}
            <br />
            <span data-mono data-faint>
              {schedule().cron}
            </span>{" "}
            <span data-faint>{schedule().tz}</span>
          </dd>
          <dt>{ctx.t("agents.schedule.state")}</dt>
          <dd>
            <span data-slot="agents-tag" data-tone={schedule().state === "paused" ? "warning" : "success"}>
              {schedule().state === "paused" ? ctx.t("agents.schedule.paused") : ctx.t("agents.schedule.active")}
            </span>
          </dd>
          <dt>{ctx.t("agents.schedule.next")}</dt>
          <dd>{schedule().next}</dd>
          <dt>{ctx.t("agents.schedule.runs")}</dt>
          <dd>{schedule().runs}</dd>
          <dt>{ctx.t("agents.schedule.overlap")}</dt>
          <dd>{ctx.t("agents.schedule.overlapValue")}</dd>
        </dl>
      )}
    </Show>
  )
}
