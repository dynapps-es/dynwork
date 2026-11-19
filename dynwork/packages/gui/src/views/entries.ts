import type { IconName } from "@opencode/plugin/gui"
import type { BuiltinContext } from "@opencode/plugin/gui/builtin"

/** The Scheduled row's clock (`./clock.tsx`), which the app's icon catalog does not have. */
export const clock = "dynwork-clock"

/**
 * The DynWork rows of the sidebar, in order. Each opens the view of its id in the main area (`./route`) and stays
 * highlighted on every page in `pages`: Agents holds every routine, local and remote, and `routines` is the same view
 * filtered to the local ones. The governance settings are reached from Settings only.
 */
export const entries: readonly {
  id: string
  icon: IconName | typeof clock
  label: string
  pages: readonly string[]
}[] = [
  { id: "agents", icon: clock, label: "views.nav.agents", pages: ["agents", "routines"] },
  { id: "drive", icon: "folder", label: "views.nav.drive", pages: ["drive"] },
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
