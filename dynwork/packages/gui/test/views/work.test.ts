import { describe, expect, test } from "bun:test"
import { device } from "../../src/views/device"
import en from "../../src/views/en"
import { workNav } from "../../src/views/work"

// A window context as far as the Agents menu reads it: the real English table, the desktop's OS (none on the web),
// and a layout that records the pages it opens.
function setup(os?: "macos" | "windows" | "linux") {
  const pages: string[] = []
  const ctx = {
    t: (key: string, params?: Record<string, string>) =>
      ((en as Record<string, string>)[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, name: string) => params?.[name] ?? ""),
    desktop: os ? { os } : undefined,
    layout: { page: (id: string) => pages.push(id) },
  }
  // SAFETY: `device` and `workNav` read only `t`, `desktop.os` and `layout.page`.
  return { ctx: ctx as never, pages }
}

describe("this computer's name", () => {
  test.each([
    ["macos", "This Mac", "this Mac"],
    ["windows", "This PC", "this PC"],
    ["linux", "This computer", "this computer"],
    [undefined, "This computer", "this computer"],
  ] as const)("on %s it is %s", (os, label, inline) => {
    expect(device(setup(os).ctx)).toEqual({ label, inline })
  })

  test("reaches the sentences that mention it", () => {
    const view = setup("windows")
    const t = (view.ctx as { t: (key: string, params?: Record<string, string>) => string }).t
    expect(t("agents.description", { device: device(view.ctx).inline })).toContain("when this PC sleeps")
    expect(t("routines.description", { device: device(view.ctx).inline })).toStartWith("Routines run on this PC")
  })
})

describe("the Agents menu", () => {
  test("groups the farm's agents under Cloud and the routines under this computer", () => {
    const nav = workNav(setup("macos").ctx, { selected: "agents", agents: 6, routines: 3 })
    expect(
      nav.groups.map((group) => ({
        label: group.label,
        items: group.items.map((item) => [item.id, item.label, item.icon, item.count]),
      })),
    ).toEqual([
      { label: "Cloud", items: [["agents", "Agents", "cloud-upload", 6]] },
      { label: "This Mac", items: [["routines", "Routines", "monitor", 3]] },
    ])
  })

  test("opens the other page, and stays put on the selected one", () => {
    const view = setup("macos")
    const nav = workNav(view.ctx, { selected: "routines", agents: 6, routines: 3 })
    nav.select("routines")
    nav.select("agents")
    expect(view.pages).toEqual(["agents"])
  })
})
