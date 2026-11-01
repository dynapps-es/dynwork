import { usePlugin } from "@opencode/plugin/gui"
import { Loader } from "@opencode/ui/loader"
import { For, Show } from "solid-js"
import { filters, statusTone, type AgentsModel } from "./model"
import type { AgentStatus, RunStatus } from "./demo"

/** A spinner while it runs, else a dot in the status's tone. */
export function StatusMark(props: { status: AgentStatus | RunStatus; label: string }) {
  return (
    <span data-slot="agents-state" title={props.label}>
      <Show when={props.status !== "running"} fallback={<Loader width={14} height={14} data-slot="agents-spinner" />}>
        <span data-slot="agents-dot" data-tone={statusTone(props.status)} />
      </Show>
    </span>
  )
}

/** All / Running / Idle / Failed, each with its count. */
export function SegmentedFilters(props: { model: AgentsModel }) {
  const ctx = usePlugin()

  return (
    <div data-slot="agents-filters" role="radiogroup" aria-label={ctx.t("agents.filter.label")}>
      <For each={filters}>
        {(filter) => (
          <button
            type="button"
            role="radio"
            data-slot="agents-filter"
            aria-checked={props.model.state.filter === filter}
            data-state={props.model.state.filter === filter ? "pressed" : undefined}
            onClick={() => props.model.filter(filter)}
          >
            {ctx.t(`agents.filter.${filter}`)}
            <span data-slot="agents-count">{props.model.count(filter)}</span>
          </button>
        )}
      </For>
    </div>
  )
}
