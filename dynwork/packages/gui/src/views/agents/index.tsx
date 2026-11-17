import { usePlugin } from "@opencode/plugin/gui"
import { Button } from "@opencode/ui/button"
import { createEffect, For, lazy, Match, on, onCleanup, Show, Switch } from "solid-js"
import { isServer } from "solid-js/web"
import { RoutinesClient } from "../../routines/client"
import { isFailure, type Routine, type Run } from "../../routines/contract"
import { sessionHref } from "../runs/model"
import { device } from "../device"
import { ViewShell } from "../shell"
import { RoutineDetail } from "./detail"
import { backendLine, runWhen } from "./format"
import { RoutineForm } from "./editor"
import { clearFocus, focused } from "./focus"
import { createFormModel, systemZone } from "./form"
import { Activity, RoutineCards, Templates, Toolbar } from "./list"
import { createAgentsModel } from "./model"
import type { Where } from "./routine"
import { RunViewer } from "./viewer"
import "./agents.css"

const NewRoutineMenu = lazy(() => import("./new-menu"))

/**
 * The Agents view: every routine, local and remote, in one list over the `dynwork.routines` Ipc. The view never reaches
 * a backend: it reads the Ipc's state and calls its methods. `where` opens it filtered, as the `routines` page does.
 */
export default function AgentsView(props: { where?: Where }) {
  const ctx = usePlugin()
  const live = () => RoutinesClient.connection()
  const client = () => {
    const current = live()
    return current?.status === "active" ? current.value : undefined
  }
  const model = createAgentsModel({ client, where: props.where })
  const selected = () => model.selected()

  // While the view is on screen it watches, so backends that only push while watched (the farm's poll) keep it live.
  createEffect(() => {
    const current = client()
    if (!current) return
    const watching = new AbortController()
    void current.watch({ signal: watching.signal })
    // A backend may have changed while nothing watched (the local service starting after the app): read them again.
    void current.refresh()
    current.on("run", model.received)
    onCleanup(() => watching.abort())
  })

  // A routine another place asked to show, such as Edit in the Runs panel.
  createEffect(
    on(focused, (ref) => {
      if (!ref) return
      model.select(ref)
      clearFocus()
    }),
  )

  // The loads below read and write the model's store: `on` keeps them from tracking what they write.
  createEffect(
    on([client, () => model.state.selected], ([current, ref]) => {
      if (current && ref) void model.loadHistory(ref)
    }),
  )

  createEffect(
    on([client, () => model.state.tab], ([current, tab]) => {
      if (current && tab === "activity") void model.loadActivity()
    }),
  )

  // The labels the detail shows for the agent, the model and every field filled from a lookup.
  createEffect(
    on(selected, (routine) => {
      if (!routine) return
      const backend = routine.ref.backend
      const lookups = [
        ...(routine.definition.agent ? ["agents"] : []),
        ...(routine.definition.model ? ["models"] : []),
        ...(model.capabilities(backend)?.fields ?? []).flatMap((field) =>
          field.lookup && routine.definition.options[field.key] !== undefined ? [field.lookup] : [],
        ),
      ]
      lookups.forEach((lookup) => void model.loadChoices(backend, lookup))
    }),
  )

  // A `session` run is a link to its conversation (`RunLink`), which the app's router opens in place: this is the rest.
  const open = (run: Run) => {
    if (run.conversation.kind === "external") return ctx.system.openExternal(run.conversation.url)
    void model.open(run)
  }

  // The form edits `routine`, or creates one on the backend of the chip in use (the first backend with "All").
  const form = (routine?: Routine) => {
    const created = createFormModel({
      client,
      backends: model.backends,
      routine,
      backend: model.backends().find((backend) => backend.kind === model.state.where)?.backend,
      zone: systemZone(),
      now: Date.now,
    })
    ctx.dialogs.open((dialog) => (
      <RoutineForm form={created} agents={model} close={dialog.close} onSaved={model.select} />
    ))
  }

  // "Create with Dynwork": main opens a conversation in the user's home with the setup prompt, and this window routes
  // to it as a link does (`views/runs/open.ts`).
  const chat = async () => {
    const live = RoutinesClient.chatConnection()
    const started = live?.status === "active" ? await live.value.start().catch(() => undefined) : undefined
    if (!started || isFailure(started)) return model.fail(started ?? undefined)
    const link = document.createElement("a")
    link.href = sessionHref(started.server, started.session)
    link.hidden = true
    document.body.append(link)
    link.click()
    link.remove()
  }

  const remove = async (routine: Routine) => {
    const confirmed = await ctx.dialogs.confirm({
      title: ctx.t("agents.remove.title", { name: routine.definition.name }),
      description: ctx.t("agents.remove.description"),
      confirm: ctx.t("agents.detail.remove"),
      danger: true,
    })
    if (confirmed) await model.remove(routine)
  }

  return (
    <ViewShell
      view="agents"
      title={ctx.t("agents.title")}
      description={ctx.t("agents.description", { device: device(ctx).inline })}
      demo={false}
      header={!selected()}
      status={
        // JESÚS: the farm's part of this line is your `capabilities()`: `label`, `status` with `detail` when it cannot
        // serve, and `quota` (the tenant's schedules, `shared: true`).
        <For each={model.backends()}>
          {(backend) => (
            <span data-slot="agents-status">
              <span data-slot="agents-dot" data-tone={backend.status === "ready" ? "success" : "warning"} />
              {backendLine(ctx.t, backend)}
            </span>
          )}
        </For>
      }
      actions={
        // Kobalte's menu runs browser-only code as soon as it loads, so it is loaded on the client only: the view tests
        // render with Solid's server build.
        <Show when={!isServer}>
          <NewRoutineMenu
            label={ctx.t("agents.new")}
            chat={ctx.t("agents.new.chat")}
            manual={ctx.t("agents.new.manual")}
            disabled={!model.ready() || model.backends().length === 0}
            onChat={() => void chat()}
            onManual={() => form()}
          />
        </Show>
      }
      detail={<Show when={model.state.viewer}>{(viewer) => <RunViewer viewer={viewer()} model={model} />}</Show>}
      detailTitle={
        model.state.viewer
          ? ctx.t("agents.viewer.title", { when: runWhen(ctx.locale.locale(), model.state.viewer.run) })
          : undefined
      }
      onCloseDetail={model.closeViewer}
    >
      <Switch fallback={<p data-slot="agents-empty">{ctx.t("agents.loading")}</p>}>
        <Match when={live()?.status === "inactive"}>
          <p data-slot="agents-empty">{ctx.t("agents.unavailable")}</p>
        </Match>
        <Match when={model.ready() ? selected() : undefined}>
          {(routine) => <RoutineDetail routine={routine()} model={model} open={open} edit={form} remove={remove} />}
        </Match>
        <Match when={model.ready()}>
          <Toolbar model={model} />
          <Show when={model.state.failure}>
            {(failure) => (
              <div data-slot="agents-notice" data-tone="danger" role="alert">
                <span>{failure().message}</span>
                <Button variant="ghost" size="small" onClick={model.dismiss}>
                  {ctx.t("agents.dismiss")}
                </Button>
              </div>
            )}
          </Show>
          <Switch>
            <Match when={model.state.tab === "mine"}>
              <RoutineCards model={model} />
            </Match>
            <Match when={model.state.tab === "templates"}>
              <Templates />
            </Match>
            <Match when={model.state.tab === "activity"}>
              <Activity model={model} open={open} />
            </Match>
          </Switch>
        </Match>
      </Switch>
    </ViewShell>
  )
}
