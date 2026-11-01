import { describe, expect, test } from "bun:test"
import agents from "../../src/views/agents"
import brain from "../../src/views/brain"
import routines from "../../src/views/routines"
import en from "../../src/views/en"
import { entries } from "../../src/views/entries"
import { views } from "../../src/views/route"

describe("the page route", () => {
  test.each([
    ["agents", agents],
    ["routines", routines],
    ["brain", brain],
  ] as const)("/page/%s mounts its view", async (id, view) => {
    const lazy = views.get(id)
    expect(lazy).toBeDefined()
    expect((await lazy?.preload())?.default).toBe(view)
  })

  test("pages DynWork does not own mount nothing", () => {
    expect(views.get("systemprompt")).toBeUndefined()
    expect(views.get("settings")).toBeUndefined()
  })

  test("every sidebar row has its label and every view its title", () => {
    const table: Record<string, string> = en
    expect(entries.filter((entry) => !table[entry.label])).toEqual([])
    expect([...views.keys()].filter((id) => !table[`${id}.title`])).toEqual([])
    expect(entries.filter((entry) => !entry.settings).map((entry) => entry.id)).toEqual([...views.keys()])
  })
})
