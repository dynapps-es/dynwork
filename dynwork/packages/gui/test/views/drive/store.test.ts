import { afterEach, describe, expect, test } from "bun:test"
import { isFailure } from "../../../src/drive/contract"
import { back, openInDrive } from "../../../src/views/drive/chat"
import { account as active, drive, follow, governance } from "../../../src/views/drive/store"
import { frameOf } from "../../../src/views/drive/viewer"
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
      input: {
        template: "dynapps-word",
        name: "Q3 report",
        folder: folder.id,
        message: "david@dynapps.es by DynWork",
        contextId: undefined,
      },
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

describe("a chat's artifacts", () => {
  // What the chat header counts and the Artifacts tab lists. The tests run Solid's server build, where nothing reruns,
  // so the count is read again each time; in the window the Ipc's state is a signal main sets on every push.
  async function counted() {
    const pushes = { count: 0 }
    const view = await stand({ changed: () => void pushes.count++ })
    return { ...view, pushes }
  }

  test("a chat with no documents has none", async () => {
    const { store } = await counted()
    expect(store.artifactsOf(chat.id)).toEqual([])
  })

  test("one per document the chat made, changed or attached, pushed to the windows as each arrives", async () => {
    const { store, id, pushes } = await counted()
    const report = id("VAT rounding report.docx")
    const analysis = id("Credit note analysis.xlsx")
    const before = pushes.count
    expect(await store.link(chat.id, report, "created")).toBeUndefined()
    expect(pushes.count).toBeGreaterThan(before)
    expect(store.artifactsOf(chat.id)).toHaveLength(1)
    expect(await store.link(chat.id, analysis, "attached")).toBeUndefined()
    // The same document edited again stays one artifact, and another chat's is not this chat's.
    expect(await store.link(chat.id, report, "edited")).toBeUndefined()
    expect(await store.link("ses_other", id("Acme proposal 2027.pptx"), "created")).toBeUndefined()
    // The links of one test may share a millisecond, so which act is the latest is `latest`'s test (agent.test.ts).
    expect(
      store
        .artifactsOf(chat.id)
        .map((link) => link.document)
        .toSorted(),
    ).toEqual([report, analysis].toSorted())
  })
})

describe("an open document", () => {
  test("reads its details, versions, proposals, access and what DynWork may do; its viewer reads the page", async () => {
    const { store, client, fake, id } = await stand()
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
    // The viewer reads the page itself, by format and version (viewer.test.ts): the drawer does not read it again
    expect(fake.calls.preview ?? 0).toBe(0)
    expect(store.state.doc.tab).toBe("details")
    store.closeDoc()
    expect(store.state.open).toBeUndefined()
    expect(store.state.opened).toEqual({})
  })

  test("keeps the size the listing showed, which the document by id does not carry (0.83)", async () => {
    const { store, id } = await stand({
      backend: (backend) => ({
        ...backend,
        get: async (document) => {
          const answer = await backend.get(document)
          if (isFailure(answer)) return answer
          const { size, ...rest } = answer.document
          return { ...answer, document: rest }
        },
      }),
    })
    await store.reload()
    const checklist = id("Project start checklist.md")
    const listed = store.doc(checklist)?.size
    expect(listed).toBeGreaterThan(0)
    await store.openDoc(checklist)
    expect(store.state.opened.detail?.document.id).toBe(checklist)
    expect(store.current()?.size).toBe(listed)
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

describe("Back from an open document", () => {
  const vat = { server: "local", id: "ses_vat", tab: "tab-vat" }

  test("opened from a folder, it goes back to that folder of the browser", async () => {
    const { store, id } = await stand()
    await store.goFolder(id("Artifacts/odoo-modules"))
    await store.openDoc(id("VAT dashboard by journal.html"))
    expect(store.closeDoc()).toBeUndefined()
    expect(store.state.open).toBeUndefined()
    expect([store.state.browse.scope, store.state.browse.folder]).toEqual(["home", id("Artifacts/odoo-modules")])
    expect(names(store.shown())).toContain("VAT dashboard by journal.html")
  })

  test("opened from a search or a scope, it goes back to it, even when the browser moved meanwhile", async () => {
    const { store, id } = await stand()
    await store.setScope("shared")
    await store.setQuery("contract")
    await store.openDoc(id("Framework contract.pdf"))
    await store.goFolder(id("Internal"))
    store.closeDoc()
    await flush()
    expect([store.state.browse.scope, store.state.browse.folder, store.state.browse.query]).toEqual([
      "shared",
      undefined,
      "contract",
    ])
    expect(names(store.shown())).toEqual(["Framework contract.pdf"])
  })

  test("opened beside a chat, it answers that chat and leaves the browser as it was", async () => {
    const { store, id } = await stand()
    await store.goFolder(id("Internal"))
    await store.openDoc(id("VAT dashboard by journal.html"), { from: vat })
    expect(store.closeDoc()).toEqual(vat)
    expect(store.state.browse.folder).toBe(id("Internal"))
    // Each opening says where it came from: the next one, from the browser, goes back to it.
    await store.openDoc(id("Framework contract.pdf"))
    expect(store.closeDoc()).toBeUndefined()
  })

  test("from nowhere known it goes to the Drive's Home", async () => {
    const { store, id } = await stand()
    await store.goFolder(id("Internal"))
    expect(store.closeDoc()).toBeUndefined()
    expect([store.state.browse.scope, store.state.browse.folder]).toEqual(["home", undefined])
  })

  test("Open in the Drive from a chat's side panel comes back to that chat's tab, opened again when it was closed", () => {
    const pages: string[] = []
    const calls: unknown[] = []
    const tabs = { list: [] as { key: string }[] }
    const ctx = {
      layout: { page: (page: string) => pages.push(page) },
      tabs: {
        list: () => tabs.list,
        focus: (key: string) => calls.push(["focus", key]),
        open: (session: unknown, options: unknown) => calls.push(["open", session, options]),
      },
    }
    const session = { id: vat.id, tab: vat.tab, server: { id: vat.server } }
    // SAFETY: `openInDrive` reads the session's ids and `layout.page`; `back` reads only `tabs`.
    openInDrive(ctx as never, session as never, "doc-1")
    expect([pages, drive.state.open]).toEqual([["drive"], "doc-1"])
    tabs.list = [{ key: "tab-other" }, { key: vat.tab }]
    back(ctx as never)
    expect(calls).toEqual([["focus", vat.tab]])
    expect(drive.state.open).toBeUndefined()

    calls.length = 0
    openInDrive(ctx as never, session as never, "doc-1")
    tabs.list = []
    back(ctx as never)
    expect(calls).toEqual([["open", { server: vat.server, id: vat.id }, { focus: true }]])
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
    const frame = frameOf({
      html: "<p>Hola</p>",
      csp: "sandbox allow-scripts; default-src 'none'; img-src data: \"x\"; frame-ancestors 'self'",
    })
    expect(frame.sandbox).toBe("allow-scripts")
    const page = frame.srcdoc
    expect(page).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: &quot;x&quot;">`,
    )
    expect(page).toContain("<body><p>Hola</p></body>")
    expect(frameOf({ html: "" }).srcdoc).toContain(`content="default-src 'none'"`)
  })

  // G11: the CSP 0.84 serves a page an agent wrote under `renderedHtml.agentAuthored` with scripts on and two remote
  // origins, as `RenderedHtmlTier::csp` builds it (core `rendered_csp.rs`). The frame takes exactly what it grants.
  test("a page an agent wrote, under 0.84's agentAuthored tier, runs its scripts with those origins and nothing more", () => {
    const origins = "https://cdnjs.cloudflare.com https://cdn.jsdelivr.net"
    const csp = [
      "sandbox allow-scripts",
      "default-src 'none'",
      `script-src 'unsafe-inline' 'unsafe-eval' ${origins}`,
      `style-src 'unsafe-inline' ${origins}`,
      `img-src data: blob: ${origins}`,
      `font-src data: ${origins}`,
      `media-src data: blob: ${origins}`,
      "form-action 'none'",
      "base-uri 'none'",
    ].join("; ")
    const frame = frameOf({ html: "<h1>Chart</h1><script>draw()</script>", csp })
    // Scripts, and never DynWork's origin, a popup, a form or the top window.
    expect(frame.sandbox).toBe("allow-scripts")
    expect(frame.srcdoc).toContain(
      `<meta http-equiv="Content-Security-Policy" content="${csp.replace("sandbox allow-scripts; ", "")}">`,
    )
    expect(frame.srcdoc).toContain("<script>draw()</script>")
    // The locked tier (agentAuthored off, 0.84's default) leaves the page without scripts.
    const locked = frameOf({
      html: "<script>draw()</script>",
      csp: "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'",
    })
    expect(locked.sandbox).toBe("")
  })
})
