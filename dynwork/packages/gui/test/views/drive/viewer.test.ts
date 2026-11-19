import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { LinkHandler, MenuItem, Panel, Slot } from "@opencode/plugin/gui"
import { createRoot } from "solid-js"
import { fail, DriveBackend } from "../../../src/drive/backend"
import { isFailure, type Document } from "../../../src/drive/contract"
import { DriveFrames } from "../../../src/drive/frames"
import { DriveIpc } from "../../../src/drive/ipc"
import { askAgent, docKey, listKey, openArtifacts } from "../../../src/views/drive/chat"
import { registerDrive } from "../../../src/views/drive/register"
import { isPdf } from "../../../src/views/drive/model"
import { frameOf, load } from "../../../src/views/drive/viewer"
import { startFake } from "../../../../sp-client/test/fake"
import { storage } from "../../routines/fixture"
import { connect, flush } from "../../drive/wire"
import { setup } from "./fixture"

// The policies `/rendered` answered with in the live checks (C3): sp-local runs no scripts, production runs scripts
// and loads `https:` resources.
const strict =
  "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; frame-ancestors 'self'"
const scripts =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; media-src data: blob: https:; form-action 'none'; frame-ancestors 'self'"

const meta = (srcdoc: string) =>
  srcdoc.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/)?.[1]?.replaceAll("&quot;", '"')

const cleanups: Array<() => void> = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))

async function stand(options?: Parameters<typeof setup>[0]) {
  const view = await setup(options)
  cleanups.push(view.dispose)
  return view
}

const ok = <A>(value: A) => {
  if (isFailure(value)) throw new Error(`failed: ${value.code}`)
  return value as Exclude<A, { code: string }>
}

describe("the frame an HTML page runs in", () => {
  test("the strict policy runs no scripts and reaches no network", () => {
    const frame = frameOf({ html: "<p>Hola</p>", csp: strict })
    expect(frame.sandbox).toBe("")
    // The name main's navigation guard keeps on its page (test/drive/frames.test.ts)
    expect(frame.name).toBe(DriveFrames.name)
    expect(meta(frame.srcdoc)).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'",
    )
    expect(frame.srcdoc).not.toContain("https:")
    expect(frame.srcdoc).toContain("<body><p>Hola</p></body>")
  })

  test("a policy that allows scripts and https: gets exactly that, as served", () => {
    const frame = frameOf({ html: "<canvas></canvas>", csp: scripts })
    expect(frame.sandbox).toBe("allow-scripts")
    expect(meta(frame.srcdoc)).toBe(
      "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; media-src data: blob: https:; form-action 'none'",
    )
  })

  test("never DynWork's origin, the top window or an unsandboxed popup, whatever the instance sends", () => {
    const frame = frameOf({
      html: "",
      csp: "SANDBOX allow-scripts Allow-Same-Origin allow-top-navigation allow-top-navigation-by-user-activation allow-popups-to-escape-sandbox allow-forms; default-src 'none'",
    })
    expect(frame.sandbox).toBe("allow-scripts allow-forms")
    expect(frame.sandbox.toLowerCase()).not.toContain("same-origin")
    expect(frame.sandbox).not.toContain("top-navigation")
    expect(frame.sandbox).not.toContain("escape-sandbox")
  })

  test("a policy without a sandbox directive, or no policy at all, gets the strictest frame", () => {
    const loose = frameOf({ html: "", csp: "default-src 'none'; script-src https://sandbox.example" })
    expect(loose.sandbox).toBe("")
    expect(meta(loose.srcdoc)).toBe("default-src 'none'; script-src https://sandbox.example")
    const bare = frameOf({ html: "<script>alert(1)</script>" })
    expect(bare.sandbox).toBe("")
    expect(meta(bare.srcdoc)).toBe("default-src 'none'")
  })

  test("the policy comes first, before anything the page holds, and sends no referrer", () => {
    const frame = frameOf({
      html: `</head><meta http-equiv="Content-Security-Policy" content="script-src *"><script>1</script>`,
      csp: strict,
    })
    expect(frame.srcdoc.indexOf(`content="default-src 'none'`)).toBeLessThan(frame.srcdoc.indexOf("script-src *"))
    expect(frame.srcdoc).toContain(`<meta name="referrer" content="no-referrer">`)
  })
})

describe("what each format shows", () => {
  test("an HTML page as designed (`/rendered`), Markdown from its source, Office as the Drive previews it", async () => {
    const view = await stand()
    const html = ok(
      await load(view.client, { id: view.id("VAT dashboard by journal.html"), format: "html", mime: "text/html" }),
    )
    expect(html.kind).toBe("page")
    expect(view.fake.calls.rendered).toBe(1)
    const word = ok(
      await load(view.client, {
        id: view.id("VAT rounding report.docx"),
        format: "docx",
        mime: "application/octet-stream",
      }),
    )
    expect(word.kind).toBe("page")
    expect(view.fake.calls.preview).toBe(1)
    const notes = ok(
      await load(view.client, { id: view.id("Kickoff meeting notes.md"), format: "markdown", mime: "text/markdown" }),
    )
    if (notes.kind !== "markdown") throw new Error(`a ${notes.kind}`)
    // The stored source, for the app's own Markdown renderer: no frame and no preview for it
    expect(notes.text).toBe("Kickoff meeting notes.md\nFirst line")
    expect([view.fake.calls.content, view.fake.calls.preview, view.fake.calls.rendered]).toEqual([1, 1, 1])
  })

  test("a PDF is its stored bytes for DynWork's viewer, from no frame and no page read", async () => {
    const view = await stand()
    const shown = ok(
      await load(view.client, { id: view.id("Framework contract.pdf"), format: "pdf", mime: "application/pdf" }),
    )
    if (shown.kind !== "pdf") throw new Error(`a ${shown.kind}`)
    expect(new TextDecoder().decode(shown.pdf.bytes)).toStartWith("Framework contract.pdf")
    expect([view.fake.calls.preview ?? 0, view.fake.calls.rendered ?? 0, view.fake.calls.pdf ?? 0]).toEqual([0, 0, 0])
    expect(view.fake.calls.content).toBe(1)
  })

  test("an uploaded PDF, which the instance keeps as a `file`, is a PDF by its type; nothing else is", () => {
    expect(isPdf({ format: "file", mime: "application/pdf" })).toBe(true)
    expect(isPdf({ format: "pdf", mime: "application/octet-stream" })).toBe(true)
    expect(isPdf({ format: "file", mime: "application/pdf; charset=binary" })).toBe(true)
    expect(isPdf({ format: "html", mime: "text/html" })).toBe(false)
    expect(isPdf({ format: "file", mime: "application/octet-stream" })).toBe(false)
    expect(
      isPdf({ format: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }),
    ).toBe(false)
  })

  test("an instance without `/rendered` still shows the page, as its preview", async () => {
    const view = await stand({
      backend: (backend) => ({ ...backend, rendered: async () => fail("unsupported", "No rendered view here.") }),
    })
    const shown = ok(
      await load(view.client, { id: view.id("VAT dashboard by journal.html"), format: "html", mime: "text/html" }),
    )
    if (shown.kind !== "page") throw new Error(`a ${shown.kind}`)
    expect(shown.page.html).toStartWith("<p>")
    expect(view.fake.calls.preview).toBe(1)
  })

  test("a Markdown source is read as UTF-8", async () => {
    const view = await stand()
    const made = ok(
      await view.fake.upload({
        name: "Café.md",
        bytes: new TextEncoder().encode("# Café — ñ, €, 日本"),
        mime: "text/markdown",
      }),
    )
    const shown = ok(await load(view.client, { id: made.document.id, format: "markdown", mime: "text/markdown" }))
    expect(shown.kind === "markdown" && shown.text).toBe("# Café — ñ, €, 日本")
  })

  test("a Markdown tab's version reads that revision's source", async () => {
    const view = await stand()
    const id = view.id("Kickoff meeting notes.md")
    const head = ok(await view.client.revisions({ id }))[0]?.id
    const shown = ok(await load(view.client, { id, format: "markdown", mime: "text/markdown" }, head))
    expect(shown.kind === "markdown" && shown.revision).toBe(head ?? "none")
    const missing = await load(view.client, { id, format: "markdown", mime: "text/markdown" }, "rev-missing")
    expect(isFailure(missing) && missing.code).toBe("not-found")
  })

  test("a PDF tab's version reads that revision's bytes", async () => {
    const view = await stand()
    const id = view.id("Framework contract.pdf")
    const head = ok(await view.client.revisions({ id }))[0]?.id
    const shown = ok(await load(view.client, { id, format: "file", mime: "application/pdf" }, head))
    expect(shown.kind === "pdf" && shown.pdf.revision).toBe(head ?? "none")
  })

  test("a tab's version reads that revision; one the Drive does not have says so", async () => {
    const view = await stand()
    const id = view.id("VAT dashboard by journal.html")
    const head = ok(await view.client.revisions({ id }))[0]?.id
    const shown = ok(await load(view.client, { id, format: "html", mime: "text/html" }, head))
    expect(shown.kind === "page" && shown.page.revision).toBe(head ?? "none")
    const missing = await load(view.client, { id, format: "html", mime: "text/html" }, "rev-missing")
    expect(isFailure(missing) && missing.code).toBe("not-found")
  })
})

describe("the bearer stays in main", () => {
  const instance = startFake()
  afterAll(() => instance.stop())

  test("the page is read with the account's JWT, and neither the JWT nor DynWork's origin reaches the frame", async () => {
    const jwt = `jwt-${randomUUID()}`
    instance.state.jwts.add(jwt)
    instance.state.drive.csp = scripts
    const backend = DriveBackend.remote({ url: instance.url, user: "user-david", withJwt: (use) => use(jwt) })
    const service = DriveIpc.make({
      account: () => ({ id: "account-david", user: "david@dynapps.es" }),
      backend: () => backend,
      store: storage(DriveIpc.Saved, DriveIpc.initial),
      changed: () => {},
      capabilities: () => ({}),
      timers: { set: () => () => {} },
    })
    const client = connect(service)
    const created = ok(
      await client.upload({
        name: `animated-${randomUUID()}.html`,
        bytes: new TextEncoder().encode(`<canvas></canvas><script src="https://cdn.example/chart.js"></script>`),
        mime: "text/html",
      }),
    )
    const shown = ok(await load(client, { id: created.document.id, format: "html", mime: "text/html" }))
    if (shown.kind !== "page") throw new Error(`a ${shown.kind}`)
    const frame = frameOf(shown.page)

    const read = instance.state.requests.find(
      (request) => request.path === `/api/v1/documents/${created.document.id}/rendered`,
    )
    expect(read?.headers.authorization).toBe(`Bearer ${jwt}`)
    expect(frame.sandbox).toBe("allow-scripts")
    expect(frame.srcdoc).toContain(`<script src="https://cdn.example/chart.js"></script>`)
    expect(JSON.stringify(shown)).not.toContain(jwt)
    expect(frame.srcdoc).not.toContain(jwt)
    expect(frame.srcdoc).not.toContain("Bearer")
  })
})

describe("the side panel's tabs", () => {
  // The window entry's setup, with a stand-in context that records what the Drive adds and opens.
  async function registered() {
    const view = await stand()
    const added = new Map<unknown, unknown>()
    const opened: Array<{ key: string; session: unknown; options: unknown }> = []
    const session = { id: "ses_vat", key: "ses_vat@local" }
    const ctx = {
      use: () => () => ({ status: "active", value: view.client }),
      add: (registry: unknown, value: unknown) => {
        added.set(registry, value)
        return () => {}
      },
      t: (key: string) => key,
      sessions: { current: () => session },
      layout: {
        open: (key: string, target: unknown, options: unknown) => opened.push({ key, session: target, options }),
      },
    }
    const dispose = createRoot((dispose) => {
      // SAFETY: the Drive's setup reads only `use`, `add`, `t`, `sessions.current` and `layout.open`.
      registerDrive(ctx as unknown as Parameters<typeof registerDrive>[0])
      return dispose
    })
    cleanups.push(dispose)
    // SAFETY: each registry got the value the Drive gave it, a factory for Panel and MenuItem.
    const panel = (added.get(Panel) as () => Panel)()
    const item = (added.get(MenuItem) as () => MenuItem)()
    const links = added.get(LinkHandler) as LinkHandler
    const header = added.get(Slot) as Slot
    const list = (open: readonly string[]) =>
      // SAFETY: `list` reads only `open`.
      panel.list({ open } as unknown as Parameters<Panel["list"]>[0])
    return { view, ctx, panel, item, links, header, list, opened, session }
  }

  test("several documents open beside a chat at once, each its own tab, in the strip's order", async () => {
    const { view, list } = await registered()
    const a = view.id("VAT dashboard by journal.html")
    const b = view.id("Framework contract.pdf")
    const tabs = list(["drive", `drive.${a}`, `drive.${b}`])
    expect(tabs.map((tab) => tab.id)).toEqual(["drive", `drive.${a}`, `drive.${b}`])
    expect(tabs.map((tab) => tab.title)).toEqual([
      "drive.panel.title",
      "VAT dashboard by journal.html",
      "Framework contract.pdf",
    ])
    expect(tabs.every((tab) => tab.group === "drive" && !tab.hidden)).toBe(true)
    // The same tab object while the name stays, so the strip does not draw its label again
    expect(list([`drive.${a}`])[0]).toBe(tabs[1])
  })

  test("a restored tab the window does not know yet stays listed, hidden, until the Drive reads it", async () => {
    const { view, list } = await registered()
    const made = ok(
      await view.fake.upload({
        name: "Late report.md",
        bytes: new TextEncoder().encode("# Late"),
        mime: "text/markdown",
      }),
    )
    const before = list([`drive.${made.document.id}`])
    expect(before.map((tab) => [tab.id, tab.hidden])).toEqual([[`drive.${made.document.id}`, true]])
    await flush()
    const after = list([`drive.${made.document.id}`])
    expect(after.map((tab) => [tab.title, tab.hidden ?? false])).toEqual([["Late report.md", false]])
  })

  test("a tab whose document the Drive no longer has shows as missing, so it can be closed", async () => {
    const { list } = await registered()
    expect(list(["drive.gone"]).map((tab) => tab.hidden)).toEqual([true])
    await flush()
    expect(list(["drive.gone"]).map((tab) => [tab.title, tab.missing, tab.hidden])).toEqual([
      ["drive.tab.missing", true, false],
    ])
  })

  test("a tab whose document could not be read for a passing reason stays hidden, and is read again", async () => {
    const { view, list } = await registered()
    const made = ok(
      await view.fake.upload({ name: "Offline.md", bytes: new TextEncoder().encode("# x"), mime: "text/markdown" }),
    )
    view.fake.down(fail("unreachable", "Governance does not answer."))
    expect(list([`drive.${made.document.id}`]).map((tab) => tab.hidden)).toEqual([true])
    await flush()
    expect(list([`drive.${made.document.id}`]).map((tab) => [tab.hidden, tab.missing])).toEqual([[true, false]])
    view.fake.down(undefined)
    list([`drive.${made.document.id}`])
    await flush()
    expect(list([`drive.${made.document.id}`]).map((tab) => [tab.title, tab.hidden])).toEqual([["Offline.md", false]])
  })

  test("the panel's + offers the Drive, which opens the chat's list beside it", async () => {
    const { item, opened, session } = await registered()
    expect([item.menu, item.title]).toEqual(["session.panel", "drive.title"])
    item.run()
    expect(opened).toEqual([{ key: listKey, session, options: { tab: "open" } }])
  })

  // The button itself loads only in the window (Kobalte's tooltip needs a browser); it calls `openArtifacts`.
  test("the chat header counts the chat's artifacts before the context ring, and opens its Artifacts tab", async () => {
    const { ctx, header, opened, session } = await registered()
    // The context ring is at 10.
    expect(header.at).toBe("session.header")
    expect(header.order).toBeLessThan(10)
    // SAFETY: `openArtifacts` reads only `layout.open`, and the session as the header passes it on.
    openArtifacts(ctx as never, session as never)
    expect(opened).toEqual([{ key: listKey, session, options: { tab: "select" } }])
  })

  test("a link to a document from the Drive opens its tab in the link's chat", async () => {
    const { view, links, opened, session } = await registered()
    const id = view.id("VAT dashboard by journal.html")
    expect(links.match({ href: docKey(id), origin: "dynwork-drive" })).toBe(true)
    expect(links.match({ href: "src/app.ts" })).toBe(false)
    expect(links.match({ href: docKey(id), origin: "review" })).toBe(false)
    links.open({ href: docKey(id), origin: "dynwork-drive", session, background: true })
    expect(opened).toEqual([{ key: docKey(id), session, options: { tab: "select", background: true } }])
  })

  test("Use in a chat opens the document beside the chat and attaches a chip whose link opens it again", async () => {
    const view = await stand()
    const doc = view.store.doc(view.id("VAT dashboard by journal.html")) as Document
    const attached: Array<Record<string, unknown>> = []
    const opened: string[] = []
    const session = { id: "ses_vat", key: "ses_vat@local", tab: "tab-1" }
    const ctx = {
      sessions: { current: () => session },
      tabs: { list: () => [], focus: () => {} },
      layout: { open: (key: string) => opened.push(key) },
      screen: {
        current: () => ({
          composer: {
            attach: (item: Record<string, unknown>) => attached.push(item),
            setText: () => {},
            focus: () => {},
          },
        }),
      },
      toast: { show: () => {} },
      t: (key: string) => key,
    }
    // SAFETY: `askAgent` reads only these members of the host.
    askAgent(ctx as unknown as Parameters<typeof askAgent>[0], doc)
    expect(opened).toEqual([docKey(doc.id)])
    expect(attached.map((item) => [item.origin, item.href])).toEqual([["dynwork-drive", docKey(doc.id)]])
  })
})
