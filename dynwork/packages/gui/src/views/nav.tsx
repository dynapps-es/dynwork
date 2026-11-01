import { usePlugin } from "@opencode/plugin/gui"
import { builtinContext } from "@opencode/plugin/gui/builtin"
import { Icon } from "@opencode/ui/icon"
import { For } from "solid-js"
import { navRows } from "./entries"
import "./nav.css"

/**
 * The DynWork rows: after New session in the vertical sidebar, and after Home in the tabs drawer of a narrow window,
 * where the host hides the sidebar. Opening a view changes the route, which also closes the drawer.
 */
export function ViewsNav(props: { drawer: boolean }) {
  return (
    <For each={navRows(builtinContext(usePlugin()))}>
      {(row) => (
        <button
          type="button"
          data-component="dynwork-nav-row"
          data-action={`dynwork-${row.id}`}
          data-drawer={props.drawer ? "" : undefined}
          // The sidebar's own rows take their hover and pressed backgrounds from this attribute.
          data-titlebar-tab-action={props.drawer ? undefined : ""}
          data-state={row.active() ? "pressed" : undefined}
          aria-current={row.active() ? "page" : undefined}
          onClick={row.open}
        >
          <Icon name={row.icon} />
          <span data-slot="dynwork-nav-label">{row.label()}</span>
        </button>
      )}
    </For>
  )
}
