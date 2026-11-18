import { afterEach, describe, expect, test } from "bun:test"
import { DriveCapabilities } from "../../../src/drive/capabilities"
import { isFailure, type Comment } from "../../../src/drive/contract"
import {
  anchorsOf,
  matchNodes,
  nodeLabel,
  pickable,
  plain,
  quoteIn,
  threadsOf,
  type Node,
} from "../../../src/views/drive/model"
import { file, setup } from "./fixture"

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

/** What a write answered: the code of its failure, or `ok`. */
const code = (value: unknown) => (isFailure(value) ? value.code : "ok")

const comment = (id: string, at: number, change: Partial<Comment> = {}): Comment => ({
  id,
  anchor: { node: "n1" },
  author: "u1",
  mine: true,
  body: id,
  created: at,
  ...change,
})

const node = (id: string, text: string): Node => ({ id, hash: "", text })

describe("threads", () => {
  test("a reply joins its thread, oldest message first, and the newest thread comes first", () => {
    const threads = threadsOf([
      comment("a", 1),
      comment("b", 5, { anchor: { node: "n2", find: "x" } }),
      comment("a2", 3, { parent: "a" }),
      comment("a1", 2, { parent: "a" }),
    ])
    expect(threads.map((thread) => thread.id)).toEqual(["b", "a"])
    expect(threads[1]?.messages.map((message) => message.id)).toEqual(["a", "a1", "a2"])
    expect(threads[0]).toMatchObject({ node: "n2", quote: "x", open: true })
  })

  test("a reply of a reply is in the thread of the first comment", () => {
    const [thread] = threadsOf([comment("a", 1), comment("b", 2, { parent: "a" }), comment("c", 3, { parent: "b" })])
    expect(thread?.messages.map((message) => message.id)).toEqual(["a", "b", "c"])
  })

  test("a thread is resolved when its first comment is, and stays one whatever its replies say", () => {
    const [thread] = threadsOf([comment("a", 1, { resolved: 9 }), comment("b", 2, { parent: "a" })])
    expect(thread?.open).toBe(false)
    expect(thread?.messages).toHaveLength(2)
  })

  test("a message says whose it is, and a comment with no anchor starts no thread", () => {
    const threads = threadsOf([comment("a", 1, { mine: false }), comment("b", 2, { anchor: undefined })])
    expect(threads.map((thread) => thread.id)).toEqual(["a"])
    expect(threads[0]?.messages[0]?.mine).toBe(false)
  })

  test("a message keeps its author's id, for the name the window may know", () => {
    const [thread] = threadsOf([comment("a", 1, { author: "u-ben", mine: false })])
    expect(thread?.messages[0]?.author).toBe("u-ben")
  })
})

describe("what a node says", () => {
  test("its marker and its Markdown syntax are not what a reader sees", () => {
    expect(plain("# Informe de IVA")).toBe("Informe de IVA")
    expect(plain("- Primera línea con `código` y [un enlace](https://example.com)")).toBe(
      "Primera línea con código y un enlace",
    )
    expect(plain("2. Paso **dos**")).toBe("Paso dos")
    expect(plain("| Ventas")).toBe("Ventas")
    expect(plain("> Una cita")).toBe("Una cita")
    expect(plain("## slide 2: Dynapps")).toBe("slide 2: Dynapps")
    expect(plain("")).toBe("")
  })

  test("a row of a spreadsheet reads its cells one after the other", () => {
    expect(nodeLabel(node("n1", "Dynapps\tUntitled"))).toBe("Dynapps · Untitled")
    expect(nodeLabel(node("n2", "x".repeat(200)), 10)).toBe("xxxxxxxxx…")
  })

  test("the picker offers what has text, narrowed by a search without regard to case", () => {
    const nodes = [node("n1", "# Informe"), node("n2", ""), node("n3", "- Primera línea"), node("n4", "| Total")]
    expect(pickable(nodes, "").map((item) => item.id)).toEqual(["n1", "n3", "n4"])
    expect(pickable(nodes, "  PRIMERA ").map((item) => item.id)).toEqual(["n3"])
    expect(pickable(nodes, "nada")).toEqual([])
  })
})

describe("the node of each block of a document", () => {
  // The text view of a Markdown document, blank lines and a table's separator row included
  const markdown = [
    node("a1", "# Informe de IVA"),
    node("a2", ""),
    node("a3", "Resumen del **redondeo** de IVA en Q3."),
    node("a4", ""),
    node("a5", "- Primera línea con `código` y [un enlace](https://example.com)"),
    node("a6", "- Segunda línea"),
    node("a7", ""),
    node("a8", "| Diario | Total |"),
    node("a9", "|---|---|"),
    node("a10", "| Ventas | 120 |"),
    node("a11", "> Una cita importante"),
  ]

  test("the blocks of the rendered page find their nodes by their text, in reading order", () => {
    const found = matchNodes(markdown, [
      "Informe de IVA",
      "Resumen del redondeo de IVA en Q3.",
      "Primera línea con código y un enlace",
      "Segunda línea",
      "Diario Total",
      "Ventas 120",
      "Una cita importante",
    ])
    expect(found.map((item) => item?.id)).toEqual(["a1", "a3", "a5", "a6", "a8", "a10", "a11"])
  })

  test("a block that is no node, as what a script painted is, does not move the nodes on", () => {
    const found = matchNodes(markdown, ["Informe de IVA", "Pintado por JS", "Segunda línea"])
    expect(found.map((item) => item?.id)).toEqual(["a1", undefined, "a6"])
  })

  test("the same text twice finds each node once, as they come", () => {
    const nodes = [node("n1", "Total"), node("n2", "Otra cosa"), node("n3", "| Total")]
    expect(matchNodes(nodes, ["Total", "Otra cosa", "Total"]).map((item) => item?.id)).toEqual(["n1", "n2", "n3"])
  })

  test("a block with nothing to read matches nothing", () => {
    expect(matchNodes([node("n1", "")], ["  "])).toEqual([undefined])
  })

  test("a table's cells and a deck's points, as Word and PowerPoint read them, match too", () => {
    const word = [node("w1", "| Diario"), node("w2", "| Total"), node("w3", "| Ventas"), node("w4", "| 120")]
    expect(matchNodes(word, ["Diario", "Total", "Ventas", "120"]).map((item) => item?.id)).toEqual([
      "w1",
      "w2",
      "w3",
      "w4",
    ])
    const deck = [
      node("s1", "## slide 1: Untitled"),
      node("s2", "Untitled"),
      node("s3", "## slide 2: Dynapps"),
      node("s4", "Overview"),
    ]
    expect(matchNodes(deck, ["Untitled", "Dynapps", "Overview"]).map((item) => item?.id)).toEqual([
      "s2",
      undefined,
      "s4",
    ])
  })
})

describe("the quote of a selection", () => {
  test("a selection inside the node's text is its quote", () => {
    expect(quoteIn(node("n1", "Resumen del **redondeo** de IVA"), "redondeo")).toBe("redondeo")
    expect(quoteIn(node("n1", "Resumen del redondeo"), "  Resumen   del  redondeo ")).toBe("Resumen del redondeo")
  })

  test("one that crosses the node's Markdown anchors to the node alone: the instance would refuse the quote", () => {
    expect(quoteIn(node("n1", "Resumen del **redondeo** de IVA"), "Resumen del redondeo")).toBeUndefined()
    expect(quoteIn(node("n1", "Hola"), "   ")).toBeUndefined()
  })

  test("a long selection quotes its first 90 characters", () => {
    const long = "palabra ".repeat(30)
    expect(quoteIn(node("n1", long), long)).toHaveLength(90)
  })
})

describe("how a document takes a comment (D11)", () => {
  const off = DriveCapabilities.none
  const on = { ...DriveCapabilities.none, rangeComments: true, pdfComments: true }

  test("a node, whatever the instance gives; nothing else while it gives nothing", () => {
    for (const format of ["markdown", "html", "docx", "pptx", "xlsx"])
      expect(anchorsOf({ format, mime: "" }, off)).toEqual({ node: true, range: false, page: false })
  })

  test("a cell range of a spreadsheet only once rangeComments is on", () => {
    expect(anchorsOf({ format: "xlsx", mime: "" }, off).range).toBe(false)
    expect(anchorsOf({ format: "xlsx", mime: "" }, on)).toMatchObject({ node: true, range: true })
    expect(anchorsOf({ format: "docx", mime: "" }, on).range).toBe(false)
  })

  test("a PDF has no nodes, and a point on a page only once pdfComments is on", () => {
    const pdf = { format: "file", mime: "application/pdf" }
    expect(anchorsOf(pdf, off)).toEqual({ node: false, range: false, page: false })
    expect(anchorsOf(pdf, on)).toEqual({ node: false, range: false, page: true })
    expect(anchorsOf({ format: "pdf", mime: "" }, on).page).toBe(true)
    expect(anchorsOf({ format: "markdown", mime: "" }, on).page).toBe(false)
  })
})

describe("comments in the store", () => {
  const notes = "# Informe\nResumen del **redondeo** de IVA\nSegunda línea"

  async function open() {
    const view = await stand()
    const created = ok(await view.client.upload({ ...file("notes.md", notes, "text/markdown") }))
    const id = created.document.id
    await view.store.openDoc(id)
    return { ...view, id }
  }

  test("opening a document reads its comments and the nodes they anchor to", async () => {
    const { store, id } = await open()
    expect(store.state.discussion[id]?.status).toBe("ready")
    expect(store.nodesOf(id).map((item) => item.text)).toEqual([
      "# Informe",
      "Resumen del **redondeo** de IVA",
      "Segunda línea",
    ])
    expect(store.threadsOf(id)).toEqual([])
  })

  test("a new comment lands on its node and quote, and its thread opens in the tab", async () => {
    const { store, id } = await open()
    store.startComment({ kind: "node", node: "n2", find: "redondeo" })
    expect(store.state.doc).toMatchObject({
      tab: "comments",
      choosing: false,
      compose: { node: "n2", find: "redondeo" },
    })
    const created = ok(await store.comment(id, { kind: "node", node: "n2", find: "redondeo" }, "¿Seguro?"))
    const [thread] = store.threadsOf(id)
    expect(thread).toMatchObject({ id: created.id, node: "n2", quote: "redondeo", open: true })
    expect(thread?.messages.map((message) => [message.text, message.mine])).toEqual([["¿Seguro?", true]])
    expect(store.state.doc).toMatchObject({ tab: "comments", thread: created.id, filter: "open" })
    expect(store.state.doc.compose).toBeUndefined()
  })

  test("a reply goes to its thread and resolving moves the thread to Resolved", async () => {
    const { store, id } = await open()
    const first = ok(await store.comment(id, { kind: "node", node: "n1" }, "Título claro"))
    ok(await store.reply(id, first.id, "Gracias"))
    expect(store.threadsOf(id)[0]?.messages.map((message) => message.text)).toEqual(["Título claro", "Gracias"])
    ok(await store.resolve(id, first.id))
    expect(store.threadsOf(id)[0]?.open).toBe(false)
    expect(store.state.doc.thread).toBeUndefined()
    // Focusing it again shows it where it is now
    store.focusThread(first.id)
    expect(store.state.doc).toMatchObject({ thread: first.id, filter: "resolved" })
  })

  test("there is no reopen: the store does not offer one (G12)", async () => {
    const { store } = await open()
    expect(Object.keys(store).filter((name) => /reopen|unresolve/i.test(name))).toEqual([])
  })

  test("a quote the node does not hold is a conflict, and the window reads the nodes again", async () => {
    const { store, id, fake } = await open()
    const refused = await store.comment(id, { kind: "node", node: "n2", find: "Resumen del redondeo" }, "?")
    expect(isFailure(refused) && refused.code).toBe("conflict")
    expect(store.threadsOf(id)).toEqual([])
    expect(fake.calls.outline).toBeGreaterThan(1)
    expect(store.state.doc.compose).toBeUndefined()
  })

  test("the comment typed stays when the Drive refuses it, for the user to try again", async () => {
    const { store, id } = await open()
    store.startComment({ kind: "node", node: "n9" })
    const refused = await store.comment(id, { kind: "node", node: "n9" }, "texto")
    expect(isFailure(refused) && refused.code).toBe("conflict")
    expect(store.state.doc.compose).toEqual({ kind: "node", node: "n9" })
  })

  test("a cell range and a PDF point are refused while their capabilities are off, and reach the Drive when on", async () => {
    const range = { kind: "range" as const, sheet: 0, from: "A1", to: "B2" }
    const page = { kind: "page" as const, page: 1, x: 0.5, y: 0.5 }
    const reached: string[] = []
    const watch = (backend: Parameters<NonNullable<NonNullable<Parameters<typeof setup>[0]>["backend"]>>[0]) => ({
      ...backend,
      comment: (id: string, input: Parameters<typeof backend.comment>[1]) => (
        reached.push(input.anchor.kind),
        backend.comment(id, input)
      ),
    })
    const off = await stand({ backend: watch })
    const offId = ok(await off.client.upload(file("a.md", "# A", "text/markdown"))).document.id
    expect(code(await off.store.comment(offId, range, "?"))).toBe("unsupported")
    expect(code(await off.store.comment(offId, page, "?"))).toBe("unsupported")
    expect(reached).toEqual([])
    const on = await stand({ backend: watch, capabilities: { rangeComments: true, pdfComments: true } })
    const onId = ok(await on.client.upload(file("b.md", "# B", "text/markdown"))).document.id
    await on.store.comment(onId, range, "?")
    await on.store.comment(onId, page, "?")
    expect(reached).toEqual(["range", "page"])
  })

  test("the comments of the document are read again when its Comments tab opens", async () => {
    const { store, id, client } = await open()
    // Someone else comments meanwhile
    ok(await client.comment({ id, body: "Desde fuera", anchor: { kind: "node", node: "n3" } }))
    expect(store.threadsOf(id)).toEqual([])
    store.setTab("comments")
    await store.discuss(id)
    expect(store.threadsOf(id).map((thread) => thread.messages[0]?.text)).toEqual(["Desde fuera"])
  })

  test("a read that answers after a newer one is dropped", async () => {
    const gate: { open: () => void } = { open: () => {} }
    let first = true
    // The first read of the comments is held until a newer one has answered
    const slow = await stand({
      backend: (backend) => ({
        ...backend,
        comments: async (target) => {
          const answer = await backend.comments(target)
          if (first) {
            first = false
            await new Promise<void>((resolve) => (gate.open = resolve))
          }
          return answer
        },
      }),
    })
    const made = ok(await slow.client.upload(file("slow.md", "# Slow", "text/markdown")))
    const held = slow.store.discuss(made.document.id)
    ok(await slow.client.comment({ id: made.document.id, body: "nuevo", anchor: { kind: "node", node: "n1" } }))
    await slow.store.discuss(made.document.id)
    gate.open()
    await held
    expect(slow.store.threadsOf(made.document.id).map((thread) => thread.messages[0]?.text)).toEqual(["nuevo"])
  })

  test("only one reply box is open at a time, and sending a reply closes it", async () => {
    const { store, id } = await open()
    const first = ok(await store.comment(id, { kind: "node", node: "n1" }, "Uno"))
    const second = ok(await store.comment(id, { kind: "node", node: "n3" }, "Dos"))
    store.startReply(first.id)
    store.startReply(second.id)
    expect(store.state.doc.replying).toBe(second.id)
    store.cancelReply()
    expect(store.state.doc.replying).toBeUndefined()
    store.startReply(first.id)
    ok(await store.reply(id, first.id, "Hecho"))
    expect(store.state.doc.replying).toBeUndefined()
  })

  test("a reply the Drive refuses keeps its box open", async () => {
    const { store, id } = await open()
    store.startReply("missing")
    expect(code(await store.reply(id, "missing", "?"))).toBe("not-found")
    expect(store.state.doc.replying).toBe("missing")
  })

  test("comment mode and an open reply box do not outlive the document", async () => {
    const { store, id } = await open()
    store.setCommenting(true)
    store.startReply("t")
    expect(store.state.doc).toMatchObject({ commenting: true, replying: "t" })
    await store.openDoc(id)
    expect(store.state.doc.commenting).toBe(false)
    expect(store.state.doc.replying).toBeUndefined()
  })

  test("an author is named by the grants of the documents opened, and unnamed otherwise", async () => {
    const view = await stand({
      backend: (backend) => ({
        ...backend,
        access: async (target) => {
          const answer = await backend.access(target)
          if (isFailure(answer)) return answer
          return {
            ...answer,
            grants: [
              { subject: "user", value: "u-ben", name: "Ben", level: "comment" },
              { subject: "role", value: "sales", name: "Sales", level: "view" },
            ],
            inherited: [
              { subject: "user", value: "u-eva", name: "Eva", level: "edit", from: { folder: "f", name: "Team" } },
              { subject: "user", value: "u-no-name", level: "view" },
            ],
          }
        },
      }),
    })
    const id = ok(await view.client.upload(file("named.md", "# N", "text/markdown"))).document.id
    expect(view.store.nameOf("u-ben")).toBeUndefined()
    await view.store.openDoc(id)
    expect(view.store.nameOf("u-ben")).toBe("Ben")
    expect(view.store.nameOf("u-eva")).toBe("Eva")
    expect(view.store.nameOf("sales")).toBeUndefined()
    expect(view.store.nameOf("u-no-name")).toBeUndefined()
    expect(view.store.nameOf("someone-else")).toBeUndefined()
  })

  test("without a connection to main nothing is read, and a write answers signed-out", async () => {
    const { store } = await stand({ disconnected: true })
    await store.discuss("doc")
    expect(store.state.discussion.doc).toBeUndefined()
    const refused = await store.comment("doc", { kind: "node", node: "n1" }, "?")
    expect(isFailure(refused) && refused.code).toBe("signed-out")
    expect(code(await store.reply("doc", "c", "?"))).toBe("signed-out")
    expect(code(await store.resolve("doc", "c"))).toBe("signed-out")
  })

  test("a document that is gone says why its comments cannot be read", async () => {
    const { store } = await stand()
    await store.discuss("gone")
    expect(store.state.discussion.gone?.status).toBe("failed")
    expect(store.threadsOf("gone")).toEqual([])
  })
})
