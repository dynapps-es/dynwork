import { usePlugin } from "@opencode/plugin/gui"
import { builtinContext } from "@opencode/plugin/gui/builtin"
import { Button } from "@opencode/ui/button"
import { Show } from "solid-js"
import { AgentDetail } from "./detail"
import { NewAgentDialog } from "./dialog"
import { AgentList } from "./list"
import { farm, routinesOn } from "./demo"
import { createAgentsModel, detailAgent, startSimulation } from "./model"
import { createViewLayout, ViewShell } from "../shell"
import "./agents.css"

/** The Agents view: the Agent Farm's agents on built-in demo data, kept in memory. */
export default function AgentsView() {
  const ctx = usePlugin()
  const host = builtinContext(ctx)
  const layout = createViewLayout()
  const model = createAgentsModel()
  startSimulation(model)

  const current = () => detailAgent(layout(), model.selected(), model.visible())
  const add = () => ctx.dialogs.open((dialog) => <NewAgentDialog model={model} close={dialog.close} />)

  return (
    <ViewShell
      view="agents"
      title={ctx.t("agents.title")}
      badge={ctx.t("agents.badge")}
      description={ctx.t("agents.description")}
      actions={
        <Button variant="contrast" icon="plus" onClick={add}>
          {ctx.t("agents.new")}
        </Button>
      }
      nav={{
        groups: [
          {
            label: ctx.t("agents.nav.farm"),
            items: [
              { id: "agents", label: ctx.t("agents.nav.agents"), icon: "cube", count: model.state.agents.length },
            ],
          },
          {
            label: ctx.t("agents.nav.mac"),
            items: [{ id: "routines", label: ctx.t("agents.nav.routines"), icon: "refresh", count: routinesOn }],
          },
        ],
        selected: "agents",
        select: (id) => {
          if (id !== "agents") host.layout.page(id)
        },
        footer: (
          <div data-slot="agents-farm-status">
            <span data-slot="agents-connected">
              <span data-slot="agents-dot" data-tone="success" />
              {ctx.t("agents.nav.connected")}
            </span>
            <span>{ctx.t("agents.nav.account", { host: farm.host, user: farm.user })}</span>
          </div>
        ),
      }}
      detail={<Show when={current()}>{(agent) => <AgentDetail agent={agent()} model={model} add={add} />}</Show>}
      detailTitle={current()?.name}
      onCloseDetail={model.deselect}
    >
      <AgentList model={model} current={current()?.id} />
    </ViewShell>
  )
}
