import { usePlugin } from "@opencode/plugin/gui"
import { Show } from "solid-js"
import { AccessPanel } from "./access"
import { spaces } from "./demo"
import { DocumentPage } from "./document"
import { navGroups } from "./model"
import { createBrainStore } from "./store"
import { BrainSidebar } from "./tree"
import { createViewLayout, ViewShell } from "../shell"
import "./brain.css"

// The Brain view: Odoo Knowledge's spaces and documents on built-in demo data, in memory.
export default function BrainView() {
  const ctx = usePlugin()
  const brain = createBrainStore()
  const layout = createViewLayout()
  const searching = () => brain.state.query.trim().length > 0
  // In a narrow window the shell shows the documents as a select, and a result opens over the search.
  const open = (id: string) => {
    brain.select(id)
    if (layout() === "narrow") brain.setQuery("")
  }

  return (
    <ViewShell
      view="brain"
      title={ctx.t("brain.title")}
      description={ctx.t("brain.description")}
      nav={
        layout() === "narrow"
          ? { groups: navGroups(spaces), selected: brain.state.selected, select: brain.select }
          : undefined
      }
      detail={
        brain.state.accessOpen ? (
          <AccessPanel
            brain={brain}
            spaceName={brain.located()?.space.name ?? ""}
            mirror={brain.located()?.space.origin === "mirror"}
          />
        ) : undefined
      }
      detailTitle={ctx.t("brain.access.title")}
      onCloseDetail={brain.closeAccess}
    >
      <div data-slot="brain-layout" data-searching={searching() ? "" : undefined}>
        <BrainSidebar brain={brain} tree={layout() !== "narrow"} open={open} />
        <Show when={brain.located()}>{(item) => <DocumentPage brain={brain} item={item()} />}</Show>
      </div>
    </ViewShell>
  )
}
