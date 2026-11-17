import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Plugin } from "vite"

const branding = (file: string) => fileURLToPath(new URL(`../../branding/${file}`, import.meta.url))

const newSessionView = fileURLToPath(new URL("../../../../packages/app/src/new-session/view.tsx", import.meta.url))

// DynWork ships its Dynapps theme under the bundled default's id, so the main and renderer imports of oc-2.json
// (static and import.meta.glob) load it and every upstream "oc-2" default path keeps working unchanged.
const defaultTheme = {
  find: /^(?:.*\/)?themes\/oc-2\.json$/,
  replacement: branding("theme/dynapps.json"),
}

// DynWork logos: the renderer's logo and wordmark modules, which come from the branding package with the same exports.
const logos = [
  { find: /^@opencode\/ui\/logo$/, replacement: branding("src/logo.tsx") },
  { find: /^@opencode\/ui\/wordmark$/, replacement: branding("src/wordmark.tsx") },
]

// The new session's easter-egg wordmark, which view.tsx imports by a relative path.
const newSessionWordmark: Plugin = {
  name: "dynwork:new-session-wordmark",
  enforce: "pre",
  resolveId(source, importer) {
    if (source !== "./wordmark" || importer !== newSessionView) return undefined

    return branding("src/new-session-wordmark.tsx")
  },
}

// Fixes the channel into the bundle: `DynWorkIdentity` reads `process.env.DYNWORK_CHANNEL`, and without this a packaged
// app would take its app id, scheme and port from whatever environment the user launches it in. The build runs with the
// channel it packages. This config is loaded by Node, which cannot load `identity.ts` (its self-export has no file
// extension), so the value is read here as it is; the identity validates it when the packer and the app load it.
const channel: Plugin = {
  name: "dynwork:channel",
  config: () => ({
    define: { "process.env.DYNWORK_CHANNEL": JSON.stringify(process.env.DYNWORK_CHANNEL ?? "internal") },
  }),
}

// AppKit's sidebar glass (`@dynwork/gui`'s `views/glass`): a Mac build compiles its addon, for both Mac architectures,
// and writes it next to the main bundle, where `SidebarGlass` loads it. Other platforms build without it. It compiles
// once per run, and a watching dev build reuses it.
const glassSource = fileURLToPath(new URL("../../gui/src/views/glass/glass.mm", import.meta.url))

const compileGlass = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dynwork-glass-"))
  const out = path.join(dir, "glass.node")
  execFileSync("xcrun", [
    "clang++",
    "-std=c++17",
    "-ObjC++",
    "-fobjc-arc",
    "-O2",
    "-shared",
    "-undefined",
    "dynamic_lookup",
    "-arch",
    "arm64",
    "-arch",
    "x86_64",
    "-mmacosx-version-min=12.0",
    "-framework",
    "AppKit",
    glassSource,
    "-o",
    out,
  ])
  const addon = readFileSync(out)
  rmSync(dir, { recursive: true, force: true })
  return addon
}

const glass = (): Plugin => {
  const built: { addon?: Buffer } = {}
  return {
    name: "dynwork:sidebar-glass",
    apply: () => process.platform === "darwin",
    generateBundle() {
      built.addon ??= compileGlass()
      this.emitFile({ type: "asset", fileName: "sidebar-glass.node", source: built.addon })
    },
  }
}

const aliases = { main: [defaultTheme], renderer: [defaultTheme, ...logos] }

const aliasing = (name: string, alias: typeof logos): Plugin => ({
  name,
  config: () => ({ resolve: { alias } }),
})

// Every build-time swap DynWork makes. The desktop config spreads `main()` and `renderer()` into the plugins of its
// own process and holds no swap of its own, so a new swap lands here and not in an upstream file.
export const DynWorkVite = {
  // The alias tables and the plugins are also data, for the contract test.
  aliases,
  newSessionView,
  newSessionWordmark,
  channel,
  glassSource,
  main: (): Plugin[] => [channel, aliasing("dynwork:main-aliases", aliases.main), glass()],
  renderer: (): Plugin[] => [channel, aliasing("dynwork:renderer-aliases", aliases.renderer), newSessionWordmark],
}
