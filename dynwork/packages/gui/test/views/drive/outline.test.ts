import { describe, expect, test } from "bun:test"
import { anchorPage, markdownHeadings, renderedHeading } from "../../../src/views/drive/outline"
import { frameOf } from "../../../src/views/drive/viewer"

describe("a Markdown document's index", () => {
  test("its ATX and setext headings, in reading order, without the marks they are written with", () => {
    const source = [
      "# Quarterly **VAT** report",
      "",
      "Intro paragraph.",
      "",
      "## Rounding in `account.move` ##",
      "",
      "Totals",
      "======",
      "",
      "Per journal",
      "---",
      "",
      "### See [the ledger](https://example.com/ledger)",
      "####### not a heading",
      "#hashtag is not one either",
    ].join("\n")
    expect(markdownHeadings(source)).toEqual([
      { level: 1, text: "Quarterly VAT report" },
      { level: 2, text: "Rounding in account.move" },
      { level: 1, text: "Totals" },
      { level: 2, text: "Per journal" },
      { level: 3, text: "See the ledger" },
    ])
  })

  test("nothing inside a fence is a heading, and a rule after a blank line is not one", () => {
    const source = [
      "# Setup",
      "```bash",
      "# install",
      "~~~",
      "```",
      "~~~~",
      "## still code",
      "~~~~",
      "",
      "---",
      "- item",
      "---",
      "## After",
    ].join("\n")
    expect(markdownHeadings(source)).toEqual([
      { level: 1, text: "Setup" },
      { level: 2, text: "After" },
    ])
  })

  test("a jump finds the heading as rendered by its text, the same occurrence, else by place", () => {
    const headings = markdownHeadings("# Notes\n## Summary\n# Annex\n## Summary")
    // The renderer drew a heading the source reader did not count (a quoted one), before the second Summary.
    const rendered = ["Notes", "Summary", "Quoted", "Annex", "Summary"].map((text, element) => ({ text, element }))
    expect(renderedHeading(rendered, headings, 3)).toBe(4)
    expect(renderedHeading(rendered, headings, 2)).toBe(3)
    // Text the renderer wrote differently falls back to the heading at that place.
    expect(renderedHeading([{ text: "Other", element: 9 }], [{ level: 1, text: "Notes" }], 0)).toBe(9)
    expect(renderedHeading(rendered, headings, 7)).toBeUndefined()
  })
})

describe("a page's index", () => {
  test("every heading gets an id it can be jumped to, unique in the page; the ones it had stay; a line break reads as a space", () => {
    const anchored = anchorPage(
      `<h1>Informe<br><span>de<br>IVA</span><!-- x --></h1><p id="resumen">x</p><h2>Resumen</h2><h2 id="own">Kept</h2><h2>Resumen</h2><h3>  </h3><h4>Café &amp; más</h4>`,
    )
    expect(anchored.headings).toEqual([
      { level: 1, text: "Informe de IVA", id: "informe-de-iva" },
      { level: 2, text: "Resumen", id: "resumen-2" },
      { level: 2, text: "Kept", id: "own" },
      { level: 2, text: "Resumen", id: "resumen-3" },
      { level: 4, text: "Café & más", id: "cafe-mas" },
    ])
    expect(anchored.page.querySelectorAll("[id]").length).toBe(6)
  })

  test("reading a page runs none of it", () => {
    const seen = globalThis as { ranOutline?: boolean }
    anchorPage(
      `<h1 onclick="1">Title</h1><script>globalThis.ranOutline = true</script><img src=x onerror="globalThis.ranOutline = true">`,
    )
    expect(seen.ranOutline).toBeUndefined()
  })

  test("the frame's page carries those ids, under the policy, which stays first in its head", () => {
    const frame = frameOf({
      html: `<html><head><script>1</script></head><body><h1>Dashboard</h1><h2>By journal</h2></body></html>`,
      csp: "default-src 'none'",
    })
    expect(frame.headings.map((heading) => heading.id)).toEqual(["dashboard", "by-journal"])
    expect(frame.srcdoc).toContain(`<h1 id="dashboard">Dashboard</h1><h2 id="by-journal">By journal</h2>`)
    expect(
      frame.srcdoc.startsWith(
        `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'">`,
      ),
    ).toBe(true)
    expect(frame.srcdoc.indexOf("Content-Security-Policy")).toBeLessThan(frame.srcdoc.indexOf("<script>"))
    // One document: the page's own html, head and body are the frame's.
    expect(frame.srcdoc.match(/<body>/g)?.length).toBe(1)
  })

  test("a page without headings has no index", () => {
    expect(frameOf({ html: "<table><tr><td>1</td></tr></table>" }).headings).toEqual([])
  })
})
