import { usePlugin, type Context } from "@opencode/plugin/gui"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Menu } from "@opencode/ui/menu"
import { isFailure, type Document } from "../../drive/contract"
import { askAgent } from "./chat"
import { isPdf, stem } from "./model"
import { failureText, openGovernance } from "./parts"
import { drive, governance } from "./store"

// Kobalte's menu runs browser-only code when it loads, and the tests render with Solid's server build: the views load
// this module on the client only (`./menus.tsx`).

type Host = Pick<Context, "t" | "toast" | "system">

/**
 * Saves the document as the Drive exports it to PDF, through the browser's download. An uploaded PDF is saved as
 * stored: the instance renders only its own formats to PDF.
 */
export async function exportPdf(ctx: Host, doc: Document) {
  const client = drive.client()
  const pdf = isPdf(doc) ? await client?.content({ id: doc.id }) : await client?.pdf({ id: doc.id })
  if (!pdf || isFailure(pdf))
    return ctx.toast.show({
      title: ctx.t("drive.export.failed"),
      description: pdf ? failureText(ctx, pdf) : undefined,
      variant: "error",
    })
  const url = URL.createObjectURL(new Blob([pdf.bytes.slice()], { type: "application/pdf" }))
  const link = Object.assign(document.createElement("a"), { href: url, download: `${stem(doc.name)}.pdf` })
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** Copies the document's page in Governance: only people with access can open it. */
export async function copyLink(ctx: Host, doc: Document) {
  const url = governance(doc.id)
  if (!url) return
  await navigator.clipboard.writeText(url)
  ctx.toast.show({ title: ctx.t("drive.link.copied"), icon: "link" })
}

/**
 * A document's menu: open, use in a chat, export, link, and what the Drive keeps to the person (rename, move, trash),
 * which happens in Governance until DynWork acts as the person (P1).
 */
export default function RowMenu(props: { doc: Document }) {
  const ctx = usePlugin()
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
          <Menu.Item onSelect={() => void drive.openDoc(props.doc.id)}>
            <Icon name="eye" size="small" />
            {ctx.t("drive.open")}
          </Menu.Item>
          <Menu.Item onSelect={() => askAgent(ctx, props.doc)}>
            <Icon name="speech-bubble" size="small" />
            {ctx.t("drive.useInChat")}
          </Menu.Item>
          <Menu.Separator />
          <Menu.Item onSelect={() => void copyLink(ctx, props.doc)}>
            <Icon name="link" size="small" />
            {ctx.t("drive.link.copy")}
          </Menu.Item>
          <Menu.Item onSelect={() => void exportPdf(ctx, props.doc)}>
            <Icon name="download" size="small" />
            {ctx.t("drive.export.pdf")}
          </Menu.Item>
          <Menu.Item onSelect={() => openGovernance(ctx, props.doc)}>
            <Icon name="square-arrow-top-right" size="small" />
            {ctx.t("drive.governance")}
          </Menu.Item>
          <Menu.Separator />
          <Menu.Item onSelect={() => openGovernance(ctx, props.doc)}>
            <Icon name="edit" size="small" />
            {ctx.t("drive.rename")}
            <span data-slot="drive-menu-hint">Governance</span>
          </Menu.Item>
          <Menu.Item onSelect={() => openGovernance(ctx, props.doc)}>
            <Icon name="folder" size="small" />
            {ctx.t("drive.move")}
            <span data-slot="drive-menu-hint">Governance</span>
          </Menu.Item>
          <Menu.Item onSelect={() => openGovernance(ctx, props.doc)}>
            <Icon name="trash" size="small" />
            {ctx.t("drive.trash")}
            <span data-slot="drive-menu-hint">Governance</span>
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu>
  )
}
