import { usePlugin } from "@opencode/plugin/gui"
import { ViewShell } from "../shell"

// Placeholder until phase 04 fills the Brain view.
export default function BrainView() {
  const ctx = usePlugin()

  return (
    <ViewShell view="brain" title={ctx.t("brain.title")}>
      <p data-slot="view-placeholder">{ctx.t("brain.placeholder")}</p>
    </ViewShell>
  )
}
