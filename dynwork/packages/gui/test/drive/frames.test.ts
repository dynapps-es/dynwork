import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { DriveFrames } from "../../src/drive/frames"

// Electron only loads inside Electron: the app and each window's contents are event emitters here, as they are there,
// and a navigation is the details object Electron hands `will-frame-navigate`.

function navigation(frame: { name: string; frameTreeNodeId: number } | null, url: string, more = {}) {
  const sent = { url, isMainFrame: false, isSameDocument: false, frame, prevented: false, ...more }
  return Object.assign(sent, {
    preventDefault: () => {
      sent.prevented = true
    },
  })
}

function stand() {
  const app = new EventEmitter()
  const open = new EventEmitter()
  // SAFETY: `guard` uses only `on` and `off` of the app and `on`, `off` and `once` of each contents, which emitters have.
  const host = { app, contents: () => [open] } as unknown as DriveFrames.Host
  const remove = DriveFrames.guard(host)
  return { app, open, remove }
}

describe("which sub-frame navigations go ahead", () => {
  test("the viewer's frame loads only its srcdoc or a blank page", () => {
    const viewer = { name: DriveFrames.name, known: false, sameDocument: false }
    expect(DriveFrames.allows({ ...viewer, url: "about:srcdoc" })).toBe(true)
    expect(DriveFrames.allows({ ...viewer, url: "about:blank" })).toBe(true)
    expect(DriveFrames.allows({ ...viewer, url: "https://evil.example/" })).toBe(false)
    expect(DriveFrames.allows({ ...viewer, url: "http://127.0.0.1:4096/" })).toBe(false)
    expect(DriveFrames.allows({ ...viewer, url: "data:text/html,<p>x</p>" })).toBe(false)
    expect(DriveFrames.allows({ ...viewer, url: "about:srcdoc#more" })).toBe(false)
  })

  test("a link to a heading of the same page stays in it", () => {
    expect(
      DriveFrames.allows({ name: DriveFrames.name, known: true, url: "about:srcdoc#more", sameDocument: true }),
    ).toBe(true)
  })

  test("a frame once seen as the viewer's is still guarded under another name", () => {
    expect(DriveFrames.allows({ name: "", known: true, url: "https://evil.example/", sameDocument: false })).toBe(false)
  })

  test("every other frame is left alone", () => {
    expect(DriveFrames.allows({ name: "", known: false, url: "https://example.com/", sameDocument: false })).toBe(true)
    expect(
      DriveFrames.allows({ name: "preview", known: false, url: "https://example.com/", sameDocument: false }),
    ).toBe(true)
  })
})

describe("the guard in main", () => {
  test("stops the viewer's frame leaving its page, in the windows open now and in new ones", () => {
    const { app, open } = stand()
    const frame = { name: DriveFrames.name, frameTreeNodeId: 7 }
    const load = navigation(frame, "about:srcdoc")
    open.emit("will-frame-navigate", load)
    expect(load.prevented).toBe(false)
    const away = navigation(frame, "https://evil.example/")
    open.emit("will-frame-navigate", away)
    expect(away.prevented).toBe(true)

    const later = new EventEmitter()
    app.emit("web-contents-created", {}, later)
    const fresh = navigation({ name: DriveFrames.name, frameTreeNodeId: 9 }, "https://evil.example/")
    later.emit("will-frame-navigate", fresh)
    expect(fresh.prevented).toBe(true)
  })

  test("a script that renames its frame cannot leave either", () => {
    const { open } = stand()
    open.emit("will-frame-navigate", navigation({ name: DriveFrames.name, frameTreeNodeId: 3 }, "about:srcdoc"))
    const renamed = navigation({ name: "", frameTreeNodeId: 3 }, "https://evil.example/")
    open.emit("will-frame-navigate", renamed)
    expect(renamed.prevented).toBe(true)
  })

  test("main frames and other frames navigate as before", () => {
    const { open } = stand()
    const main = navigation({ name: DriveFrames.name, frameTreeNodeId: 1 }, "https://example.com/", {
      isMainFrame: true,
    })
    const other = navigation({ name: "browser", frameTreeNodeId: 2 }, "https://example.com/")
    const gone = navigation(null, "https://example.com/")
    ;[main, other, gone].forEach((details) => open.emit("will-frame-navigate", details))
    expect([main.prevented, other.prevented, gone.prevented]).toEqual([false, false, false])
  })

  test("registers once per window, and its cleanup removes every listener", () => {
    const { app, open, remove } = stand()
    app.emit("web-contents-created", {}, open)
    expect(open.listenerCount("will-frame-navigate")).toBe(1)
    expect(app.listenerCount("web-contents-created")).toBe(1)
    remove()
    expect(open.listenerCount("will-frame-navigate")).toBe(0)
    expect(app.listenerCount("web-contents-created")).toBe(0)
  })
})
