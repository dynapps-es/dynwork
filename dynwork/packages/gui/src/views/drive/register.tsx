import { MenuItem, Panel, type PanelTab, type SetupContext } from "@opencode/plugin/gui"
import { BuiltinSlot } from "@opencode/plugin/gui/builtin"
import { createMemo, Show } from "solid-js"
import type definition from "../../accounts/index"
import { listKey } from "./chat"
import { ArtifactsPanel, DocPanel, OverwriteDock } from "./panel"
import { drive } from "./store"
import "./drive.css"

// The Drive beside a chat: one side panel with a tab for the chat's artifacts and a tab per document opened from it,
// the + menu's "Artifacts" item, and the agent's pending overwrite in the composer's dock.
export function registerDrive(ctx: SetupContext<typeof definition>) {
  const list = createMemo((): PanelTab => ({ id: "drive", title: ctx.t("drive.panel.title"), group: "drive" }))
  // The same tab object per document while its name and the language stay: a new one would render its label again.
  const docs = new Map<string, { name: string; tab: PanelTab }>()
  const docTab = (id: string) => {
    const name = drive.doc(id)?.name ?? id
    const cached = docs.get(id)
    if (cached?.name === name) return cached.tab
    const tab: PanelTab = { id: `drive.${id}`, title: name, group: "drive" }
    docs.set(id, { name, tab })
    return tab
  }

  ctx.add(
    Panel,
    (): Panel => ({
      id: "drive",
      region: "side",
      width: 520,
      mobile: { title: ctx.t("drive.panel.title"), order: 40, kind: "drawer", icon: "file-document" },
      list: (input) =>
        input.open.flatMap((id) => {
          if (id === "drive") return [list()]
          const doc = id.startsWith("drive.") ? id.slice("drive.".length) : undefined
          return doc && drive.doc(doc) ? [docTab(doc)] : []
        }),
      render: (props) => (
        <Show when={props.tab.id !== "drive"} fallback={<ArtifactsPanel session={props.session} />}>
          <DocPanel session={props.session} id={props.tab.id.slice("drive.".length)} />
        </Show>
      ),
    }),
  )

  ctx.add(
    MenuItem,
    (): MenuItem => ({
      menu: "session.panel",
      id: "drive",
      title: ctx.t("drive.panel.title"),
      icon: "file-document",
      order: 40,
      run() {
        const session = ctx.sessions.current()
        if (session) ctx.layout.open(listKey, session, { tab: "open" })
      },
    }),
  )

  ctx.add(BuiltinSlot, {
    at: "session.composer.dock",
    render: () => (
      <Show when={ctx.sessions.current()}>
        {(session) => (
          <Show when={drive.chat(session().key).dock}>
            <OverwriteDock session={session()} />
          </Show>
        )}
      </Show>
    ),
  })
}
