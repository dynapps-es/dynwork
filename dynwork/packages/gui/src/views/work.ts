import type { Context } from "@opencode/plugin/gui"
import { builtinContext } from "@opencode/plugin/gui/builtin"
import type { JSX } from "solid-js"
import { device } from "./device"
import type { ViewNav } from "./shell"

/**
 * The sub-navigation the Agents sidebar entry shares between its two pages: the Agent Farm's agents under Cloud, and
 * the routines of this computer under "This Mac" (or "This PC", "This computer").
 */
export function workNav(
  ctx: Context,
  input: { selected: "agents" | "routines"; agents: number; routines: number; footer?: JSX.Element },
): ViewNav {
  return {
    groups: [
      {
        label: ctx.t("views.work.cloud"),
        items: [{ id: "agents", label: ctx.t("views.work.agents"), icon: "cloud-upload", count: input.agents }],
      },
      {
        label: device(ctx).label,
        items: [{ id: "routines", label: ctx.t("views.work.routines"), icon: "monitor", count: input.routines }],
      },
    ],
    selected: input.selected,
    select: (id) => {
      if (id !== input.selected) builtinContext(ctx).layout.page(id)
    },
    footer: input.footer,
  }
}
