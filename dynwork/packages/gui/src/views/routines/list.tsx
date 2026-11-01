import { usePlugin } from "@opencode/plugin/gui"
import { Switch } from "@opencode/ui/switch"
import { For, Show } from "solid-js"
import { scheduleText } from "./schedule"
import { lastState, summary, type Routine } from "./store"

/** The routines as a table: toggle, name and what it runs, schedule and next run, last result. */
export function RoutineList(props: {
  routines: readonly Routine[]
  selected?: string
  select(id: string): void
  toggle(id: string): void
}) {
  const ctx = usePlugin()

  return (
    <div data-slot="routines-list" role="listbox" aria-label={ctx.t("routines.list.label")}>
      <div data-slot="routines-head" data-part="row">
        <span>{ctx.t("routines.list.on")}</span>
        <span>{ctx.t("routines.list.routine")}</span>
        <span>{ctx.t("routines.list.schedule")}</span>
        <span data-slot="routines-last-col">{ctx.t("routines.list.last")}</span>
      </div>
      <For each={props.routines}>
        {(routine) => (
          <div
            role="option"
            tabIndex={0}
            data-slot="routines-row"
            data-part="row"
            aria-selected={props.selected === routine.id}
            data-selected={props.selected === routine.id ? "" : undefined}
            onClick={() => props.select(routine.id)}
            onKeyDown={(event) => {
              if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
                event.preventDefault()
                props.select(routine.id)
              }
            }}
          >
            {/* The toggle is its own control: clicking it must not select the row. */}
            <span data-slot="routines-toggle" onClick={(event) => event.stopPropagation()}>
              <Switch hideLabel checked={routine.enabled} onChange={() => props.toggle(routine.id)}>
                {ctx.t(routine.enabled ? "routines.toggle.pause" : "routines.toggle.resume", { name: routine.name })}
              </Switch>
            </span>
            <span data-slot="routines-name">
              <span data-slot="routines-title">{routine.name}</span>
              <span data-slot="routines-sub">{summary(routine)}</span>
            </span>
            <span data-slot="routines-when">
              <span>{scheduleText(routine.schedule)}</span>
              <span data-slot="routines-sub">
                {routine.enabled ? ctx.t("routines.list.next", { when: routine.next }) : ctx.t("routines.list.off")}
              </span>
            </span>
            <span data-slot="routines-last-col">
              <Show
                when={lastState(routine)}
                fallback={<span data-slot="routines-sub">{ctx.t("routines.list.never")}</span>}
              >
                {(state) => (
                  <>
                    <span data-slot="routines-state" data-state={state()}>
                      {ctx.t(`routines.state.${state()}`)}
                    </span>
                    <span data-slot="routines-sub">{routine.history[0]?.when}</span>
                  </>
                )}
              </Show>
            </span>
          </div>
        )}
      </For>
    </div>
  )
}
