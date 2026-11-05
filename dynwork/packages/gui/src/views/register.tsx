import type { SetupContext } from "@opencode/plugin/gui"
import { BuiltinSlot } from "@opencode/plugin/gui/builtin"
import type definition from "../accounts/index"
import { SidebarBrand } from "./brand"
import { ViewsNav } from "./nav"
import { ViewRoute } from "./route"

/** The DynWork views: their rows in the sidebar (and the narrow window's tabs drawer), their pages, and the brand at
 * the sidebar's foot. */
export function registerViews(ctx: SetupContext<typeof definition>) {
  ctx.add(BuiltinSlot, { at: "sidebar.nav", render: (input) => <ViewsNav place={input.place} /> })
  ctx.add(BuiltinSlot, { at: "page", render: (input) => <ViewRoute id={input.id} /> })
  ctx.add(BuiltinSlot, { at: "sidebar.footer", render: () => <SidebarBrand /> })
}
