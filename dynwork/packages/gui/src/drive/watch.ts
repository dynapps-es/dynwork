export * as DriveWatch from "./watch"

import type { WebContents } from "electron"
import { Option, Schema } from "effect"
import type { Seen } from "./contract"
import { DriveFrames } from "./frames"

// Main's observer in the viewer's HTML frames (`frames.ts`). The frame is a sandboxed `srcdoc` without
// `allow-same-origin`, so the window cannot read it, and Electron 44 runs it out of process, so neither can the window's
// `webFrame`. `WebFrameMain.executeJavaScript` would run in the page's own world, where its scripts see it, and not at
// all in a frame whose policy runs no scripts. The DevTools protocol reaches every frame, in an isolated world of
// main's own: while a window shows a frame and asks for it (`watch`), main attaches to the window, auto-attaches to its
// sub-frames, keeps the viewer's and lets the others go, and in each viewer frame adds the observer to every new
// document in `DriveFrames.world`, with a binding that exists only in that world. Neither reaches the page: its
// scripts cannot see, call or replace them. What the binding receives is parsed here (a kind and one short id) and
// sent to that window alone, which keeps only an id it gave the page. When the window stops watching, main detaches,
// unless another client had attached first, which it then leaves attached.

/** What `make` needs of a window's contents. */
export type Contents = Pick<WebContents, "debugger" | "isDestroyed" | "once">

export interface Options {
  /** A window's contents by window id; undefined once the window is gone. */
  contents: (window: number) => Contents | undefined
  /** Tells a window what one of its frames was seen doing. */
  seen: (window: number, seen: Seen) => void
}

/** What a window's frame may report through the binding: a kind and one id, as JSON, nothing else. */
const Report = Schema.fromJsonString(
  Schema.Struct({
    kind: Schema.Literals(["heading", "mark"]),
    id: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  }),
)
const decodeReport = Schema.decodeUnknownOption(Report)
const decodeTree = Schema.decodeUnknownOption(
  Schema.Struct({ frameTree: Schema.Struct({ frame: Schema.Struct({ name: Schema.optional(Schema.String) }) }) }),
)

/** A report the binding received, or undefined for anything that is not one: too long, another shape, not JSON. */
export function report(payload: unknown) {
  if (typeof payload !== "string" || payload.length > 512) return undefined
  return Option.getOrUndefined(decodeReport(payload))
}

/** A window main watches: its frames by name and how many calls hold each, and the sessions of its viewer frames. */
interface Watched {
  readonly contents: Contents
  readonly frames: Map<string, number>
  readonly sessions: Map<string, string>
  /** Main attached the debugger, so it detaches it. */
  owned: boolean
  attached: boolean
  readonly stop: () => void
}

export function make(options: Options) {
  const windows = new Map<number, Watched>()

  function attach(watched: Watched) {
    const devtools = watched.contents.debugger
    if (watched.attached || watched.contents.isDestroyed()) return
    if (!devtools.isAttached()) {
      // Attach throws when it cannot: the window then shows its frames without the channel.
      const ok = Option.liftThrowable(() => devtools.attach("1.3"))()
      if (Option.isNone(ok)) return
      watched.owned = true
    }
    watched.attached = true
    void devtools
      .sendCommand("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
        filter: [{ type: "iframe" }],
      })
      .catch(() => undefined)
  }

  async function adopt(watched: Watched, session: string) {
    const devtools = watched.contents.debugger
    const send = (method: string, params: object = {}) =>
      devtools.sendCommand(method, params, session).catch(() => undefined)
    const tree = Option.getOrUndefined(decodeTree(await send("Page.getFrameTree")))
    const name = tree?.frameTree.frame.name ?? ""
    if (!DriveFrames.isViewer(name)) return void send("Target.detachFromTarget", { sessionId: session })
    watched.sessions.set(session, name)
    await send("Runtime.enable")
    await send("Page.enable")
    await send("Runtime.addBinding", { name: DriveFrames.binding, executionContextName: DriveFrames.world })
    await send("Page.addScriptToEvaluateOnNewDocument", {
      source: DriveFrames.observer,
      worldName: DriveFrames.world,
      runImmediately: true,
    })
  }

  function watched(window: number) {
    const found = windows.get(window)
    if (found) return found
    const contents = options.contents(window)
    if (!contents || contents.isDestroyed()) return undefined
    const devtools = contents.debugger
    const message = (_event: unknown, method: string, params: unknown, session?: string) => {
      if (method === "Target.attachedToTarget" && !session) {
        const target = params as { sessionId: string; targetInfo: { type: string } }
        if (target.targetInfo.type === "iframe") void adopt(entry, target.sessionId)
        return
      }
      if (method === "Target.detachedFromTarget") {
        entry.sessions.delete((params as { sessionId: string }).sessionId)
        return
      }
      if (method !== "Runtime.bindingCalled" || !session) return
      const called = params as { name: string; payload: unknown }
      const frame = entry.sessions.get(session)
      if (called.name !== DriveFrames.binding || frame === undefined || !entry.frames.has(frame)) return
      const seen = report(called.payload)
      if (seen) options.seen(window, { frame, kind: seen.kind, id: seen.id })
    }
    // Another client detached the debugger: attach again while the window still watches.
    const detach = () => {
      entry.attached = false
      entry.owned = false
      entry.sessions.clear()
      if (entry.frames.size > 0) attach(entry)
    }
    const entry: Watched = {
      contents,
      frames: new Map(),
      sessions: new Map(),
      owned: false,
      attached: false,
      stop: () => {
        devtools.off("message", message)
        devtools.off("detach", detach)
      },
    }
    devtools.on("message", message)
    devtools.on("detach", detach)
    contents.once("destroyed", () => {
      entry.stop()
      windows.delete(window)
    })
    windows.set(window, entry)
    return entry
  }

  // The last call for the window's last frame ended: main lets the frames go, and detaches if it attached.
  function release(window: number, entry: Watched) {
    entry.stop()
    windows.delete(window)
    if (entry.contents.isDestroyed() || !entry.attached) return
    const devtools = entry.contents.debugger
    if (entry.owned) return void Option.liftThrowable(() => devtools.detach())()
    void devtools
      .sendCommand("Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false })
      .catch(() => undefined)
    entry.sessions.forEach((_name, session) => {
      void devtools.sendCommand("Target.detachFromTarget", { sessionId: session }).catch(() => undefined)
    })
  }

  return {
    /** Observes the window's frame named `frame` until `signal` aborts. A name that is not a viewer's is not observed. */
    watch(window: number, frame: string, signal: AbortSignal) {
      if (!DriveFrames.isViewer(frame) || signal.aborted) return Promise.resolve()
      const entry = watched(window)
      if (!entry) return Promise.resolve()
      entry.frames.set(frame, (entry.frames.get(frame) ?? 0) + 1)
      attach(entry)
      return new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            const held = (entry.frames.get(frame) ?? 1) - 1
            if (held > 0) entry.frames.set(frame, held)
            else entry.frames.delete(frame)
            if (entry.frames.size === 0 && windows.get(window) === entry) release(window, entry)
            resolve()
          },
          { once: true },
        )
      })
    },
    /** Stops watching every window. */
    dispose() {
      ;[...windows].forEach(([window, entry]) => release(window, entry))
    },
  }
}
