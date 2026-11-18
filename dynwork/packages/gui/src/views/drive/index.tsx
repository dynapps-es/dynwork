import { usePlugin } from "@opencode/plugin/gui"
import { Button } from "@opencode/ui/button"
import { createEffect, on, onCleanup, Show } from "solid-js"
import { Browser, BrowserActions } from "./browser"
import { drive } from "./store"
import { Workspace } from "./workspace"
import { ViewShell } from "../shell"
import "./drive.css"

// The Drive view: the active account's Drive in Governance (the user's own documents, those shared with them and those
// their chats made), and a document open over the browser with its details, versions, proposals and sharing.
export default function DriveView() {
  const ctx = usePlugin()

  // While the view is on screen it watches, so main reads the Drive every 20 s instead of every 5 minutes.
  createEffect(() => {
    const client = drive.client()
    if (!client) return
    const watching = new AbortController()
    void client.watch({ signal: watching.signal })
    onCleanup(() => watching.abort())
  })
  // The listing follows the account, and is read again whenever main has read the Drive (a poll or a write).
  createEffect(
    on(
      () => [drive.client(), drive.remote()?.account, drive.remote()?.read] as const,
      () => void drive.reload(),
    ),
  )

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
          demo={false}
        >
          <Browser />
        </ViewShell>
      }
    >
      {(id) => (
        <Show
          when={drive.doc(id)}
          fallback={
            <ViewShell view="drive" title={ctx.t("drive.title")} demo={false}>
              <div data-slot="drive-banner">
                <span data-slot="drive-grow">
                  {ctx.t(
                    drive.state.opened.failure ? `drive.failure.${drive.state.opened.failure.code}` : "drive.loading",
                  )}
                </span>
                <Button variant="ghost" size="small" icon="arrow-left" onClick={() => drive.closeDoc()}>
                  {ctx.t("views.back")}
                </Button>
              </div>
            </ViewShell>
          }
        >
          {(doc) => (
            <ViewShell view="drive" title={doc().name} header={false} demo={false}>
              <Workspace doc={doc()} />
            </ViewShell>
          )}
        </Show>
      )}
    </Show>
  )
}
