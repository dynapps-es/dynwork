import type { Persisted } from "@opencode/plugin/gui"
import { Schema } from "effect"
import { createRoot, createSignal } from "solid-js"

// How the user lays out an open document, kept in the window's storage (`drive.panes`, opened by the window entry):
// whether the index at the left and the drawer at the right of the Drive view show, the drawer's width, and whether the
// comments are marked on the document, in the Drive view and beside a chat.

export const Panes = Schema.Struct({
  outline: Schema.Boolean,
  drawer: Schema.Boolean,
  width: Schema.Number,
  /** Absent in what was kept before the marks existed: shown. */
  marks: Schema.optional(Schema.Boolean),
})
export type Panes = typeof Panes.Type

export const initial: Panes = { outline: true, drawer: true, width: 400, marks: true }

/** How narrow and how wide the drawer may get: its tabs fit at the minimum, and the document keeps room at the maximum. */
export const drawerWidth = { min: 320, max: 720 }

const clamp = (width: number) => Math.round(Math.min(drawerWidth.max, Math.max(drawerWidth.min, width)))

/**
 * The layout over its stored value: the defaults until it loads. A drag resizes the drawer as it moves and is stored
 * once, when it ends.
 */
export function createPanes(stored: () => Persisted<Panes> | undefined) {
  const [dragged, setDragged] = createSignal<number>()
  const value = () => stored()?.value ?? initial
  return {
    outline: () => value().outline,
    drawer: () => value().drawer,
    marks: () => value().marks ?? true,
    width: () => dragged() ?? clamp(value().width),
    toggle(pane: "outline" | "drawer" | "marks") {
      const shown = value()[pane] ?? true
      stored()?.update((draft) => {
        draft[pane] = !shown
      })
    },
    resize(width: number) {
      setDragged(clamp(width))
    },
    /** The drag ended: the width it left is kept. */
    settle() {
      const width = dragged()
      if (width === undefined) return
      stored()?.update((draft) => {
        draft.width = width
      })
      setDragged(undefined)
    },
  }
}

const [stored, setStored] = createSignal<Persisted<Panes>>()

/** The window's layout, over the store the window entry opens (`keepPanes`). */
export const panes = createRoot(() => createPanes(stored))
export const keepPanes = setStored
