export * as DriveFrames from "./frames"

import type { App, WebContents } from "electron"

// The Drive viewer's HTML frame may run the page's scripts when the instance allows them (D5). A script can still send
// its frame to another page: CSP does not govern navigation, and the frame's sandbox keeps it in the frame. Main keeps
// that frame on the page DynWork gave it: in every window, a navigation of a frame named `name`, or of a frame once
// seen with that name (a script can rename its window), goes ahead only to the frame's `srcdoc` or a blank page.
// Every other frame is left alone.

/** The `name` the viewer gives its frame (`views/drive/viewer.tsx`). */
export const name = "dynwork-drive-frame"

/** Whether a sub-frame's navigation goes ahead. */
export function allows(input: { name: string; known: boolean; url: string; sameDocument: boolean }) {
  if (input.name !== name && !input.known) return true
  // A link to a heading of the same page stays in the page.
  if (input.sameDocument) return true
  return input.url === "about:srcdoc" || input.url === "about:blank"
}

/** What `guard` needs of Electron: the app's `web-contents-created`, and the contents that exist already. */
export interface Host {
  app: Pick<App, "on" | "off">
  contents: () => readonly WebContents[]
}

/** Guards the viewer's frames in every window, now and later; answers what removes the guard. */
export function guard(host: Host) {
  const seen = new Set<number>()
  const guarded = new Set<WebContents>()
  const navigate = (details: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>) => {
    const frame = details.frame
    if (details.isMainFrame || !frame) return
    const known = seen.has(frame.frameTreeNodeId)
    if (frame.name === name) seen.add(frame.frameTreeNodeId)
    if (allows({ name: frame.name, known, url: details.url, sameDocument: details.isSameDocument })) return
    details.preventDefault()
  }
  const watch = (contents: WebContents) => {
    if (guarded.has(contents)) return
    guarded.add(contents)
    contents.on("will-frame-navigate", navigate)
    contents.once("destroyed", () => guarded.delete(contents))
  }
  const created = (_event: unknown, contents: WebContents) => watch(contents)
  host.contents().forEach(watch)
  host.app.on("web-contents-created", created)
  return () => {
    host.app.off("web-contents-created", created)
    guarded.forEach((contents) => contents.off("will-frame-navigate", navigate))
    guarded.clear()
  }
}
