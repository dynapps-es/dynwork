import { usePlugin } from "@opencode/plugin/gui"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Menu } from "@opencode/ui/menu"
import type { Doc } from "./demo"
import { drive } from "./store"

// The open document's More menu: download, export, link, Governance, and the v2 preview. Loaded on the client only
// (`./menus.tsx`), as Kobalte's menu runs browser-only code when it loads.

export default function DocMenu(props: { doc: Doc }) {
  const ctx = usePlugin()
  const demo = (key: string) => ctx.toast.show({ title: ctx.t(key), description: props.doc.name, icon: "info" })
  return (
    <Menu placement="bottom-end" gutter={6}>
      <Menu.Trigger
        as={IconButton}
        variant="ghost"
        icon={<Icon name="outline-dots" />}
        aria-label={ctx.t("drive.more")}
        title={ctx.t("drive.more")}
      />
      <Menu.Portal>
        <Menu.Content>
          <Menu.Item onSelect={() => demo("drive.download.demo")}>
            <Icon name="download" size="small" />
            {ctx.t("drive.download")}
          </Menu.Item>
          <Menu.Item onSelect={() => demo("drive.export.demo")}>
            <Icon name="download" size="small" />
            {ctx.t("drive.export.pdf")}
          </Menu.Item>
          <Menu.Item onSelect={() => demo("drive.link.copied")}>
            <Icon name="link" size="small" />
            {ctx.t("drive.link.copy")}
          </Menu.Item>
          <Menu.Item onSelect={() => demo("drive.governance.demo")}>
            <Icon name="square-arrow-top-right" size="small" />
            {ctx.t("drive.governance")}
          </Menu.Item>
          <Menu.Separator />
          <Menu.CheckboxItem
            checked={drive.state.mode === "v2"}
            onChange={(checked: boolean) => drive.setMode(checked ? "v2" : "mvp")}
          >
            {ctx.t("drive.mode.v2")}
          </Menu.CheckboxItem>
        </Menu.Content>
      </Menu.Portal>
    </Menu>
  )
}
