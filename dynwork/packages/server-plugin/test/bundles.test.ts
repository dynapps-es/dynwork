import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { DynWorkSync } from "../src/contract"
import { DynWorkBundles } from "../src/bundles"
import { DynWorkMapping } from "../src/mapping"
import { alpha, apply } from "./fixture"

// The files the systemprompt bridge projects for OpenCode out of each plugin bundle (`managed_resources/content.rs`,
// `owned.rs`): bundle plugins, agents as sub-agents and pinned themes, each checked against the digest the manifest
// signed, recorded in `.systemprompt-owned.json` and removed once the manifest stops projecting them.

const sha = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex")
const base64 = (text: string) => Buffer.from(text).toString("base64")

type Plugin = NonNullable<DynWorkSync.Manifest["plugins"]>[number]
const plugin = (id: string, files: Record<string, string>): Plugin => ({
  id,
  files: Object.entries(files).map(([file, text]) => ({ path: file, sha256: sha(text) })),
})
const delivered = (id: string, files: Record<string, string>) =>
  Object.entries(files).map(([file, text]) => ({ plugin: id, path: file, content: base64(text) }))
const manifest = (plugins: Plugin[], opencode?: Record<string, unknown>): DynWorkSync.Manifest => ({
  ...alpha,
  plugins,
  marketplaces: [{ id: "m", ...(opencode ? { opencode } : {}) }],
})

const header = 'export default { id: "dynwork.session-header", setup: async () => {} }\n'
const theme = '{ "base": {} }\n'
// What prod's `dynwork-common` plugin ships for OpenCode, next to files OpenCode has no use for.
const common = {
  ".claude-plugin/plugin.json": "{}",
  "skills/notes/SKILL.md": "# Notes",
  "hosts/opencode/plugins/session-header.js": header,
  "hosts/opencode/themes/dynwork.json": theme,
}

describe("wanted", () => {
  test("lists only the files OpenCode gets: agents, bundle plugins and pinned themes, by plugin id", () => {
    const listed = DynWorkBundles.wanted(
      manifest(
        [
          plugin("zeta", {
            "agents/helper.md": "# Helper",
            "agents/nested/deep.md": "# Deep",
            "agents/notes.txt": "x",
            "hosts/opencode/plugins/extra.ts": "export {}",
            "hosts/opencode/plugins/nested/x.js": "x",
            "hosts/opencode/plugins/style.css": "x",
          }),
          plugin("dynwork-common", common),
          plugin("../escape", { "agents/evil.md": "x" }),
        ],
        { themes: [{ name: "dynwork", sha: sha(theme) }] },
      ),
    )
    expect(listed.map((file) => `${file.plugin}/${file.path}`)).toEqual([
      "dynwork-common/hosts/opencode/plugins/session-header.js",
      "dynwork-common/hosts/opencode/themes/dynwork.json",
      "zeta/agents/helper.md",
      "zeta/hosts/opencode/plugins/extra.ts",
    ])
    expect(listed[0]?.sha256).toBe(sha(header))
  })

  test("a theme is wanted only at the digest a marketplace pins, and its desktop variant whenever it is listed", () => {
    const files = { "hosts/opencode/themes/dynwork.json": theme, "hosts/opencode/desktop-themes/dynwork.json": "{}" }
    const pinned = (opencode?: Record<string, unknown>) =>
      DynWorkBundles.wanted(manifest([plugin("p", files)], opencode)).map((file) => file.path)
    expect(pinned()).toEqual([])
    expect(pinned({ themes: [{ name: "dynwork", sha: sha("another build") }] })).toEqual([
      "hosts/opencode/desktop-themes/dynwork.json",
    ])
    // A 0.73 gateway sends one `theme` instead of `themes`
    expect(pinned({ theme: { name: "dynwork", sha: sha(theme) } })).toEqual([
      "hosts/opencode/themes/dynwork.json",
      "hosts/opencode/desktop-themes/dynwork.json",
    ])
  })
})

describe("project", () => {
  test("bundle plugins keep their bytes under the plugin's id, as the bridge names them", () => {
    const projected = DynWorkBundles.project(
      manifest([plugin("dynwork-common", common)], { themes: [{ name: "dynwork", sha: sha(theme) }] }),
      delivered("dynwork-common", common),
    )
    expect(projected.warnings).toEqual([])
    expect(projected.files.map((file) => [file.path, Buffer.from(file.bytes).toString()])).toEqual([
      ["plugins/dynwork-common-session-header.js", header],
      ["themes/dynwork.json", theme],
    ])
  })

  test("agents become sub-agents: a mode of their own is replaced, and front matter is added when there is none", () => {
    const files = {
      "agents/reviewer.md": "---\ndescription: Reviews\nmode: primary\n---\n\nReview it.\n",
      "agents/plain.md": "\uFEFFJust a prompt.\n",
    }
    const projected = DynWorkBundles.project(manifest([plugin("p", files)]), delivered("p", files))
    expect(projected.files.map((file) => [file.path, Buffer.from(file.bytes).toString()])).toEqual([
      ["agents/plain.md", "---\nmode: subagent\n---\n\nJust a prompt.\n"],
      ["agents/reviewer.md", "---\nmode: subagent\ndescription: Reviews\n---\n\nReview it.\n"],
    ])
  })

  test("a file whose bytes do not match the manifest is skipped with a warning, and the next plugin's takes the name", () => {
    const first = plugin("a-first", { "agents/helper.md": "# Signed" })
    const second = plugin("b-second", { "agents/helper.md": "# Second" })
    const projected = DynWorkBundles.project(manifest([second, first]), [
      ...delivered("a-first", { "agents/helper.md": "# Tampered" }),
      ...delivered("b-second", { "agents/helper.md": "# Second" }),
    ])
    expect(projected.files.map((file) => Buffer.from(file.bytes).toString())).toEqual([
      "---\nmode: subagent\n---\n\n# Second",
    ])
    expect(projected.warnings).toEqual([expect.stringContaining("agents/helper.md of plugin a-first not projected")])
  })

  test("the first plugin by id wins a name, and a file main could not fetch is reported", () => {
    const files = { "agents/helper.md": "# Helper" }
    const projected = DynWorkBundles.project(
      manifest([plugin("b", files), plugin("a", files), plugin("c", { "agents/other.md": "# Other" })]),
      [...delivered("b", files), ...delivered("a", files)],
    )
    expect(projected.files.map((file) => file.path)).toEqual(["agents/helper.md"])
    expect(projected.warnings).toEqual([expect.stringContaining("agents/other.md of plugin c not projected")])
  })

  test("the mapping projects bundles only while OpenCode is an enabled host", () => {
    const files = { "agents/helper.md": "# Helper" }
    const input = (enabled: string[]) =>
      apply({ ...alpha, enabled_hosts: enabled, plugins: [plugin("p", files)] }, { files: delivered("p", files) })
    expect(DynWorkMapping.map(input(["opencode"])).owned?.files.map((file) => file.path)).toEqual(["agents/helper.md"])
    expect(DynWorkMapping.map(input(["claude-code"])).owned).toBeUndefined()
  })
})

describe("write", () => {
  const roots: string[] = []
  afterEach(() => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))
  const directory = async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dynwork-bundles-"))
    roots.push(root)
    return root
  }
  const tree = async (root: string) =>
    (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: root, dot: true }))).toSorted()
  const files = (entries: Record<string, string>) =>
    Object.entries(entries).map(([file, text]) => ({ path: file, bytes: Buffer.from(text) }))

  test("writes the files and the bridge's ledger byte for byte, and an unchanged file is not rewritten", async () => {
    const root = await directory()
    await DynWorkBundles.write(root, {
      files: files({ "themes/dynwork.json": theme, "plugins/dynwork-common-session-header.js": header }),
      warnings: [],
    })
    expect(await tree(root)).toEqual([
      ".systemprompt-owned.json",
      "plugins/dynwork-common-session-header.js",
      "themes/dynwork.json",
    ])
    // The ledger the bridge left in prod's `~/.config/opencode`: serde_json's pretty print, sorted, no final newline
    expect(await Bun.file(path.join(root, ".systemprompt-owned.json")).text()).toBe(
      '{\n  "files": [\n    "plugins/dynwork-common-session-header.js",\n    "themes/dynwork.json"\n  ]\n}',
    )
    expect(await Bun.file(path.join(root, "plugins/dynwork-common-session-header.js")).text()).toBe(header)
    const inode = (await stat(path.join(root, "themes/dynwork.json"))).ino
    await DynWorkBundles.write(root, {
      files: files({ "themes/dynwork.json": theme, "plugins/dynwork-common-session-header.js": "// v2\n" }),
      warnings: [],
    })
    expect((await stat(path.join(root, "themes/dynwork.json"))).ino).toBe(inode)
    expect(await Bun.file(path.join(root, "plugins/dynwork-common-session-header.js")).text()).toBe("// v2\n")
  })

  test("a file that left the manifest is removed, the user's own files beside it stay", async () => {
    const root = await directory()
    await DynWorkBundles.write(root, { files: files({ "agents/a.md": "a", "agents/b.md": "b" }), warnings: [] })
    await Bun.write(path.join(root, "agents/mine.md"), "mine")
    await Bun.write(path.join(root, "plugins/mine.js"), "mine")
    await DynWorkBundles.write(root, { files: files({ "agents/b.md": "b" }), warnings: [] })
    expect(await tree(root)).toEqual([".systemprompt-owned.json", "agents/b.md", "agents/mine.md", "plugins/mine.js"])
    // Nothing projected: every owned file and the ledger go
    await DynWorkBundles.write(root, undefined)
    expect(await tree(root)).toEqual(["agents/mine.md", "plugins/mine.js"])
  })

  test("a corrupt ledger, or one naming a file the bridge never writes, fails and leaves every file as it was", async () => {
    const root = await directory()
    await DynWorkBundles.write(root, { files: files({ "agents/a.md": "a" }), warnings: [] })
    await Bun.write(path.join(root, "opencode.json"), "{}")
    const ledger = path.join(root, ".systemprompt-owned.json")
    await Bun.write(ledger, "{ not json")
    await expect(DynWorkBundles.write(root, undefined)).rejects.toThrow("is corrupt")
    for (const entry of ["opencode.json", "../outside.js", "/etc/hosts", "agents/../opencode.json"]) {
      await Bun.write(ledger, JSON.stringify({ files: [entry] }))
      await expect(DynWorkBundles.write(root, undefined)).rejects.toThrow("is corrupt")
    }
    expect(await tree(root)).toEqual([".systemprompt-owned.json", "agents/a.md", "opencode.json"])
  })

  test("a projected path outside the bridge's shapes is never written", async () => {
    const root = await directory()
    await expect(DynWorkBundles.write(root, { files: files({ "../escape.js": "x" }), warnings: [] })).rejects.toThrow()
    expect(await tree(root)).toEqual([])
  })
})
