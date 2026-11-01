import { usePlugin } from "@opencode/plugin/gui"
import { builtinContext } from "@opencode/plugin/gui/builtin"
import { Button } from "@opencode/ui/button"
import { createSignal } from "solid-js"
import { RoutineDetail } from "./detail"
import { RoutineList } from "./list"
import { NewRoutine } from "./new-routine"
import { createRoutines, pickSelected } from "./store"
import { createViewLayout, ViewShell } from "../shell"
import "./routines.css"

/** The Routines view: what runs on this Mac on a schedule. Demo data in memory; nothing is fetched. */
export default function RoutinesView() {
  const ctx = usePlugin()
  const layout = createViewLayout()
  const routines = createRoutines()
  const [picked, setPicked] = createSignal<string>()
  const selected = () =>
    routines.list().find(
      (routine) =>
        routine.id ===
        pickSelected(
          picked(),
          routines.list().map((item) => item.id),
          layout() === "wide",
        ),
    )

  const remove = async (id: string, name: string) => {
    const confirmed = await ctx.dialogs.confirm({
      title: ctx.t("routines.remove.title", { name }),
      description: ctx.t("routines.remove.description"),
      confirm: ctx.t("routines.detail.remove"),
      danger: true,
    })
    if (confirmed) routines.remove(id)
  }

  return (
    <ViewShell
      view="routines"
      title={ctx.t("routines.title")}
      badge={ctx.t("routines.badge")}
      description={ctx.t("routines.description")}
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
      nav={{
        groups: [
          {
            label: ctx.t("routines.nav.farm"),
            items: [{ id: "agents", label: ctx.t("routines.nav.agents"), icon: "mcp", count: 6 }],
          },
          {
            label: ctx.t("routines.nav.mac"),
            items: [
              { id: "routines", label: ctx.t("routines.nav.routines"), icon: "task", count: routines.enabledCount() },
            ],
          },
        ],
        selected: "routines",
        select: (id) => builtinContext(ctx).layout.page(id),
        footer: <span>{ctx.t("routines.nav.status")}</span>,
      }}
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
