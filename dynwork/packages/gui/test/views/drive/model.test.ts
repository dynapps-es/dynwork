import { describe, expect, test } from "bun:test"
import { docs, folders, me } from "../../../src/views/drive/demo"
import {
  ago,
  anchorCell,
  cellsIn,
  formatOf,
  highlight,
  needsStoreChange,
  pathOf,
  rangeOf,
  snippet,
  visibleDocs,
  visibleFolders,
  type Browse,
} from "../../../src/views/drive/model"

const browse = (change: Partial<Browse> = {}): Browse => ({
  scope: "home",
  folder: undefined,
  query: "",
  type: "all",
  sort: "updated",
  ...change,
})
const names = (list: readonly { name: string }[]) => list.map((item) => item.name)

describe("what the browser lists", () => {
  test("Home shows the open folder's folders and loose files", () => {
    expect(names(visibleFolders(folders, browse()))).toEqual(["Artifacts", "Customers", "Internal", "Management"])
    expect(names(visibleDocs(docs, browse(), me))).toEqual(["Project start checklist.md"])
    expect(names(visibleFolders(folders, browse({ folder: "art" })))).toEqual([
      "odoo-modules",
      "acme-retail",
      "dyncloud-manager",
    ])
    expect(names(visibleDocs(docs, browse({ folder: "art-odoo" }), me))).toEqual([
      "VAT dashboard by journal.html",
      "VAT rounding report.docx",
      "Credit note analysis.xlsx",
    ])
  })

  test("a type filter looks in every folder, and the scopes split by owner, age and chats", () => {
    expect(names(visibleDocs(docs, browse({ type: "pptx" }), me))).toEqual(["Acme proposal 2027.pptx"])
    expect(visibleFolders(folders, browse({ type: "pptx" }))).toEqual([])
    expect(visibleDocs(docs, browse({ scope: "mine" }), me).every((doc) => doc.owner === me)).toBe(true)
    expect(visibleDocs(docs, browse({ scope: "shared" }), me).every((doc) => doc.owner !== me)).toBe(true)
    expect(visibleDocs(docs, browse({ scope: "recent" }), me).every((doc) => doc.age < 2000)).toBe(true)
    expect(visibleDocs(docs, browse({ scope: "chats" }), me).every((doc) => doc.chats.length > 0)).toBe(true)
    expect(names(visibleFolders(folders, browse({ scope: "shared" })))).toEqual(["Customers", "Management"])
  })

  test("a search matches names and content everywhere, and sorts by name on demand", () => {
    expect(names(visibleDocs(docs, browse({ query: "Proposal", sort: "name" }), me))).toEqual([
      "Acme proposal 2027.pptx",
      "VAT rounding report.docx",
    ])
    const report = docs.find((doc) => doc.id === "d1")
    expect(report && snippet(report, "proposal")?.match).toBe("proposal")
    expect(report && snippet(report, "report")).toBeUndefined()
    expect(highlight("Acme proposal 2027.pptx", "PROPOSAL")).toEqual({
      before: "Acme ",
      match: "proposal",
      after: " 2027.pptx",
    })
  })
})

describe("folders, cells and anchors", () => {
  test("a folder's path runs from the root", () => {
    expect(names(pathOf(folders, "art-odoo"))).toEqual(["Artifacts", "odoo-modules"])
    expect(pathOf(folders, undefined)).toEqual([])
  })

  test("a range covers its cells whichever corner comes first", () => {
    expect(cellsIn("B2:C3")).toEqual(["B2", "B3", "C2", "C3"])
    expect(cellsIn("C3:B2")).toEqual(["B2", "B3", "C2", "C3"])
    expect(cellsIn(undefined)).toEqual([])
    expect(rangeOf("C6", "C3")).toBe("C3:C6")
    expect(rangeOf("F7", "F7")).toBeUndefined()
  })

  test("only a cell range and a PDF point need the store to change (P10)", () => {
    expect(needsStoreChange({ kind: "range", sheet: 0, from: "D2", to: "E9" })).toBe(true)
    expect(needsStoreChange({ kind: "page", page: 0, x: 10, y: 10 })).toBe(true)
    expect(needsStoreChange({ kind: "cell", sheet: 0, cell: "F7" })).toBe(false)
    expect(needsStoreChange({ kind: "shape", slide: 2, node: "s2.li3" })).toBe(false)
    expect(anchorCell({ kind: "range", sheet: 0, from: "D2", to: "E9" })).toBe("D2")
  })

  test("formats come from the extension and times read in the window's language", () => {
    expect(formatOf("notes.md")).toBe("markdown")
    expect(formatOf("contract.PDF")).toBeUndefined()
    expect(ago(0, "en", "now")).toBe("now")
    expect(ago(5, "en", "now")).toBe("5 minutes ago")
    expect(ago(1440, "es", "ahora")).toBe("ayer")
  })
})
