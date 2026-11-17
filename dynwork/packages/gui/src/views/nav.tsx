import { usePlugin } from "@opencode/plugin/gui"
import { builtinContext } from "@opencode/plugin/gui/builtin"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { For, lazy, Show } from "solid-js"
import { isServer } from "solid-js/web"
import { askNewTask } from "./agents/intent"
import { ClockIcon } from "./clock"
import { clock, navRows } from "./entries"
import "./nav.css"

// Kobalte's menu runs browser-only code when it loads, and the tests render with Solid's server build.
const NewTaskMenu = lazy(() => import("./agents/new-menu"))

/**
 * The DynWork rows: after New session in the vertical sidebar, after Home in the tabs drawer of a narrow window, where
 * the host hides the sidebar, and as icon buttons after Search in the horizontal titlebar, which has no sidebar.
 * Opening a view changes the route, which also closes the drawer.
 */
export function ViewsNav(props: { place: "sidebar" | "drawer" | "titlebar" }) {
  const ctx = builtinContext(usePlugin())
  return (
    <For each={navRows(ctx)}>
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
          <div data-component="dynwork-nav-item">
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
            {/* The Scheduled row's "+", on hover in the sidebar: a new task without opening the view first. */}
            <Show when={!isServer && props.place === "sidebar" && row.id === "agents"}>
              <NewTaskMenu
                compact
                label={ctx.t("agents.new")}
                chat={ctx.t("agents.new.chat")}
                manual={ctx.t("agents.new.manual")}
                disabled={false}
                onChat={() => {
                  askNewTask("chat")
                  row.open()
                }}
                onManual={() => {
                  askNewTask("manual")
                  row.open()
                }}
              />
            </Show>
          </div>
        </Show>
      )}
    </For>
  )
}

function Glyph(props: { icon: ReturnType<typeof navRows>[number]["icon"] }) {
  return (
    <Show when={props.icon !== clock} fallback={<ClockIcon />}>
      <Icon name={props.icon} />
    </Show>
  )
}
