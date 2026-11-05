import { usePlugin } from "@opencode/plugin/gui"
import { SegmentedFilters, StatusMark } from "./parts"
import { For, Show } from "solid-js"
import { instance } from "./demo"
import { triggerKey, type AgentsModel } from "./model"

/** The filters and the table of agents. The row `current` is the one the detail pane shows. */
export function AgentList(props: { model: AgentsModel; current?: string }) {
  const ctx = usePlugin()

  return (
    <>
      <SegmentedFilters model={props.model} />
      <div data-slot="agents-list" role="listbox" aria-label={ctx.t("agents.list.label")}>
        <div data-slot="agents-head" data-row>
          <span />
          <span>{ctx.t("agents.list.agent")}</span>
          <span data-slot="agents-instance">{ctx.t("agents.list.instance")}</span>
          <span>{ctx.t("agents.list.lastRun")}</span>
        </div>
        <For each={props.model.visible()} fallback={<p data-slot="agents-empty">{ctx.t("agents.list.empty")}</p>}>
          {(agent) => (
            <button
              type="button"
              role="option"
              data-slot="agents-row"
              data-row
              data-state={props.current === agent.id ? "pressed" : undefined}
              aria-selected={props.current === agent.id}
              onClick={() => props.model.select(agent.id)}
            >
              <StatusMark status={agent.status} label={ctx.t(`agents.status.${agent.status}`)} />
              <span data-slot="agents-name">
                <span data-slot="agents-title">
                  <span>{agent.name}</span>
                  <span data-slot="agents-slug">{agent.slug}</span>
                </span>
                <span data-slot="agents-task">
                  <Show when={agent.status === "failed"}>
                    <span data-tone="danger">{agent.failure}. </span>
                  </Show>
                  <Show when={agent.status === "queued"}>{ctx.t("agents.queued.hint")} </Show>
                  {agent.task}
                </span>
              </span>
              <span data-slot="agents-instance" data-meta>
                {instance}
                <span data-faint>{ctx.t(triggerKey(agent))}</span>
              </span>
              <span data-meta>
                {ctx.t(`agents.status.${agent.status}`)}
                <span data-faint>{agent.when}</span>
              </span>
            </button>
          )}
        </For>
      </div>
    </>
  )
}
