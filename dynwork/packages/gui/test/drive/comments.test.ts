import { afterAll, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { Comment, Outline } from "../../src/drive/contract"
import { DriveBackend } from "../../src/drive/backend"
import { DriveFake } from "../../src/drive/fake"
import { DriveIpc } from "../../src/drive/ipc"
import { startFake } from "../../../sp-client/test/fake"
import { storage } from "../routines/fixture"
import { expectFailure, ok } from "./conformance"
import { connect, crossing } from "./wire"

// What a comment needs of the Drive service: every node of the document to anchor to, who wrote it, and the instance's
// own refusals. The real backend runs against sp-client's fake instance, the service against the in-memory Drive.

const instance = startFake()
afterAll(() => instance.stop())

const user = "1ecce4e3-bc87-441d-b374-ea29bab88da8"
const text = (value: string) => new TextEncoder().encode(value)

function remote(owner: string | undefined) {
  const jwt = `jwt-${randomUUID()}`
  instance.state.jwts.add(jwt)
  return DriveBackend.remote({ url: instance.url, user: owner, withJwt: (use) => use(jwt) })
}

function stand() {
  const fake = DriveFake.make({ user: "user-ana" })
  const service = DriveIpc.make({
    account: () => ({ id: "account-ana", user: "ana@dynapps.es" }),
    backend: () => fake,
    store: storage(DriveIpc.Saved, DriveIpc.initial),
    changed: () => {},
    capabilities: () => ({}),
    timers: { set: () => () => {} },
  })
  return { client: connect(service), fake }
}

describe("the nodes of a document", () => {
  test("the backend reads the text view, where every node is, and not the outline's gaps", async () => {
    const backend = remote(user)
    const created = await ok(backend.upload({ name: "nodes.md", bytes: text("# Hola"), mime: "text/markdown" }))
    const outline = crossing(Outline, await ok(backend.outline(created.document.id)))
    const read = instance.state.requests.filter(
      (entry) => entry.path === `/api/v1/documents/${created.document.id}/read`,
    )
    expect(read.map((entry) => entry.query)).toEqual(["?view=text"])
    expect(outline.nodes.map((node) => node.id)).toEqual(["n1", "n2", "n3"])
  })

  test("a node with no text is a node still: a blank line takes a comment", async () => {
    const backend = remote(user)
    const created = await ok(backend.upload({ name: "blank.md", bytes: text("# Hola"), mime: "text/markdown" }))
    const outline = await ok(backend.outline(created.document.id))
    expect(outline.nodes.find((node) => node.text === "")?.id).toBe("n2")
  })

  test("the service answers the nodes of an open document in the order it reads", async () => {
    const { client } = stand()
    const created = await ok(
      client.upload({ name: "order.md", bytes: text("first\nsecond\nthird"), mime: "text/markdown" }),
    )
    const outline = await ok(client.outline({ id: created.document.id }))
    expect(outline.nodes.map((node) => node.text)).toEqual(["first", "second", "third"])
  })
})

describe("who wrote a comment", () => {
  test("the user's own comment is theirs, and another user's is not", async () => {
    const own = remote(user)
    const created = await ok(own.upload({ name: "who.md", bytes: text("# Hola"), mime: "text/markdown" }))
    await ok(own.comment(created.document.id, { body: "Mine", anchor: { kind: "node", node: "n1" } }))
    const seenByMe = await ok(own.comments(created.document.id))
    expect(seenByMe.map((comment) => comment.mine)).toEqual([true])
    // Someone else reading the same thread: the instance names the author by id only
    const seenByOther = await ok(remote("another-user").comments(created.document.id))
    expect(seenByOther.map((comment) => comment.mine)).toEqual([false])
    expect(seenByOther[0]?.author).toBe(user)
  })

  test("a comment of a signed-in account with no known user is nobody's own", async () => {
    const created = await ok(
      remote(undefined).upload({ name: "anon.md", bytes: text("# Hola"), mime: "text/markdown" }),
    )
    await ok(remote(undefined).comment(created.document.id, { body: "?", anchor: { kind: "node", node: "n1" } }))
    expect((await ok(remote(undefined).comments(created.document.id))).map((comment) => comment.mine)).toEqual([false])
  })
})

describe("what the instance refuses in a comment", () => {
  test("a quote that is not in the node's own text is a conflict that names the head", async () => {
    const { client } = stand()
    const created = await ok(
      client.upload({ name: "quote.md", bytes: text("# Hola **mundo**"), mime: "text/markdown" }),
    )
    const anchor = { kind: "node" as const, node: "n1", find: "Hola mundo" }
    const refused = await client.comment({ id: created.document.id, body: "?", anchor })
    expectFailure(refused, "conflict")
    expect(refused).toMatchObject({ head: created.revision.id })
    const accepted = await ok(
      client.comment({ id: created.document.id, body: "ok", anchor: { ...anchor, find: "mundo" } }),
    )
    expect(crossing(Comment, accepted).anchor).toEqual({ node: "n1", find: "mundo" })
  })

  test("a reply to a comment that is not there, and resolving one, are not-found", async () => {
    const { client } = stand()
    const created = await ok(client.upload({ name: "gone.md", bytes: text("# Hola"), mime: "text/markdown" }))
    expectFailure(await client.reply({ id: created.document.id, parent: "missing", body: "?" }), "not-found")
    expectFailure(await client.resolve({ id: created.document.id, comment: "missing" }), "not-found")
  })

  test("a document that is not in the Drive has no comments to read", async () => {
    const { client } = stand()
    expectFailure(await client.comments({ id: "gone" }), "not-found")
    expectFailure(await client.outline({ id: "gone" }), "not-found")
  })

  test("0.83 reopens nothing: the service answers unsupported and the Drive is not asked (G12)", async () => {
    const { client, fake } = stand()
    const created = await ok(client.upload({ name: "closed.md", bytes: text("# Hola"), mime: "text/markdown" }))
    const root = await ok(client.comment({ id: created.document.id, body: "x", anchor: { kind: "node", node: "n1" } }))
    await ok(client.resolve({ id: created.document.id, comment: root.id }))
    expectFailure(await client.reopen({ id: created.document.id, comment: root.id }), "unsupported")
    expect(fake.calls.reopen).toBeUndefined()
  })
})
