import { describe, expect, test } from "bun:test"
import { DriveCapabilities } from "../../../src/drive/capabilities"
import type { Comment, Document, Folder, Link } from "../../../src/drive/contract"
import {
  ago,
  bubbleFaces,
  bubbleRows,
  byConversation,
  highlight,
  known,
  mimeOf,
  pathOf,
  afterShare,
  bannerOf,
  madeByAgent,
  personOffer,
  sharing,
  revisionBy,
  size,
  threadsOf,
  visibleDocs,
  writerOf,
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

  test("PDF lists an uploaded PDF, which the instance keeps as a `file` of type application/pdf", () => {
    const mixed = [
      ...docs,
      doc("scan.pdf", { format: "file", mime: "application/pdf" }),
      doc("print.pdf", { format: "pdf", mime: "application/pdf" }),
      doc("data.bin", { format: "file", mime: "application/octet-stream" }),
    ]
    expect(names(visibleDocs(mixed, browse({ scope: "mine", type: "pdf", sort: "name" })))).toEqual([
      "print.pdf",
      "scan.pdf",
    ])
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

describe("the comments' bubbles beside a document", () => {
  test("one per height, top to bottom, threads closer than a bubble sharing it", () => {
    expect(
      bubbleRows([
        { thread: "c", top: 400 },
        { thread: "a", top: 100 },
        { thread: "b", top: 110 },
        { thread: "d", top: 127 },
        { thread: "e", top: 128 },
      ]),
    ).toEqual([
      { top: 100, threads: ["a", "b", "d"] },
      { top: 128, threads: ["e"] },
      { top: 400, threads: ["c"] },
    ])
  })

  test("none without threads, and a bubble of another size groups by it", () => {
    expect(bubbleRows([])).toEqual([])
    expect(
      bubbleRows(
        [
          { thread: "a", top: 0 },
          { thread: "b", top: 40 },
        ],
        48,
      ),
    ).toEqual([{ top: 0, threads: ["a", "b"] }])
  })
})

describe("the faces of a bubble", () => {
  test("in place order, two while folded and the rest as +N", () => {
    expect(bubbleFaces(["a", "b"], undefined)).toEqual({ faces: ["a", "b"], more: 0 })
    expect(bubbleFaces(["a", "b", "c", "d"], undefined)).toEqual({ faces: ["a", "b", "c", "d"], more: 2 })
    expect(bubbleFaces(["a"], "z")).toEqual({ faces: ["a"], more: 0 })
  })

  test("the thread open now goes to the front, also from behind the +N", () => {
    // The lower, covered face of two threads at one height, once clicked and open, is the one in front.
    expect(bubbleFaces(["a", "b"], "b")).toEqual({ faces: ["b", "a"], more: 0 })
    expect(bubbleFaces(["a", "b", "c", "d"], "d")).toEqual({ faces: ["d", "a", "b", "c"], more: 2 })
    expect(bubbleFaces(["a", "b"], "a").faces[0]).toBe("a")
  })
})

describe("what the Share popover offers", () => {
  const link = "https://governance.example/drive/d1"

  test("live on a document DynWork's agent made, for whom may share it, under the agents' edit cap", () => {
    expect(sharing({ access: "own", link, made: true, cap: "edit" })).toEqual({
      change: "live",
      copy: true,
      governance: true,
    })
    expect(sharing({ access: "share", link, made: true, cap: "edit" }).change).toBe("live")
  })

  test("shut and sent to Governance on any other document the user may share", () => {
    // Not the agent's, a lower agents' cap, or nothing read about either.
    const shut = [
      sharing({ access: "own", link, made: false, cap: "edit" }),
      sharing({ access: "own", link, made: true, cap: "suggest" }),
      sharing({ access: "own", link }),
      sharing({ access: undefined, link, made: true, cap: "edit" }),
    ]
    expect(shut).toEqual(Array(4).fill({ change: "governance", copy: true, governance: true }))
  })

  test("who may not share it is told so, with no way to Governance for it, the agent's or not", () => {
    expect(
      ["edit", "comment", "view"].flatMap((access) => [
        sharing({ access, link }),
        sharing({ access, link, made: true, cap: "edit" }),
      ]),
    ).toEqual(Array(6).fill({ change: "level", copy: true, governance: false }))
  })

  test("without the document's page in Governance there is no link to copy or open", () => {
    expect(sharing({ access: "own", link: undefined })).toEqual({ change: "governance", copy: false, governance: false })
  })
})

describe("acting as the person (G01)", () => {
  const link = "https://governance.example/drive/d1"

  test("the Share popover is live on any document the user may share while their session is on", () => {
    expect(sharing({ access: "own", link, person: "on" })).toEqual({ change: "live", copy: true, governance: true })
    expect(sharing({ access: "share", link, made: false, cap: "suggest", person: "on" }).change).toBe("live")
    // Their access still decides: who may not share it is told so
    expect(sharing({ access: "edit", link, person: "on" }).change).toBe("level")
  })

  test("without it, a document the agent did not make asks to sign in where the instance has a session for DynWork", () => {
    expect(sharing({ access: "own", link, person: "off" })).toEqual({ change: "sign-in", copy: true, governance: true })
    expect(sharing({ access: undefined, link, person: "off" }).change).toBe("sign-in")
    // The agent's own document stays live as the agent, as before
    expect(sharing({ access: "own", link, made: true, cap: "edit", person: "off" }).change).toBe("live")
    expect(sharing({ access: "own", link, person: "unavailable" }).change).toBe("governance")
  })

  test("an action only the person may do is live as them, asks to sign in, or goes to Governance", () => {
    expect(personOffer({ person: "on", access: "own", needs: "own" })).toBe("live")
    expect(personOffer({ person: "on", access: undefined, needs: "own" })).toBe("live")
    expect(personOffer({ person: "off", access: "own", needs: "own" })).toBe("sign-in")
    expect(personOffer({ person: "unavailable", access: "own", needs: "own" })).toBe("governance")
    expect(personOffer({ person: undefined, access: "edit", needs: "edit" })).toBe("governance")
  })

  test("what their access does not allow is shut, whoever acts: trash and transfer need own, restore and review edit", () => {
    expect(personOffer({ person: "on", access: "share", needs: "own" })).toBe("level")
    expect(personOffer({ person: "on", access: "edit", needs: "own" })).toBe("level")
    expect(personOffer({ person: "on", access: "edit", needs: "edit" })).toBe("live")
    expect(personOffer({ person: "off", access: "comment", needs: "edit" })).toBe("level")
  })

  test("the banner says who acts", () => {
    expect([bannerOf("on"), bannerOf("off"), bannerOf("unavailable"), bannerOf(undefined)]).toEqual([
      "person",
      "signIn",
      "agent",
      "agent",
    ])
  })
})

describe("which documents DynWork's agent made", () => {
  const head = { actor: "human", origin: "web_session" }
  test("the user's document whose first revision an agent wrote through the API or the documents MCP", () => {
    expect(madeByAgent({ mine: true }, [head, { actor: "agent", origin: "api" }])).toBe(true)
    expect(madeByAgent({ mine: true }, [{ actor: "agent", origin: "mcp_execution" }])).toBe(true)
  })

  test("not one a person started, the bridge synced, someone else owns, or with no revisions read", () => {
    expect(madeByAgent({ mine: true }, [{ actor: "agent", origin: "api" }, head])).toBe(false)
    expect(madeByAgent({ mine: true }, [{ actor: "agent", origin: "bridge_device" }])).toBe(false)
    expect(madeByAgent({ mine: false }, [{ actor: "agent", origin: "api" }])).toBe(false)
    expect(madeByAgent({ mine: true }, [])).toBe(false)
  })
})

describe("who has access after a change asked from the popover", () => {
  const before = { owner: "u-1", access: "own", grants: [], inherited: [] }
  test("the instance's answer replaces the list", () => {
    const after = {
      ...before,
      grants: [{ id: "g1", subject: "user", value: "u-2", name: "Ana", level: "view" }],
    }
    expect(afterShare(before, after)).toEqual({ access: after, refusal: undefined })
  })

  test("a refusal keeps the list as it was, and says why", () => {
    const refused = { code: "person" as const, message: "Governance keeps this to a person.", retryable: false }
    expect(afterShare(before, refused)).toEqual({ access: before, refusal: refused })
  })
})

describe("who wrote a version or a comment (G02)", () => {
  const labelled = { ...DriveCapabilities.none, conversationLabel: true }
  const agentRevision = { actor: "agent", conversation: "Q3 report", agent: "sp_bridge", ours: true }

  test("an agent's version is DynWork's while the instance tells nothing, and its conversation once it does", () => {
    expect(revisionBy(DriveCapabilities.none, agentRevision)).toBe("DynWork")
    expect(revisionBy(labelled, agentRevision)).toBe("Q3 report · DynWork")
    expect(revisionBy(labelled, { actor: "agent", conversation: "Weekly", agent: "claude-code" })).toBe("Weekly · claude-code")
    // 0.84 without a conversation's title and without DynWork's signature: the agent the instance names.
    expect(revisionBy(labelled, { actor: "agent", agent: "claude-code" })).toBe("claude-code")
    expect(revisionBy(labelled, { actor: "agent" })).toBe("DynWork")
    expect(revisionBy(labelled, { actor: "human", conversation: "x" })).toBeUndefined()
  })

  test("the user's own comment from a conversation reads its conversation; the rest keep their words", () => {
    const comment = (change: Partial<Comment>): Comment => ({
      id: "c1",
      anchor: { node: "n1" },
      author: "user-ana",
      mine: true,
      body: "Hola",
      created: 1,
      ...change,
    })
    const [mine] = threadsOf([comment({ conversation: "Q3 report", via: "sp_bridge", ours: true })])
    const message = mine?.messages[0]
    expect(message).toMatchObject({ conversation: "Q3 report", via: "sp_bridge", ours: true })
    expect(writerOf(labelled, message!)).toBe("Q3 report · DynWork")
    expect(writerOf(DriveCapabilities.none, message!)).toBeUndefined()
    // Typed in the Drive itself, or someone else's: "You" or their name, as before.
    expect(writerOf(labelled, threadsOf([comment({})])[0]!.messages[0]!)).toBeUndefined()
    expect(writerOf(labelled, { mine: false, conversation: "Theirs", via: "x" })).toBeUndefined()
  })
})
