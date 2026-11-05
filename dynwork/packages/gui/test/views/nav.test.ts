import { describe, expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { navRows, robot } from "../../src/views/entries"
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
  test("show Agents and Brain, in that order; the governance settings are not a row", () => {
    const view = setup()
    expect(view.rows.map((row) => row.label())).toEqual(["Agents", "Brain"])
    expect(view.rows.map((row) => row.icon)).toEqual([robot, "brain"])
  })

  test("highlight the routed view's row and follow the route; Agents holds the routines too", () => {
    const view = setup("/page/agents")
    const active = () => view.rows.filter((row) => row.active()).map((row) => row.id)
    expect(active()).toEqual(["agents"])

    view.route("/page/routines")
    expect(active()).toEqual(["agents"])

    view.route("/page/brain?from=search")
    expect(active()).toEqual(["brain"])

    view.route("/")
    expect(active()).toEqual([])

    view.route("/settings")
    expect(active()).toEqual([])
  })

  test("each row opens its page in the main area, never a settings page", () => {
    const view = setup()
    view.rows.forEach((row) => row.open())
    expect(view.pages).toEqual(["agents", "brain"])
    expect(view.settings).toEqual([])
  })
})
