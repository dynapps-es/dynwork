import { Icon } from "@opencode/ui/icon"
import { createEffect } from "solid-js"
import { FormatGlyph } from "./parts"
import { reveal } from "./tabs"
import { drive } from "./store"

/**
 * A document's tab in the side panel: its file glyph and its name, which the strip's narrow tab cuts with an ellipsis,
 * and the tab comes into view when it is selected. The name follows the document: it is the title until the Drive has
 * read it.
 */
export function DocTabLabel(props: { id: string; title: string; active: boolean }) {
  let label: HTMLSpanElement | undefined
  const doc = () => drive.doc(props.id)
  // After the strip has laid the tab out (and, for a new one, scrolled to its end).
  createEffect(() => {
    if (props.active) requestAnimationFrame(() => requestAnimationFrame(() => reveal(label)))
  })
  return (
    <span ref={label} data-slot="drive-tab">
      <FormatGlyph format={doc()?.format ?? "file"} />
      <span data-slot="drive-tab-name">{doc()?.name ?? props.title}</span>
    </span>
  )
}

/** The chat's artifacts tab: the same label, with the Drive's icon, so it too comes into view when it is selected. */
export function ListTabLabel(props: { title: string; active: boolean }) {
  let label: HTMLSpanElement | undefined
  createEffect(() => {
    if (props.active) requestAnimationFrame(() => requestAnimationFrame(() => reveal(label)))
  })
  return (
    <span ref={label} data-slot="drive-tab">
      <Icon name="file-document" size="small" />
      <span data-slot="drive-tab-name">{props.title}</span>
    </span>
  )
}
