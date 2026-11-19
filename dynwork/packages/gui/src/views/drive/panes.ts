import type { Persisted } from "@opencode/plugin/gui"
import { Schema } from "effect"
import { createRoot, createSignal } from "solid-js"

// How the user lays out an open document, kept in the window's storage (`drive.panes`, opened by the window entry):
// whether the index at the left and the drawer at the right of the Drive view show, how wide each is, and whether the
// comments are marked on the document, in the Drive view and beside a chat.

export const Panes = Schema.Struct({
  outline: Schema.Boolean,
  drawer: Schema.Boolean,
  /** The drawer's width. */
  width: Schema.Number,
  /** Absent in what was kept before the marks existed: shown. */
  marks: Schema.optional(Schema.Boolean),
  /** The index's width; absent in what was kept before it could be resized: its default. */
  outlineWidth: Schema.optional(Schema.Number),
})
export type Panes = typeof Panes.Type

export const initial: Panes = { outline: true, drawer: true, width: 400, marks: true, outlineWidth: 196 }

/** How narrow and how wide the drawer may get: its tabs fit at the minimum, and the document keeps room at the maximum. */
export const drawerWidth = { min: 320, max: 720 }

/** How narrow and how wide the index may get: a short heading fits at the minimum, a long one at the maximum. */
export const outlineWidth = { min: 180, max: 420 }

/** A pane the user can resize. */
export type Sized = "drawer" | "outline"

const bounds = { drawer: drawerWidth, outline: outlineWidth }

const clamp = (pane: Sized, width: number) => Math.round(Math.min(bounds[pane].max, Math.max(bounds[pane].min, width)))

/**
 * The layout over its stored value: the defaults until it loads. A drag resizes the drawer or the index as it moves and
 * is stored once, when it ends.
 */
export function createPanes(stored: () => Persisted<Panes> | undefined) {
  const [dragged, setDragged] = createSignal<{ pane: Sized; width: number }>()
  const value = () => stored()?.value ?? initial
  const kept = (pane: Sized) =>
    pane === "drawer" ? value().width : (value().outlineWidth ?? initial.outlineWidth ?? outlineWidth.min)
  return {
    outline: () => value().outline,
    drawer: () => value().drawer,
    marks: () => value().marks ?? true,
    /** A pane's width: the drawer's unless it says otherwise. */
    width: (pane: Sized = "drawer") => {
      const drag = dragged()
      return drag?.pane === pane ? drag.width : clamp(pane, kept(pane))
    },
    toggle(pane: "outline" | "drawer" | "marks") {
      const shown = value()[pane] ?? true
      stored()?.update((draft) => {
        draft[pane] = !shown
      })
    },
    resize(width: number, pane: Sized = "drawer") {
      setDragged({ pane, width: clamp(pane, width) })
    },
    /** The drag ended: the width it left is kept. */
    settle() {
      const drag = dragged()
      if (drag === undefined) return
      stored()?.update((draft) => {
        if (drag.pane === "drawer") draft.width = drag.width
        else draft.outlineWidth = drag.width
      })
      setDragged(undefined)
    },
  }
}

const [stored, setStored] = createSignal<Persisted<Panes>>()

/** The window's layout, over the store the window entry opens (`keepPanes`). */
export const panes = createRoot(() => createPanes(stored))
export const keepPanes = setStored
