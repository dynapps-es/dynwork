import { usePlugin } from "@opencode/plugin/gui"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { For, Show } from "solid-js"
import type { Role } from "./demo"
import type { BrainStore } from "./store"

const roles: readonly Role[] = ["Can read", "Can edit"]

/** Who can open the document and how, inside the shell's detail pane. Changes stay in memory. */
export function AccessPanel(props: { brain: BrainStore; spaceName: string; mirror: boolean }) {
  const ctx = usePlugin()
  const role = (value: Role) => ctx.t(value === "Can edit" ? "brain.role.edit" : "brain.role.read")

  return (
    <div data-slot="brain-access">
      <h2 data-slot="brain-access-title">{ctx.t("brain.access.title")}</h2>
      <p data-slot="brain-access-lede">
        {ctx.t("brain.access.lede", {
          role: props.mirror ? role("Can read") : role(props.brain.canEdit() ? "Can edit" : "Can read"),
        })}
      </p>
      <Show when={props.mirror}>
        <p data-slot="brain-notice" data-tone="neutral">
          <Icon name="lock" size="small" />
          <span>{ctx.t("brain.access.mirror")}</span>
        </p>
      </Show>
      <div data-slot="brain-grants">
        <For each={props.brain.grants()}>
          {(grant) => (
            <div data-slot="brain-grant" data-source={grant.source}>
              <span
                data-slot="brain-avatar"
                style={{
                  background: `var(--v2-avatar-bg-${grant.tone})`,
                  "box-shadow": `inset 0 0 0 0.5px var(--v2-avatar-border-${grant.tone})`,
                }}
              >
                {grant.initials}
              </span>
              <span data-slot="brain-grant-copy">
                <span data-slot="brain-grant-name">{grant.name}</span>
                <span data-slot="brain-grant-from">
                  <span data-slot="brain-badge" data-kind={grant.source}>
                    {ctx.t(grant.source === "explicit" ? "brain.access.explicit" : "brain.access.inherited")}
                  </span>
                  <span data-slot="brain-grant-source">
                    {grant.source === "explicit"
                      ? ctx.t("brain.access.fromDoc")
                      : ctx.t("brain.access.fromSpace", { space: props.spaceName })}
                  </span>
                </span>
              </span>
              <Show
                when={props.brain.canEdit()}
                fallback={<span data-slot="brain-grant-role">{role(grant.role)}</span>}
              >
                <select
                  data-slot="brain-grant-select"
                  aria-label={ctx.t("brain.access.role", { group: grant.name })}
                  value={grant.role}
                  onChange={(event) => props.brain.setRole(grant.id, event.currentTarget.value as Role)}
                >
                  <For each={roles}>
                    {(value) => (
                      <option value={value} selected={grant.role === value}>
                        {role(value)}
                      </option>
                    )}
                  </For>
                </select>
              </Show>
            </div>
          )}
        </For>
      </div>
      <div>
        <Button
          icon="plus"
          disabled={!props.brain.canEdit() || props.brain.shareable().length === 0}
          onClick={() => props.brain.share()}
        >
          {ctx.t("brain.access.share")}
        </Button>
      </div>
    </div>
  )
}
