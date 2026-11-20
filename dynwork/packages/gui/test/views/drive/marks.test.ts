import { describe, expect, test } from "bun:test"
import { blockAttribute, markId } from "../../../src/views/drive/marks"
import type { Thread } from "../../../src/views/drive/model"
import { frameOf } from "../../../src/views/drive/viewer"

// The comments marked on an HTML page as it goes into its frame: the page is read the way the instance reads it into
// nodes (one per heading, paragraph, list item, table, row and cell, in reading order), and each open thread's quote is
// wrapped in a mark inside its node.

const page = {
  html: `<html><head><title>Informe</title></head><body>
<h1>Informe de IVA</h1>
<p>El total del <b>trimestre</b>   sube un 4 %.</p>
<ul><li>Primera línea<ul><li>Anidada</li></ul></li></ul>
<table><tr><td>Total</td><td>1.200 €</td></tr></table>
</body></html>`,
  csp: "default-src 'none'; style-src 'unsafe-inline'",
}

const nodes = [
  { id: "n1", hash: "a", text: "# Informe de IVA" },
  { id: "n2", hash: "b", text: "El total del trimestre sube un 4 %." },
  { id: "n3", hash: "c", text: "- Primera línea" },
  { id: "n4", hash: "d", text: "- Anidada" },
  { id: "n5", hash: "e", text: "Total\t1.200 €" },
  { id: "n6", hash: "f", text: "Total\t1.200 €" },
  { id: "n7", hash: "g", text: "Total" },
  { id: "n8", hash: "h", text: "1.200 €" },
]

const thread = (id: string, node: string, quote?: string, open = true): Thread => ({
  id,
  node,
  quote,
  open,
  messages: [{ id, author: "u1", mine: false, text: `Revisar   este\npunto ${id}`, created: 1 }],
})

const body = (srcdoc: string) => new DOMParser().parseFromString(srcdoc, "text/html")

describe("comments marked on an HTML page", () => {
  test("a quote is marked inside its node, across the page's own tags and spaces, by its thread alone", () => {
    const frame = frameOf(page, { marks: { nodes, threads: [thread("t1", "n2", "total del trimestre sube")] } })
    const marks = [...body(frame.srcdoc).querySelectorAll("mark[data-dynwork-comment='t1']")]
    expect(marks.map((mark) => mark.textContent)).toEqual(["total del ", "trimestre", "   sube"])
    expect(marks[0]?.id).toBe(markId("t1"))
    expect(marks.slice(1).map((mark) => mark.id)).toEqual(["", ""])
    // Nothing of the comment reaches the page: its scripts may reach the network.
    expect(marks.every((mark) => !mark.hasAttribute("title"))).toBe(true)
    expect(frame.srcdoc).not.toContain("Revisar")
    expect(marks.map((mark) => [...mark.attributes].map((attribute) => attribute.name).toSorted())).toEqual([
      ["data-dynwork-comment", "id"],
      ["data-dynwork-comment"],
      ["data-dynwork-comment"],
    ])
    expect(frame.marks).toEqual({ t1: markId("t1") })
    // The paragraph reads as it did.
    expect(body(frame.srcdoc).querySelector("p")?.textContent).toBe("El total del trimestre   sube un 4 %.")
  })

  test("a thread without a quote marks its node's text; a cell's mark stays inside the cell", () => {
    const frame = frameOf(page, {
      marks: { nodes, threads: [thread("t1", "n1"), thread("t2", "n8"), thread("t3", "n3")] },
    })
    const doc = body(frame.srcdoc)
    expect(doc.querySelector("h1 > mark")?.getAttribute("data-dynwork-comment")).toBe("t1")
    expect(doc.querySelector("td:nth-child(2) > mark")?.textContent).toBe("1.200 €")
    expect(doc.querySelector("td:nth-child(1) mark")).toBeNull()
    // A list item's mark is its own text: the list nested in it is a node of its own.
    expect([...doc.querySelectorAll("mark[data-dynwork-comment='t3']")].map((mark) => mark.textContent)).toEqual([
      "Primera línea",
    ])
    expect(Object.keys(frame.marks)).toEqual(["t1", "t2", "t3"])
  })

  test("a quote the node does not have, a node the page does not show and a resolved thread mark nothing", () => {
    const frame = frameOf(page, {
      marks: {
        nodes,
        threads: [
          thread("t1", "n2", "not in the paragraph"),
          thread("t2", "n99", "Total"),
          thread("t3", "n2", "total", false),
        ],
      },
    })
    expect(body(frame.srcdoc).querySelector("mark")).toBeNull()
    expect(frame.marks).toEqual({})
    // No marks, no style for them.
    expect(frame.srcdoc).not.toContain("data-dynwork-comment")
  })

  test("hidden marks are the page as it is, and the policy stays first in the head with or without them", () => {
    const threads = [thread("t1", "n2", "trimestre")]
    const hidden = frameOf(page)
    expect(hidden.srcdoc).not.toContain("<mark")
    expect(hidden.marks).toEqual({})
    const shown = frameOf(page, { marks: { nodes, threads } })
    expect(shown.srcdoc).toContain(`<mark data-dynwork-comment="t1"`)
    for (const srcdoc of [hidden.srcdoc, shown.srcdoc])
      expect(
        srcdoc.startsWith(
          `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"`,
        ),
      ).toBe(true)
    // The marks' look comes last in the head, under the page's policy, which decides whether it applies.
    const head = body(shown.srcdoc).head
    expect(head.lastElementChild?.tagName).toBe("STYLE")
    expect(head.lastElementChild?.textContent).toContain("mark[data-dynwork-comment]")
  })

  test("two threads on the same text nest their marks, and each has its own first mark", () => {
    const frame = frameOf(page, {
      marks: { nodes, threads: [thread("t1", "n2", "trimestre"), thread("t2", "n2", "del trimestre")] },
    })
    const doc = body(frame.srcdoc)
    expect(doc.getElementById(markId("t1"))?.textContent).toBe("trimestre")
    expect(doc.getElementById(markId("t2"))?.textContent).toContain("del ")
    expect(frame.marks).toEqual({ t1: markId("t1"), t2: markId("t2") })
  })

  test("each block matched to a node carries an opaque number, and the frame keeps the node of each number", () => {
    const frame = frameOf(page, { marks: { nodes, threads: [] } })
    const doc = body(frame.srcdoc)
    const numbered = [...doc.querySelectorAll(`[${blockAttribute}]`)]
    // Numbers from 0 in reading order, never a node's id.
    expect(numbered.map((element) => element.getAttribute(blockAttribute))).toEqual(
      numbered.map((_, index) => String(index)),
    )
    expect(frame.srcdoc).not.toMatch(/data-dynwork-block="n\d"/)
    expect(numbered.map((element) => element.tagName)).toEqual(["H1", "P", "LI", "LI", "TABLE", "TR", "TD", "TD"])
    expect(frame.blocks.map((node) => node.id)).toEqual(["n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8"])
    expect(frame.blocks[Number(doc.querySelector("p")?.getAttribute(blockAttribute))]?.id).toBe("n2")
    expect(frame.blocks[Number(doc.querySelector("td + td")?.getAttribute(blockAttribute))]?.id).toBe("n8")
    // No threads: nothing marked, no style for marks, and the page reads as it did.
    expect(frame.srcdoc).not.toContain("<mark")
    expect(doc.querySelector("p")?.textContent).toBe("El total del trimestre   sube un 4 %.")
  })

  test("a block no node names is not numbered, and hidden marks number nothing", () => {
    const frame = frameOf(
      { html: `<p>Hola mundo</p><p>Pintado por un script</p><p>Adiós</p>` },
      {
        marks: {
          nodes: [
            { id: "n1", hash: "a", text: "Hola mundo" },
            { id: "n2", hash: "b", text: "Adiós" },
          ],
          threads: [],
        },
      },
    )
    const doc = body(frame.srcdoc)
    expect([...doc.querySelectorAll("p")].map((element) => element.getAttribute(blockAttribute))).toEqual([
      "0",
      null,
      "1",
    ])
    expect(frame.blocks.map((node) => node.id)).toEqual(["n1", "n2"])
    const hidden = frameOf(page)
    expect(hidden.srcdoc).not.toContain(blockAttribute)
    expect(hidden.blocks).toEqual([])
  })

  test("marking runs none of the page", () => {
    const seen = globalThis as { ranMarks?: boolean }
    frameOf(
      {
        html: `<p onclick="1">Hola mundo</p><script>globalThis.ranMarks = true</script><img src=x onerror="globalThis.ranMarks = true">`,
      },
      { marks: { nodes: [{ id: "n1", hash: "a", text: "Hola mundo" }], threads: [thread("t1", "n1", "mundo")] } },
    )
    expect(seen.ranMarks).toBeUndefined()
  })
})
