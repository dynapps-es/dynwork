import { afterEach, describe, expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { DriveFrames } from "../../../src/drive/frames"
import { holds, pickAnchor, type Node } from "../../../src/views/drive/model"
import { clicked, createInline, selected } from "../../../src/views/drive/spot"

// Commenting in place: when a pick on a document opens the comment popup, at what, and what the popup keeps. Markdown's
// picks are read from the app's own DOM; happy-dom gives ranges to the window's document only, so the tests draw there.

afterEach(() => {
  document.getSelection()?.removeAllRanges()
  document.body.innerHTML = ""
})

const node = (id: string, text: string): Node => ({ id, hash: "", text })
const markdown = { format: "markdown" }
const rect = { left: 10, top: 20, width: 100, height: 18 }

/** A Markdown document as `CommentMarks` leaves it: blocks with their node, a marked one with its thread. */
function draw() {
  document.body.innerHTML =
    `<main><div data-slot="drive-markdown">` +
    `<h2 data-node="n1">Ventas</h2>` +
    `<p data-node="n2">El total del <strong>trimestre</strong> sube</p>` +
    `<p data-node="n3" data-thread="t1">Riesgos <a href="https://example.com">altos</a></p>` +
    `<p>Una nota sin nodo</p>` +
    `<p data-node="n4">Ver <button>más</button></p>` +
    `</div><button data-slot="drive-bubble">TU</button></main>`
  const at = (selector: string) => {
    const found = document.querySelector(selector)
    if (!found) throw new Error(`no ${selector}`)
    return found
  }
  const range = (start: [Node | ChildNode, number], end: [Node | ChildNode, number]) => {
    const made = document.createRange()
    made.setStart(...start)
    made.setEnd(...end)
    return made
  }
  const text = (selector: string) => {
    const found = at(selector).firstChild
    if (!found) throw new Error(`no text in ${selector}`)
    return found
  }
  return { root: at("[data-slot=drive-markdown]"), at, range, text }
}

describe("when a pick opens the comment popup, and at what", () => {
  const paragraph = node("n2", "El total del **trimestre** sube")

  test("with the marks shown and leave to comment, a quote the node holds as written, else the node whole", () => {
    const at = (quote?: string) => pickAnchor({ shown: true, allowed: true, doc: markdown, node: paragraph, quote })
    expect(at("total del")).toEqual({ kind: "node", node: "n2", find: "total del" })
    // Across the node's own Markdown: the instance would refuse the quote, so the comment is on the node.
    expect(at("total del trimestre")).toEqual({ kind: "node", node: "n2" })
    expect(at()).toEqual({ kind: "node", node: "n2" })
  })

  test("nothing with the marks hidden, without leave to comment, or on a document without marks", () => {
    const base = { shown: true, allowed: true, doc: markdown, node: paragraph }
    expect(pickAnchor({ ...base, shown: false })).toBeUndefined()
    expect(pickAnchor({ ...base, allowed: false })).toBeUndefined()
    expect(pickAnchor({ ...base, doc: undefined })).toBeUndefined()
    expect(["docx", "xlsx", "pptx", "pdf"].map((format) => pickAnchor({ ...base, doc: { format } }))).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ])
    expect(pickAnchor({ ...base, doc: { format: "html" } })).toEqual({ kind: "node", node: "n2" })
  })

  test("a page's quote is the node's when the node holds it, spaces as they come", () => {
    const cell = node("n5", "Total\t1.200 €")
    expect(holds(cell, "Total 1.200")).toBe(true)
    expect(holds(cell, "  1.200 €\n")).toBe(true)
    expect(holds(cell, "Total 9.999")).toBe(false)
    expect(holds(cell, "   ")).toBe(false)
  })
})

describe("what a selection on a Markdown document picks", () => {
  test("the block it starts in, and the part of the selection inside it", () => {
    const view = draw()
    const found = selected(
      view.range([view.text("[data-node=n2]"), 3], [view.text("[data-node=n2] strong"), 5]),
      view.root,
    )
    expect([found?.node, found?.quote]).toEqual(["n2", "total del trime"])
  })

  test("a selection that crosses blocks is the part of the first one", () => {
    const view = draw()
    const found = selected(view.range([view.text("[data-node=n1]"), 0], [view.text("[data-node=n3]"), 4]), view.root)
    expect([found?.node, found?.quote]).toEqual(["n1", "Ventas"])
  })

  test("nothing for one that starts outside a block with a node, outside the document, or selects only spaces", () => {
    const view = draw()
    const note = view.text("p:not([data-node])")
    expect(selected(view.range([note, 0], [view.text("[data-node=n4]"), 2]), view.root)).toBeUndefined()
    expect(
      selected(
        view.range([view.text("[data-slot=drive-bubble]"), 0], [view.text("[data-slot=drive-bubble]"), 2]),
        view.root,
      ),
    ).toBeUndefined()
    view.at("[data-node=n1]").textContent = "Ventas   "
    expect(
      selected(view.range([view.text("[data-node=n1]"), 6], [view.text("[data-node=n1]"), 9]), view.root),
    ).toBeUndefined()
  })

  test("a long selection quotes its first `maxQuote` characters", () => {
    const view = draw()
    view.at("[data-node=n1]").textContent = "palabra ".repeat(200)
    const length = view.text("[data-node=n1]").textContent?.length ?? 0
    const found = selected(
      view.range([view.text("[data-node=n1]"), 0], [view.text("[data-node=n1]"), length]),
      view.root,
    )
    expect(found?.quote).toHaveLength(DriveFrames.maxQuote)
  })
})

describe("what a click on a Markdown document does", () => {
  test("a block with a node is picked whole, from anywhere inside it", () => {
    const view = draw()
    expect(clicked(view.at("strong"), view.root)).toMatchObject({ kind: "block", node: "n2" })
    expect(clicked(view.at("[data-node=n1]"), view.root)).toMatchObject({ kind: "block", node: "n1" })
  })

  test("a marked block opens its thread", () => {
    const view = draw()
    expect(clicked(view.at("[data-thread=t1]"), view.root)).toEqual({ kind: "thread", thread: "t1" })
  })

  test("a link or a button does its own, and a block without a node or what is not the document picks nothing", () => {
    const view = draw()
    expect(clicked(view.at("a"), view.root)).toBeUndefined()
    expect(clicked(view.at("[data-node=n4] button"), view.root)).toBeUndefined()
    expect(clicked(view.at("p:not([data-node])"), view.root)).toBeUndefined()
    expect(clicked(view.at("[data-slot=drive-bubble]"), view.root)).toBeUndefined()
    expect(clicked(view.root, view.root)).toBeUndefined()
    expect(clicked(undefined, view.root)).toBeUndefined()
  })
})

describe("the comment popup's state", () => {
  function stand(format = "markdown") {
    const [shown, setShown] = createSignal(true)
    const [allowed, setAllowed] = createSignal(true)
    const [paused, setPaused] = createSignal(false)
    const inline = createInline({ doc: () => ({ format }), shown, allowed, paused })
    return { inline, setShown, setAllowed, setPaused }
  }
  const paragraph = node("n2", "El total del trimestre sube")
  const heading = node("n1", "## Ventas")

  test("a pick opens it at the comment's anchor and where the pick sits; a new one moves it there", () => {
    const view = stand()
    view.inline.offer({ node: paragraph, quote: "total del", rect })
    expect(view.inline.spot()).toEqual({
      anchor: { kind: "node", node: "n2", find: "total del" },
      quote: "total del",
      rect,
    })
    const below = { ...rect, top: 300 }
    view.inline.offer({ node: heading, rect: below })
    expect(view.inline.spot()).toEqual({ anchor: { kind: "node", node: "n1" }, quote: undefined, rect: below })
  })

  test("nothing opens with the marks hidden, without leave to comment, while presenting, or on a Word document", () => {
    const view = stand()
    view.setShown(false)
    view.inline.offer({ node: paragraph, rect })
    view.setShown(true)
    view.setAllowed(false)
    view.inline.offer({ node: paragraph, rect })
    view.setAllowed(true)
    view.setPaused(true)
    view.inline.offer({ node: paragraph, rect })
    expect(view.inline.spot()).toBeUndefined()
    const word = stand("docx")
    word.inline.offer({ node: paragraph, rect })
    expect(word.inline.spot()).toBeUndefined()
  })

  test("a click outside closes it while empty, and leaves it open with what is written", () => {
    const view = stand()
    view.inline.offer({ node: paragraph, rect })
    view.inline.outside()
    expect(view.inline.spot()).toBeUndefined()
    view.inline.offer({ node: paragraph, rect })
    view.inline.setDraft("Revisar esta cifra")
    view.inline.outside()
    expect(view.inline.spot()?.anchor).toEqual({ kind: "node", node: "n2" })
    expect(view.inline.draft()).toBe("Revisar esta cifra")
    // Spaces alone are not something written.
    view.inline.setDraft("   ")
    view.inline.outside()
    expect(view.inline.spot()).toBeUndefined()
  })

  test("with something written, another pick does not move it; Cancel or Escape closes it and drops the text", () => {
    const view = stand()
    view.inline.offer({ node: paragraph, rect })
    view.inline.setDraft("Revisar")
    view.inline.offer({ node: heading, rect: { ...rect, top: 300 } })
    expect(view.inline.spot()?.anchor).toEqual({ kind: "node", node: "n2" })
    view.inline.close()
    expect([view.inline.spot(), view.inline.draft()]).toEqual([undefined, ""])
    view.inline.offer({ node: heading, rect })
    expect(view.inline.spot()?.anchor).toEqual({ kind: "node", node: "n1" })
  })
})
