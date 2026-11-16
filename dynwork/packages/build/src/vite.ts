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
  main: (): Plugin[] => [channel, aliasing("dynwork:main-aliases", aliases.main)],
  renderer: (): Plugin[] => [channel, aliasing("dynwork:renderer-aliases", aliases.renderer), newSessionWordmark],
}
