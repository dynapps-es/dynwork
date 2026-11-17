export * as SidebarGlass from "./glass"

import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { nativeTheme, type BrowserWindow } from "electron"
import type { MainContext } from "@opencode/plugin/gui/main"

/** What the addon (`glass.mm`) exports. `handle` is `BrowserWindow.getNativeWindowHandle()`. */
interface Addon {
  attach(handle: Buffer, color: string): void
  detach(handle: Buffer): void
}

/** The addon's file, which `@dynwork/build`'s vite plugin writes next to the main bundle. */
export const FILE = "sidebar-glass.node"

/** The first macOS whose AppKit sidebar is glass. Older ones keep Electron's material (desktop `windows/defaults.ts`). */
export const SINCE = 26

/**
 * The solid colour behind the glass: it keeps the windows behind from showing through, and sets how dark the glass
 * reads. Dark goes to black, under DynWork's near-black theme; light is Claude desktop's.
 */
export const backing = (dark: boolean) => (dark ? "#000000" : "#fafafa")

/**
 * Puts AppKit's sidebar glass behind every DynWork window on macOS 26 and later, in place of Electron's material, and
 * follows the app's light or dark scheme (`nativeTheme` follows it). The shell's chrome is transparent over it
 * (`../vibrancy.css`). Elsewhere, or when the addon does not load, the windows keep Electron's material.
 */
export function setup(ctx: MainContext) {
  if (process.platform !== "darwin" || Number(process.getSystemVersion().split(".")[0]) < SINCE) return
  const addon = load(ctx)
  if (!addon) return

  const paint = (window: BrowserWindow) =>
    addon.attach(window.getNativeWindowHandle(), backing(nativeTheme.shouldUseDarkColors))
  const attach = (window: BrowserWindow) => {
    paint(window)
    // Electron's material sits behind every view of the window and would cover the glass.
    window.setVibrancy(null)
  }
  ctx.windows.list().forEach(attach)
  ctx.onCleanup(ctx.windows.on("open", attach))

  const repaint = () => ctx.windows.list().forEach(paint)
  nativeTheme.on("updated", repaint)
  ctx.onCleanup(() => {
    nativeTheme.off("updated", repaint)
    ctx.windows.list().forEach((window) => {
      addon.detach(window.getNativeWindowHandle())
      window.setVibrancy("sidebar")
    })
  })
}

// SAFETY: the addon is DynWork's own `glass.mm`, built with this bundle; its exports are `Addon`. A file that does not
// load (a build without it, another architecture) leaves the windows with Electron's material instead of failing the
// plugin, so this boundary catches.
function load(ctx: MainContext) {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), FILE)
  try {
    return createRequire(import.meta.url)(file) as Addon
  } catch (error) {
    ctx.log.write("warn", "sidebar glass did not load; the window keeps Electron's material", {
      file,
      error: String(error),
    })
    return undefined
  }
}
