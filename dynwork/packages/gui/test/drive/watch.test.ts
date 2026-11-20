import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import type { Seen } from "../../src/drive/contract"
import { DriveFrames } from "../../src/drive/frames"
import { DriveWatch } from "../../src/drive/watch"

// Electron only loads inside Electron: a window's contents and its debugger are event emitters here, as they are
// there. The debugger answers the frame tree of each sub-frame session by the frame's name (its frame id is the
// session's, with an `f`), an identifier for each script added, records every command, and emits what Chromium would: a
// sub-frame attached, a binding called, a frame navigated, a detach.

function stand(options: { attached?: boolean; wait?: number } = {}) {
  const sent: Array<{ method: string; params: Record<string, unknown>; session?: string }> = []
  const names = new Map<string, string>()
  // `hold` keeps the next script added unanswered until it is called, as a busy renderer would.
  const scripts = { added: 0, hold: undefined as Promise<void> | undefined }
  const devtools = Object.assign(new EventEmitter(), {
    attached: options.attached ?? false,
    isAttached: () => devtools.attached,
    attach: () => {
      devtools.attached = true
    },
    detach: () => {
      devtools.attached = false
    },
    sendCommand: async (method: string, params: Record<string, unknown> = {}, session?: string) => {
      sent.push({ method, params, session })
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: `f${session}`, name: names.get(session ?? "") } } }
      if (method === "Page.addScriptToEvaluateOnNewDocument") {
        const identifier = `script${++scripts.added}`
        const held = scripts.hold
        scripts.hold = undefined
        if (held) await held
        return { identifier }
      }
      return {}
    },
  })
  const contents = Object.assign(new EventEmitter(), { debugger: devtools, isDestroyed: () => false })
  const seen: Array<{ window: number; seen: Seen }> = []
  // SAFETY: `make` uses only `debugger`, `isDestroyed` and `once` of the contents, which the stand-in has.
  const watch = DriveWatch.make({
    contents: (window) => (window === 1 ? (contents as unknown as DriveWatch.Contents) : undefined),
    seen: (window, report) => seen.push({ window, seen: report }),
    wait: options.wait,
  })
  const frame = async (session: string, name: string) => {
    names.set(session, name)
    devtools.emit("message", {}, "Target.attachedToTarget", { sessionId: session, targetInfo: { type: "iframe" } })
    await Bun.sleep(0)
  }
  const call = (session: string, payload: unknown, name: string = DriveFrames.binding) =>
    devtools.emit("message", {}, "Runtime.bindingCalled", { name, payload }, session)
  const of = (session: string) => sent.filter((command) => command.session === session).map((command) => command.method)
  const navigated = (session: string, frame = `f${session}`) =>
    devtools.emit("message", {}, "Page.frameNavigated", { frame: { id: frame }, type: "Navigation" }, session)
  return { devtools, contents, sent, seen, watch, frame, call, of, navigated, scripts }
}

const viewer = `${DriveFrames.name}:1`

describe("main's observer of the viewer's frames", () => {
  test("attaches to a watching window, keeps its viewer frames and adds the observer to their isolated world", async () => {
    const main = stand()
    const held = new AbortController()
    void main.watch.watch(1, viewer, held.signal)
    expect(main.devtools.attached).toBe(true)
    expect(main.sent[0]).toMatchObject({
      method: "Target.setAutoAttach",
      params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
    })
    await main.frame("s1", viewer)
    expect(main.of("s1")).toEqual([
      "Page.getFrameTree",
      "Runtime.enable",
      "Page.enable",
      "Runtime.addBinding",
      "Page.addScriptToEvaluateOnNewDocument",
    ])
    const added = main.sent.filter((command) => command.session === "s1")
    expect(added[3]?.params).toEqual({ name: DriveFrames.binding, executionContextName: DriveFrames.world })
    expect(added[4]?.params).toEqual({
      source: DriveFrames.observer,
      worldName: DriveFrames.world,
      runImmediately: true,
    })
    // Any other frame of the window is let go, with nothing added to it.
    await main.frame("s2", "browser-preview")
    expect(main.of("s2")).toEqual(["Page.getFrameTree", "Target.detachFromTarget"])
    held.abort()
  })

  test("sends the window a kind and an id its frame reported, and drops anything else", async () => {
    const main = stand()
    const held = new AbortController()
    void main.watch.watch(1, viewer, held.signal)
    await main.frame("s1", viewer)
    await main.frame("s2", `${DriveFrames.name}:2`)
    main.call("s1", JSON.stringify({ kind: "heading", id: "ventas" }))
    main.call("s1", JSON.stringify({ kind: "mark", id: "t1" }))
    // Not a report: another kind, an empty or long id, more than a report, not JSON, another binding.
    main.call("s1", JSON.stringify({ kind: "navigate", id: "https://evil.example/" }))
    main.call("s1", JSON.stringify({ kind: "mark", id: "" }))
    main.call("s1", JSON.stringify({ kind: "mark", id: "x".repeat(300) }))
    main.call("s1", JSON.stringify({ kind: "mark", id: "t1", token: "x".repeat(600) }))
    main.call("s1", "{not json")
    main.call("s1", JSON.stringify({ kind: "mark", id: "t1" }), "somethingElse")
    // A viewer frame no call of the window watches, and a session that is not a viewer frame's.
    main.call("s2", JSON.stringify({ kind: "mark", id: "t1" }))
    main.call("s9", JSON.stringify({ kind: "mark", id: "t1" }))
    expect(main.seen).toEqual([
      { window: 1, seen: { frame: viewer, kind: "heading", id: "ventas" } },
      { window: 1, seen: { frame: viewer, kind: "mark", id: "t1" } },
    ])
    held.abort()
  })

  test("the report it accepts is a kind and a short id, as JSON", () => {
    expect(DriveWatch.report(JSON.stringify({ kind: "heading", id: "a" }))).toEqual({ kind: "heading", id: "a" })
    expect(DriveWatch.report({ kind: "heading", id: "a" })).toBeUndefined()
    expect(DriveWatch.report(JSON.stringify({ kind: "heading" }))).toBeUndefined()
    expect(DriveWatch.report(JSON.stringify({ kind: "mark", id: 7 }))).toBeUndefined()
  })

  test("where marks sit is ids and whole pixels, bounded in number and distance", () => {
    const marks = (items: unknown) => DriveWatch.report(JSON.stringify({ kind: "marks", items }))
    expect(marks([{ id: "t1", top: 120 }, { id: "t2", top: -40 }])).toEqual({
      kind: "marks",
      items: [
        { id: "t1", top: 120 },
        { id: "t2", top: -40 },
      ],
    })
    expect(marks([])).toEqual({ kind: "marks", items: [] })
    const most = Array.from({ length: DriveFrames.maxMarks }, (_, index) => ({ id: `t${index}`, top: index }))
    expect(marks(most)?.kind).toBe("marks")
    // More marks than that, an id empty or too long, a top that is not a whole number within reach, more than an id
    // and a top: the whole report is dropped.
    expect(marks([...most, { id: "one-more", top: 0 }])).toBeUndefined()
    expect(marks([{ id: "", top: 0 }])).toBeUndefined()
    expect(marks([{ id: "x".repeat(257), top: 0 }])).toBeUndefined()
    expect(marks([{ id: "t1", top: 1.5 }])).toBeUndefined()
    expect(marks([{ id: "t1", top: DriveFrames.farthest + 1 }])).toBeUndefined()
    expect(marks([{ id: "t1", top: "120" }])).toBeUndefined()
    expect(marks([{ id: "t1", top: 0, name: "Ana", picture: "https://evil.example/a.png" }])).toBeUndefined()
    expect(marks({ id: "t1", top: 0 })).toBeUndefined()
    expect(DriveWatch.report(JSON.stringify({ kind: "marks", items: [], text: "hola" }))).toBeUndefined()
    expect(DriveWatch.report(JSON.stringify({ kind: "marks", id: "t1" }))).toBeUndefined()
  })

  test("a pick is a block's number, an optional short quote and a rectangle of whole pixels, nothing more", () => {
    const rect = { left: 40, top: -12, width: 300, height: 22 }
    const pick = (value: Record<string, unknown>) => DriveWatch.report(JSON.stringify({ kind: "pick", ...value }))
    expect(pick({ block: 7, quote: "total del trimestre", rect })).toEqual({
      kind: "pick",
      block: 7,
      quote: "total del trimestre",
      rect,
    })
    expect(pick({ block: 0, rect })).toEqual({ kind: "pick", block: 0, rect })
    expect(pick({ block: DriveFrames.maxBlocks, quote: "x".repeat(DriveFrames.maxQuote), rect })?.kind).toBe("pick")
    // A block that is not a whole number from 0 to `maxBlocks`, or a node's id instead.
    expect(pick({ block: -1, rect })).toBeUndefined()
    expect(pick({ block: 1.5, rect })).toBeUndefined()
    expect(pick({ block: DriveFrames.maxBlocks + 1, rect })).toBeUndefined()
    expect(pick({ block: "7", rect })).toBeUndefined()
    expect(pick({ node: "n1", rect })).toBeUndefined()
    // A quote that is empty, too long or not text.
    expect(pick({ block: 7, quote: "", rect })).toBeUndefined()
    expect(pick({ block: 7, quote: "x".repeat(DriveFrames.maxQuote + 1), rect })).toBeUndefined()
    expect(pick({ block: 7, quote: 42, rect })).toBeUndefined()
    // A rectangle out of range, not whole pixels, missing a side or with more than its four.
    expect(pick({ block: 7, rect: { ...rect, left: DriveFrames.farthest + 1 } })).toBeUndefined()
    expect(pick({ block: 7, rect: { ...rect, top: -DriveFrames.farthest - 1 } })).toBeUndefined()
    expect(pick({ block: 7, rect: { ...rect, width: -1 } })).toBeUndefined()
    expect(pick({ block: 7, rect: { ...rect, height: DriveFrames.farthest + 1 } })).toBeUndefined()
    expect(pick({ block: 7, rect: { ...rect, left: 4.5 } })).toBeUndefined()
    expect(pick({ block: 7, rect: { left: 1, top: 1, width: 1 } })).toBeUndefined()
    expect(pick({ block: 7, rect: { ...rect, url: "https://evil.example/" } })).toBeUndefined()
    expect(pick({ block: 7 })).toBeUndefined()
    // A key more than a pick has: the whole report is dropped.
    expect(pick({ block: 7, rect, text: "Revisar este punto" })).toBeUndefined()
    expect(pick({ block: 7, rect, id: "t1" })).toBeUndefined()
  })

  test("sends the window what the user picked in its frame", async () => {
    const main = stand()
    const held = new AbortController()
    void main.watch.watch(1, viewer, held.signal)
    await main.frame("s1", viewer)
    const rect = { left: 10, top: 20, width: 30, height: 40 }
    main.call("s1", JSON.stringify({ kind: "pick", block: 3, quote: "Riesgos", rect }))
    main.call("s1", JSON.stringify({ kind: "pick", block: 3, quote: "x".repeat(40 * 1024), rect }))
    main.call("s9", JSON.stringify({ kind: "pick", block: 3, rect }))
    expect(main.seen).toEqual([{ window: 1, seen: { frame: viewer, kind: "pick", block: 3, quote: "Riesgos", rect } }])
    held.abort()
  })

  test("where the page is scrolled is two whole numbers of pixels within reach, nothing more", () => {
    const scroll = (value: Record<string, unknown>) => DriveWatch.report(JSON.stringify({ kind: "scroll", ...value }))
    expect(scroll({ x: 0, y: 1840 })).toEqual({ kind: "scroll", x: 0, y: 1840 })
    expect(scroll({ x: -DriveFrames.farthest, y: DriveFrames.farthest })?.kind).toBe("scroll")
    // Part of a pixel, beyond reach, not a number, a side missing, or more than a place.
    expect(scroll({ x: 0, y: 10.5 })).toBeUndefined()
    expect(scroll({ x: 0, y: DriveFrames.farthest + 1 })).toBeUndefined()
    expect(scroll({ x: -DriveFrames.farthest - 1, y: 0 })).toBeUndefined()
    expect(scroll({ x: "0", y: 10 })).toBeUndefined()
    expect(scroll({ y: 10 })).toBeUndefined()
    expect(scroll({ x: 0, y: 10, id: "intro" })).toBeUndefined()
    expect(scroll({ x: 0, y: 10, script: "scrollTo(0, 0)" })).toBeUndefined()
  })

  test("sends the window where its frame is scrolled", async () => {
    const main = stand()
    const held = new AbortController()
    void main.watch.watch(1, viewer, held.signal)
    await main.frame("s1", viewer)
    main.call("s1", JSON.stringify({ kind: "scroll", x: 0, y: 1840 }))
    main.call("s1", JSON.stringify({ kind: "scroll", x: 0, y: 1840.5 }))
    main.call("s9", JSON.stringify({ kind: "scroll", x: 0, y: 10 }))
    expect(main.seen).toEqual([{ window: 1, seen: { frame: viewer, kind: "scroll", x: 0, y: 1840 } }])
    held.abort()
  })

  test("puts a frame's next document where the window asks, in the isolated world, and only that document", async () => {
    const main = stand()
    const held = new AbortController()
    void main.watch.watch(1, viewer, held.signal)
    await main.frame("s1", viewer)
    expect(await main.watch.restore(1, viewer, { x: 0, y: 1840 })).toBe(true)
    const added = main.sent.at(-1)
    expect(added).toEqual({
      method: "Page.addScriptToEvaluateOnNewDocument",
      params: { source: DriveFrames.restorer(0, 1840), worldName: DriveFrames.world },
      session: "s1",
    })
    // Not the main world's: the page's scripts never see it, and it has nothing but the two numbers.
    expect(added?.params).not.toHaveProperty("runImmediately")
    // A frame of the page that navigates is not the frame's next document.
    main.navigated("s1", "a-frame-of-the-page")
    expect(main.of("s1")).not.toContain("Page.removeScriptToEvaluateOnNewDocument")
    // The frame's next document has started with it: it goes, for the documents after it (the observer, added first,
    // is `script1` and stays).
    main.navigated("s1")
    expect(main.sent.at(-1)).toEqual({
      method: "Page.removeScriptToEvaluateOnNewDocument",
      params: { identifier: "script2" },
      session: "s1",
    })
    main.navigated("s1")
    expect(main.of("s1").filter((method) => method === "Page.removeScriptToEvaluateOnNewDocument")).toHaveLength(1)
    held.abort()
  })

  test("the frame holds only the last restore asked for it", async () => {
    const main = stand()
    const held = new AbortController()
    void main.watch.watch(1, viewer, held.signal)
    await main.frame("s1", viewer)
    // Asked together: the first is overtaken and takes its script away; the second arms the frame.
    const first = main.watch.restore(1, viewer, { x: 0, y: 900 })
    const second = main.watch.restore(1, viewer, { x: 0, y: 1840 })
    expect(await first).toBe(false)
    expect(await second).toBe(true)
    const together = main.sent.filter((command) => command.session === "s1").slice(-3)
    expect(together.map((command) => [command.method, command.params.source ?? command.params.identifier])).toEqual([
      ["Page.addScriptToEvaluateOnNewDocument", DriveFrames.restorer(0, 900)],
      ["Page.addScriptToEvaluateOnNewDocument", DriveFrames.restorer(0, 1840)],
      ["Page.removeScriptToEvaluateOnNewDocument", "script2"],
    ])
    // Asked after it, before the frame navigates: it replaces it.
    expect(await main.watch.restore(1, viewer, { x: 0, y: 2400 })).toBe(true)
    const after = main.sent.filter((command) => command.session === "s1").slice(-2)
    expect(after.map((command) => [command.method, command.params.source ?? command.params.identifier])).toEqual([
      ["Page.removeScriptToEvaluateOnNewDocument", "script3"],
      ["Page.addScriptToEvaluateOnNewDocument", DriveFrames.restorer(0, 2400)],
    ])
    held.abort()
  })

  test("a frame that does not take the script in time is not armed, and loses it when it lands", async () => {
    const main = stand({ wait: 5 })
    const held = new AbortController()
    void main.watch.watch(1, viewer, held.signal)
    await main.frame("s1", viewer)
    const answer = Promise.withResolvers<void>()
    main.scripts.hold = answer.promise
    expect(await main.watch.restore(1, viewer, { x: 0, y: 1840 })).toBe(false)
    answer.resolve()
    await Bun.sleep(0)
    expect(main.sent.at(-1)).toEqual({
      method: "Page.removeScriptToEvaluateOnNewDocument",
      params: { identifier: "script2" },
      session: "s1",
    })
    // The next document starts at its top: a navigation has nothing to take away.
    main.navigated("s1")
    expect(main.of("s1").filter((method) => method === "Page.removeScriptToEvaluateOnNewDocument")).toHaveLength(1)
    held.abort()
  })

  test("restores only whole numbers within reach, for a frame that window watches and main observes", async () => {
    const main = stand()
    const held = new AbortController()
    void main.watch.watch(1, viewer, held.signal)
    await main.frame("s1", viewer)
    await main.frame("s2", `${DriveFrames.name}:2`)
    const before = main.sent.length
    // Numbers that are not whole pixels within reach.
    expect(await main.watch.restore(1, viewer, { x: 0, y: 10.5 })).toBe(false)
    expect(await main.watch.restore(1, viewer, { x: 0, y: DriveFrames.farthest + 1 })).toBe(false)
    expect(await main.watch.restore(1, viewer, { x: Number.NaN, y: 0 })).toBe(false)
    // Another window, a viewer frame no call of the window watches, a name that is not a viewer's.
    expect(await main.watch.restore(2, viewer, { x: 0, y: 10 })).toBe(false)
    expect(await main.watch.restore(1, `${DriveFrames.name}:2`, { x: 0, y: 10 })).toBe(false)
    expect(await main.watch.restore(1, "browser-preview", { x: 0, y: 10 })).toBe(false)
    expect(main.sent.length).toBe(before)
    // A frame the window watches that main has not reached (no site isolation): nothing to arm.
    const other = new AbortController()
    void main.watch.watch(1, `${DriveFrames.name}:3`, other.signal)
    expect(await main.watch.restore(1, `${DriveFrames.name}:3`, { x: 0, y: 10 })).toBe(false)
    expect(main.sent.filter((command) => command.method === "Page.addScriptToEvaluateOnNewDocument")).toHaveLength(2)
    other.abort()
    held.abort()
  })

  test("sends the window where its frame's marks sit", async () => {
    const main = stand()
    const held = new AbortController()
    void main.watch.watch(1, viewer, held.signal)
    await main.frame("s1", viewer)
    main.call("s1", JSON.stringify({ kind: "marks", items: [{ id: "t1", top: 88 }] }))
    main.call("s1", "x".repeat(40 * 1024))
    expect(main.seen).toEqual([{ window: 1, seen: { frame: viewer, kind: "marks", items: [{ id: "t1", top: 88 }] } }])
    held.abort()
  })

  test("detaches when the window's last frame stops watching, and observes nothing then", async () => {
    const main = stand()
    const first = new AbortController()
    const second = new AbortController()
    const done = main.watch.watch(1, viewer, first.signal)
    void main.watch.watch(1, viewer, second.signal)
    await main.frame("s1", viewer)
    first.abort()
    await done
    expect(main.devtools.attached).toBe(true)
    second.abort()
    expect(main.devtools.attached).toBe(false)
    expect(main.devtools.listenerCount("message")).toBe(0)
    main.call("s1", JSON.stringify({ kind: "mark", id: "t1" }))
    expect(main.seen).toEqual([])
  })

  test("leaves another client's debugger attached, and lets its own frames go", async () => {
    const main = stand({ attached: true })
    const held = new AbortController()
    void main.watch.watch(1, viewer, held.signal)
    await main.frame("s1", viewer)
    held.abort()
    expect(main.devtools.attached).toBe(true)
    expect(main.sent.slice(-2)).toEqual([
      {
        method: "Target.setAutoAttach",
        params: { autoAttach: false, waitForDebuggerOnStart: false },
        session: undefined,
      },
      { method: "Target.detachFromTarget", params: { sessionId: "s1" }, session: undefined },
    ])
  })

  test("attaches again when another client detaches while the window watches", async () => {
    const main = stand()
    const held = new AbortController()
    void main.watch.watch(1, viewer, held.signal)
    main.devtools.attached = false
    main.devtools.emit("detach", {}, "target closed")
    expect(main.devtools.attached).toBe(true)
    expect(main.sent.filter((command) => command.method === "Target.setAutoAttach")).toHaveLength(2)
    held.abort()
  })

  test("watches only a viewer's name, in a window that exists", async () => {
    const main = stand()
    await main.watch.watch(1, "browser-preview", new AbortController().signal)
    await main.watch.watch(2, viewer, new AbortController().signal)
    expect(main.devtools.attached).toBe(false)
    expect(main.sent).toEqual([])
  })

  test("a window that closes is forgotten", async () => {
    const main = stand()
    void main.watch.watch(1, viewer, new AbortController().signal)
    main.contents.emit("destroyed")
    expect(main.devtools.listenerCount("message")).toBe(0)
    main.watch.dispose()
  })
})
