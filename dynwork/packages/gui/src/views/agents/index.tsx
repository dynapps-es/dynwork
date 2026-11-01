import { usePlugin } from "@opencode/plugin/gui"
import { ViewShell } from "../shell"

// Placeholder until phase 02 fills the Agents view.
export default function AgentsView() {
  const ctx = usePlugin()

  return (
    <ViewShell view="agents" title={ctx.t("agents.title")}>
      <p data-slot="view-placeholder">{ctx.t("agents.placeholder")}</p>
    </ViewShell>
  )
}
