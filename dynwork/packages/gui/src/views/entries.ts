import type { IconName } from "@opencode/plugin/gui"
import type { BuiltinContext } from "@opencode/plugin/gui/builtin"

/**
 * The DynWork rows of the sidebar, in order. Each opens the view of its id in the main area (`./route`) and stays
 * highlighted on every page in `pages`: Agents holds both the Agent Farm's agents and this computer's routines. The
 * governance settings are reached from Settings only.
 */
export const entries: readonly { id: string; icon: IconName; label: string; pages: readonly string[] }[] = [
  { id: "agents", icon: "cube", label: "views.nav.agents", pages: ["agents", "routines"] },
  { id: "brain", icon: "brain", label: "views.nav.brain", pages: ["brain"] },
]

/** What `ViewsNav` shows for each entry: its label, whether its page is the routed one, and how to open it. */
export function navRows(ctx: Pick<BuiltinContext, "t" | "router" | "layout">) {
  const routed = () => ctx.router.path().split(/[?#]/, 1)[0]

  return entries.map((entry) => ({
    id: entry.id,
    icon: entry.icon,
    label: () => ctx.t(entry.label),
    active: () => entry.pages.some((page) => routed() === `/page/${page}`),
    open: () => ctx.layout.page(entry.id),
  }))
}
