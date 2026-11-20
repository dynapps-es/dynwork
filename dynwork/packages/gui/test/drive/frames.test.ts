import { afterEach, describe, expect, test } from "bun:test"
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

describe("the viewer's frames, by name", () => {
  test("each frame of a window has a name of its own, and every one is guarded", () => {
    expect(DriveFrames.isViewer(DriveFrames.name)).toBe(true)
    expect(DriveFrames.isViewer(`${DriveFrames.name}:12`)).toBe(true)
    expect(DriveFrames.isViewer(`${DriveFrames.name}-12`)).toBe(false)
    expect(DriveFrames.isViewer("preview")).toBe(false)
    expect(
      DriveFrames.allows({
        name: `${DriveFrames.name}:3`,
        known: false,
        url: "https://evil.example/",
        sameDocument: false,
      }),
    ).toBe(false)
  })
})

describe("the heading a reader is at", () => {
  test("the last one whose top has passed the upper third of the visible area", () => {
    // 600 high: the line is at 200.
    expect(DriveFrames.reading([-900, -300, 150, 420], 600)).toBe(2)
    expect(DriveFrames.reading([-900, -300, 201, 420], 600)).toBe(1)
    expect(DriveFrames.reading([-900, -300, 200, 420], 600)).toBe(2)
  })

  test("at the top of the document, the first; without headings, none", () => {
    expect(DriveFrames.reading([320, 900], 600)).toBe(0)
    expect(DriveFrames.reading([Infinity, Infinity], 600)).toBe(0)
    expect(DriveFrames.reading([], 600)).toBe(-1)
  })
})

// The observer as main evaluates it in the frame's isolated world, here over a document of its own: the world's
// globals it reads are handed in, and the binding records what it reports.
function observe(html: string) {
  const document = new DOMParser().parseFromString(html, "text/html")
  const reported: unknown[] = []
  const world = new EventTarget()
  const frames: Array<() => void> = []
  const scope = {
    globalThis: { [DriveFrames.binding]: (payload: string) => reported.push(JSON.parse(payload)) },
    document,
    addEventListener: world.addEventListener.bind(world),
    requestAnimationFrame: (run: () => void) => frames.push(run),
    innerHeight: 600,
    Element,
  }
  new Function(...Object.keys(scope), DriveFrames.observer)(...Object.values(scope))
  const flush = () => frames.splice(0).forEach((run) => run())
  // Places each heading at a top, as the frame's layout would.
  const place = (tops: number[]) =>
    [...document.querySelectorAll("[id]")].forEach((heading, index) =>
      Object.assign(heading, { getBoundingClientRect: () => ({ top: tops[index] ?? 0 }) }),
    )
  return { document, reported, world, flush, place }
}

describe("main's observer in a frame", () => {
  test("reports the heading being read as the page scrolls, once each time it changes", () => {
    const frame = observe(`<h1 id="intro">Intro</h1><h2 id="ventas">Ventas</h2><h2 id="riesgos">Riesgos</h2>`)
    frame.place([10, 700, 1400])
    frame.flush()
    expect(frame.reported).toEqual([{ kind: "heading", id: "intro" }])
    frame.place([-700, 0, 700])
    frame.world.dispatchEvent(new Event("scroll"))
    frame.world.dispatchEvent(new Event("scroll"))
    frame.flush()
    frame.world.dispatchEvent(new Event("scroll"))
    frame.flush()
    expect(frame.reported).toEqual([
      { kind: "heading", id: "intro" },
      { kind: "heading", id: "ventas" },
    ])
  })

  test("reports a mark the user clicked, by its thread, and nothing for a click a script made", () => {
    const frame = observe(`<p>El <mark data-dynwork-comment="t1"><b>total</b></mark> sube</p>`)
    frame.flush()
    const bold = frame.document.querySelector("b")
    bold?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    expect(frame.reported).toEqual([])
    // happy-dom cannot dispatch a trusted event: the user's click is one that says so.
    const user = new MouseEvent("click", { bubbles: true })
    Object.defineProperty(user, "isTrusted", { value: true })
    bold?.dispatchEvent(user)
    const elsewhere = new MouseEvent("click", { bubbles: true })
    Object.defineProperty(elsewhere, "isTrusted", { value: true })
    frame.document.querySelector("p")?.dispatchEvent(elsewhere)
    expect(frame.reported).toEqual([{ kind: "mark", id: "t1" }])
  })

  test("reports where each thread's first mark sits when that changes, and nothing for a page without marks", () => {
    const frame = observe(
      `<p><mark data-dynwork-comment="t1" id="dynwork-comment-t1">El total</mark> sube</p>` +
        `<p><mark data-dynwork-comment="t1">y sigue</mark></p>` +
        `<p><mark data-dynwork-comment="t2" id="dynwork-comment-t2">Riesgos</mark></p>` +
        // A mark with no thread is not one to place.
        `<p><mark data-dynwork-comment="" id="dynwork-comment-">x</mark></p>`,
    )
    const tops = (values: number[]) =>
      [...frame.document.querySelectorAll("mark[id]")].forEach((mark, index) =>
        Object.assign(mark, { getBoundingClientRect: () => ({ top: values[index] ?? 0 }) }),
      )
    tops([120.4, 2_000_000, 50])
    frame.flush()
    expect(frame.reported).toEqual([
      {
        kind: "marks",
        items: [
          { id: "t1", top: 120 },
          { id: "t2", top: DriveFrames.farthest },
        ],
      },
    ])
    // The page did not move: nothing more.
    frame.world.dispatchEvent(new Event("scroll"))
    frame.flush()
    expect(frame.reported).toHaveLength(1)
    tops([-30, 400, 50])
    frame.world.dispatchEvent(new Event("scroll"))
    frame.flush()
    expect(frame.reported.at(-1)).toEqual({
      kind: "marks",
      items: [
        { id: "t1", top: -30 },
        { id: "t2", top: 400 },
      ],
    })

    const plain = observe(`<h1 id="intro">Intro</h1><p>Sin comentarios</p>`)
    plain.flush()
    expect(plain.reported).toEqual([{ kind: "heading", id: "intro" }])
  })

  test("places the first marks of the page only, as many as main takes", () => {
    const frame = observe(
      Array.from(
        { length: DriveFrames.maxMarks + 5 },
        (_, index) => `<p><mark data-dynwork-comment="t${index}" id="dynwork-comment-t${index}">x</mark></p>`,
      ).join(""),
    )
    frame.document
      .querySelectorAll("mark")
      .forEach((mark) => Object.assign(mark, { getBoundingClientRect: () => ({ top: 0 }) }))
    frame.flush()
    const report = frame.reported[0] as { items: Array<{ id: string }> }
    expect(report.items).toHaveLength(DriveFrames.maxMarks)
    expect(report.items[0]?.id).toBe("t0")
  })

  test("does nothing in a world without main's binding", () => {
    const document = new DOMParser().parseFromString(`<h1 id="a">A</h1>`, "text/html")
    const listen = { calls: 0 }
    const scope = {
      globalThis: {},
      document,
      addEventListener: () => void listen.calls++,
      requestAnimationFrame: () => 0,
      innerHeight: 600,
      Element,
    }
    new Function(...Object.keys(scope), DriveFrames.observer)(...Object.values(scope))
    expect(listen.calls).toBe(0)
  })
})

// A pick needs the window's own document: happy-dom gives ranges and a selection to that one only. The observer's
// listeners on it are taken off after each test, with what the test put in its body and selected.
const live: Array<() => void> = []
afterEach(() => live.splice(0).forEach((undo) => undo()))

function observeLive(html: string) {
  document.body.innerHTML = html
  const reported: unknown[] = []
  const added: Array<[string, EventListener, boolean | AddEventListenerOptions | undefined]> = []
  const scoped = new Proxy(document, {
    get(target, key) {
      if (key === "addEventListener")
        return (type: string, listener: EventListener, options?: boolean | AddEventListenerOptions) => {
          target.addEventListener(type, listener, options)
          added.push([type, listener, options])
        }
      const value = target[key as keyof Document]
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  const scope = {
    globalThis: { [DriveFrames.binding]: (payload: string) => reported.push(JSON.parse(payload)) },
    document: scoped,
    addEventListener: () => undefined,
    requestAnimationFrame: () => 0,
    innerHeight: 600,
    Element,
  }
  new Function(...Object.keys(scope), DriveFrames.observer)(...Object.values(scope))
  live.push(() => {
    added.forEach(([type, listener, options]) => document.removeEventListener(type, listener, options))
    document.getSelection()?.removeAllRanges()
    document.body.innerHTML = ""
  })
  const select = (start: [Node, number], end: [Node, number]) => {
    const range = document.createRange()
    range.setStart(...start)
    range.setEnd(...end)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }
  // happy-dom cannot dispatch a trusted event: the user's own is one that says so.
  const user = (target: Element, type: "click" | "mouseup", trusted = true) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true })
    if (trusted) Object.defineProperty(event, "isTrusted", { value: true })
    target.dispatchEvent(event)
    return event
  }
  const at = (selector: string) => {
    const found = document.querySelector(selector)
    if (!found) throw new Error(`no ${selector}`)
    return found
  }
  return { reported, select, user, at }
}

const text = (element: Element) => {
  const found = element.firstChild
  if (!found) throw new Error("no text")
  return found
}

describe("what the user picks in a frame, as main's observer reports it", () => {
  const page =
    `<h1 data-dynwork-block="0">Informe</h1>` +
    `<p data-dynwork-block="1">El total del <b>trimestre</b> sube</p>` +
    `<p data-dynwork-block="2">Riesgos <a href="#x">altos</a> <button>Ver</button> <input></p>` +
    `<p>Pintado por un script</p>` +
    `<p data-dynwork-block="3"><mark data-dynwork-comment="t1">Comentado</mark> y no</p>`

  test("a selection is its first block's number, the part of the selection in that block, and where it sits", () => {
    const frame = observeLive(page)
    const paragraph = frame.at("[data-dynwork-block='1']")
    // From "total" to the middle of the next paragraph: the part in the first block.
    frame.select([text(paragraph), 3], [text(frame.at("[data-dynwork-block='2']")), 4])
    // The click that ends a drag goes to the common ancestor of where it started and ended.
    frame.user(document.body, "click")
    expect(frame.reported).toEqual([
      { kind: "pick", block: 1, quote: "total del trimestre sube", rect: { left: 0, top: 0, width: 0, height: 0 } },
    ])
  })

  test("a long selection quotes its first `maxQuote` characters, in one line", () => {
    const frame = observeLive(`<p data-dynwork-block="4">${"palabra\n  ".repeat(100)}</p>`)
    const paragraph = frame.at("p")
    frame.select([text(paragraph), 0], [text(paragraph), text(paragraph).textContent?.length ?? 0])
    frame.user(paragraph, "click")
    const quote = (frame.reported[0] as { quote: string }).quote
    expect(quote).toHaveLength(DriveFrames.maxQuote)
    expect(quote).not.toContain("\n")
    expect(quote.startsWith("palabra palabra")).toBe(true)
  })

  test("nothing for a selection a script ended, one that starts in no numbered block, or only spaces", () => {
    const frame = observeLive(page + `<p data-dynwork-block="5">   </p>`)
    frame.select([text(frame.at("[data-dynwork-block='1']")), 0], [text(frame.at("[data-dynwork-block='1']")), 6])
    frame.user(frame.at("[data-dynwork-block='1']"), "click", false)
    const plain = frame.at("p:not([data-dynwork-block])")
    frame.select([text(plain), 0], [text(plain), 7])
    frame.user(plain, "click")
    // A selection of spaces in a numbered block is not a click on the block either.
    const blank = frame.at("[data-dynwork-block='5']")
    frame.select([text(blank), 0], [text(blank), 3])
    frame.user(blank, "click")
    // The mouseup alone reports nothing: the click that follows it reads the selection, once it has settled.
    frame.select([text(frame.at("[data-dynwork-block='1']")), 0], [text(frame.at("[data-dynwork-block='1']")), 6])
    frame.user(frame.at("[data-dynwork-block='1']"), "mouseup")
    expect(frame.reported).toEqual([])
  })

  test("a click without a selection picks its block whole, where the block sits, in whole pixels within reach", () => {
    const frame = observeLive(page)
    const paragraph = frame.at("[data-dynwork-block='1']")
    Object.assign(paragraph, {
      getBoundingClientRect: () => ({ left: 12.4, top: -2_000_000, width: 380.6, height: 2_000_123 }),
    })
    frame.user(frame.at("b"), "click")
    expect(frame.reported).toEqual([
      {
        kind: "pick",
        block: 1,
        rect: { left: 12, top: -DriveFrames.farthest, width: 381, height: DriveFrames.farthest },
      },
    ])
  })

  test("a click on a mark opens its thread, and one on a link, a control or no numbered block picks nothing", () => {
    const frame = observeLive(page)
    frame.user(frame.at("mark"), "click")
    frame.user(frame.at("a"), "click")
    frame.user(frame.at("button"), "click")
    frame.user(frame.at("input"), "click")
    frame.user(frame.at("p:not([data-dynwork-block])"), "click")
    frame.user(document.body, "click")
    // A script's click picks nothing either.
    frame.user(frame.at("h1"), "click", false)
    expect(frame.reported).toEqual([{ kind: "mark", id: "t1" }])
  })

  test("a click that ends a selection picks the selection, not its block whole, even on a mark", () => {
    const frame = observeLive(page)
    const heading = frame.at("h1")
    frame.select([text(heading), 0], [text(heading), 4])
    frame.user(heading, "click")
    const mark = frame.at("mark")
    frame.select([text(mark), 0], [text(mark), 6])
    frame.user(mark, "click")
    expect(frame.reported).toEqual([
      { kind: "pick", block: 0, quote: "Info", rect: { left: 0, top: 0, width: 0, height: 0 } },
      { kind: "pick", block: 3, quote: "Coment", rect: { left: 0, top: 0, width: 0, height: 0 } },
    ])
  })

  test("the observer only listens: the page's own handlers run and nothing is cancelled", () => {
    const frame = observeLive(page)
    const heard: string[] = []
    const heading = frame.at("h1")
    heading.addEventListener("click", () => heard.push("click"))
    heading.addEventListener("mouseup", () => heard.push("mouseup"))
    const click = frame.user(heading, "click")
    const mouseup = frame.user(heading, "mouseup")
    expect(heard).toEqual(["click", "mouseup"])
    expect([click.defaultPrevented, mouseup.defaultPrevented]).toEqual([false, false])
    expect(frame.reported).toHaveLength(1)
  })
})
