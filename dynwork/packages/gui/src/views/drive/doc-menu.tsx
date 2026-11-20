import { usePlugin } from "@opencode/plugin/gui"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Menu } from "@opencode/ui/menu"
import { Tooltip } from "@opencode/ui/tooltip"
import type { Document } from "../../drive/contract"
import { openGovernance } from "./parts"
import { copyLink, exportPdf } from "./row-menu"

// The open document's More menu: export, link and Governance. Loaded on the client only (`./menus.tsx`), as Kobalte's
// menu and tooltip run browser-only code when they load.

export default function DocMenu(props: { doc: Document }) {
  const ctx = usePlugin()
  return (
    <Menu placement="bottom-end" gutter={6}>
      <Tooltip value={ctx.t("drive.more")} placement="bottom">
        <Menu.Trigger
          as={IconButton}
          variant="ghost"
          icon={<Icon name="outline-dots" />}
          aria-label={ctx.t("drive.more")}
        />
      </Tooltip>
      <Menu.Portal>
        <Menu.Content>
          <Menu.Item onSelect={() => void exportPdf(ctx, props.doc)}>
            <Icon name="download" size="small" />
            {ctx.t("drive.export.pdf")}
          </Menu.Item>
          <Menu.Item onSelect={() => void copyLink(ctx, props.doc)}>
            <Icon name="link" size="small" />
            {ctx.t("drive.link.copy")}
          </Menu.Item>
          <Menu.Item onSelect={() => openGovernance(ctx, props.doc)}>
            <Icon name="square-arrow-top-right" size="small" />
            {ctx.t("drive.governance")}
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu>
  )
}
