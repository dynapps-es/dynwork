import { describe, expect, test } from "bun:test"
import type { Document, Folder, Link } from "../../../src/drive/contract"
import {
  ago,
  anchorCell,
  byConversation,
  cellsIn,
  highlight,
  known,
  mimeOf,
  needsStoreChange,
  pathOf,
  rangeOf,
  size,
  visibleDocs,
  visibleFolders,
  type Browse,
} from "../../../src/views/drive/model"
import { queriesOf } from "../../../src/views/drive/store"
import { names } from "./fixture"

const browse = (change: Partial<Browse> = {}): Browse => ({
  scope: "home",
  folder: undefined,
  query: "",
  type: "all",
  sort: "updated",
  ...change,
})

const doc = (name: string, change: Partial<Document> = {}): Document => ({
  id: name,
  name,
  format: name.split(".").pop() === "md" ? "markdown" : (name.split(".").pop() ?? ""),
  mime: "application/octet-stream",
  owner: "me",
  mine: true,
  revision: "r1",
  created: 0,
  updated: 0,
  ...change,
})
const folder = (id: string, change: Partial<Folder> = {}): Folder => ({
  id,
  name: id,
  owner: "me",
  mine: true,
  created: 0,
  updated: 0,
  ...change,
})

const docs = [
  doc("loose.md", { updated: 30 }),
  doc("report.docx", { folder: "art", updated: 50 }),
  doc("analysis.xlsx", { folder: "art", updated: 10 }),
  doc("deck.pptx", { folder: "art", updated: 40 }),
]

describe("what the browser lists", () => {
  test("Home at the root keeps the loose files; elsewhere every document listed stays", () => {
    expect(names(visibleDocs(docs, browse()))).toEqual(["loose.md"])
    // In a folder the Drive answered with that folder's documents only: the browser keeps them all.
    expect(names(visibleDocs(docs, browse({ folder: "art" })))).toEqual([
      "report.docx",
      "deck.pptx",
      "loose.md",
      "analysis.xlsx",
    ])
    expect(visibleDocs(docs, browse({ scope: "mine" }))).toHaveLength(4)
    // A search answers from every folder.
    expect(visibleDocs(docs, browse({ query: "a" }))).toHaveLength(4)
  })

  test("the type filter and the three orders apply on top", () => {
    expect(names(visibleDocs(docs, browse({ scope: "mine", type: "xlsx" })))).toEqual(["analysis.xlsx"])
    expect(names(visibleDocs(docs, browse({ scope: "mine", sort: "name" })))).toEqual([
      "analysis.xlsx",
      "deck.pptx",
      "loose.md",
      "report.docx",
    ])
    expect(names(visibleDocs(docs, browse({ scope: "mine", sort: "type" })))).toEqual([
      "report.docx",
      "loose.md",
      "deck.pptx",
      "analysis.xlsx",
    ])
  })

  test("folders: the open one's children at Home, the top shared ones under Shared, none on a search or a type", () => {
    const tree = [
      folder("art"),
      folder("odoo", { parent: "art" }),
      folder("customers", { mine: false }),
      folder("acme", { parent: "customers", mine: false }),
      folder("inbox", { parent: "art", mine: false }),
    ]
    expect(visibleFolders(tree, browse()).map((item) => item.id)).toEqual(["art", "customers"])
    expect(visibleFolders(tree, browse({ folder: "art" })).map((item) => item.id)).toEqual(["odoo", "inbox"])
    expect(visibleFolders(tree, browse({ scope: "shared" })).map((item) => item.id)).toEqual(["customers", "inbox"])
    expect(visibleFolders(tree, browse({ query: "a" }))).toEqual([])
    expect(visibleFolders(tree, browse({ type: "pdf" }))).toEqual([])
    expect(visibleFolders(tree, browse({ scope: "recent" }))).toEqual([])
    expect(pathOf(tree, "acme").map((item) => item.id)).toEqual(["customers", "acme"])
    expect(pathOf(tree, undefined)).toEqual([])
  })

  test("what the Drive is asked for: two scopes for a search, the folder at Home, none for Recent and the chats", () => {
    expect(queriesOf(browse())).toEqual([{ scope: "mine", limit: 100 }])
    expect(queriesOf(browse({ folder: "art" }))).toEqual([{ scope: "folder", folder: "art", limit: 100 }])
    expect(queriesOf(browse({ scope: "shared" }))).toEqual([{ scope: "shared", limit: 100 }])
    expect(queriesOf(browse({ scope: "recent", query: "  q3 " }))).toEqual([
      { scope: "mine", query: "q3", limit: 100 },
      { scope: "shared", query: "q3", limit: 100 },
    ])
    expect(queriesOf(browse({ scope: "recent" }))).toEqual([])
    expect(queriesOf(browse({ scope: "chats" }))).toEqual([])
  })

  test("the conversations' documents group by conversation, newest first, each act once", () => {
    const link = (conversation: string, document: string, act: Link["act"], at: number): Link => ({
      conversation,
      document,
      act,
      via: "rest",
      at,
    })
    expect(
      byConversation([
        link("a", "d1", "created", 1),
        link("b", "d2", "attached", 5),
        link("a", "d1", "edited", 3),
        link("a", "d1", "edited", 4),
        link("a", "d3", "attached", 2),
      ]),
    ).toEqual([
      { conversation: "b", documents: [{ document: "d2", acts: ["attached"] }] },
      {
        conversation: "a",
        documents: [
          { document: "d1", acts: ["edited", "created"] },
          { document: "d3", acts: ["attached"] },
        ],
      },
    ])
  })
})

describe("names, sizes and times", () => {
  test("a search match is marked whatever its case", () => {
    expect(highlight("Acme proposal 2027.pptx", "PROPOSAL")).toEqual({
      before: "Acme ",
      match: "proposal",
      after: " 2027.pptx",
    })
    expect(highlight("notes.md", " ")).toEqual({ before: "notes.md", match: "", after: "" })
  })

  test("an upload the system did not type takes its type from the extension", () => {
    expect(mimeOf("report.DOCX")).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    expect(mimeOf("notes.md")).toBe("text/markdown")
    expect(mimeOf("archive.zip")).toBeUndefined()
  })

  test("formats the Drive draws are known; the instance's others are not", () => {
    expect(known("markdown")).toBe("markdown")
    expect(known("odt")).toBeUndefined()
  })

  test("sizes and times read in the window's language", () => {
    expect(size(512, "en")).toBe("512 bytes")
    expect(size(320 * 1024, "en")).toBe("320 kB")
    expect(size(1.5 * 1024 * 1024, "es")).toBe("1,5 MB")
    expect(ago(0, "en", "now")).toBe("now")
    expect(ago(5, "en", "now")).toBe("5 minutes ago")
    expect(ago(1440, "es", "ahora")).toBe("ayer")
  })
})

describe("cells and anchors", () => {
  test("a range covers its cells whichever corner comes first", () => {
    expect(cellsIn("B2:C3")).toEqual(["B2", "B3", "C2", "C3"])
    expect(cellsIn("C3:B2")).toEqual(["B2", "B3", "C2", "C3"])
    expect(cellsIn(undefined)).toEqual([])
    expect(rangeOf("C6", "C3")).toBe("C3:C6")
    expect(rangeOf("F7", "F7")).toBeUndefined()
  })

  test("only a cell range and a PDF point need the Drive to change (P10)", () => {
    expect(needsStoreChange({ kind: "range", sheet: 0, from: "D2", to: "E9" })).toBe(true)
    expect(needsStoreChange({ kind: "page", page: 0, x: 10, y: 10 })).toBe(true)
    expect(needsStoreChange({ kind: "cell", sheet: 0, cell: "F7" })).toBe(false)
    expect(anchorCell({ kind: "range", sheet: 0, from: "D2", to: "E9" })).toBe("D2")
  })
})
