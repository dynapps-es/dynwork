import { usePlugin } from "@opencode/plugin/gui"
import { Button } from "@opencode/ui/button"
import { createSignal } from "solid-js"
import { RoutineDetail } from "./detail"
import { RoutineList } from "./list"
import { NewRoutine } from "./new-routine"
import { createRoutines } from "./store"
import { demoAgents } from "../agents/demo"
import { device } from "../device"
import { ViewShell } from "../shell"
import { workNav } from "../work"
import "./routines.css"

/** The Routines view: what runs on this computer on a schedule. Demo data in memory; nothing is fetched. */
export default function RoutinesView() {
  const ctx = usePlugin()
  const here = device(ctx)
  const routines = createRoutines()
  const [picked, setPicked] = createSignal<string>()
  // A routine removed while open closes the pane.
  const selected = () => routines.list().find((routine) => routine.id === picked())

  const remove = async (id: string, name: string) => {
    const confirmed = await ctx.dialogs.confirm({
      title: ctx.t("routines.remove.title", { name }),
      description: ctx.t("routines.remove.description", { device: here.inline }),
      confirm: ctx.t("routines.detail.remove"),
      danger: true,
    })
    if (confirmed) routines.remove(id)
  }

  return (
    <ViewShell
      view="routines"
      title={ctx.t("routines.title")}
      badge={here.label}
      description={ctx.t("routines.description", { device: here.inline })}
      actions={
        <Button
          variant="contrast"
          icon="plus"
          onClick={() =>
            ctx.dialogs.open((dialog) => (
              <NewRoutine add={(draft) => setPicked(routines.add(draft))} close={dialog.close} />
            ))
          }
        >
          {ctx.t("routines.new")}
        </Button>
      }
      nav={workNav(ctx, {
        selected: "routines",
        agents: demoAgents().length,
        routines: routines.enabledCount(),
        footer: <span>{ctx.t("routines.nav.status")}</span>,
      })}
      detail={
        selected() ? (
          <RoutineDetail
            routine={selected()!}
            run={() => routines.run(selected()!.id)}
            toggle={() => routines.toggle(selected()!.id)}
            remove={() => remove(selected()!.id, selected()!.name)}
          />
        ) : undefined
      }
      detailTitle={selected()?.name}
      onCloseDetail={() => setPicked(undefined)}
    >
      <div data-slot="routines-service">
        <div>
          <span data-slot="routines-service-title">{ctx.t("routines.service.title")}</span>
          <span data-slot="routine-tag" data-tone="success">
            {ctx.t("routines.service.running")}
          </span>
        </div>
        <p>{ctx.t("routines.service.description")}</p>
      </div>
      <RoutineList routines={routines.list()} selected={selected()?.id} select={setPicked} toggle={routines.toggle} />
    </ViewShell>
  )
}
