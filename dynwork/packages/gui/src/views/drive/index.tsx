import { usePlugin } from "@opencode/plugin/gui"
import { Show } from "solid-js"
import { Browser, BrowserActions } from "./browser"
import { drive } from "./store"
import { Workspace } from "./workspace"
import { ViewShell } from "../shell"
import "./drive.css"

// The Drive view: the governance documents (the user's own, those shared with them and those their chats made) on
// built-in demo data, and a document open over the browser with its comments, versions, proposals and sharing.
export default function DriveView() {
  const ctx = usePlugin()

  return (
    <Show
      when={drive.state.open}
      keyed
      fallback={
        <ViewShell
          view="drive"
          title={ctx.t("drive.title")}
          description={ctx.t("drive.description")}
          actions={<BrowserActions />}
        >
          <Browser />
        </ViewShell>
      }
    >
      {(id) => (
        <Show when={drive.doc(id)}>
          {(doc) => (
            <ViewShell view="drive" title={doc().name} header={false}>
              <Workspace doc={doc()} />
            </ViewShell>
          )}
        </Show>
      )}
    </Show>
  )
}
