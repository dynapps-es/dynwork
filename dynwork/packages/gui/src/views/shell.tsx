import { usePlugin, type IconName } from "@opencode/plugin/gui"
import { Icon } from "@opencode/ui/icon"
import { children, createSignal, For, onCleanup, Show, type JSX } from "solid-js"
import "./shell.css"

/** One row of a view's sub-navigation. */
export interface ViewNavItem {
  readonly id: string
  readonly label: string
  readonly icon?: IconName
  /** A muted number at the row's end, such as how many items the row lists. */
  readonly count?: number
}

/** A titled group of sub-navigation rows, such as "Cloud" and "This Mac". */
export interface ViewNavGroup {
  readonly label?: string
  readonly items: readonly ViewNavItem[]
}

/** A view's sub-navigation: a left column, or a select at the top of a narrow window. */
export interface ViewNav {
  readonly groups: readonly ViewNavGroup[]
  /** The id of the selected row. */
  readonly selected: string
  select(id: string): void
  /** Content under the rows in the column, such as a connection status. Hidden in a narrow window. */
  readonly footer?: JSX.Element
}

/** How the shell lays a view out, by window width; see `ViewShell`. */
export type ViewLayout = "wide" | "medium" | "narrow"

/**
 * The frame every DynWork view renders in: a header (title, badge, the Demo data marker, description, actions), an
 * optional sub-navigation, the content, and an optional detail pane. The detail pane is a drawer over the content, so
 * opening it never squeezes the content, closed with its Close button, the scrim or Escape. It follows the window width:
 * - `wide` (1200px and up): a wide sub-navigation column.
 * - `medium` (768 to 1199px): a narrower sub-navigation column.
 * - `narrow` (under 768px): the sub-navigation is a select above the header, and the detail pane replaces the content
 *   as a full-width page with Back.
 *
 * The detail pane shows while `detail` is set; `onCloseDetail` clears it.
 */
export function ViewShell(props: {
  /** The view's id, on `data-view` for its own styles. */
  view: string
  title: string
  /** A label next to the title, such as "Agent Farm". */
  badge?: string
  description?: string
  /** Buttons at the header's end, such as New agent. */
  actions?: JSX.Element
  nav?: ViewNav
  detail?: JSX.Element
  /** The detail pane's accessible name. */
  detailTitle?: string
  onCloseDetail?: () => void
  children?: JSX.Element
}) {
  const ctx = usePlugin()
  const layout = createViewLayout()
  // Resolved once: reading `props.detail` again would render the pane's content again.
  const detail = children(() => props.detail)
  const open = () => detail.toArray().length > 0
  const close = () => props.onCloseDetail?.()
  // Escape closes the drawer wherever the focus is, usually still on the row that opened it. A dialog over the view
  // handles its own Escape first.
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented || !open() || layout() === "narrow") return
    if (document.querySelector('[role="dialog"]')) return
    close()
  }
  document.addEventListener("keydown", escape)
  onCleanup(() => document.removeEventListener("keydown", escape))

  return (
    <div
      data-component="dynwork-view"
      data-view={props.view}
      data-layout={layout()}
      data-detail={open() ? "" : undefined}
    >
      <Show when={props.nav}>
        {(nav) => (
          <Show when={layout() !== "narrow"} fallback={<SubnavSelect nav={nav()} label={ctx.t("views.subnav")} />}>
            <nav data-slot="view-subnav" aria-label={ctx.t("views.subnav")}>
              <For each={nav().groups}>
                {(group) => (
                  <div data-slot="view-subnav-group">
                    <Show when={group.label}>
                      <div data-slot="view-subnav-label">{group.label}</div>
                    </Show>
                    <For each={group.items}>
                      {(item) => (
                        <button
                          type="button"
                          data-slot="view-subnav-item"
                          data-state={nav().selected === item.id ? "pressed" : undefined}
                          aria-current={nav().selected === item.id ? "page" : undefined}
                          onClick={() => nav().select(item.id)}
                        >
                          <Show when={item.icon}>{(icon) => <Icon name={icon()} />}</Show>
                          <span data-slot="view-subnav-text">{item.label}</span>
                          <Show when={item.count !== undefined}>
                            <span data-slot="view-subnav-count">{item.count}</span>
                          </Show>
                        </button>
                      )}
                    </For>
                  </div>
                )}
              </For>
              <Show when={nav().footer}>
                <div data-slot="view-subnav-footer">{nav().footer}</div>
              </Show>
            </nav>
          </Show>
        )}
      </Show>
      <div data-slot="view-main">
        <header data-slot="view-header">
          <div data-slot="view-heading">
            <div data-slot="view-title-row">
              <h1 data-slot="view-title">{props.title}</h1>
              <Show when={props.badge}>
                <span data-slot="view-badge">{props.badge}</span>
              </Show>
              <DemoBadge />
            </div>
            <Show when={props.description}>
              <p data-slot="view-description">{props.description}</p>
            </Show>
          </div>
          <Show when={props.actions}>
            <div data-slot="view-actions">{props.actions}</div>
          </Show>
        </header>
        <div data-slot="view-content">{props.children}</div>
      </div>
      <Show when={open()}>
        <Show when={layout() !== "narrow"}>
          <div data-slot="view-scrim" aria-hidden="true" onClick={close} />
        </Show>
        <aside data-slot="view-detail" aria-label={props.detailTitle}>
          <button type="button" data-slot="view-detail-close" onClick={close}>
            <Icon name={layout() === "narrow" ? "arrow-left" : "close"} />
            {layout() === "narrow" ? ctx.t("views.back") : ctx.t("views.close")}
          </button>
          {detail()}
        </aside>
      </Show>
    </div>
  )
}

/** The marker every demo view shows: its data is built in, never fetched. */
export function DemoBadge() {
  const ctx = usePlugin()

  return (
    <span data-component="dynwork-demo-badge" title={ctx.t("views.demo.title")}>
      {ctx.t("views.demo")}
    </span>
  )
}

function SubnavSelect(props: { nav: ViewNav; label: string }) {
  return (
    <select
      data-slot="view-subnav-select"
      aria-label={props.label}
      value={props.nav.selected}
      onChange={(event) => props.nav.select(event.currentTarget.value)}
    >
      <For each={props.nav.groups}>
        {(group) => (
          <optgroup label={group.label ?? ""}>
            <For each={group.items}>
              {(item) => (
                <option value={item.id} selected={props.nav.selected === item.id}>
                  {item.label}
                </option>
              )}
            </For>
          </optgroup>
        )}
      </For>
    </select>
  )
}

/** The shell's layout for the current window width; reactive. The host's breakpoints are window widths too. */
export function createViewLayout() {
  const wide = media("(min-width: 1200px)")
  // Where the host hides its sidebar.
  const narrow = media("(max-width: 767px)")

  return (): ViewLayout => {
    if (wide()) return "wide"
    if (narrow()) return "narrow"
    return "medium"
  }
}

function media(query: string) {
  const list = window.matchMedia(query)
  const [matches, setMatches] = createSignal(list.matches)
  const update = () => setMatches(list.matches)
  list.addEventListener("change", update)
  onCleanup(() => list.removeEventListener("change", update))

  return matches
}
