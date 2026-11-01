import { usePlugin } from "@opencode/plugin/gui"
import { ViewShell } from "../shell"

// Placeholder until phase 03 fills the Routines view.
export default function RoutinesView() {
  const ctx = usePlugin()

  return (
    <ViewShell view="routines" title={ctx.t("routines.title")}>
      <p data-slot="view-placeholder">{ctx.t("routines.placeholder")}</p>
    </ViewShell>
  )
}
