import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { Accounts } from "../../src/accounts/contract"
import definition from "../../src/accounts"
import renderer, { connection } from "../../src/accounts/renderer"
import { builtins } from "../../../../../packages/gui-plugins/src/main"

describe("dynwork built-in", () => {
  test("main composes it with its main entry, under the id its Ipc lives in", () => {
    const entry = builtins.find((item) => item.id === "dynwork")
    expect(entry).toBeDefined()
    expect(Accounts.id.split(".")[0]).toBe(entry?.id ?? "")
    // The entry itself imports electron, which only loads inside Electron.
    expect(entry?.mainEntry).toBeFunction()
    // Every upstream built-in is still listed.
    expect(builtins.map((item) => item.id)).toEqual(expect.arrayContaining(["pairing", "updater", "goal"]))
  })

  test("the window list composes it with its window entry", async () => {
    // The window list imports every built-in's renderer and its CSS, which only the app's Vite build resolves, so the
    // contract is read from its source: the two imports and one entry inside `compose`.
    const root = new URL("../../../../../packages/gui-plugins/", import.meta.url)
    const source = await Bun.file(new URL("src/renderer.ts", root)).text()
    expect(source).toContain('import dynwork from "@dynwork/gui/accounts"\n')
    expect(source).toContain('import dynworkRenderer from "@dynwork/gui/accounts/renderer"\n')
    const composed = source.slice(source.indexOf("export const builtins = compose({"))
    expect(composed).toContain("  dynwork: { ...dynwork, windowEntry: eager(dynworkRenderer) },\n})")
    const manifest = await Bun.file(new URL("package.json", root)).json()
    expect(manifest.dependencies["@dynwork/gui"]).toBe("workspace:*")
  })

  test("the window entry hands the live Ipc to the sign-in gate while it runs", () => {
    const live = () => ({ status: "pending" as const })
    const used: unknown[] = []
    const ctx = {
      desktop: {},
      use: (token: unknown) => {
        used.push(token)
        return live
      },
      // The settings page and the pill register against these; test/ui/register.test.ts reads what they add.
      add: () => () => {},
      layout: {},
    }
    expect(definition).toBeObject()
    const dispose = createRoot((dispose) => {
      // SAFETY: the setup reads only `desktop` and `use`, which the stand-in provides.
      renderer(ctx as unknown as Parameters<typeof renderer>[0])
      return dispose
    })
    expect(used).toEqual([Accounts])
    expect(connection()).toEqual({ status: "pending" })
    dispose()
    expect(connection()).toBeUndefined()
  })

  test("the window entry does nothing on the web", () => {
    const used: unknown[] = []
    createRoot((dispose) => {
      // SAFETY: the setup returns before it reads anything but `desktop`.
      renderer({ desktop: undefined, use: (token: unknown) => used.push(token) } as unknown as Parameters<
        typeof renderer
      >[0])
      dispose()
    })
    expect(used).toEqual([])
    expect(connection()).toBeUndefined()
  })
})
