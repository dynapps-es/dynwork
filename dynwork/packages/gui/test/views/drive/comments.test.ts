import { afterEach, describe, expect, test } from "bun:test"
import type { Backend } from "../../../src/drive/backend"
import { DriveCapabilities } from "../../../src/drive/capabilities"
import { isFailure, type Comment } from "../../../src/drive/contract"
import {
  anchorsOf,
  bubbleFaces,
  bubbleRows,
  matchNodes,
  nodeLabel,
  pickable,
  plain,
  pointsAt,
  quoteIn,
  rangeOf,
  sheetsOf,
  threadsOf,
  type Node,
} from "../../../src/views/drive/model"
import { drawerAsks } from "../../../src/views/drive/store"
import { account, file, setup } from "./fixture"

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

  test("a thread on a cell range keeps its range; a reopened one says when, by whom and whether it was the user", () => {
    const [range, reopened] = threadsOf([
      comment("r", 2, { anchor: { node: "sheet[Sales]", cells: "B2:D9" } }),
      comment("o", 1, { reopened: 7, reopener: "u2" }),
    ])
    expect(range).toMatchObject({ node: "sheet[Sales]", cells: "B2:D9", quote: undefined, open: true })
    expect(range?.reopened).toBeUndefined()
    expect(reopened).toMatchObject({ open: true, reopened: { at: 7, by: "u2", mine: false } })
    expect(reopened?.cells).toBeUndefined()
    const [mine] = threadsOf([comment("m", 1, { reopened: 8, reopener: "u1", reopenedMine: true })])
    expect(mine?.reopened).toEqual({ at: 8, by: "u1", mine: true })
    // A range whose sheet went is detached by the instance: the sheet's node and no range
    const [detached] = threadsOf([comment("d", 1, { anchor: { node: "sheet[Old]" } })])
    expect(detached).toMatchObject({ node: "sheet[Old]", quote: undefined })
    expect(detached?.cells).toBeUndefined()
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
  const on = { ...DriveCapabilities.none, rangeComments: true }

  test("a node, whatever the instance gives; nothing else while it gives nothing", () => {
    for (const format of ["markdown", "html", "docx", "pptx", "xlsx"])
      expect(anchorsOf({ format, mime: "" }, off)).toEqual({ node: true, range: false })
  })

  test("a cell range of a spreadsheet (xlsx, ods) only once rangeComments is on", () => {
    expect(anchorsOf({ format: "xlsx", mime: "" }, off).range).toBe(false)
    expect(anchorsOf({ format: "ods", mime: "" }, off).range).toBe(false)
    expect(anchorsOf({ format: "xlsx", mime: "" }, on)).toMatchObject({ node: true, range: true })
    expect(anchorsOf({ format: "ods", mime: "" }, on)).toMatchObject({ node: true, range: true })
    expect(anchorsOf({ format: "docx", mime: "" }, on).range).toBe(false)
  })

  test("a thread points at 'Sales · B2:D9'; one whose sheet is gone names the sheet, as the instance detaches it", () => {
    const nodes = [node("sheet[Sales]", "Sales"), node("n1", "# Informe"), node("n2", "")]
    expect(pointsAt({ kind: "range", node: "sheet[Sales]", cells: "B2:D9" }, nodes)).toEqual({
      kind: "range",
      sheet: "Sales",
      cells: "B2:D9",
    })
    // Detached: the instance keeps the sheet's node and drops the range
    expect(pointsAt({ kind: "node", node: "sheet[Sales]" }, nodes)).toEqual({
      kind: "sheet",
      sheet: "Sales",
      gone: false,
    })
    expect(pointsAt({ kind: "node", node: "sheet[Old]" }, nodes)).toEqual({ kind: "sheet", sheet: "Old", gone: true })
    expect(pointsAt({ kind: "node", node: "n1", find: "Inf" }, nodes)).toEqual({ kind: "quote", text: "Inf" })
    expect(pointsAt({ kind: "node", node: "n1" }, nodes)).toEqual({ kind: "quote", text: "Informe" })
    expect(pointsAt({ kind: "node", node: "n2" }, nodes)).toEqual({ kind: "blank" })
    expect(pointsAt({ kind: "node", node: "n9" }, nodes)).toEqual({ kind: "gone" })
  })

  test("the picker's sheets are the sheet nodes, in order; its field reads a range as the instance does", () => {
    const nodes = [
      node("sheet[Sales]", "Sales"),
      node("sheet[Sales]/row[1]", "Month\tTotal"),
      node("sheet[Q3 \\] draft]", "Q3 ] draft"),
      node("n1", "Not a sheet"),
    ]
    expect(sheetsOf(nodes)).toEqual([
      { node: "sheet[Sales]", name: "Sales" },
      { node: "sheet[Q3 \\] draft]", name: "Q3 ] draft" },
    ])
    expect(rangeOf("")).toBeUndefined()
    expect(rangeOf("   ")).toBeUndefined()
    expect(rangeOf(" b2:d9 ")).toEqual({ cells: "B2:D9" })
    expect(rangeOf("D9:B2")).toEqual({ refused: "reversed" })
    expect(rangeOf("XFE1")).toEqual({ refused: "column" })
    expect(rangeOf("A1048577")).toEqual({ refused: "row" })
    expect(rangeOf("Sales!B2")).toEqual({ refused: "malformed" })
  })

  test("a PDF takes no comment, whatever the instance gives (D22)", () => {
    const every = Object.fromEntries(Object.keys(off).map((key) => [key, true])) as typeof off
    expect(anchorsOf({ format: "file", mime: "application/pdf" }, off)).toEqual({ node: false, range: false })
    expect(anchorsOf({ format: "file", mime: "application/pdf" }, every)).toEqual({ node: false, range: false })
    expect(anchorsOf({ format: "pdf", mime: "" }, every)).toEqual({ node: false, range: false })
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

  test("a thread just written opens quietly: it asks for no jump to its mark and for no drawer", async () => {
    const { store, id } = await open()
    // The popup on the document sends a comment straight away, with no composer in the tab.
    const created = ok(await store.comment(id, { kind: "node", node: "n2", find: "redondeo" }, "Revisar"))
    expect(store.state.doc).toMatchObject({ tab: "comments", thread: created.id, quiet: true })
    expect(drawerAsks(store.state.doc).some(Boolean)).toBe(false)
    // A thread the user picks (its mark, its bubble, its card) is one they asked to see.
    store.focusThread(created.id)
    expect(store.state.doc).toMatchObject({ thread: created.id, quiet: false })
    expect(drawerAsks(store.state.doc).some(Boolean)).toBe(true)
    // A refused comment opens nothing.
    const refused = await store.comment(id, { kind: "node", node: "n9" }, "texto")
    expect(isFailure(refused)).toBe(true)
    expect(store.state.doc).toMatchObject({ thread: created.id, quiet: false })
  })

  test("a bubble's face opens its own thread, which goes to the front of the bubble, open and marked", async () => {
    const { store, id } = await open()
    // Two threads on one block: one bubble, the first one written in front.
    const first = ok(await store.comment(id, { kind: "node", node: "n2" }, "Uno"))
    const second = ok(await store.comment(id, { kind: "node", node: "n2", find: "redondeo" }, "Dos"))
    const row = bubbleRows([
      { thread: first.id, top: 120 },
      { thread: second.id, top: 124 },
    ])
    expect(row).toEqual([{ top: 120, threads: [first.id, second.id] }])
    // A click on a face opens that face's thread (`onThread` → `focusThread`), not the bubble's first one.
    store.focusThread(second.id)
    expect(store.state.doc).toMatchObject({ tab: "comments", thread: second.id, quiet: false })
    expect(bubbleFaces(row[0]?.threads ?? [], store.state.doc.thread).faces).toEqual([second.id, first.id])
    store.focusThread(first.id)
    expect(bubbleFaces(row[0]?.threads ?? [], store.state.doc.thread).faces).toEqual([first.id, second.id])
  })

  test("what became of a comment that asked for the agent is the service's record of it", async () => {
    const { store, service, id } = await open()
    const first = ok(await store.comment(id, { kind: "node", node: "n1" }, "Título claro"))
    expect(store.mentionOf(first.id)).toBeUndefined()
    service.mention.add(account.id, { comment: first.id, document: id, outcome: "unlinked", at: 1 })
    expect(store.mentionOf(first.id)).toEqual({ comment: first.id, document: id, outcome: "unlinked", at: 1 })
    expect(store.mentionOf("another")).toBeUndefined()
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

  test("0.83: reopening is unsupported and the thread stays resolved (G12)", async () => {
    const { store, id, fake } = await open()
    const first = ok(await store.comment(id, { kind: "node", node: "n1" }, "Título claro"))
    ok(await store.resolve(id, first.id))
    expect(code(await store.reopen(id, first.id))).toBe("unsupported")
    expect(fake.calls.reopen).toBeUndefined()
    expect(store.threadsOf(id)[0]?.open).toBe(false)
  })

  test("0.84: a resolved thread reopens, moves to Open quietly and says the user reopened it (G12)", async () => {
    const view = await stand({ version: "0.84" })
    const id = ok(await view.client.upload(file("notes.md", notes, "text/markdown"))).document.id
    await view.store.openDoc(id)
    expect(view.store.remote()?.capabilities.reopenComments).toBe(true)
    const first = ok(await view.store.comment(id, { kind: "node", node: "n1" }, "Título claro"))
    ok(await view.store.resolve(id, first.id))
    view.store.focusThread(first.id)
    expect(view.store.state.doc).toMatchObject({ thread: first.id, filter: "resolved" })
    ok(await view.store.reopen(id, first.id))
    const [thread] = view.store.threadsOf(id)
    expect(thread).toMatchObject({ id: first.id, open: true, reopened: { by: "user-david", mine: true } })
    expect(view.store.state.doc).toMatchObject({ thread: first.id, filter: "open", quiet: true })
    expect(drawerAsks(view.store.state.doc).some(Boolean)).toBe(false)
    // Its mark comes back: an HTML page and Markdown mark the open threads only
    expect(view.store.threadsOf(id).filter((item) => item.open)).toHaveLength(1)
    expect(code(await view.store.reopen(id, "missing"))).toBe("not-found")
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

  test("a cell range is refused while rangeComments is off, and reaches the Drive when on", async () => {
    const range = { kind: "range" as const, node: "sheet[Sales]", cells: "A1:B2" }
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
    expect(reached).toEqual([])
    const on = await stand({ backend: watch, capabilities: { rangeComments: true } })
    const onId = ok(await on.client.upload(file("b.md", "# B", "text/markdown"))).document.id
    await on.store.comment(onId, range, "?")
    expect(reached).toEqual(["range"])
  })

  test("an author no grant names is unnamed; with peopleByRest the instance names them, asked once by id (G13)", async () => {
    const asked: string[][] = []
    const others = (backend: Backend): Backend => ({
      ...backend,
      comments: async (id) => {
        const own = await backend.comments(id)
        return isFailure(own) ? own : [...own, comment("c-bob", 5, { author: "user-bob", mine: false })]
      },
      people: async (ids) => {
        asked.push([...ids])
        return ids.includes("user-bob") ? [{ id: "user-bob", name: "Bob Martín" }] : []
      },
    })
    const off = await stand({ backend: others })
    await off.store.openDoc(ok(await off.client.upload(file("a.md", "# A", "text/markdown"))).document.id)
    expect(off.store.nameOf("user-bob")).toBeUndefined()
    expect(asked).toEqual([])
    const on = await stand({ backend: others, capabilities: { peopleByRest: true } })
    const id = ok(await on.client.upload(file("b.md", "# B", "text/markdown"))).document.id
    await on.store.openDoc(id)
    expect(on.store.nameOf("user-bob")).toBe("Bob Martín")
    expect(asked).toEqual([["user-bob"]])
    // Named once, not asked again
    await on.store.openDoc(id)
    expect(asked).toHaveLength(1)
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
              { id: "g-ben", subject: "user", value: "u-ben", name: "Ben", level: "comment" },
              { id: "g-sales", subject: "role", value: "sales", name: "Sales", level: "view" },
            ],
            inherited: [
              {
                id: "g-eva",
                subject: "user",
                value: "u-eva",
                name: "Eva",
                level: "edit",
                from: { folder: "f", name: "Team" },
              },
              { id: "g-no-name", subject: "user", value: "u-no-name", level: "view" },
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
