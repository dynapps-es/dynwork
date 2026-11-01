import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { DynWorkSync } from "../src/contract"
import { DynWorkConfig } from "../src/config"
import { alpha } from "./fixture"

// What the systemprompt bridge merges into OpenCode's own config files (`install/merge.rs`,
// `managed_resources/config_json.rs`): the `policies` that leave its provider the only one, a marketplace's
// `cli_defaults` where the user has not set the key, and its default theme in `cli.json` where none is chosen.

const roots: string[] = []
afterEach(() => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))
const directory = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dynwork-config-"))
  roots.push(root)
  return root
}
const read = async (root: string, file: string) => Bun.file(path.join(root, file)).text()
const marketplaces = (...opencode: Array<Record<string, unknown> | undefined>): DynWorkSync.Manifest => ({
  ...alpha,
  marketplaces: opencode.map((block, index) => ({ id: `m${index}`, ...(block ? { opencode: block } : {}) })),
})

// The two statements as they sit in prod's `~/.config/opencode/opencode.json`
const ours = [
  { effect: "deny", action: "provider.use", resource: "*" },
  { effect: "allow", action: "provider.use", resource: "systemprompt" },
]

describe("policies", () => {
  test("are written ahead of the user's own, once however often the instance is applied", async () => {
    const root = await directory()
    const foreign = { effect: "deny", action: "tool.use", resource: "shell:rm *" }
    await Bun.write(path.join(root, "opencode.json"), JSON.stringify({ $schema: "x", policies: [foreign] }))
    await DynWorkConfig.write(root, { locked: true })
    await DynWorkConfig.write(root, { locked: true })
    // `install/merge.rs`: pretty JSON ending in a newline, the policies key moved to the end
    expect(await read(root, "opencode.json")).toBe(
      `${JSON.stringify({ $schema: "x", policies: [...ours, foreign] }, null, 2)}\n`,
    )
    expect((await stat(path.join(root, "opencode.json"))).mode & 0o777).toBe(0o600)
  })

  test("leaving takes only ours away, and removes a file left empty", async () => {
    const root = await directory()
    const foreign = { effect: "allow", action: "provider.use", resource: "anthropic" }
    await Bun.write(path.join(root, "opencode.json"), JSON.stringify({ model: "x/y", policies: [foreign] }))
    await DynWorkConfig.write(root, { locked: true })
    await DynWorkConfig.write(root, { locked: false })
    expect(JSON.parse(await read(root, "opencode.json"))).toEqual({ model: "x/y", policies: [foreign] })
    const empty = await directory()
    await DynWorkConfig.write(empty, { locked: true })
    expect(JSON.parse(await read(empty, "opencode.json"))).toEqual({ policies: ours })
    await DynWorkConfig.write(empty, { locked: false })
    expect(await Bun.file(path.join(empty, "opencode.json")).exists()).toBe(false)
  })

  test("a config file that is not a JSON object is refused and left as it was", async () => {
    const root = await directory()
    await Bun.write(path.join(root, "opencode.json"), "[1, 2]")
    await expect(DynWorkConfig.write(root, { locked: true })).rejects.toThrow("not a JSON object")
    await Bun.write(path.join(root, "opencode.json"), "{ broken")
    await expect(DynWorkConfig.write(root, { locked: true })).rejects.toThrow()
    expect(await read(root, "opencode.json")).toBe("{ broken")
  })
})

describe("cli_defaults", () => {
  test("every key is set only where the user has not set it, the first marketplace winning a key", async () => {
    const root = await directory()
    await Bun.write(path.join(root, "opencode.json"), JSON.stringify({ model: "mine/model" }))
    const settings = DynWorkConfig.settings(
      marketplaces(
        undefined,
        { cli_defaults: { model: "systemprompt/x", default_agent: "build", share: "disabled" } },
        { cli_defaults: { share: "auto", autoupdate: false } },
      ),
      [],
    )
    await DynWorkConfig.write(root, { locked: false, settings })
    expect(JSON.parse(await read(root, "opencode.json"))).toEqual({
      model: "mine/model",
      default_agent: "build",
      share: "disabled",
      autoupdate: false,
    })
  })

  test("a V1 top-level theme naming a marketplace theme is removed, any other is the user's", async () => {
    const root = await directory()
    const themes = { themes: [{ name: "dynwork", sha: "0".repeat(64) }] }
    await Bun.write(path.join(root, "opencode.json"), JSON.stringify({ theme: "dynwork" }))
    await DynWorkConfig.write(root, { locked: false, settings: DynWorkConfig.settings(marketplaces(themes), []) })
    expect(await Bun.file(path.join(root, "opencode.json")).exists()).toBe(true)
    expect(JSON.parse(await read(root, "opencode.json"))).toEqual({})
    await Bun.write(path.join(root, "opencode.json"), JSON.stringify({ theme: "tokyonight" }))
    await DynWorkConfig.write(root, { locked: false, settings: DynWorkConfig.settings(marketplaces(themes), []) })
    expect(JSON.parse(await read(root, "opencode.json"))).toEqual({ theme: "tokyonight" })
  })
})

describe("default theme", () => {
  const dynwork = { themes: [{ name: "dynwork", sha: "0".repeat(64) }], default_theme: "dynwork" }

  test("is selected in cli.json when it was projected and the user has chosen none, as prod's", async () => {
    const root = await directory()
    await Bun.write(path.join(root, "cli.json"), JSON.stringify({ $schema: "https://opencode.ai/v2/cli.json" }))
    await DynWorkConfig.write(root, {
      locked: false,
      settings: DynWorkConfig.settings(marketplaces(dynwork), ["dynwork"]),
    })
    // `write_json`: serde_json's pretty print without a final newline
    expect(await read(root, "cli.json")).toBe(
      '{\n  "$schema": "https://opencode.ai/v2/cli.json",\n  "theme": {\n    "name": "dynwork"\n  }\n}',
    )
  })

  test("carries the marketplace's mode, and is never forced over a choice or without its file", async () => {
    const root = await directory()
    const settings = (projected: string[], opencode = { ...dynwork, theme_mode: "dark" }) =>
      DynWorkConfig.settings(marketplaces(opencode), projected)
    await DynWorkConfig.write(root, { locked: false, settings: settings([]) })
    expect(await Bun.file(path.join(root, "cli.json")).exists()).toBe(false)
    await DynWorkConfig.write(root, { locked: false, settings: settings(["dynwork"]) })
    expect(JSON.parse(await read(root, "cli.json"))).toEqual({ theme: { name: "dynwork", mode: "dark" } })
    await Bun.write(path.join(root, "cli.json"), JSON.stringify({ theme: { name: "mine" } }))
    await DynWorkConfig.write(root, { locked: false, settings: settings(["dynwork"]) })
    expect(JSON.parse(await read(root, "cli.json"))).toEqual({ theme: { name: "mine" } })
  })
})
