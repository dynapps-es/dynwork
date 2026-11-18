import { Panel, type PanelTab, type SessionRef, type SetupContext } from "@opencode/plugin/gui"
import { BuiltinSlot } from "@opencode/plugin/gui/builtin"
import { createEffect, createMemo, onCleanup } from "solid-js"
import type definition from "../accounts/index"
import { RoutinesClient } from "../routines/client"
import { SidebarBrand } from "./brand"
import { registerDrive } from "./drive/register"
import { ViewsNav } from "./nav"
import { ViewRoute } from "./route"
import { panelKey, routineOf } from "./runs/model"
import { RunsPanel } from "./runs/panel"
import "./badges.css"
import "../brand.css"
import "./bubble.css"
import "./font.css"
import "./primary.css"
import "./titlebar.css"
import "./vibrancy.css"

/** The DynWork views: their rows in the sidebar (and the narrow window's tabs drawer), their pages, the brand at the
 * sidebar's foot, the Runs panel on a routine's conversation, the Drive beside a chat, and the macOS sidebar material. */
export function registerViews(ctx: SetupContext<typeof definition>) {
  ctx.add(BuiltinSlot, { at: "sidebar.nav", render: (input) => <ViewsNav place={input.place} /> })
  ctx.add(BuiltinSlot, { at: "page", render: (input) => <ViewRoute id={input.id} /> })
  ctx.add(BuiltinSlot, { at: "sidebar.footer", render: () => <SidebarBrand /> })
  registerRuns(ctx)
  registerDrive(ctx)
  // The macOS window shows the native sidebar material through the shell's chrome (`./vibrancy.css`).
  if (ctx.desktop?.os !== "macos") return
  document.documentElement.dataset.vibrancy = ""
  onCleanup(() => delete document.documentElement.dataset.vibrancy)
}

// The Runs panel (docs/04-ui.md §A.3.3): a pinned tab listed only while the routed session is a routine's anchor or one
// of its runs, by the session's `metadata.dynwork`, or the routines' state until the metadata has loaded.
function registerRuns(ctx: SetupContext<typeof definition>) {
  const routines = () => {
    const live = RoutinesClient.connection()
    return live?.status === "active" ? (live.value.state()?.routines ?? []) : []
  }
  const isRoutine = (session: SessionRef) => {
    const info = session.server.data.session.get(session.id)
    const routine = routineOf({
      session: session.id,
      metadata: info?.metadata,
      parent: info?.parentID,
      routines: routines(),
    })
    return routine !== undefined
  }
  // The same tab object while the language stays: a new one would render its label again.
  const tab = createMemo(
    (): PanelTab => ({ id: "runs", title: ctx.t("runs.title"), pinned: true, closable: false, draggable: false }),
  )

  ctx.add(
    Panel,
    (): Panel => ({
      id: "runs",
      region: "side",
      width: 320,
      mobile: { title: ctx.t("runs.title"), order: 50, kind: "drawer", icon: "outline-video" },
      list: (input) => (isRoutine(input.session) ? [tab()] : []),
      render: (props) => <RunsPanel session={props.session} />,
    }),
  )

  // The first time a window routes a routine's session, its Runs panel opens beside it, without taking the narrow
  // window's view. Afterwards the user's own choice (closing the side region) stands.
  const opened = new Set<string>()
  createEffect(() => {
    const session = ctx.sessions.current()
    if (!session || !ctx.layout.ready() || opened.has(session.key) || !isRoutine(session)) return
    opened.add(session.key)
    ctx.layout.open(panelKey, session, { tab: "select", background: true })
  })
}
