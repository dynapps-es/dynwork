import { usePlugin, type MountedSession } from "@opencode/plugin/gui"
import { Button } from "@opencode/ui/button"
import { Tooltip } from "@opencode/ui/tooltip"
import { Show } from "solid-js"
import { openArtifacts } from "./chat"
import { drive } from "./store"

// The chat header's artifacts button, as Claude counts a chat's artifacts beside its title: how many documents the chat
// made, changed or attached (the cards of its Artifacts tab, the instance's list of the chat included), none shown at 0,
// and a click opens that tab. The window entry loads it on the client only (`register.tsx`): Kobalte's tooltip runs
// browser-only code when it loads.
export default function ArtifactsCount(props: { session: MountedSession }) {
  const ctx = usePlugin()
  drive.followChat(() => props.session.id)
  const count = () => drive.artifactsOf(props.session.id).length
  return (
    <Tooltip value={ctx.t("drive.panel.title")} placement="bottom">
      <Button
        type="button"
        variant="ghost-muted"
        icon="file-document"
        class="shrink-0"
        style={{ padding: "0 6px", color: "var(--v2-text-text-faint)" }}
        aria-label={ctx.t("drive.panel.title")}
        onClick={() => openArtifacts(ctx, props.session)}
      >
        <Show when={count() > 0}>
          <span class="tabular-nums">{count()}</span>
        </Show>
      </Button>
    </Tooltip>
  )
}
