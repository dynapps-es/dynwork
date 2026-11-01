import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { SettingsPage, TitlebarItem } from "@opencode/plugin/gui"
import type { State } from "../../src/accounts/contract"
import { register } from "../../src/accounts/ui/register"
import { account, state, synced } from "./fixture"

// The window entry's context, as far as `register` uses it: it records what is added and what dialogs open, and
// translates a key into "key|params" so the assertions read what the page would look up.
function setup(initial: State | undefined) {
  const [current, setCurrent] = createSignal(initial)
  const added: { registry: unknown; item: unknown }[] = []
  const settings: string[] = []
  const opened: unknown[] = []
  const calls: string[] = []
  const ctx = {
    layout: { settings: (page: string) => settings.push(page) },
    dialogs: { open: (render: unknown) => opened.push(render) },
    add: (registry: unknown, item: unknown) => {
      added.push({ registry, item })
      return () => {}
    },
    t: (key: string, params?: Record<string, string>) => (params ? `${key}|${JSON.stringify(params)}` : key),
    plural: (key: string, count: number) => `${key}|${count}`,
  }
  const live = () => ({
    status: "active" as const,
    generation: 1,
    value: {
      state: current,
      activate: async (id: string) => void calls.push(`activate:${id}`),
      syncNow: async () => void calls.push("syncNow"),
    },
  })
  const dispose = createRoot((dispose) => {
    // SAFETY: `register` reads only the members the stand-in provides; the rest of the context is the host's.
    register(ctx as never, live as never)
    return dispose
  })

  return { added, settings, opened, calls, set: setCurrent, dispose }
}

describe("the window entry's contributions", () => {
  test("a settings page of its own, found by search, and a titlebar pill", () => {
    const view = setup(undefined)
    const page = view.added.find((entry) => entry.registry === SettingsPage)?.item as SettingsPage
    expect(page).toMatchObject({ id: "accounts", icon: "lock", title: "title" })
    expect(page.page).toBeUndefined()
    expect(page.entries).toEqual([{ id: "accounts", title: "title", keywords: "keywords" }])
    expect(view.added.some((entry) => entry.registry === TitlebarItem)).toBe(true)
    view.dispose()
  })

  test("the pill shows with the active instance and follows the accounts' state", () => {
    const view = setup(undefined)
    const pill = view.added.find((entry) => entry.registry === TitlebarItem)?.item as () => TitlebarItem | undefined
    expect(pill()).toBeUndefined()

    view.set(state([account({ active: true })], synced("alpha", Date.now())))
    const item = pill()
    expect(item).toMatchObject({ id: "systemprompt", icon: "circle-check" })
    expect(item?.label).toContain("Dynapps")
    expect(item?.title).toContain('pill.title|{"label":"Dynapps"}')

    view.set(state([account({ active: true })], { status: "error", account: "alpha", kind: "refused", at: Date.now() }))
    expect(pill()?.icon).toBe("circle-exclamation")
    view.dispose()
  })

  test("clicking the pill opens the instances menu", () => {
    const view = setup(state([account({ active: true })], synced("alpha", Date.now())))
    const pill = view.added.find((entry) => entry.registry === TitlebarItem)?.item as () => TitlebarItem | undefined
    pill()?.run?.()
    expect(view.opened).toHaveLength(1)
    view.dispose()
  })
})
