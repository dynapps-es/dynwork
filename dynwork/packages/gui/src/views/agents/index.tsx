import { usePlugin } from "@opencode/plugin/gui"
import { Button } from "@opencode/ui/button"
import { Show } from "solid-js"
import { AgentDetail } from "./detail"
import { NewAgentDialog } from "./dialog"
import { AgentList } from "./list"
import { farm, routinesOn } from "./demo"
import { createAgentsModel, startSimulation } from "./model"
import { device } from "../device"
import { ViewShell } from "../shell"
import { workNav } from "../work"
import "./agents.css"

/** The Agents view: the Agent Farm's agents on built-in demo data, kept in memory. */
export default function AgentsView() {
  const ctx = usePlugin()
  const model = createAgentsModel()
  startSimulation(model)

  const current = model.selected
  const add = () => ctx.dialogs.open((dialog) => <NewAgentDialog model={model} close={dialog.close} />)

  return (
    <ViewShell
      view="agents"
      title={ctx.t("agents.title")}
      badge={ctx.t("agents.badge")}
      description={ctx.t("agents.description", { device: device(ctx).inline })}
      actions={
        <Button variant="contrast" icon="plus" onClick={add}>
          {ctx.t("agents.new")}
        </Button>
      }
      nav={workNav(ctx, {
        selected: "agents",
        agents: model.state.agents.length,
        routines: routinesOn,
        footer: (
          <div data-slot="agents-farm-status">
            <span data-slot="agents-connected">
              <span data-slot="agents-dot" data-tone="success" />
              {ctx.t("agents.nav.connected")}
            </span>
            <span>{ctx.t("agents.nav.account", { host: farm.host, user: farm.user })}</span>
          </div>
        ),
      })}
      detail={<Show when={current()}>{(agent) => <AgentDetail agent={agent()} model={model} add={add} />}</Show>}
      detailTitle={current()?.name}
      onCloseDetail={model.deselect}
    >
      <AgentList model={model} current={current()?.id} />
    </ViewShell>
  )
}
