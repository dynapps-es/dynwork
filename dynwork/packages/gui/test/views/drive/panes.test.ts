import { describe, expect, test } from "bun:test"
import type { Persisted } from "@opencode/plugin/gui"
import { createRoot, createSignal } from "solid-js"
import { createPanes, drawerWidth, initial, Panes } from "../../../src/views/drive/panes"
import { storage } from "../../routines/fixture"

// The layout over a store kept as its schema's JSON, as the window's storage keeps it.
function stand(saved?: Persisted<Panes, Panes>) {
  const [store, setStore] = createSignal<Persisted<Panes>>(saved)
  return { panes: createRoot(() => createPanes(store)), setStore }
}

describe("how an open document is laid out", () => {
  test("the index and the drawer show at the default width until the store has loaded", () => {
    const { panes } = stand()
    expect([panes.outline(), panes.drawer(), panes.width()]).toEqual([true, true, initial.width])
    // Nothing to keep it in yet: a toggle changes nothing it would lose.
    panes.toggle("drawer")
    expect(panes.drawer()).toBe(true)
  })

  test("hiding the index or the drawer is kept, and shows again from the same button", () => {
    const saved = storage(Panes, initial)
    const { panes } = stand(saved)
    panes.toggle("outline")
    panes.toggle("drawer")
    expect(saved.value).toEqual({ ...initial, outline: false, drawer: false })
    // A window that opens the store later reads the same.
    expect([stand(saved).panes.outline(), stand(saved).panes.drawer()]).toEqual([false, false])
    panes.toggle("drawer")
    expect(saved.value.drawer).toBe(true)
  })

  test("a drag resizes the drawer as it moves, within its bounds, and keeps the width once it ends", () => {
    const saved = storage(Panes, initial)
    const { panes } = stand(saved)
    panes.resize(512.4)
    expect(panes.width()).toBe(512)
    expect(saved.value.width).toBe(initial.width)
    panes.resize(10_000)
    expect(panes.width()).toBe(drawerWidth.max)
    panes.resize(12)
    expect(panes.width()).toBe(drawerWidth.min)
    panes.settle()
    expect(saved.value.width).toBe(drawerWidth.min)
    expect(panes.width()).toBe(drawerWidth.min)
    // A click on the edge without a drag keeps nothing.
    panes.settle()
    expect(saved.value.width).toBe(drawerWidth.min)
  })

  test("a stored width out of bounds, from an older layout or another screen, is drawn within them", () => {
    const { panes } = stand(storage(Panes, { ...initial, width: 4000 }))
    expect(panes.width()).toBe(drawerWidth.max)
  })
})

describe("the comments marked on a document", () => {
  test("show until the user hides them, and stay as they left them", () => {
    expect(stand().panes.marks()).toBe(true)
    const saved = storage(Panes, initial)
    const { panes } = stand(saved)
    expect(panes.marks()).toBe(true)
    panes.toggle("marks")
    expect(panes.marks()).toBe(false)
    expect(saved.value.marks).toBe(false)
    expect(stand(saved).panes.marks()).toBe(false)
    panes.toggle("marks")
    expect(saved.value.marks).toBe(true)
  })

  test("a layout kept before the marks existed shows them, and keeps the rest", () => {
    const saved = storage(Panes, { outline: false, drawer: true, width: 500 })
    const { panes } = stand(saved)
    expect([panes.marks(), panes.outline(), panes.width()]).toEqual([true, false, 500])
    panes.toggle("marks")
    expect(saved.value).toEqual({ outline: false, drawer: true, width: 500, marks: false })
  })
})
