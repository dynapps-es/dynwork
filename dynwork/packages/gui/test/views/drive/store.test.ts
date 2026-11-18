import { afterEach, describe, expect, test } from "bun:test"
import { isFailure } from "../../../src/drive/contract"
import { account as active, follow, governance } from "../../../src/views/drive/store"
import { framed } from "../../../src/views/drive/workspace"
import { flush } from "../../drive/wire"
import { account, chat, file, names, setup } from "./fixture"

const cleanups: Array<() => void> = []
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  follow(undefined)
})

async function stand(options?: Parameters<typeof setup>[0]) {
  const view = await setup(options)
  cleanups.push(view.dispose)
  return view
}

const ok = <A>(value: A) => {
  if (isFailure(value)) throw new Error(`failed: ${value.code}`)
  return value as Exclude<A, { code: string }>
}

describe("the browser over the account's Drive", () => {
  test("Home lists the root's folders and loose files, and a folder its own", async () => {
    const { store, id } = await stand()
    await store.reload()
    expect(names(store.shownFolders())).toEqual(["Artifacts", "Internal", "Customers"])
    expect(names(store.shown())).toEqual(["Project start checklist.md"])
    await store.goFolder(id("Artifacts/odoo-modules"))
    expect(names(store.shown()).toSorted()).toEqual([
      "Credit note analysis.xlsx",
      "VAT dashboard by journal.html",
      "VAT rounding report.docx",
    ])
    await store.goFolder(id("Artifacts"))
    expect(names(store.shownFolders())).toEqual(["odoo-modules", "acme-retail"])
  })

  test("Recent is the service's snapshot: choosing it reads nothing more", async () => {
    const { store, fake } = await stand()
    const before = fake.calls.list ?? 0
    await store.setScope("recent")
    expect(fake.calls.list ?? 0).toBe(before)
    expect(store.shown()).toHaveLength(7)
    expect(store.state.listing.status).toBe("ready")
  })

  test("Mine and Shared split by owner, and Shared shows the top folders someone shares", async () => {
    const { store } = await stand()
    await store.setScope("mine")
    expect(store.shown().every((doc) => doc.mine)).toBe(true)
    expect(store.shown()).toHaveLength(5)
    await store.setScope("shared")
    expect(names(store.shown()).toSorted()).toEqual(["Framework contract.pdf", "Kickoff meeting notes.md"])
    expect(names(store.shownFolders())).toEqual(["Customers"])
  })

  test("a search reads both scopes by name, from every folder; clearing it goes back to the scope", async () => {
    const { store } = await stand()
    await store.reload()
    await store.setQuery("  VAT ")
    expect(names(store.shown()).toSorted()).toEqual(["VAT dashboard by journal.html", "VAT rounding report.docx"])
    expect(store.shownFolders()).toEqual([])
    await store.setQuery("kickoff")
    expect(names(store.shown())).toEqual(["Kickoff meeting notes.md"])
    await store.setQuery("")
    expect(names(store.shown())).toEqual(["Project start checklist.md"])
  })

  test("the type filter and the order apply to what was read", async () => {
    const { store } = await stand()
    await store.setScope("mine")
    store.setType("xlsx")
    expect(names(store.shown())).toEqual(["Credit note analysis.xlsx"])
    store.setType("all")
    store.nextSort()
    expect(store.state.browse.sort).toBe("name")
    expect(names(store.shown())[0]).toBe("Acme proposal 2027.pptx")
  })

  test("an answer for a listing the user has left is dropped", async () => {
    const gate: { open?: () => void } = {}
    const { store, id } = await stand({
      backend: (backend) => ({
        ...backend,
        list: async (query) => {
          if (query.scope === "shared") await new Promise<void>((resolve) => (gate.open = resolve))
          return backend.list(query)
        },
      }),
    })
    const slow = store.setScope("shared")
    await flush()
    await store.goFolder(id("Internal"))
    gate.open?.()
    await slow
    expect(store.state.browse.folder).toBe(id("Internal"))
    expect(store.shown()).toEqual([])
    expect(store.state.listing.status).toBe("ready")
  })

  test("a listing that fails says why and shows nothing stale; a retry reads it again", async () => {
    const { store, fake } = await stand()
    await store.reload()
    fake.down({ code: "unreachable", message: "away", retryable: true })
    await store.setScope("mine")
    expect(store.state.listing).toMatchObject({ status: "failed", documents: [] })
    expect(store.state.listing.failure?.code).toBe("unreachable")
    fake.down(undefined)
    await store.reload()
    expect(store.state.listing.status).toBe("ready")
    expect(store.shown()).toHaveLength(5)
  })

  test("a long listing comes a page at a time, and Show more appends the next", async () => {
    const { store, fake } = await stand()
    // Straight into the Drive: 101 writes through the service would each read the Drive again.
    await Promise.all(Array.from({ length: 101 }, (_, index) => fake.upload(file(`bulk ${index}.md`))))
    await store.setScope("mine")
    expect(store.shown()).toHaveLength(100)
    expect(store.state.listing.next).toBeDefined()
    await store.more()
    expect(store.shown()).toHaveLength(106)
    expect(store.state.listing.next).toBeUndefined()
  })
})

describe("writing to the Drive", () => {
  test("an upload lands in the open folder, signed by the user, selected, and the listing has it", async () => {
    const { store, id, seen } = await stand()
    await store.goFolder(id("Internal"))
    const created = ok(await store.upload(file("minutes.md", "# Minutes", "")))
    expect(created.document).toMatchObject({ name: "minutes.md", folder: id("Internal"), format: "markdown" })
    expect(store.state.browse.selected).toBe(created.document.id)
    expect(names(store.shown())).toEqual(["minutes.md"])
    expect(seen.at(-1)?.input).toMatchObject({ message: `${account.user} by DynWork`, mime: "text/markdown" })
  })

  test("a file a conversation made goes to the root with the conversation's name and context, and into the index", async () => {
    const { store, id, seen, service } = await stand()
    await store.goFolder(id("Internal"))
    const created = ok(await store.upload(file("chart.html", "<p>chart</p>", "text/html"), chat))
    expect(created.document.folder).toBeUndefined()
    expect(seen.at(-1)?.input).toMatchObject({
      message: `${chat.name} by DynWork`,
      contextId: service.context(chat.id),
    })
    expect(store.linksOf(chat.id).map((link) => [link.document, link.act])).toEqual([[created.document.id, "created"]])
    await store.setScope("chats")
    expect(names(store.shown())).toEqual(["chart.html"])
  })

  test("a folder is made in the open folder, and a document from a template too", async () => {
    const { store, id, seen } = await stand()
    await store.goFolder(id("Artifacts"))
    const folder = ok(await store.createFolder("Q3"))
    expect(folder.parent).toBe(id("Artifacts"))
    expect(names(store.folders().filter((item) => item.parent === id("Artifacts")))).toContain("Q3")
    await store.goFolder(folder.id)
    const created = ok(await store.create("dynapps-word", "Q3 report"))
    expect(created.document).toMatchObject({ name: "Q3 report", format: "docx", folder: folder.id })
    expect(seen.at(-1)).toEqual({
      method: "create",
      input: { template: "dynapps-word", name: "Q3 report", folder: folder.id, contextId: undefined },
    })
    expect(names(store.shown())).toEqual(["Q3 report"])
  })

  test("a template from a conversation goes to the root and into its index", async () => {
    const { store, id, service } = await stand()
    await store.goFolder(id("Artifacts"))
    const created = ok(await store.create("blank-markdown", "Notes", chat))
    expect(created.document.folder).toBeUndefined()
    expect(store.linksOf(chat.id)).toEqual([
      expect.objectContaining({ document: created.document.id, act: "created", via: "rest" }),
    ])
    expect(service.context(chat.id)).toBeDefined()
  })

  test("attaching a document to a chat enters the index; From my chats reads by id one no listing holds", async () => {
    // An empty snapshot: the document is older than what Recent holds.
    const { store, id } = await stand({
      backend: (backend) => ({
        ...backend,
        list: (query) =>
          query.scope === "recent" ? Promise.resolve({ folders: [], documents: [] }) : backend.list(query),
      }),
    })
    const kickoff = id("Kickoff meeting notes.md")
    expect(store.doc(kickoff)).toBeUndefined()
    expect(await store.link(chat.id, kickoff, "attached")).toBeUndefined()
    expect(store.linksOf(chat.id).map((link) => link.act)).toEqual(["attached"])
    await store.setScope("chats")
    expect(names(store.shown())).toEqual(["Kickoff meeting notes.md"])
    expect(store.state.known[kickoff]?.mine).toBe(false)
  })

  test("without a connection to main nothing is read, and a write answers signed-out", async () => {
    const { store } = await stand({ disconnected: true })
    expect(store.status()).toBe("none")
    await store.reload()
    expect(store.state.listing).toMatchObject({ status: "idle", documents: [] })
    const uploaded = await store.upload(file("x.md"))
    expect(isFailure(uploaded) && uploaded.code).toBe("signed-out")
    const made = await store.create("dynapps-word", "x")
    expect(isFailure(made) && made.code).toBe("signed-out")
  })
})

describe("an open document", () => {
  test("reads its details, versions, proposals, access, what DynWork may do, and a preview", async () => {
    const { store, client, id } = await stand()
    const report = id("VAT rounding report.docx")
    ok(await client.edit({ id: report, ops: [{ op: "append_markdown", markdown: "More" }] }))
    ok(await client.edit({ id: report, ops: [{ op: "append_markdown", markdown: "Idea" }], mode: "propose" }))
    await store.openDoc(report)
    const opened = store.state.opened
    expect(store.current()?.name).toBe("VAT rounding report.docx")
    expect(opened.detail?.document.id).toBe(report)
    expect(opened.revisions?.map((revision) => revision.message)).toEqual([`${account.user} by DynWork`, undefined])
    expect(opened.proposals?.map((proposal) => proposal.status)).toEqual(["open"])
    expect(opened.access?.access).toBe("own")
    expect(opened.cap).toMatchObject({ cap: "edit", unattended: "suggest" })
    expect(opened.page && !isFailure(opened.page) && opened.page.csp).toContain("default-src 'none'")
    expect(store.state.doc.tab).toBe("details")
    store.closeDoc()
    expect(store.state.open).toBeUndefined()
    expect(store.state.opened).toEqual({})
  })

  test("a document that is gone says not-found", async () => {
    const { store } = await stand()
    await store.openDoc("gone")
    expect(store.state.opened.failure?.code).toBe("not-found")
    expect(store.current()).toBeUndefined()
  })

  test("opening another document drops what the first one answers late", async () => {
    const gate: { open?: () => void } = {}
    const { store, id } = await stand({
      backend: (backend) => ({
        ...backend,
        revisions: async (document) => {
          if (document === id("Project start checklist.md")) await new Promise<void>((resolve) => (gate.open = resolve))
          return backend.revisions(document)
        },
      }),
    })
    const first = store.openDoc(id("Project start checklist.md"))
    await flush()
    await store.openDoc(id("Framework contract.pdf"))
    gate.open?.()
    await first
    expect(store.state.open).toBe(id("Framework contract.pdf"))
    expect(store.state.opened.revisions?.[0]?.document).toBe(id("Framework contract.pdf"))
  })

  test("DynWork edits as the person only once the Drive allows it (P1)", async () => {
    expect((await stand()).store.person()).toBe(false)
    expect((await stand({ capabilities: { personActions: true } })).store.person()).toBe(true)
  })
})

describe("Governance and the preview", () => {
  test("Open in Governance goes to the active account's Drive, and nowhere without one", () => {
    expect(governance("doc 1")).toBeUndefined()
    follow({ url: "https://governance.example.com/", user: "david@dynapps.es" })
    expect(governance("doc 1")).toBe("https://governance.example.com/drive/doc%201")
    expect(governance()).toBe("https://governance.example.com/drive")
    expect(active()?.user).toBe("david@dynapps.es")
  })

  test("the preview keeps the instance's policy, less what only a header carries", () => {
    const page = framed({
      html: "<p>Hola</p>",
      csp: "sandbox allow-scripts; default-src 'none'; img-src data: \"x\"; frame-ancestors 'self'",
    })
    expect(page).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: &quot;x&quot;">`,
    )
    expect(page).toContain("<body><p>Hola</p></body>")
    expect(framed({ html: "" })).toContain(`content="default-src 'none'"`)
  })
})
