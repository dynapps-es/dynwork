import { afterEach, describe, expect, jest, test } from "bun:test"
import type { Backend } from "../../src/drive/backend"
import type { DriveCapabilities } from "../../src/drive/capabilities"
import { DriveFake } from "../../src/drive/fake"
import { DriveIpc } from "../../src/drive/ipc"
import { storage } from "../routines/fixture"
import { expectFailure, ok } from "./conformance"
import { connect, flush, manualTimers } from "./wire"

afterEach(() => {
  jest.useRealTimers()
})

const ana = { id: "account-ana", user: "ana@dynapps.es" }
const ben = { id: "account-ben", user: "ben@dynapps.es" }
const chat = { id: "ses_q3", name: "Q3 report" }
const text = (value: string) => new TextEncoder().encode(value)
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

// The service over one fake Drive per account, with timers the test fires and a clock it reads. `seen` holds what
// reached each backend's `upload`, `edit` and `comment`, attribution included.
function stand(
  options: {
    account?: DriveIpc.Account
    capabilities?: Partial<DriveCapabilities.Capabilities>
    backend?: (fake: DriveFake.Fake) => Backend
    store?: ReturnType<typeof storage<typeof DriveIpc.Saved>>
  } = {},
) {
  const timers = manualTimers()
  const store = options.store ?? storage(DriveIpc.Saved, DriveIpc.initial)
  const fakes = new Map<string, DriveFake.Fake>()
  const seen: Array<{ method: string; input: unknown }> = []
  const active: { account?: DriveIpc.Account } = { account: "account" in options ? options.account : ana }
  const pushes = { count: 0 }
  const capabilities = { value: options.capabilities ?? {} }
  const service = DriveIpc.make({
    account: () => active.account,
    backend: (account) => {
      const fake = fakes.get(account.id) ?? DriveFake.make({ user: `user-${account.id}`, contexts: true })
      fakes.set(account.id, fake)
      const spied: Backend = {
        ...fake,
        upload: (input) => (seen.push({ method: "upload", input }), fake.upload(input)),
        edit: (id, input) => (seen.push({ method: "edit", input }), fake.edit(id, input)),
        comment: (id, input) => (seen.push({ method: "comment", input }), fake.comment(id, input)),
      }
      return options.backend?.(fake) ?? spied
    },
    store,
    changed: () => void pushes.count++,
    capabilities: () => capabilities.value,
    timers,
  })
  const fake = (account = ana) => {
    const found = fakes.get(account.id)
    if (!found) throw new Error(`no backend for ${account.id}`)
    return found
  }
  return { service, client: connect(service), timers, store, fake, seen, active, pushes, capabilities }
}

describe("the Drive service's state", () => {
  test("without an active signed-in account it says none, and every call answers signed-out", async () => {
    const { client } = stand({ account: undefined })
    await flush()
    expect(client.state()).toMatchObject({ status: "none", folders: [], documents: [], links: [] })
    expect(client.state().account).toBeUndefined()
    expectFailure(await client.list({}), "signed-out")
    expectFailure(await client.upload({ name: "x.md", bytes: text("x") }), "signed-out")
    expectFailure(await client.link({ conversation: "c", document: "d", act: "attached", via: "rest" }), "signed-out")
  })

  test("holds the account's folders and recent documents once read, all capabilities off, with a push", async () => {
    const { client, fake, pushes } = stand()
    await flush()
    expect(client.state()).toMatchObject({ account: ana.id, status: "ready", documents: [], folders: [] })
    const before = pushes.count
    await fake().createFolder({ name: "Reports" })
    await fake().upload({ name: "a.md", bytes: text("a"), mime: "text/markdown" })
    await client.refresh()
    expect(client.state().folders.map((folder) => folder.name)).toEqual(["Reports"])
    expect(client.state().documents.map((document) => document.name)).toEqual(["a.md"])
    expect(client.state().read).toBeNumber()
    expect(Object.values(client.state().capabilities).every((value) => value === false)).toBe(true)
    expect(pushes.count).toBeGreaterThan(before)
  })

  test("a write reads the Drive again, so the state has what it made", async () => {
    const { client } = stand()
    await flush()
    const created = await ok(client.upload({ name: "new.md", bytes: text("x"), mime: "text/markdown" }))
    expect(client.state().documents.map((document) => document.id)).toEqual([created.document.id])
    const folder = await ok(client.createFolder({ name: "Made here" }))
    expect(client.state().folders.map((entry) => entry.id)).toEqual([folder.id])
  })

  test("a read that fails keeps the last folders and documents, and says why", async () => {
    const { client, fake } = stand()
    await flush()
    await ok(client.upload({ name: "kept.md", bytes: text("x"), mime: "text/markdown" }))
    fake().down({ code: "unreachable", message: "away", retryable: true })
    await client.refresh()
    expect(client.state()).toMatchObject({ status: "unreachable" })
    expect(client.state().documents.map((document) => document.name)).toEqual(["kept.md"])
    fake().down({ code: "signed-out", message: "expired", retryable: false })
    await client.refresh()
    expect(client.state().status).toBe("signed-out")
    fake().down(undefined)
    await client.refresh()
    expect(client.state().status).toBe("ready")
  })

  test("a backend that rejects answers failed, never a rejection", async () => {
    const broken = (fake: DriveFake.Fake): Backend => ({
      ...fake,
      get: () => Promise.reject(new Error("token=secret")),
    })
    const { client } = stand({ backend: broken })
    const answer = await client.get({ id: "x" })
    expectFailure(answer, "failed")
    expect(JSON.stringify(answer)).not.toContain("secret")
  })
})

describe("switching accounts", () => {
  test("empties the snapshot at once and reads the new account's Drive", async () => {
    const { client, service, active, fake } = stand()
    await flush()
    await ok(client.upload({ name: "ana.md", bytes: text("x"), mime: "text/markdown" }))
    active.account = ben
    service.account()
    // Nothing of the previous account stays visible while the new one is read.
    expect(client.state()).toMatchObject({ account: ben.id, status: "loading", documents: [], folders: [] })
    await flush()
    expect(client.state()).toMatchObject({ account: ben.id, status: "ready", documents: [] })
    await ok(client.upload({ name: "ben.md", bytes: text("x"), mime: "text/markdown" }))
    expect(fake(ben).calls.upload).toBe(1)
    expect(fake(ana).calls.upload).toBe(1)
  })

  test("an answer for the account that left is dropped", async () => {
    const held: { release?: () => void } = {}
    const slow = (fake: DriveFake.Fake): Backend => ({
      ...fake,
      folders: () =>
        new Promise((resolve) => {
          held.release = () => resolve([{ id: "f", name: "Ana's", owner: "u", mine: true, created: 0, updated: 0 }])
        }),
    })
    const { client, service, active } = stand({ backend: slow })
    await flush()
    active.account = undefined
    service.account()
    held.release?.()
    await flush()
    expect(client.state()).toMatchObject({ status: "none", folders: [] })
  })

  test("a call notices a switch main has not announced yet", async () => {
    const { client, active, fake } = stand()
    await flush()
    active.account = ben
    await ok(client.list({}))
    expect(fake(ben).calls.list).toBeGreaterThan(0)
    expect(client.state().account).toBe(ben.id)
  })
})

describe("polling", () => {
  test("every 5 minutes, every 20 s while a window watches, and 5 minutes again when it stops", async () => {
    const { client, timers, fake } = stand()
    await flush()
    expect(timers.pending()).toEqual([5 * 60_000])
    const window = new AbortController()
    const watching = client.watch({ signal: window.signal })
    await flush()
    expect(timers.pending()).toEqual([20_000])
    const reads = fake().calls.list ?? 0
    timers.fire()
    await flush()
    expect(fake().calls.list).toBe(reads + 1)
    expect(timers.pending()).toEqual([20_000])
    window.abort()
    await watching
    expect(timers.pending()).toEqual([5 * 60_000])
  })

  test("with pushChanges on, a watched Drive keeps the 5-minute poll only", async () => {
    const { client, timers } = stand({ capabilities: { pushChanges: true } })
    await flush()
    const window = new AbortController()
    const watching = client.watch({ signal: window.signal })
    await flush()
    expect(timers.pending()).toEqual([5 * 60_000])
    window.abort()
    await watching
  })

  test("on its own timers by default, so the Drive is read again 5 minutes later", async () => {
    jest.useFakeTimers()
    const fake = DriveFake.make()
    const service = DriveIpc.make({
      account: () => ana,
      backend: () => fake,
      store: storage(DriveIpc.Saved, DriveIpc.initial),
      changed: () => {},
    })
    await flush()
    const reads = fake.calls.list
    jest.advanceTimersByTime(5 * 60_000 - 1)
    await flush()
    expect(fake.calls.list).toBe(reads)
    jest.advanceTimersByTime(1)
    await flush()
    expect(fake.calls.list).toBe((reads ?? 0) + 1)
    service.dispose()
  })

  test("stops with the service, and while no account is active", async () => {
    const { service, timers, active } = stand()
    await flush()
    active.account = undefined
    service.account()
    expect(timers.pending()).toEqual([])
    active.account = ana
    service.account()
    await flush()
    expect(timers.pending()).toEqual([5 * 60_000])
    service.dispose()
    expect(timers.pending()).toEqual([])
  })
})

describe("attribution", () => {
  test("personActions off: a direct write is signed '<user> by DynWork', with no conversation", async () => {
    const { client, seen } = stand()
    const created = await ok(client.upload({ name: "d.md", bytes: text("x"), mime: "text/markdown" }))
    await ok(client.edit({ id: created.document.id, ops: [{ op: "append_markdown", markdown: "y" }] }))
    expect(seen.map((entry) => entry.input)).toEqual([
      expect.objectContaining({ message: "ana@dynapps.es by DynWork", contextId: undefined }),
      expect.objectContaining({ message: "ana@dynapps.es by DynWork", contextId: undefined }),
    ])
    expect((await ok(client.revisions({ id: created.document.id })))[0]?.message).toBe("ana@dynapps.es by DynWork")
  })

  test("personActions on: a direct write is the person's own, with no message", async () => {
    const { client, seen } = stand({ capabilities: { personActions: true } })
    await ok(client.upload({ name: "d.md", bytes: text("x"), mime: "text/markdown" }))
    expect(seen[0]?.input).toMatchObject({ message: undefined })
  })

  test("conversationLabel off: a conversation's write names it and carries its context", async () => {
    const { client, seen, service } = stand()
    const created = await ok(
      client.upload({ name: "c.md", bytes: text("x"), mime: "text/markdown", conversation: chat }),
    )
    await ok(
      client.edit({ id: created.document.id, ops: [{ op: "append_markdown", markdown: "y" }], conversation: chat }),
    )
    const context = service.context(chat.id)
    expect(context).toMatch(uuid)
    expect(seen.map((entry) => entry.input)).toEqual([
      expect.objectContaining({ message: "Q3 report by DynWork", contextId: context }),
      expect.objectContaining({ message: "Q3 report by DynWork", contextId: context }),
    ])
  })

  test("conversationLabel on: a conversation's write carries only its context", async () => {
    const { client, seen, service } = stand({ capabilities: { conversationLabel: true } })
    await ok(client.upload({ name: "c.md", bytes: text("x"), mime: "text/markdown", conversation: chat }))
    expect(seen[0]?.input).toMatchObject({ message: undefined, contextId: service.context(chat.id) })
  })

  test("a comment carries the conversation's context and no message", async () => {
    const { client, seen, service } = stand()
    const created = await ok(client.upload({ name: "c.md", bytes: text("# Hola"), mime: "text/markdown" }))
    await ok(
      client.comment({ id: created.document.id, body: "?", anchor: { kind: "node", node: "n1" }, conversation: chat }),
    )
    expect(seen.find((entry) => entry.method === "comment")?.input).toEqual({
      body: "?",
      anchor: { kind: "node", node: "n1" },
      contextId: service.context(chat.id),
    })
  })

  test("a reply carries the conversation's context too, and resolving needs none", async () => {
    const replies: unknown[] = []
    const { client, service } = stand({
      backend: (fake) => ({ ...fake, reply: (id, input) => (replies.push(input), fake.reply(id, input)) }),
    })
    const created = await ok(client.upload({ name: "r.md", bytes: text("# Hola"), mime: "text/markdown" }))
    const first = await ok(client.comment({ id: created.document.id, body: "?", anchor: { kind: "node", node: "n1" } }))
    const reply = await ok(client.reply({ id: created.document.id, parent: first.id, body: "!", conversation: chat }))
    expect(reply.parent).toBe(first.id)
    expect(replies).toEqual([{ body: "!", parent: first.id, contextId: service.context(chat.id) }])
    expect((await ok(client.resolve({ id: created.document.id, comment: first.id }))).resolved).toBeNumber()
  })

  test("a conversation keeps one context, a UUID v4, per account, kept on this computer", async () => {
    const store = storage(DriveIpc.Saved, DriveIpc.initial)
    const { client, service, active, seen } = stand({ store })
    await ok(client.upload({ name: "1.md", bytes: text("x"), conversation: chat }))
    await ok(client.upload({ name: "2.md", bytes: text("x"), conversation: chat }))
    await ok(client.upload({ name: "3.md", bytes: text("x"), conversation: { id: "ses_other", name: "Other" } }))
    const contexts = seen.map((entry) => (entry.input as { contextId?: string }).contextId)
    expect(contexts[0]).toBe(contexts[1])
    expect(contexts[2]).not.toBe(contexts[0])
    expect(store.value.accounts[ana.id]?.contexts[chat.id]).toBe(contexts[0])
    active.account = ben
    service.account()
    expect(service.context(chat.id)).not.toBe(contexts[0])
    // Main starting again reads the same one back.
    expect(stand({ store }).service.context(chat.id)).toBe(contexts[0])
  })
})

describe("the conversation index", () => {
  test("docsByContext off: a conversation's REST writes enter the index, listed newest first in the state", async () => {
    const { client } = stand()
    const created = await ok(
      client.upload({ name: "c.md", bytes: text("x"), mime: "text/markdown", conversation: chat }),
    )
    const edited = await ok(
      client.edit({
        id: created.document.id,
        ops: [{ op: "append_markdown", markdown: "y" }],
        mode: "propose",
        conversation: chat,
      }),
    )
    await ok(client.upload({ name: "direct.md", bytes: text("x") }))
    const links = await ok(client.documentsOf({ conversation: chat.id }))
    expect(links.map((link) => [link.document, link.act, link.revision, link.via])).toEqual(
      expect.arrayContaining([
        [created.document.id, "created", created.revision.id, "rest"],
        [created.document.id, "proposed", edited.revision.id, "rest"],
      ]),
    )
    expect(links).toHaveLength(2)
    expect(client.state().links).toHaveLength(2)
  })

  test("docsByContext on: REST writes are left to the Drive, which lists them by the conversation's context", async () => {
    const { client, store } = stand({ capabilities: { docsByContext: true } })
    const created = await ok(
      client.upload({ name: "c.md", bytes: text("x"), mime: "text/markdown", conversation: chat }),
    )
    expect(store.value.accounts[ana.id]?.links ?? []).toEqual([])
    const links = await ok(client.documentsOf({ conversation: chat.id }))
    expect(links).toEqual([expect.objectContaining({ document: created.document.id, via: "server" })])
  })

  test("docsByContext on, the index still answers what it holds, and the Drive adds the rest", async () => {
    const { client } = stand({ capabilities: { docsByContext: true } })
    await ok(client.link({ conversation: chat.id, document: "attached-doc", act: "attached", via: "mcp" }))
    const created = await ok(client.upload({ name: "c.md", bytes: text("x"), conversation: chat }))
    const links = await ok(client.documentsOf({ conversation: chat.id }))
    expect(links.map((link) => [link.document, link.via]).toSorted()).toEqual(
      [
        ["attached-doc", "mcp"],
        [created.document.id, "server"],
      ].toSorted(),
    )
  })

  test("contextByMcp: an MCP write is indexed here until both the MCP carries the context and the Drive lists by it", async () => {
    const mcp = { conversation: chat.id, document: "doc-1", act: "edited" as const, via: "mcp" as const }
    const off = stand({ capabilities: { docsByContext: true } })
    await ok(off.client.link(mcp))
    expect(off.store.value.accounts[ana.id]?.links).toHaveLength(1)
    const on = stand({ capabilities: { docsByContext: true, contextByMcp: true } })
    await ok(on.client.link(mcp))
    expect(on.store.value.accounts[ana.id]?.links ?? []).toEqual([])
  })

  test("the same act on the same revision is recorded once", async () => {
    const { client } = stand()
    const link = { conversation: chat.id, document: "doc-1", act: "attached" as const, via: "rest" as const }
    await ok(client.link(link))
    await ok(client.link(link))
    await ok(client.link({ ...link, act: "read" }))
    expect(await ok(client.documentsOf({ conversation: chat.id }))).toHaveLength(2)
  })
})

describe("comment anchors", () => {
  test("rangeComments off: a cell range is refused without reaching the Drive; on, it reaches it", async () => {
    const anchor = { kind: "range" as const, sheet: 0, from: "A1", to: "B2" }
    const off = stand()
    expectFailure(await off.client.comment({ id: "doc", body: "?", anchor }), "unsupported")
    expect(off.seen).toEqual([])
    const on = stand({ capabilities: { rangeComments: true } })
    await on.client.comment({ id: "doc", body: "?", anchor })
    expect(on.seen.map((entry) => entry.method)).toEqual(["comment"])
  })

  test("pdfComments off: a point on a PDF is refused without reaching the Drive; on, it reaches it", async () => {
    const anchor = { kind: "page" as const, page: 1, x: 0.2, y: 0.4 }
    const off = stand()
    expectFailure(await off.client.comment({ id: "doc", body: "?", anchor }), "unsupported")
    expect(off.seen).toEqual([])
    const on = stand({ capabilities: { pdfComments: true } })
    await on.client.comment({ id: "doc", body: "?", anchor })
    expect(on.seen.map((entry) => entry.method)).toEqual(["comment"])
  })
})
