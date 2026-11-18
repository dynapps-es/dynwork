import { describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import type { Backend } from "../../src/drive/backend"
import {
  Access,
  AgentCap,
  Comment,
  Content,
  Created,
  Detail,
  Edited,
  isFailure,
  Listing,
  Outline,
  Page,
  Pdf,
  type Failure,
} from "../../src/drive/contract"
import { crossing } from "./wire"

/** What the suite needs of a backend under test, besides the backend. */
export interface Subject {
  readonly backend: Backend
  /** Caps agents at `suggest` where the documents are, or lifts the cap. */
  suggestOnly(on: boolean): void
}

const text = (value: string) => new TextEncoder().encode(value)

/**
 * The suite every Drive backend passes: the fake in `src/drive/fake.ts`, and the real one over sp-client's fake
 * instance. Names are unique per test, so a backend shared between tests does not need emptying. Every answer is also
 * sent across the Ipc's schemas, as a window would get it.
 */
export function conformance(name: string, make: () => Subject) {
  describe(`drive backend conformance: ${name}`, () => {
    test("an uploaded file is answered, listed, found by name and read back", async () => {
      const { backend } = make()
      const unique = `notes-${randomUUID()}`
      const created = crossing(
        Created,
        await ok(backend.upload({ name: `${unique}.md`, bytes: text("# Notes\n"), mime: "text/markdown" })),
      )
      expect(created.document).toMatchObject({ name: `${unique}.md`, format: "markdown", mine: true })
      expect(created.document.revision).toBe(created.revision.id)
      // 0.83 records no message on a document it creates from a file.
      expect(created.revision.message).toBeUndefined()
      const mine = await ok(backend.list({ scope: "mine", limit: 200 }))
      expect(mine.documents.map((document) => document.id)).toContain(created.document.id)
      const found = crossing(Listing, await ok(backend.list({ scope: "mine", query: unique })))
      expect(found.documents.map((document) => document.id)).toEqual([created.document.id])
      const detail = crossing(Detail, await ok(backend.get(created.document.id)))
      expect(detail.document).toMatchObject({
        id: created.document.id,
        name: `${unique}.md`,
        revision: created.revision.id,
      })
      expect(detail.head.id).toBe(created.revision.id)
    })

    test("folders nest, are listed with their parent, and hold what is uploaded into them", async () => {
      const { backend } = make()
      const parent = await ok(backend.createFolder({ name: `Parent ${randomUUID()}` }))
      const child = await ok(backend.createFolder({ name: "Child", parent: parent.id }))
      expect(parent.parent).toBeUndefined()
      expect(child.parent).toBe(parent.id)
      const folders = await ok(backend.folders())
      expect(folders.map((folder) => folder.id)).toEqual(expect.arrayContaining([parent.id, child.id]))
      const created = await ok(
        backend.upload({ name: "inside.md", bytes: text("inside"), mime: "text/markdown", folder: child.id }),
      )
      expect(created.document.folder).toBe(child.id)
      const inChild = await ok(backend.list({ scope: "folder", folder: child.id }))
      expect(inChild.documents.map((document) => document.id)).toEqual([created.document.id])
      const inParent = await ok(backend.list({ scope: "folder", folder: parent.id }))
      expect(inParent.folders.map((folder) => folder.id)).toEqual([child.id])
      expect(inParent.documents).toEqual([])
      expect((await ok(backend.get(created.document.id))).document.folder).toBe(child.id)
    })

    test("a template makes a document in the folder, with an unnamed first revision", async () => {
      const { backend } = make()
      const parent = await ok(backend.createFolder({ name: `Templates ${randomUUID()}` }))
      const created = crossing(
        Created,
        await ok(backend.create({ template: "dynapps-word", name: "Q3 report", folder: parent.id })),
      )
      expect(created.document).toMatchObject({ name: "Q3 report", folder: parent.id, template: "dynapps-word" })
      expect(created.revision.message).toBeUndefined()
      const listed = await ok(backend.list({ scope: "folder", folder: parent.id }))
      expect(listed.documents.map((document) => document.id)).toEqual([created.document.id])
    })

    test("a listing pages with its cursor until there is no next page", async () => {
      const { backend } = make()
      const prefix = `page-${randomUUID()}`
      const ids = await Promise.all(
        ["a", "b", "c"].map(
          async (letter) =>
            (await ok(backend.upload({ name: `${prefix}-${letter}.md`, bytes: text(letter), mime: "text/markdown" })))
              .document.id,
        ),
      )
      const first = await ok(backend.list({ scope: "mine", query: prefix, limit: 2 }))
      expect(first.documents).toHaveLength(2)
      expect(first.next).toBeDefined()
      const second = await ok(backend.list({ scope: "mine", query: prefix, limit: 2, cursor: first.next }))
      expect(second.documents).toHaveLength(1)
      expect(second.next).toBeUndefined()
      expect(new Set([...first.documents, ...second.documents].map((document) => document.id))).toEqual(new Set(ids))
    })

    test("an edit lands a revision with its message, newest first, and becomes the head", async () => {
      const { backend } = make()
      const created = await ok(backend.upload({ name: "edited.md", bytes: text("# One"), mime: "text/markdown" }))
      const edited = crossing(
        Edited,
        await ok(
          backend.edit(created.document.id, {
            ops: [{ op: "append_markdown", markdown: "Two" }],
            message: "Weekly report by DynWork",
            contextId: randomUUID(),
          }),
        ),
      )
      if (edited.kind !== "landed") throw new Error(`expected a landed edit, got ${edited.kind}`)
      expect(edited.merged).toBeUndefined()
      const revisions = await ok(backend.revisions(created.document.id))
      expect(revisions.map((revision) => revision.id)).toEqual([edited.revision.id, created.revision.id])
      expect(revisions[0]?.message).toBe("Weekly report by DynWork")
      expect(revisions[0]?.parent).toBe(created.revision.id)
      expect((await ok(backend.get(created.document.id))).head.id).toBe(edited.revision.id)
    })

    test("an edit written against an older revision merges onto the head and says so", async () => {
      const { backend } = make()
      const created = await ok(backend.upload({ name: "merged.md", bytes: text("# One"), mime: "text/markdown" }))
      const ops = [{ op: "append_markdown", markdown: "more" }]
      const second = await ok(backend.edit(created.document.id, { ops }))
      if (second.kind !== "landed") throw new Error("expected a landed edit")
      const third = await ok(backend.edit(created.document.id, { ops, base: created.revision.id }))
      if (third.kind !== "landed") throw new Error("expected a landed edit")
      expect(third.merged).toBe(second.revision.id)
    })

    test("a proposal leaves the head alone and is listed as open", async () => {
      const { backend } = make()
      const created = await ok(backend.upload({ name: "proposed.md", bytes: text("# One"), mime: "text/markdown" }))
      const proposed = await ok(
        backend.edit(created.document.id, {
          ops: [{ op: "append_markdown", markdown: "Two" }],
          mode: "propose",
          message: "Chat by DynWork",
        }),
      )
      if (proposed.kind !== "proposed") throw new Error(`expected a proposal, got ${proposed.kind}`)
      expect(proposed.proposal).toMatchObject({
        document: created.document.id,
        base: created.revision.id,
        status: "open",
      })
      expect((await ok(backend.get(created.document.id))).head.id).toBe(created.revision.id)
      expect((await ok(backend.proposals(created.document.id))).map((proposal) => proposal.id)).toEqual([
        proposed.proposal.id,
      ])
    })

    test("where agents may only suggest, an edit that lands answers suggest", async () => {
      const subject = make()
      const created = await ok(
        subject.backend.upload({ name: "capped.md", bytes: text("# One"), mime: "text/markdown" }),
      )
      subject.suggestOnly(true)
      const refused = await subject.backend.edit(created.document.id, {
        ops: [{ op: "append_markdown", markdown: "x" }],
      })
      subject.suggestOnly(false)
      expectFailure(refused, "suggest")
    })

    test("comments anchor to a node of the outline, take replies and resolve", async () => {
      const { backend } = make()
      const created = await ok(
        backend.upload({ name: "commented.md", bytes: text("# Hola\nsecond"), mime: "text/markdown" }),
      )
      const outline = crossing(Outline, await ok(backend.outline(created.document.id)))
      expect(outline.revision).toBe(created.revision.id)
      const node = outline.nodes[0]
      if (!node) throw new Error("the outline has no node")
      const first = crossing(
        Comment,
        await ok(
          backend.comment(created.document.id, { body: "Why?", anchor: { kind: "node", node: node.id, find: "Hola" } }),
        ),
      )
      expect(first.anchor).toEqual({ node: node.id, find: "Hola" })
      // The user's own comment, whichever way DynWork signs it
      expect(first.mine).toBe(true)
      expect(first.resolved).toBeUndefined()
      const reply = await ok(backend.reply(created.document.id, { body: "Because.", parent: first.id }))
      expect(reply.parent).toBe(first.id)
      expect(reply.anchor?.node).toBe(node.id)
      const resolved = await ok(backend.resolve(created.document.id, first.id))
      expect(resolved.resolved).toBeNumber()
      const comments = await ok(backend.comments(created.document.id))
      expect(comments.map((comment) => comment.id)).toEqual([first.id, reply.id])
      expect(comments[0]?.resolved).toBeNumber()
    })

    test("a comment on a node that is not in the head is a conflict", async () => {
      const { backend } = make()
      const created = await ok(backend.upload({ name: "gone.md", bytes: text("# Hola"), mime: "text/markdown" }))
      expectFailure(
        await backend.comment(created.document.id, { body: "?", anchor: { kind: "node", node: "zz-missing" } }),
        "conflict",
      )
    })

    test("a comment on a cell range or a PDF point is unsupported", async () => {
      const { backend } = make()
      const created = await ok(backend.upload({ name: "sheet.md", bytes: text("# Hola"), mime: "text/markdown" }))
      expectFailure(
        await backend.comment(created.document.id, {
          body: "?",
          anchor: { kind: "range", sheet: 0, from: "A1", to: "B2" },
        }),
        "unsupported",
      )
      expectFailure(
        await backend.comment(created.document.id, { body: "?", anchor: { kind: "page", page: 1, x: 0.5, y: 0.5 } }),
        "unsupported",
      )
    })

    test("an HTML document renders as designed with the policy it came with; any document previews", async () => {
      const { backend } = make()
      const html = await ok(backend.upload({ name: "page.html", bytes: text("<h1>Hi</h1>"), mime: "text/html" }))
      expect(html.document.format).toBe("html")
      const rendered = crossing(Page, await ok(backend.rendered(html.document.id)))
      expect(rendered.html).toContain("<h1>Hi</h1>")
      expect(rendered.csp).toContain("sandbox")
      expect(rendered.revision).toBe(html.revision.id)
      expect((await ok(backend.rendered(html.document.id, html.revision.id))).revision).toBe(html.revision.id)
      const markdown = await ok(backend.upload({ name: "plain.md", bytes: text("plain words"), mime: "text/markdown" }))
      expect((await ok(backend.preview(markdown.document.id))).html).toContain("plain words")
      expectFailure(await backend.rendered(markdown.document.id), "unsupported")
    })

    test("a document's bytes come as stored, at its head or at a revision it has", async () => {
      const { backend } = make()
      const created = await ok(
        backend.upload({ name: "source.md", bytes: text("# Source\n\n- one"), mime: "text/markdown" }),
      )
      const source = crossing(Content, await ok(backend.content(created.document.id)))
      expect(new TextDecoder().decode(source.bytes)).toBe("# Source\n\n- one")
      expect(source.revision).toBe(created.revision.id)
      expect((await ok(backend.content(created.document.id, created.revision.id))).revision).toBe(created.revision.id)
      expectFailure(await backend.content(created.document.id, randomUUID()), "not-found")
    })

    test("any document comes as a PDF", async () => {
      const { backend } = make()
      const created = await ok(backend.upload({ name: "print.md", bytes: text("# Print"), mime: "text/markdown" }))
      const pdf = crossing(Pdf, await ok(backend.pdf(created.document.id)))
      expect(new TextDecoder().decode(pdf.bytes.subarray(0, 5))).toBe("%PDF-")
      const at = await ok(backend.pdf(created.document.id, created.revision.id))
      expect(at.revision).toBe(created.revision.id)
      expectFailure(await backend.pdf(created.document.id, randomUUID()), "not-found")
    })

    test("who has access and what DynWork may do answer for a document", async () => {
      const { backend } = make()
      const created = await ok(backend.upload({ name: "shared.md", bytes: text("# Hola"), mime: "text/markdown" }))
      const access = crossing(Access, await ok(backend.access(created.document.id)))
      expect(access.access).toBe("own")
      expect(access.owner).toBe(created.document.owner)
      const cap = crossing(AgentCap, await ok(backend.agentCap({ kind: "document", id: created.document.id })))
      expect(["none", "read", "suggest", "edit"]).toContain(cap.cap)
      expect(["none", "read", "suggest", "edit"]).toContain(cap.unattended)
    })

    test("an unknown document is not-found, as data, for every read", async () => {
      const { backend } = make()
      const id = randomUUID()
      const answers = await Promise.all([
        backend.get(id),
        backend.rendered(id),
        backend.preview(id),
        backend.content(id),
        backend.pdf(id),
        backend.outline(id),
        backend.revisions(id),
        backend.proposals(id),
        backend.comments(id),
        backend.access(id),
        backend.agentCap({ kind: "document", id }),
      ])
      answers.forEach((answer) => expectFailure(answer, "not-found"))
    })
  })
}

/** The success, or the test fails with the failure it got. */
export async function ok<A>(answer: Promise<A | Failure> | A | Failure): Promise<A> {
  const value = await answer
  if (isFailure(value)) throw new Error(`expected a success, got ${value.code}: ${value.message}`)
  return value
}

export function expectFailure(value: unknown, code: Failure["code"]) {
  expect(isFailure(value)).toBe(true)
  expect(value).toMatchObject({ code })
}
