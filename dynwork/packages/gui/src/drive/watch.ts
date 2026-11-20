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
// scripts cannot see, call or replace them. What the binding receives is parsed here (a kind and one short id,
// bounded mark positions, where the page is scrolled, or a pick of a block index, a short quote and a bounded
// rectangle) and sent to that window alone, which keeps only ids it gave the page. When the window loads a frame's page
// again, it may ask main to put the next document where the reader was (`restore`): main adds `DriveFrames.restorer`,
// built from two whole numbers, to that frame's next document, in the same world, and takes it away once the frame has
// navigated. When the window stops watching, main detaches, unless another client had attached first, which it then
// leaves attached.

/** What `make` needs of a window's contents. */
export type Contents = Pick<WebContents, "debugger" | "isDestroyed" | "once">

export interface Options {
  /** A window's contents by window id; undefined once the window is gone. */
  contents: (window: number) => Contents | undefined
  /** Tells a window what one of its frames was seen doing. */
  seen: (window: number, seen: Seen) => void
  /** How long a restore waits for the frame to take its script, in milliseconds: 2 s by default. */
  wait?: number
}

const Id = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256))
const Px = Schema.Int.check(Schema.isBetween({ minimum: -DriveFrames.farthest, maximum: DriveFrames.farthest }))
const Size = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: DriveFrames.farthest }))

/**
 * What a window's frame may report through the binding, as JSON, nothing else: a kind and one id; where at most
 * `DriveFrames.maxMarks` marks sit, each an id and a whole number of pixels within `DriveFrames.farthest`; where the
 * page is scrolled, two such numbers; or a pick, a block's index, an optional quote of `DriveFrames.maxQuote` at most
 * and a rectangle of whole pixels.
 */
const Report = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ kind: Schema.Literals(["heading", "mark"]), id: Id }),
    Schema.Struct({
      kind: Schema.Literal("marks"),
      items: Schema.Array(Schema.Struct({ id: Id, top: Px })).check(Schema.isMaxLength(DriveFrames.maxMarks)),
    }),
    Schema.Struct({ kind: Schema.Literal("scroll"), x: Px, y: Px }),
    Schema.Struct({
      kind: Schema.Literal("pick"),
      block: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: DriveFrames.maxBlocks })),
      quote: Schema.optional(Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(DriveFrames.maxQuote))),
      rect: Schema.Struct({ left: Px, top: Px, width: Size, height: Size }),
    }),
  ]),
)
// A report with anything more than these keys is not one.
const decodeReport = Schema.decodeUnknownOption(Report, { onExcessProperty: "error" })
const decodeTree = Schema.decodeUnknownOption(
  Schema.Struct({
    frameTree: Schema.Struct({ frame: Schema.Struct({ id: Schema.String, name: Schema.optional(Schema.String) }) }),
  }),
)
const decodeAdded = Schema.decodeUnknownOption(Schema.Struct({ identifier: Schema.String }))
const decodeNavigated = Schema.decodeUnknownOption(Schema.Struct({ frame: Schema.Struct({ id: Schema.String }) }))

/** The longest report taken: `maxMarks` marks with the longest ids. */
const longest = 32 * 1024

/** A report the binding received, or undefined for anything that is not one: too long, another shape, not JSON. */
export function report(payload: unknown) {
  if (typeof payload !== "string" || payload.length > longest) return undefined
  return Option.getOrUndefined(decodeReport(payload))
}

/** A viewer frame main observes: its name and the id of its frame in its session. */
interface Session {
  readonly name: string
  readonly root: string
  /** The `restorer` added for the frame's next document, until the frame navigates. */
  restorer?: string
  /** How many restores were asked for the frame: only the last one asked arms it. */
  asked: number
}

/** A window main watches: its frames by name and how many calls hold each, and the sessions of its viewer frames. */
interface Watched {
  readonly contents: Contents
  readonly frames: Map<string, number>
  readonly sessions: Map<string, Session>
  /** Main attached the debugger, so it detaches it. */
  owned: boolean
  attached: boolean
  readonly stop: () => void
}

export function make(options: Options) {
  const windows = new Map<number, Watched>()
  const wait = options.wait ?? 2000

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
    if (!tree || !DriveFrames.isViewer(name)) return void send("Target.detachFromTarget", { sessionId: session })
    watched.sessions.set(session, { name, root: tree.frameTree.frame.id, asked: 0 })
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
      const frame = session === undefined ? undefined : entry.sessions.get(session)
      if (!session || !frame) return
      // The frame's next document has started, with the restorer: it is not one for the documents after it.
      if (method === "Page.frameNavigated") {
        const navigated = Option.getOrUndefined(decodeNavigated(params))
        const added = frame.restorer
        if (navigated?.frame.id !== frame.root || added === undefined) return
        frame.restorer = undefined
        void devtools
          .sendCommand("Page.removeScriptToEvaluateOnNewDocument", { identifier: added }, session)
          .catch(() => undefined)
        return
      }
      if (method !== "Runtime.bindingCalled") return
      const called = params as { name: string; payload: unknown }
      if (called.name !== DriveFrames.binding || !entry.frames.has(frame.name)) return
      const seen = report(called.payload)
      if (seen) options.seen(window, { frame: frame.name, ...seen })
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

  // The frame holds at most the last restore asked for it. One that a later one overtook, or that the frame did not
  // take in time (its window's renderer may be busy), takes its script away whenever it lands, and answers false.
  async function arm(watched: Watched, frame: string, source: string) {
    const found = [...watched.sessions].find((item) => item[1].name === frame)
    if (!found) return false
    const session = found[0]
    const held = found[1]
    const turn = ++held.asked
    const devtools = watched.contents.debugger
    const send = (method: string, params: object) =>
      devtools.sendCommand(method, params, session).catch(() => undefined)
    const remove = (identifier: string) => void send("Page.removeScriptToEvaluateOnNewDocument", { identifier })
    if (held.restorer !== undefined) remove(held.restorer)
    held.restorer = undefined
    const adding = send("Page.addScriptToEvaluateOnNewDocument", { source, worldName: DriveFrames.world }).then(
      (answer) => Option.getOrUndefined(decodeAdded(answer))?.identifier,
    )
    const late = new Promise<"late">((resolve) => setTimeout(() => resolve("late"), wait))
    const added = await Promise.race([adding, late])
    if (added === "late") {
      void adding.then((identifier) => identifier !== undefined && remove(identifier))
      return false
    }
    if (added === undefined) return false
    if (held.asked !== turn || watched.sessions.get(session) !== held) {
      remove(added)
      return false
    }
    held.restorer = added
    return true
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
    /**
     * Puts the next document of the window's frame named `frame` where `at` says, from where its scroller starts: only
     * for a frame a call of that window watches, and only whole numbers within `DriveFrames.farthest`. Answers whether
     * the next document will be put there; it is up to the window to load that document then.
     */
    restore(window: number, frame: string, at: { x: number; y: number }) {
      const source = DriveFrames.restorer(at.x, at.y)
      const entry = windows.get(window)
      if (source === undefined || !entry || !entry.frames.has(frame)) return Promise.resolve(false)
      return arm(entry, frame, source)
    },
    /** Stops watching every window. */
    dispose() {
      ;[...windows].forEach(([window, entry]) => release(window, entry))
    },
  }
}
