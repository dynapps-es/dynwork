import { describe, expect, test } from "bun:test"
import { DynWorkIdentity } from "@dynwork/branding/identity"
import path from "node:path"
import { DynWorkVite } from "../src/vite"

const repo = path.join(import.meta.dir, "..", "..", "..", "..")

const transpiler = new Bun.Transpiler({ loader: "tsx" })

const scan = async (file: string) => transpiler.scan(await Bun.file(path.resolve(repo, file)).text())

const specifiers = async (file: string) => (await scan(file)).imports.map((item) => item.path)

const [themeAlias, logoAlias, wordmarkAlias] = DynWorkVite.aliases.renderer

// The aliases match specifiers with regular expressions, so they only work while some upstream file imports a specifier
// they match. Each row is an upstream importer the build bundles and the alias that must still catch it.
const importers = [
  { process: "main", importer: "packages/desktop/src/main/windows/defaults.ts", alias: themeAlias },
  { process: "renderer", importer: "packages/ui/src/theme/context.tsx", alias: themeAlias },
  { process: "renderer", importer: "packages/desktop/src/renderer/startup/splash.tsx", alias: logoAlias },
  { process: "renderer", importer: "packages/desktop/src/renderer/startup/splash.tsx", alias: wordmarkAlias },
] as const

const hook = (plugin: ReturnType<typeof DynWorkVite.main>[number]) => {
  if (typeof plugin.config !== "function") throw new Error(`${plugin.name} has no config hook`)

  return plugin.config.call({} as never, {}, { command: "build", mode: "production" })
}

describe("alias contract", () => {
  test.each(importers)("$alias.find still matches a specifier imported by $importer ($process)", async (row) => {
    const matched = (await specifiers(row.importer)).filter((specifier) => row.alias.find.test(specifier))

    expect(matched.length).toBeGreaterThan(0)
  })

  test("every alias replacement is an existing file", async () => {
    const replacements = [
      ...new Set([...DynWorkVite.aliases.main, ...DynWorkVite.aliases.renderer].map((a) => a.replacement)),
    ]

    expect(replacements.length).toBe(3)
    expect(await Promise.all(replacements.map((file) => Bun.file(file).exists()))).toEqual(replacements.map(() => true))
  })

  // @opencode/ui/logo and @opencode/ui/wordmark are resolved through the ui package exports; if upstream remaps them,
  // the alias still matches the specifier but replaces a different module than the one we compared exports with.
  test.each([
    { specifier: "@opencode/ui/logo", file: "packages/ui/src/components/logo.tsx" },
    { specifier: "@opencode/ui/wordmark", file: "packages/ui/src/typography/wordmark/wordmark.tsx" },
  ])("$specifier resolves to $file", (row) => {
    expect(Bun.resolveSync(row.specifier, path.join(repo, "packages/desktop"))).toBe(path.join(repo, row.file))
  })

  test("the theme alias catches the bundled default theme and nothing else", async () => {
    expect(await Bun.file(path.join(repo, "packages/ui/src/theme/themes/oc-2.json")).exists()).toBe(true)
    expect(
      ["./themes/oc-2.json", "../../../../ui/src/theme/themes/oc-2.json", "/abs/ui/src/theme/themes/oc-2.json"].map(
        (specifier) => themeAlias.find.test(specifier),
      ),
    ).toEqual([true, true, true])
    expect(
      ["./themes/oc-2-deep.json", "./themes/oc-1.json", "./oc-2.json"].map((s) => themeAlias.find.test(s)),
    ).toEqual([false, false, false])
  })
})

describe("swapped modules", () => {
  // A missing export in our module would break the renderer build, or worse, import undefined at runtime.
  test.each([
    { upstream: "packages/ui/src/components/logo.tsx", ours: logoAlias.replacement },
    { upstream: "packages/ui/src/typography/wordmark/wordmark.tsx", ours: wordmarkAlias.replacement },
    {
      upstream: "packages/app/src/new-session/wordmark.tsx",
      ours: path.join(repo, "dynwork/packages/branding/src/new-session-wordmark.tsx"),
    },
  ])("$ours exports everything $upstream does", async (row) => {
    const upstream = await scan(row.upstream)

    expect(upstream.exports.length).toBeGreaterThan(0)
    expect((await scan(row.ours)).exports).toEqual(expect.arrayContaining(upstream.exports))
  })

  test("the theme keeps the top-level shape of the bundled one", async () => {
    const upstream = await Bun.file(path.join(repo, "packages/ui/src/theme/themes/oc-2.json")).json()
    const ours = await Bun.file(themeAlias.replacement).json()

    expect(Object.keys(ours)).toEqual(Object.keys(upstream))
    expect(ours.id).toBe(upstream.id)
  })
})

describe("new session wordmark plugin", () => {
  const resolve = (source: string, importer: string) => {
    const resolveId = DynWorkVite.newSessionWordmark.resolveId

    if (typeof resolveId !== "function") throw new Error("resolveId is not a function")

    return resolveId.call({} as never, source, importer, { attributes: {}, isEntry: false })
  }

  test("view.tsx still imports ./wordmark", async () => {
    expect(await Bun.file(DynWorkVite.newSessionView).exists()).toBe(true)
    expect(await specifiers("packages/app/src/new-session/view.tsx")).toContain("./wordmark")
  })

  test("swaps ./wordmark for view.tsx only", async () => {
    const swapped = await resolve("./wordmark", DynWorkVite.newSessionView)

    expect(swapped).toEndWith("dynwork/packages/branding/src/new-session-wordmark.tsx")
    expect(await Bun.file(String(swapped)).exists()).toBe(true)
    expect(await resolve("./wordmark", path.join(repo, "packages/app/src/other.tsx"))).toBeUndefined()
    expect(await resolve("./other", DynWorkVite.newSessionView)).toBeUndefined()
  })
})

describe("plugins", () => {
  test("main carries the channel and the theme alias", () => {
    const plugins = DynWorkVite.main()

    expect(plugins.map((plugin) => plugin.name)).toEqual(["dynwork:channel", "dynwork:main-aliases"])
    expect(hook(plugins[1])).toEqual({ resolve: { alias: DynWorkVite.aliases.main } })
  })

  test("renderer carries the channel, the theme and logo aliases and the new session plugin", () => {
    const plugins = DynWorkVite.renderer()

    expect(plugins.map((plugin) => plugin.name)).toEqual([
      "dynwork:channel",
      "dynwork:renderer-aliases",
      "dynwork:new-session-wordmark",
    ])
    expect(hook(plugins[1])).toEqual({ resolve: { alias: DynWorkVite.aliases.renderer } })
    expect(plugins[2].enforce).toBe("pre")
  })

  // DynWorkIdentity reads this exact expression, so the define must key on the same text.
  test.each([
    { process: "main", plugin: () => DynWorkVite.main()[0] },
    { process: "renderer", plugin: () => DynWorkVite.renderer()[0] },
  ])("the $process bundle fixes the build-time channel", (row) => {
    expect(hook(row.plugin())).toEqual({
      define: { "process.env.DYNWORK_CHANNEL": JSON.stringify(DynWorkIdentity.channel) },
    })
  })

  // The define replaces the expression the identity reads, so a packaged app never reads the user's environment: with
  // the plugin's own define applied, the identity source holds no `process.env` read and carries the build's channel.
  test("the define leaves no runtime environment read in the identity", async () => {
    const define = hook(DynWorkVite.main()[0])
    const built = await new Bun.Transpiler({ loader: "ts", define: define?.define }).transform(
      await Bun.file(path.join(repo, "dynwork/packages/branding/src/identity.ts")).text(),
    )

    expect(built).not.toContain("process.env")
    expect(built).toContain(JSON.stringify(DynWorkIdentity.channel))
  })

  // electron-vite loads the desktop config with Node, not Bun: a module that Node cannot load (a specifier without its
  // extension, as in `identity.ts`'s self-export) fails the packed build and no Bun test would say so.
  // Node is skipped only where it is not installed.
  test.each([
    { runtime: "bun", binary: process.execPath },
    { runtime: "node", binary: Bun.which("node") },
  ])("a build run by $runtime with DYNWORK_CHANNEL=canary fixes canary", (row) => {
    if (!row.binary) return

    const run = Bun.spawnSync({
      cmd: [
        row.binary,
        row.runtime === "node" ? "--input-type=module" : "-e",
        ...(row.runtime === "node" ? ["-e"] : []),
        `import { DynWorkVite } from ${JSON.stringify(path.join(import.meta.dir, "../src/vite.ts"))}
const config = DynWorkVite.channel.config
console.log(JSON.stringify(typeof config === "function" ? config.call({}, {}, { command: "build", mode: "production" }) : undefined))`,
      ],
      env: { ...process.env, DYNWORK_CHANNEL: "canary" },
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(run.stderr.toString()).toBe("")
    expect(JSON.parse(run.stdout.toString())).toEqual({ define: { "process.env.DYNWORK_CHANNEL": '"canary"' } })
  })

  test("a build run without DYNWORK_CHANNEL fixes internal", () => {
    const env = Object.fromEntries(Object.entries(process.env).filter((entry) => entry[0] !== "DYNWORK_CHANNEL"))
    const run = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        `import { DynWorkVite } from ${JSON.stringify(path.join(import.meta.dir, "../src/vite.ts"))}
const config = DynWorkVite.channel.config
console.log(JSON.stringify(typeof config === "function" ? config.call({}, {}, { command: "build", mode: "production" }) : undefined))`,
      ],
      env,
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(JSON.parse(run.stdout.toString())).toEqual({ define: { "process.env.DYNWORK_CHANNEL": '"internal"' } })
  })
})
