import type { IconName } from "@opencode/plugin/gui"
import type { BuiltinContext } from "@opencode/plugin/gui/builtin"

/**
 * The DynWork rows of the sidebar, in order. A row with `settings` opens that settings page; the others open the view
 * of the same id in the main area (`./route`).
 */
export const entries: readonly { id: string; icon: IconName; label: string; settings?: string }[] = [
  { id: "agents", icon: "mcp", label: "views.nav.agents" },
  { id: "routines", icon: "task", label: "views.nav.routines" },
  { id: "brain", icon: "file-document", label: "views.nav.brain" },
  // The real Accounts page (`../accounts/ui/register.tsx`), not a demo copy.
  { id: "systemprompt", icon: "lock", label: "views.nav.systemprompt", settings: "accounts" },
]

/** What `ViewsNav` shows for each entry: its label, whether its page is the routed one, and how to open it. */
export function navRows(ctx: Pick<BuiltinContext, "t" | "router" | "layout">) {
  const routed = () => ctx.router.path().split(/[?#]/, 1)[0]

  return entries.map((entry) => ({
    id: entry.id,
    icon: entry.icon,
    label: () => ctx.t(entry.label),
    active: () => routed() === `/page/${entry.id}`,
    open: () => (entry.settings ? ctx.layout.settings(entry.settings) : ctx.layout.page(entry.id)),
  }))
}
