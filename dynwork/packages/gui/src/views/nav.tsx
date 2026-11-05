import { usePlugin } from "@opencode/plugin/gui"
import { builtinContext } from "@opencode/plugin/gui/builtin"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { For, Show } from "solid-js"
import { navRows, robot } from "./entries"
import { RobotIcon } from "./robot"
import "./nav.css"

/**
 * The DynWork rows: after New session in the vertical sidebar, after Home in the tabs drawer of a narrow window, where
 * the host hides the sidebar, and as icon buttons after Search in the horizontal titlebar, which has no sidebar.
 * Opening a view changes the route, which also closes the drawer.
 */
export function ViewsNav(props: { place: "sidebar" | "drawer" | "titlebar" }) {
  return (
    <For each={navRows(builtinContext(usePlugin()))}>
      {(row) => (
        <Show
          when={props.place !== "titlebar"}
          fallback={
            // Like the titlebar's own Home and Search buttons. A native title, not the UI Tooltip: that one reaches for the
            // DOM when imported, which breaks every test that loads this plugin.
            <IconButton
              type="button"
              variant="ghost-muted"
              size="large"
              class="!w-9 shrink-0"
              data-component="dynwork-nav-icon"
              data-action={`dynwork-${row.id}`}
              icon={<Glyph icon={row.icon} />}
              state={row.active() ? "pressed" : undefined}
              onClick={row.open}
              title={row.label()}
              aria-label={row.label()}
              aria-current={row.active() ? "page" : undefined}
            />
          }
        >
          <button
            type="button"
            data-component="dynwork-nav-row"
            data-action={`dynwork-${row.id}`}
            data-drawer={props.place === "drawer" ? "" : undefined}
            // The sidebar's own rows take their hover and pressed backgrounds from this attribute.
            data-titlebar-tab-action={props.place === "sidebar" ? "" : undefined}
            data-state={row.active() ? "pressed" : undefined}
            aria-current={row.active() ? "page" : undefined}
            onClick={row.open}
          >
            <Glyph icon={row.icon} />
            <span data-slot="dynwork-nav-label">{row.label()}</span>
          </button>
        </Show>
      )}
    </For>
  )
}

function Glyph(props: { icon: ReturnType<typeof navRows>[number]["icon"] }) {
  return (
    <Show when={props.icon !== robot} fallback={<RobotIcon />}>
      <Icon name={props.icon} />
    </Show>
  )
}
