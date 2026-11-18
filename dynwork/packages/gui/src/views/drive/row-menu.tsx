import { usePlugin } from "@opencode/plugin/gui"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Menu } from "@opencode/ui/menu"
import { Show } from "solid-js"
import { askAgent } from "./chat"
import type { Doc } from "./demo"
import { drive } from "./store"

// Kobalte's menu runs browser-only code when it loads, and the tests render with Solid's server build: the views load
// this module on the client only (`./menus.tsx`).

/** A document's menu: open, use in a chat, link, download, and what only people do (in Governance until v2). */
export default function RowMenu(props: { doc: Doc }) {
  const ctx = usePlugin()
  const mvp = () => drive.state.mode === "mvp"
  const own = () => props.doc.access === "own"
  const demo = (key: string) => ctx.toast.show({ title: ctx.t(key), description: props.doc.name })
  return (
    <Menu placement="bottom-end" gutter={4}>
      <Menu.Trigger
        as={IconButton}
        variant="ghost-muted"
        size="small"
        icon={<Icon name="outline-dots" size="small" />}
        aria-label={ctx.t("drive.more")}
        title={ctx.t("drive.more")}
        onClick={(event: MouseEvent) => event.stopPropagation()}
      />
      <Menu.Portal>
        <Menu.Content>
          <Menu.Item onSelect={() => drive.openDoc(props.doc.id)}>
            <Icon name="eye" size="small" />
            {ctx.t("drive.open")}
          </Menu.Item>
          <Menu.Item onSelect={() => askAgent(ctx, props.doc)}>
            <Icon name="speech-bubble" size="small" />
            {ctx.t("drive.useInChat")}
          </Menu.Item>
          <Menu.Separator />
          <Menu.Item onSelect={() => demo("drive.link.copied")}>
            <Icon name="link" size="small" />
            {ctx.t("drive.link.copy")}
          </Menu.Item>
          <Menu.Item onSelect={() => demo("drive.download.demo")}>
            <Icon name="download" size="small" />
            {ctx.t("drive.download")}
          </Menu.Item>
          <Menu.Item onSelect={() => demo("drive.export.demo")}>
            <Icon name="download" size="small" />
            {ctx.t("drive.export.pdf")}
          </Menu.Item>
          <Menu.Item onSelect={() => demo("drive.governance.demo")}>
            <Icon name="square-arrow-top-right" size="small" />
            {ctx.t("drive.governance")}
          </Menu.Item>
          <Menu.Separator />
          <Menu.Item disabled={mvp()} onSelect={() => demo("drive.rename.demo")}>
            <Icon name="edit" size="small" />
            {ctx.t("drive.rename")}
            <Show when={mvp()}>
              <span data-slot="drive-menu-hint">Governance</span>
            </Show>
          </Menu.Item>
          <Menu.Item disabled={mvp() || !own()} onSelect={() => demo("drive.move.demo")}>
            <Icon name="folder" size="small" />
            {ctx.t("drive.move")}
          </Menu.Item>
          <Menu.Item disabled={mvp() || !own()} onSelect={() => demo("drive.trash.demo")}>
            <Icon name="trash" size="small" />
            {ctx.t("drive.trash")}
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu>
  )
}
