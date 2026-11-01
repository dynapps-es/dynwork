import { describe, expect, test } from "bun:test"
import { canonicalState, parseMarkdown } from "../../../src/views/brain/model"
import { createBrainStore } from "../../../src/views/brain/store"

describe("opening a document", () => {
  test("starts on the 17.0 to 18.0 checklist with its tree unfolded", () => {
    const brain = createBrainStore()
    expect(brain.state.selected).toBe("mig-18")
    expect(brain.located()?.node.title).toBe("17.0 to 18.0 checklist")
    expect(brain.state.expanded).toMatchObject({ delivery: true, migrations: true, platform: true, handbook: true })
  })

  test("shows the title, the metadata and the body of the selected document", () => {
    const brain = createBrainStore()
    brain.select("backups")
    expect(brain.located()?.node.title).toBe("Backups and restore")
    expect(brain.located()?.space.name).toBe("Dyncloud Platform")
    expect(brain.doc().type).toBe("Reference")
    expect(brain.doc().owner).toBe("Platform team")
    expect(canonicalState(brain.doc()).key).toBe("brain.canon.source")
    expect(brain.doc().updated).toBe("Synced 1 hour ago")
    const body = parseMarkdown(brain.doc().markdown)
    expect(body[0]).toMatchObject({ kind: "heading", text: [{ text: "Schedule" }] })
  })

  test("unfolds the folders above it and ignores an unknown document", () => {
    const brain = createBrainStore()
    brain.toggle("migrations")
    expect(brain.state.expanded.migrations).toBe(false)
    brain.select("openupgrade")
    expect(brain.state.expanded.migrations).toBe(true)
    brain.select("nope")
    expect(brain.state.selected).toBe("openupgrade")
  })

  test("toggles View and Markdown, and keeps the mode across documents", () => {
    const brain = createBrainStore()
    expect(brain.state.mode).toBe("view")
    brain.setMode("markdown")
    expect(brain.state.mode).toBe("markdown")
    brain.select("sleep")
    expect(brain.state.mode).toBe("markdown")
    brain.setMode("view")
    expect(brain.state.mode).toBe("view")
  })

  test("reads English when the document has it, else its only language, and remembers a pick", () => {
    const brain = createBrainStore()
    expect(brain.language()).toBe("English")
    brain.select("tools")
    expect(brain.language()).toBe("Spanish")
    brain.select("mig-18")
    brain.setLanguage("Spanish")
    expect(brain.language()).toBe("Spanish")
    brain.select("sleep")
    expect(brain.language()).toBe("English")
  })
})

describe("the search", () => {
  test("filters the documents as the query changes", () => {
    const brain = createBrainStore()
    expect(brain.results()).toEqual([])
    brain.setQuery("how long are backups kept")
    expect(brain.results().map((hit) => hit.id)[0]).toBe("backups")
    brain.setQuery("deploy")
    expect(brain.results().map((hit) => hit.id)[0]).toBe("deploy")
    brain.setQuery("")
    expect(brain.results()).toEqual([])
  })

  test("searches the text of an edited document", () => {
    const brain = createBrainStore()
    brain.select("tools")
    brain.startEdit()
    expect(brain.state.editing).toBe(false)
    brain.select("quality-gate")
    brain.startEdit()
    brain.setDraft("---\ntitle: Quality gate before go-live\n---\n\n## The gate\n\nZebra crossing checks.\n")
    brain.save()
    brain.setQuery("zebra")
    expect(brain.results().map((hit) => hit.id)).toEqual(["quality-gate"])
  })
})

describe("the access panel", () => {
  test("opens and closes", () => {
    const brain = createBrainStore()
    brain.toggleAccess()
    expect(brain.state.accessOpen).toBe(true)
    brain.closeAccess()
    expect(brain.state.accessOpen).toBe(false)
  })

  test("changes the role of an explicit grant", () => {
    const brain = createBrainStore()
    expect(brain.grants().find((grant) => grant.id === "consultants")?.role).toBe("Can edit")
    brain.setRole("consultants", "Can read")
    expect(brain.grants().find((grant) => grant.id === "consultants")?.role).toBe("Can read")
  })

  test("an inherited grant changed on a document becomes explicit there, and the space keeps its own", () => {
    const brain = createBrainStore()
    brain.select("methodology")
    brain.setRole("employees", "Can edit")
    const grant = brain.grants().find((item) => item.id === "employees" && item.source === "explicit")
    expect(grant?.role).toBe("Can edit")
    brain.select("quality-gate")
    expect(brain.grants().find((item) => item.id === "employees")?.role).toBe("Can read")
  })

  test("shares with the next group, once each", () => {
    const brain = createBrainStore()
    expect(brain.shareable().map((group) => group.name)).toEqual(["Sales team", "Finance", "Partners", "Interns"])
    brain.share()
    expect(brain.grants().map((grant) => grant.name)).toContain("Sales team")
    expect(brain.grants().find((grant) => grant.name === "Sales team")).toMatchObject({
      role: "Can read",
      source: "explicit",
    })
    expect(brain.shareable().map((group) => group.name)).toEqual(["Finance", "Partners", "Interns"])
  })

  test("is read-only on a mirrored document and where the user can only read", () => {
    const brain = createBrainStore()
    brain.select("backups")
    const before = brain.grants()
    brain.setRole("platform-team", "Can edit")
    brain.share()
    expect(brain.grants()).toEqual(before)
    brain.select("first-week")
    expect(brain.canEdit()).toBe(false)
    brain.setRole("people-team", "Can read")
    expect(brain.grants().find((grant) => grant.id === "people-team")?.role).toBe("Can edit")
  })
})

describe("editing", () => {
  test("Edit and Save update the body of the in-memory document", () => {
    const brain = createBrainStore()
    brain.startEdit()
    expect(brain.state.editing).toBe(true)
    expect(brain.state.draft).toBe(brain.doc().markdown)
    brain.setDraft("---\ntitle: 17.0 to 18.0 checklist\n---\n\n## Rewritten\n\nA new body.\n")
    expect(brain.doc().markdown).toContain("## Before you start")
    brain.save()
    expect(brain.state.editing).toBe(false)
    expect(brain.doc().updated).toBe("Just now")
    expect(parseMarkdown(brain.doc().markdown)).toMatchObject([
      { kind: "heading", text: [{ text: "Rewritten" }] },
      { kind: "paragraph", text: [{ text: "A new body." }] },
    ])
  })

  test("Cancel keeps the document as it was", () => {
    const brain = createBrainStore()
    const before = brain.doc().markdown
    brain.startEdit()
    brain.setDraft("changed")
    brain.cancelEdit()
    expect(brain.state.editing).toBe(false)
    expect(brain.doc().markdown).toBe(before)
  })

  test("opening another document drops an edit in progress", () => {
    const brain = createBrainStore()
    brain.startEdit()
    brain.select("methodology")
    expect(brain.state.editing).toBe(false)
  })

  test("a mirrored document and a read-only space cannot be edited", () => {
    const brain = createBrainStore()
    brain.select("sleep")
    expect(brain.canEdit()).toBe(false)
    brain.startEdit()
    expect(brain.state.editing).toBe(false)
    brain.select("writing")
    expect(brain.canEdit()).toBe(false)
  })

  test("the demo documents are copied: a new store starts from the original text", () => {
    const first = createBrainStore()
    first.startEdit()
    first.setDraft("edited")
    first.save()
    expect(createBrainStore().doc().markdown).toContain("## Before you start")
  })
})
