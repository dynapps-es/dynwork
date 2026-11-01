import { describe, expect, test } from "bun:test"
import { docs, spaces } from "../../../src/views/brain/demo"
import {
  canonicalState,
  grantsOf,
  highlight,
  listDocuments,
  locate,
  navGroups,
  parseMarkdown,
  search,
  searchTerms,
  sourceLines,
} from "../../../src/views/brain/model"

const byID = Object.fromEntries(docs.map((doc) => [doc.id, doc]))

describe("the brain tree", () => {
  test("has the three spaces with their nested documents", () => {
    expect(spaces.map((space) => space.name)).toEqual(["Odoo Delivery", "Dyncloud Platform", "Dynapps Handbook"])
    expect(listDocuments(spaces).map((item) => item.node.title)).toEqual([
      "Project methodology",
      "17.0 to 18.0 checklist",
      "Data migration with OpenUpgrade",
      "Quality gate before go-live",
      "Environments and sleep",
      "Backups and restore",
      "Deploying a release",
      "Your first week",
      "Tools and accounts",
      "Writing documentation",
    ])
    expect(locate(spaces, "mig-18")?.trail.map((node) => node.title)).toEqual(["Migrations"])
    expect(locate(spaces, "mig-18")?.space.name).toBe("Odoo Delivery")
    expect(locate(spaces, "nope")).toBeUndefined()
  })

  test("every document in the tree has demo content", () => {
    expect(listDocuments(spaces).filter((item) => !byID[item.node.id])).toEqual([])
  })

  test("reads as a select of documents in a narrow window", () => {
    const groups = navGroups(spaces)
    expect(groups.map((group) => group.label)).toEqual(["Odoo Delivery", "Dyncloud Platform", "Dynapps Handbook"])
    expect(groups[0].items.map((item) => item.label)).toContain("Migrations / 17.0 to 18.0 checklist")
    expect(groups[1].items.map((item) => item.id)).toEqual(["sleep", "backups", "deploy"])
  })
})

describe("a document's metadata", () => {
  test("shows the canonical state with a tone", () => {
    expect(canonicalState(byID["mig-18"])).toEqual({ tone: "success", key: "brain.canon.verified", date: "1 Feb 2027" })
    expect(canonicalState(byID.openupgrade).key).toBe("brain.canon.draft")
    expect(canonicalState(byID.sleep).key).toBe("brain.canon.source")
  })

  test("lists the space's grants as inherited, then the document's own as explicit", () => {
    const item = locate(spaces, "mig-18")!
    expect(grantsOf(item.space, byID["mig-18"]).map((grant) => [grant.name, grant.role, grant.source])).toEqual([
      ["Delivery team", "Can edit", "inherited"],
      ["All employees", "Can read", "inherited"],
      ["Consultants", "Can edit", "explicit"],
    ])
  })
})

describe("the markdown", () => {
  const blocks = parseMarkdown(byID["mig-18"].markdown)

  test("drops the front matter and reads headings, paragraphs, lists, a table and a quote", () => {
    expect(blocks.map((block) => block.kind)).toEqual([
      "heading",
      "paragraph",
      "list",
      "heading",
      "paragraph",
      "table",
      "heading",
      "list",
      "quote",
    ])
    expect(blocks[0]).toMatchObject({ kind: "heading", level: 2, text: [{ kind: "text", text: "Before you start" }] })
  })

  test("reads inline code and bold", () => {
    const paragraph = blocks[1]
    if (paragraph.kind !== "paragraph") throw new Error("not a paragraph")
    expect(paragraph.text.filter((part) => part.kind === "code").map((part) => part.text)).toEqual(["addons"])
    const audit = blocks[4]
    if (audit.kind !== "paragraph") throw new Error("not a paragraph")
    expect(audit.text.filter((part) => part.kind === "strong").map((part) => part.text)).toEqual(["migration analysis"])
  })

  test("reads the table and the ordered list", () => {
    const table = blocks[5]
    if (table.kind !== "table") throw new Error("not a table")
    expect(table.head.map((cell) => cell[0].text)).toEqual(["Check", "Who", "When"])
    expect(table.rows).toHaveLength(4)
    expect(table.rows[3].map((cell) => cell[0].text)).toEqual(["Key users sign the test plan", "Consultant", "Week 4"])
    const steps = blocks[7]
    if (steps.kind !== "list") throw new Error("not a list")
    expect(steps.ordered).toBe(true)
    expect(steps.items).toHaveLength(3)
  })

  test("the code view tags front matter and headings", () => {
    const lines = sourceLines(byID["mig-18"].markdown)
    expect(lines[0]).toEqual({ text: "---", kind: "fm" })
    expect(lines[1].kind).toBe("fm")
    expect(lines.find((line) => line.text === "## Before you start")?.kind).toBe("h")
    expect(lines.find((line) => line.text.startsWith("Agree the"))?.kind).toBe("")
  })
})

describe("the search", () => {
  test("turns a question into its content words", () => {
    expect(searchTerms("how long are backups kept")).toEqual(["backup", "kept"])
    expect(searchTerms("is the a")).toEqual([])
  })

  test("finds documents by body and title, best first, with a highlighted snippet", () => {
    const hits = search(spaces, byID as never, "how long are backups kept")
    expect(hits.map((hit) => hit.id)).toEqual(["backups", "mig-18", "openupgrade", "quality-gate"])
    expect(hits[0].space).toBe("Dyncloud Platform")
    const marked = hits[0].snippet.filter((segment) => segment.match).map((segment) => segment.text.toLowerCase())
    expect(marked).toContain("backup")
    expect(hits[0].snippet.map((segment) => segment.text).join("")).toContain("A backup can also be taken on demand")
  })

  test("finds a document by a word only its title holds", () => {
    expect(search(spaces, byID as never, "methodology").map((hit) => hit.id)).toContain("methodology")
  })

  test("finds nothing for words no document holds, or for a query of question words only", () => {
    expect(search(spaces, byID as never, "zebra quasar")).toEqual([])
    expect(search(spaces, byID as never, "how are the")).toEqual([])
  })

  test("highlights every match, whatever the case", () => {
    expect(highlight("Backups and a backup", ["backup"])).toEqual([
      { text: "Backup", match: true },
      { text: "s and a ", match: false },
      { text: "backup", match: true },
    ])
    expect(highlight("plain", [])).toEqual([{ text: "plain", match: false }])
  })
})
