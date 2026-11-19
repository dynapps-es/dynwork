export * as DrivePresent from "./present"

import type { BrowserWindow, WebContents } from "electron"

// Present: a document alone, with its window full screen. The window cannot take itself full screen from the page: the
// app's windows grant a page no `fullscreen` permission (`packages/desktop/src/main/windows/security.ts`), so the
// Fullscreen API is refused there. Main does it instead, for the window that asks, while the window holds the call
// (`Frames.present`), and the view shows the document alone over the rest of the window meanwhile. Escape ends it from
// anywhere in the window, a document's frame included: main sees the key before any page does.

/** What `make` needs of a window. */
export type Window = Pick<BrowserWindow, "isDestroyed" | "isFullScreen" | "setFullScreen" | "on" | "off"> & {
  readonly webContents: Pick<WebContents, "on" | "off">
}

export interface Options {
  /** A window by id; undefined once it is gone. */
  window: (id: number) => Window | undefined
}

export function make(options: Options) {
  return {
    /**
     * Takes the window full screen until `signal` aborts, then back, unless it was full screen already. Returns early,
     * after the same, when the user presses Escape, the window leaves full screen another way, or it closes.
     */
    present(window: number, signal: AbortSignal) {
      const win = options.window(window)
      if (!win || win.isDestroyed() || signal.aborted) return Promise.resolve()
      // A window the user had full screen stays so afterwards.
      const entered = !win.isFullScreen()
      if (entered) win.setFullScreen(true)
      return new Promise<void>((resolve) => {
        const end = (restore: boolean) => {
          signal.removeEventListener("abort", aborted)
          win.off("leave-full-screen", left)
          win.off("closed", closed)
          win.webContents.off("before-input-event", key)
          if (restore && entered && !win.isDestroyed()) win.setFullScreen(false)
          resolve()
        }
        const aborted = () => end(true)
        const left = () => end(false)
        const closed = () => end(false)
        const key = (_event: unknown, input: Electron.Input) => {
          if (input.type === "keyDown" && input.key === "Escape") end(true)
        }
        signal.addEventListener("abort", aborted, { once: true })
        win.on("leave-full-screen", left)
        win.on("closed", closed)
        win.webContents.on("before-input-event", key)
      })
    },
  }
}
