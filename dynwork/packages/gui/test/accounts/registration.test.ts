import { describe, expect, test } from "bun:test"
import { runsOn } from "@opencode/plugin/gui/host"
import { createRoot } from "solid-js"
import { Accounts } from "../../src/accounts/contract"
import { DriveClient } from "../../src/drive/client"
import { Drive, Frames, Shares } from "../../src/drive/contract"
import { Remote } from "../../src/remote/contract"
import { RoutinesClient } from "../../src/routines/client"
import { Chat, Routines } from "../../src/routines/contract"
import definition from "../../src/accounts"
import renderer, { connection } from "../../src/accounts/renderer"
import { builtins } from "../../../../../packages/gui-plugins/src/main"

describe("dynwork built-in", () => {
  test("main composes it with its main entry, under the id its Ipc lives in", () => {
    const entry = builtins.find((item) => item.id === "dynwork")
    expect(entry).toBeDefined()
    expect(Accounts.id.split(".")[0]).toBe(entry?.id ?? "")
    expect(Routines.id.split(".")[0]).toBe(entry?.id ?? "")
    // The entry itself imports electron, which only loads inside Electron.
    expect(entry?.mainEntry).toBeFunction()
    // Every upstream built-in is still listed.
    expect(builtins.map((item) => item.id)).toEqual(expect.arrayContaining(["pairing", "updater", "goal"]))
  })

  test("OpenCode's pairing never runs, in main or in a window, and keeps its id", async () => {
    const pairing = builtins.find((item) => item.id === "pairing")
    expect(pairing).toBeDefined()
    expect((["macos", "windows", "linux"] as const).filter((os) => runsOn(pairing ?? {}, os))).toEqual([])
    const source = await Bun.file(
      new URL("../../../../../packages/gui-plugins/src/renderer.ts", import.meta.url),
    ).text()
    expect(source).toContain("  pairing: { ...pairing, os: [], windowEntry: eager(pairingRenderer) },\n")
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
      // The settings page, the pill and the Runs panel register against these; test/ui/register.test.ts reads what
      // the first two add. No session is routed, so the panel opens nowhere.
      add: () => () => {},
      t: (key: string) => key,
      layout: { ready: () => false },
      sessions: { current: () => undefined },
      // The Drive opens how the user lays out a document; it has not loaded here.
      storage: { store: () => ({ value: undefined, ready: () => false, update: () => {}, set: () => {} }) },
    }
    expect(definition).toBeObject()
    const dispose = createRoot((dispose) => {
      // SAFETY: the setup reads only `desktop`, `use`, `add`, `t`, `layout.ready`, `sessions.current` and
      // `storage.store`, which the stand-in provides.
      renderer(ctx as unknown as Parameters<typeof renderer>[0])
      return dispose
    })
    // The Drive, main's observer of its frames and the agent's share cards, remote control, the routines and their chat
    // cards ride on the same built-in
    expect(used).toEqual([Accounts, Drive, Frames, Shares, Remote, Routines, Chat])
    expect(connection()).toEqual({ status: "pending" })
    expect(DriveClient.connection()).toEqual({ status: "pending" })
    expect(RoutinesClient.connection()).toEqual({ status: "pending" })
    expect(RoutinesClient.chatConnection()).toEqual({ status: "pending" })
    dispose()
    expect(connection()).toBeUndefined()
    expect(DriveClient.connection()).toBeUndefined()
    expect(RoutinesClient.connection()).toBeUndefined()
    expect(RoutinesClient.chatConnection()).toBeUndefined()
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
    expect(DriveClient.connection()).toBeUndefined()
    expect(RoutinesClient.connection()).toBeUndefined()
    expect(RoutinesClient.chatConnection()).toBeUndefined()
  })
})
