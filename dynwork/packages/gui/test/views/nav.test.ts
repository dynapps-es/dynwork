import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { SettingsPage } from "@opencode/plugin/gui"
import { register } from "../../src/accounts/ui/register"
import { navRows } from "../../src/views/entries"
import en from "../../src/views/en"

// The window context as far as the rows use it: the real English table, a route path the test moves, and a layout
// that records what the rows open.
function setup(path = "/") {
  const [current, setCurrent] = createSignal(path)
  const pages: string[] = []
  const settings: string[] = []
  const ctx = {
    t: (key: string) => (en as Record<string, string>)[key] ?? key,
    router: { routing: () => false, path: current },
    layout: { page: (id: string) => pages.push(id), settings: (page: string) => settings.push(page) },
  }
  // SAFETY: `navRows` reads only `t`, `router.path`, `layout.page` and `layout.settings`.
  return { rows: navRows(ctx as never), pages, settings, route: setCurrent }
}

describe("the DynWork sidebar rows", () => {
  test("show Agents, Routines, Brain and systemprompt, in that order", () => {
    const view = setup()
    expect(view.rows.map((row) => row.label())).toEqual(["Agents", "Routines", "Brain", "systemprompt"])
    expect(view.rows.map((row) => row.icon)).toEqual(["mcp", "task", "file-document", "lock"])
  })

  test("highlight the routed view's row and follow the route", () => {
    const view = setup("/page/agents")
    const active = () => view.rows.filter((row) => row.active()).map((row) => row.id)
    expect(active()).toEqual(["agents"])

    view.route("/page/brain?from=search")
    expect(active()).toEqual(["brain"])

    view.route("/")
    expect(active()).toEqual([])

    view.route("/settings")
    expect(active()).toEqual([])
  })

  test("a view row opens its page in the main area", () => {
    const view = setup()
    view.rows.filter((row) => row.id !== "systemprompt").forEach((row) => row.open())
    expect(view.pages).toEqual(["agents", "routines", "brain"])
    expect(view.settings).toEqual([])
  })

  test("the systemprompt row opens the real Accounts settings page", () => {
    const view = setup()
    view.rows.find((row) => row.id === "systemprompt")?.open()
    expect(view.pages).toEqual([])

    // The page id the row opens is the one the accounts window entry contributes.
    const added: { registry: unknown; item: unknown }[] = []
    const ctx = {
      layout: { settings: () => {} },
      dialogs: { open: () => {} },
      add: (registry: unknown, item: unknown) => {
        added.push({ registry, item })
        return () => {}
      },
      t: (key: string) => key,
    }
    const dispose = createRoot((dispose) => {
      // SAFETY: `register` reads only the members the stand-in provides.
      register(ctx as never, (() => ({ status: "connecting" })) as never)
      return dispose
    })
    const page = added.find((entry) => entry.registry === SettingsPage)?.item as SettingsPage
    expect(view.settings).toEqual([page.id])
    dispose()
  })
})
