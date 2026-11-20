import { afterEach, describe, expect, jest, test } from "bun:test"
import { fail, type Backend } from "../../src/drive/backend"
import { DriveCapabilities } from "../../src/drive/capabilities"
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
    /** The core each account's fake answers as; 0.83 when absent. */
    version?: (account: string) => "0.83" | "0.84"
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
      const fake =
        fakes.get(account.id) ??
        DriveFake.make({ user: `user-${account.id}`, contexts: true, version: options.version?.(account.id) })
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

  test("with pushChanges on, a watched Drive keeps the 5-minute poll only while its stream is open", async () => {
    const { client, timers, service } = stand({ capabilities: { pushChanges: true } })
    await flush()
    service.streamed(ana.id, true)
    const window = new AbortController()
    const watching = client.watch({ signal: window.signal })
    await flush()
    expect(timers.pending()).toEqual([5 * 60_000])
    // The stream drops: the fast poll is back at once, and the read after it covers the gap.
    service.streamed(ana.id, false)
    expect(timers.pending()).toEqual([20_000])
    service.streamed(ana.id, true)
    timers.fire()
    await flush()
    expect(timers.pending()).toEqual([5 * 60_000])
    // Another account's stream says nothing of this one.
    service.streamed(ben.id, false)
    expect(timers.pending()).toEqual([5 * 60_000])
    window.abort()
    await watching
  })

  test("with pushChanges on and no stream, a watched Drive is polled every 20 s", async () => {
    const { client, timers } = stand({ capabilities: { pushChanges: true } })
    await flush()
    const window = new AbortController()
    const watching = client.watch({ signal: window.signal })
    await flush()
    expect(timers.pending()).toEqual([20_000])
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

  test("a document made from a template carries the conversation's context and enters the index", async () => {
    const made: unknown[] = []
    const { client, service } = stand({
      backend: (fake) => ({ ...fake, create: (input) => (made.push(input), fake.create(input)) }),
    })
    const created = await ok(client.create({ template: "dynapps-word", name: "Q3", conversation: chat }))
    // The message goes too: 0.84 keeps it on the first revision, 0.83 ignores it.
    expect(made).toEqual([
      {
        template: "dynapps-word",
        name: "Q3",
        folder: undefined,
        message: "Q3 report by DynWork",
        contextId: service.context(chat.id),
      },
    ])
    expect(client.state().documents.map((document) => document.id)).toEqual([created.document.id])
    expect(client.state().links.map((link) => [link.document, link.act])).toEqual([[created.document.id, "created"]])
    expectFailure(await client.create({ template: "nope", name: "x" }), "invalid")
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

  test("a conversation keeps one context, the instance's, per account, kept on this computer", async () => {
    const store = storage(DriveIpc.Saved, DriveIpc.initial)
    const { client, service, active, seen, fake } = stand({ store })
    await ok(client.upload({ name: "1.md", bytes: text("x"), conversation: chat }))
    await ok(client.upload({ name: "2.md", bytes: text("x"), conversation: chat }))
    await ok(client.upload({ name: "3.md", bytes: text("x"), conversation: { id: "ses_other", name: "Other" } }))
    const contexts = seen.map((entry) => (entry.input as { contextId?: string }).contextId)
    expect(contexts[0]).toBe(contexts[1])
    expect(contexts[2]).not.toBe(contexts[0])
    expect(fake().contexts.get(contexts[0] ?? "")).toBe("Q3 report")
    expect(store.value.accounts[ana.id]?.contexts[chat.id]).toEqual({ id: contexts[0], name: "Q3 report" })
    active.account = ben
    service.account()
    expect(service.context(chat.id)).not.toBe(contexts[0])
    // Main starting again reads the same one back.
    expect(stand({ store }).service.context(chat.id)).toBe(contexts[0])
  })
})

describe("the conversation's context (D20)", () => {
  test("the first write registers the conversation under its title; the next ones carry the same id", async () => {
    const { client, fake, seen, service } = stand()
    expect(service.context(chat.id)).toBeUndefined()
    await ok(client.upload({ name: "1.md", bytes: text("x"), conversation: chat }))
    await ok(client.upload({ name: "2.md", bytes: text("x"), conversation: chat }))
    expect(fake().calls.createContext).toBe(1)
    expect([...fake().contexts.values()]).toEqual(["Q3 report"])
    const id = service.context(chat.id)
    expect(fake().contexts.has(id ?? "")).toBe(true)
    expect(seen.map((entry) => (entry.input as { contextId?: string }).contextId)).toEqual([id, id])
  })

  test("a direct write registers nothing", async () => {
    const { client, fake } = stand()
    await ok(client.upload({ name: "d.md", bytes: text("x") }))
    expect(fake().calls.createContext).toBeUndefined()
  })

  test("writes of one conversation made together register it once", async () => {
    const { client, fake, seen } = stand()
    await Promise.all(
      ["1", "2", "3"].map((name) => ok(client.upload({ name: `${name}.md`, bytes: text("x"), conversation: chat }))),
    )
    expect(fake().calls.createContext).toBe(1)
    expect(new Set(seen.map((entry) => (entry.input as { contextId?: string }).contextId)).size).toBe(1)
  })

  test("a renamed conversation renames its context on its next write, and keeps its id", async () => {
    const { client, fake, service, store } = stand()
    await ok(client.upload({ name: "1.md", bytes: text("x"), conversation: chat }))
    const id = service.context(chat.id)
    await ok(client.upload({ name: "2.md", bytes: text("x"), conversation: { ...chat, name: "Q3 closing" } }))
    expect(service.context(chat.id)).toBe(id)
    expect(fake().contexts.get(id ?? "")).toBe("Q3 closing")
    expect(fake().calls.renameContext).toBe(1)
    expect(store.value.accounts[ana.id]?.contexts[chat.id]).toEqual({ id, name: "Q3 closing" })
  })

  test("a context the instance no longer knows is registered again; any other failure keeps it", async () => {
    const answer = { rename: fail("not-found", "No such conversation.") }
    const { client, fake, service } = stand({
      backend: (fake) => ({ ...fake, renameContext: async () => answer.rename }),
    })
    await ok(client.upload({ name: "1.md", bytes: text("x"), conversation: chat }))
    const first = service.context(chat.id)
    answer.rename = fail("unreachable", "away")
    await ok(client.upload({ name: "2.md", bytes: text("x"), conversation: { ...chat, name: "Renamed" } }))
    expect(service.context(chat.id)).toBe(first)
    answer.rename = fail("not-found", "No such conversation.")
    await ok(client.upload({ name: "3.md", bytes: text("x"), conversation: { ...chat, name: "Renamed" } }))
    expect(service.context(chat.id)).not.toBe(first)
    expect(fake().contexts.get(service.context(chat.id) ?? "")).toBe("Renamed")
  })

  test("without an answer the write goes without a context, and the next write registers it", async () => {
    const down = { on: true }
    const { client, seen, service } = stand({
      backend: (fake) => ({
        ...fake,
        upload: (input) => (seen.push({ method: "upload", input }), fake.upload(input)),
        createContext: (name) =>
          down.on ? Promise.resolve(fail("unreachable", "Governance did not answer.")) : fake.createContext(name),
      }),
    })
    await ok(client.upload({ name: "1.md", bytes: text("x"), conversation: chat }))
    expect(seen[0]?.input).toMatchObject({ contextId: undefined, message: "Q3 report by DynWork" })
    expect(service.context(chat.id)).toBeUndefined()
    down.on = false
    await ok(client.upload({ name: "2.md", bytes: text("x"), conversation: chat }))
    expect(seen[1]?.input).toMatchObject({ contextId: service.context(chat.id) })
    expect(service.context(chat.id)).toMatch(uuid)
  })

  test("a context an earlier version made up is never sent: the next write registers one, and the links stay", async () => {
    const store = storage(DriveIpc.Saved, DriveIpc.initial)
    const legacy = "8f9a3c52-7d1e-4b6a-9c0d-2e5f7a8b1c3d"
    const kept = { conversation: chat.id, document: "doc-old", act: "created" as const, via: "rest" as const, at: 1 }
    store.update((draft) => {
      draft.accounts[ana.id] = { contexts: { [chat.id]: legacy }, links: [kept] }
    })
    const { client, service, seen, fake } = stand({ store })
    expect(service.context(chat.id)).toBeUndefined()
    await ok(client.upload({ name: "new.md", bytes: text("x"), conversation: chat }))
    const sent = (seen[0]?.input as { contextId?: string }).contextId
    expect(sent).not.toBe(legacy)
    expect(fake().contexts.get(sent ?? "")).toBe("Q3 report")
    expect(store.value.accounts[ana.id]?.contexts[chat.id]).toEqual({ id: sent, name: "Q3 report" })
    expect((await ok(client.documentsOf({ conversation: chat.id }))).map((link) => link.document)).toContain("doc-old")
  })
})

describe("changes the stream announces (G09)", () => {
  test("pushChanges on: a change reads the account's Drive at once; a burst makes at most one more read", async () => {
    const { service, fake, client } = stand({ capabilities: { pushChanges: true } })
    await flush()
    const reads = fake().calls.list ?? 0
    await fake().upload({ name: "web.md", bytes: text("x"), mime: "text/markdown" })
    service.reread(ana.id)
    service.reread(ana.id)
    service.reread(ana.id)
    await flush()
    expect(fake().calls.list).toBe(reads + 2)
    expect(client.state().documents.map((document) => document.name)).toEqual(["web.md"])
  })

  test("pushChanges off, or another account's change: nothing is read", async () => {
    const off = stand()
    await flush()
    const reads = off.fake().calls.list
    off.service.reread(ana.id)
    await flush()
    expect(off.fake().calls.list).toBe(reads)
    const other = stand({ capabilities: { pushChanges: true } })
    await flush()
    const before = other.fake().calls.list
    other.service.reread(ben.id)
    await flush()
    expect(other.fake().calls.list).toBe(before)
  })
})

describe("what the account's instance delivers", () => {
  // What 0.84 turns on: the REST side (phase 20), the agent's side through the MCP (phase 21), comments on cell
  // ranges and reopened (phase 22) and a conversation's documents (phase 23).
  const rest = {
    conversationLabel: true,
    pushChanges: true,
    peopleByRest: true,
    rawHtmlByMcp: true,
    mcpFolders: true,
    contextByMcp: true,
    rangeComments: true,
    reopenComments: true,
    docsByContext: true,
  }

  test("a 0.83 instance delivers nothing: every capability stays off, as today", async () => {
    const { client, fake } = stand()
    await flush()
    expect(client.state().capabilities).toEqual(DriveCapabilities.none)
    expect(fake().calls.discovery).toBe(1)
    expect(fake().calls.people).toBeUndefined()
  })

  test("a 0.84 instance turns on the REST side and the agent's through the MCP, pushed to the windows", async () => {
    const { client, pushes } = stand({ version: () => "0.84" })
    const before = pushes.count
    await flush()
    expect(client.state().capabilities).toEqual({ ...DriveCapabilities.none, ...rest })
    expect(pushes.count).toBeGreaterThan(before)
  })

  test("read again when the account changes, and when the instance answers again after failing", async () => {
    const { client, fake, active, service } = stand({ version: (account) => (account === ben.id ? "0.84" : "0.83") })
    await flush()
    expect(client.state().capabilities.pushChanges).toBe(false)
    active.account = ben
    service.account()
    await flush()
    expect(client.state()).toMatchObject({ account: ben.id, capabilities: { ...DriveCapabilities.none, ...rest } })
    active.account = ana
    service.account()
    await flush()
    expect(client.state().capabilities).toEqual(DriveCapabilities.none)
    const asked = fake().calls.discovery
    await client.refresh()
    expect(fake().calls.discovery).toBe(asked)
    fake().down({ code: "unreachable", message: "down", retryable: true })
    await client.refresh()
    fake().down(undefined)
    await client.refresh()
    await flush()
    expect(fake().calls.discovery).toBe((asked ?? 0) + 1)
  })

  test("a discovery that does not answer leaves what was read, and the next read asks again", async () => {
    const answers = { down: true }
    const { client, fake } = stand({
      version: () => "0.84",
      backend: (fake) => ({
        ...fake,
        discovery: () =>
          answers.down ? Promise.resolve(fail("unreachable", "Governance did not answer.")) : fake.discovery(),
      }),
    })
    await flush()
    expect(client.state().capabilities).toEqual(DriveCapabilities.none)
    answers.down = false
    await client.refresh()
    await flush()
    expect(client.state().capabilities).toEqual({ ...DriveCapabilities.none, ...rest })
    expect(fake().calls.list).toBe(2)
  })

  test("where discovery tells neither its version nor the Drive, the user's own id is looked up to tell", async () => {
    const silent = (fake: DriveFake.Fake): Backend => ({ ...fake, discovery: async () => ({}) })
    const at84 = stand({
      account: { ...ana, userId: "user-ana" },
      backend: () => silent(DriveFake.make({ user: "user-ana", people: { "user-ana": "Ana" } })),
    })
    await flush()
    expect(at84.client.state().capabilities).toEqual({ ...DriveCapabilities.none, ...rest })
    const at83 = stand({
      account: { ...ana, userId: "user-ana" },
      backend: (fake) => ({ ...silent(fake), people: async () => fail("not-found", "No such route.") }),
    })
    await flush()
    expect(at83.client.state().capabilities).toEqual(DriveCapabilities.none)
    // Without the user's id there is nothing to look up: nothing is delivered, and nothing is asked.
    const unknown = stand({ backend: silent })
    await flush()
    expect(unknown.client.state().capabilities).toEqual(DriveCapabilities.none)
    expect(unknown.fake().calls.people).toBeUndefined()
  })

  test("the agent's switches are the active account's, and a new reading tells main to apply them again", async () => {
    const { service, active } = stand({ version: (account) => (account === ben.id ? "0.84" : "0.83") })
    const heard: string[] = []
    const stop = service.listen.capabilities((account) => heard.push(account))
    await flush()
    const off = {
      rawHtmlByMcp: false,
      mcpFolders: false,
      contextByMcp: false,
      peopleByRest: false,
      rangeComments: false,
      reopenComments: false,
    }
    expect(service.switches(ana.id)).toEqual(off)
    // A 0.83 reading changes nothing: there is nothing to apply again.
    expect(heard).toEqual([])
    // Another account than the Drive's active one has no switches to give.
    expect(service.switches(ben.id)).toBeUndefined()
    active.account = ben
    service.account()
    await flush()
    expect(service.switches(ben.id)).toEqual({
      rawHtmlByMcp: true,
      mcpFolders: true,
      contextByMcp: true,
      peopleByRest: true,
      rangeComments: true,
      reopenComments: true,
    })
    expect(service.switches(ana.id)).toBeUndefined()
    expect(heard).toEqual([ben.id])
    stop()
    active.account = ana
    service.account()
    await flush()
    expect(heard).toEqual([ben.id])
  })

  test("what the main entry forces stays forced over what the instance delivers", async () => {
    const { client } = stand({ version: () => "0.84", capabilities: { pushChanges: false, rangeComments: true } })
    await flush()
    expect(client.state().capabilities).toMatchObject({ pushChanges: false, rangeComments: true, peopleByRest: true })
  })
})

describe("on a 0.84 instance (G02)", () => {
  test("a conversation's write carries its context and no message; the instance keeps a direct one's", async () => {
    const { client, seen, service } = stand({ version: () => "0.84" })
    await flush()
    const created = await ok(client.upload({ name: "c.md", bytes: text("x"), mime: "text/markdown", conversation: chat }))
    expect(seen[0]?.input).toMatchObject({ message: undefined, contextId: service.context(chat.id) })
    const direct = await ok(client.create({ template: "blank-markdown", name: "Notes" }))
    expect(direct.revision.message).toBe("ana@dynapps.es by DynWork")
    expect(created.revision.message).toBeUndefined()
  })

  test("revisions and comments of DynWork's conversations say so, with their title; another conversation's do not", async () => {
    const { client, fake } = stand({ version: () => "0.84" })
    await flush()
    const created = await ok(client.upload({ name: "c.md", bytes: text("# a\nb"), mime: "text/markdown", conversation: chat }))
    const id = created.document.id
    // Another of the user's agents, in a conversation DynWork did not register here
    const elsewhere = await ok(fake().createContext("Weekly"))
    await ok(fake().edit(id, { ops: [{ op: "append_markdown", markdown: "c" }], contextId: elsewhere }))
    await ok(client.comment({ id, body: "Mine", anchor: { kind: "node", node: "n1" }, conversation: chat }))
    const revisions = await ok(client.revisions({ id }))
    expect(revisions.map((revision) => [revision.conversation, revision.ours, revision.agent])).toEqual([
      ["Weekly", undefined, DriveFake.agent],
      ["Q3 report", true, DriveFake.agent],
    ])
    const comments = await ok(client.comments({ id }))
    expect(comments[0]).toMatchObject({ conversation: "Q3 report", ours: true, via: DriveFake.agent })
  })

  test("a context the instance no longer holds is registered again and the write made once more", async () => {
    const store = storage(DriveIpc.Saved, DriveIpc.initial)
    const gone = "0b7c2a7e-0d4f-4b8e-9a51-6f3e2d1c0b9a"
    store.update((draft) => {
      draft.accounts[ana.id] = { contexts: { [chat.id]: { id: gone, name: chat.name } }, links: [] }
    })
    const { client, seen, service, fake } = stand({ version: () => "0.84", store })
    await flush()
    const created = await ok(client.upload({ name: "c.md", bytes: text("x"), conversation: chat }))
    expect(seen.map((entry) => (entry.input as { contextId?: string }).contextId)).toEqual([gone, service.context(chat.id)])
    expect(service.context(chat.id)).not.toBe(gone)
    expect(fake().contexts.get(service.context(chat.id) ?? "")).toBe("Q3 report")
    expect(created.document.name).toBe("c.md")
  })

  test("a refusal that comes back after registering again reaches the window, once", async () => {
    const { client, seen } = stand({
      version: () => "0.84",
      backend: (fake) => ({
        ...fake,
        upload: async (input) => (seen.push({ method: "upload", input }), fail("unknown-context", "No.")),
      }),
    })
    await flush()
    expectFailure(await client.upload({ name: "c.md", bytes: text("x"), conversation: chat }), "unknown-context")
    expect(seen).toHaveLength(2)
    // A direct write names no conversation: nothing to register again.
    expectFailure(await client.upload({ name: "d.md", bytes: text("x") }), "unknown-context")
    expect(seen).toHaveLength(3)
  })
})

describe("people by id (G13)", () => {
  test("the directory search goes over REST with peopleByRest, and through the MCP server without it", async () => {
    const people = { "user-bob": "Bob Martín Ruiz" }
    const off = stand({ backend: () => DriveFake.make({ user: "user-account-ana", people }) })
    await flush()
    expect(await ok(off.client.findPeople({ query: "bob", limit: 5 }))).toEqual([{ id: "user-bob", name: "Bob Martín Ruiz" }])
    const on = stand({ version: () => "0.84" })
    await flush()
    await ok(on.client.findPeople({ query: "bob ruiz", limit: 5 }))
    expect(on.fake().calls.searchPeople).toBe(1)
    expect(on.fake().calls.findPeople).toBeUndefined()
    expect(off.client.state().capabilities.peopleByRest).toBe(false)
  })

  test("peopleByRest off: unsupported, without a call; on, the instance names whom it knows", async () => {
    const people = { "user-bob": "Bob Martín" }
    const off = stand()
    expectFailure(await off.client.people({ ids: ["user-bob"] }), "unsupported")
    expect(off.fake().calls.people).toBeUndefined()
    const on = stand({
      capabilities: { peopleByRest: true },
      backend: () => DriveFake.make({ user: "user-account-ana", people }),
    })
    expect(await ok(on.client.people({ ids: ["user-bob", "user-gone"] }))).toEqual([
      { id: "user-bob", name: "Bob Martín" },
    ])
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

  test("docsByContext on: a REST write still enters the index, and the instance's listing of it is the same entry", async () => {
    const { client, store } = stand({ capabilities: { docsByContext: true } })
    const created = await ok(
      client.upload({ name: "c.md", bytes: text("x"), mime: "text/markdown", conversation: chat }),
    )
    expect(store.value.accounts[ana.id]?.links).toHaveLength(1)
    const links = await ok(client.documentsOf({ conversation: chat.id }))
    expect(links).toEqual([
      expect.objectContaining({ document: created.document.id, act: "created", via: "rest" }),
    ])
  })

  test("docsByContext on: the index keeps what the instance does not list, and the instance adds what the index lacks", async () => {
    const { client, service, fake } = stand({ capabilities: { docsByContext: true } })
    await ok(client.link({ conversation: chat.id, document: "attached-doc", act: "attached", via: "mcp" }))
    const created = await ok(client.upload({ name: "c.md", bytes: text("x"), conversation: chat }))
    // Written for the conversation where this computer's index does not see it: from another computer of the account.
    const elsewhere = await ok(
      fake().upload({ name: "elsewhere.md", bytes: text("y"), contextId: service.context(chat.id) }),
    )
    const links = await ok(client.documentsOf({ conversation: chat.id }))
    expect(links.map((link) => [link.document, link.act, link.via]).toSorted()).toEqual(
      [
        ["attached-doc", "attached", "mcp"],
        [created.document.id, "created", "rest"],
        [elsewhere.document.id, "edited", "server"],
      ].toSorted(),
    )
    expect(await ok(client.byContext({ conversation: chat.id }))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: created.document.id }),
        expect.objectContaining({ id: elsewhere.document.id, name: "elsewhere.md" }),
      ]),
    )
  })

  test("docsByContext on: a document both know is one entry, at the instance's head and the later time", async () => {
    const { client, fake } = stand({ capabilities: { docsByContext: true } })
    const created = await ok(client.upload({ name: "c.md", bytes: text("# C"), conversation: chat }))
    // Changed since, outside the conversation: the index still holds the revision the conversation wrote.
    const later = await ok(fake().edit(created.document.id, { ops: [{ op: "append_markdown", markdown: "more" }] }))
    expect(later.kind).toBe("landed")
    const links = await ok(client.documentsOf({ conversation: chat.id }))
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({ act: "created", via: "rest", revision: later.revision.id })
    expect(links[0]?.at).toBeGreaterThanOrEqual(later.revision.created)
  })

  test("docsByContext: an instance that fails, or no longer holds the context, leaves the index alone, with no failure", async () => {
    for (const failure of [
      fail("unknown-context", "Governance does not know this conversation."),
      fail("unreachable", "Governance did not answer."),
    ]) {
      const { client } = stand({
        capabilities: { docsByContext: true },
        backend: (fake) => ({ ...fake, byContext: async () => failure }),
      })
      const created = await ok(client.upload({ name: "c.md", bytes: text("x"), conversation: chat }))
      expect(await ok(client.byContext({ conversation: chat.id }))).toEqual([])
      expect((await ok(client.documentsOf({ conversation: chat.id }))).map((link) => link.document)).toEqual([
        created.document.id,
      ])
    }
    // A 0.84 instance refusing a context it does not hold, for real: the fake answers as the core does.
    const at84 = stand({ version: () => "0.84" })
    await flush()
    const created = await ok(at84.client.upload({ name: "c.md", bytes: text("x"), conversation: chat }))
    at84.store.update((draft) => {
      const saved = draft.accounts[ana.id]
      if (saved) saved.contexts[chat.id] = { id: "ctx-gone", name: chat.name }
    })
    expect(await ok(at84.client.byContext({ conversation: chat.id }))).toEqual([])
    expect((await ok(at84.client.documentsOf({ conversation: chat.id }))).map((link) => link.document)).toEqual([
      created.document.id,
    ])
    expect(at84.fake().calls.byContext).toBe(2)
  })

  test("docsByContext off, or a conversation this computer never registered: the instance is not asked", async () => {
    const off = stand()
    await ok(off.client.upload({ name: "c.md", bytes: text("x"), conversation: chat }))
    expect(await ok(off.client.byContext({ conversation: chat.id }))).toEqual([])
    expect(await ok(off.client.documentsOf({ conversation: chat.id }))).toHaveLength(1)
    const unknown = stand({ capabilities: { docsByContext: true } })
    expect(await ok(unknown.client.byContext({ conversation: "ses_elsewhere" }))).toEqual([])
    expect(off.fake().calls.byContext).toBeUndefined()
    expect(unknown.fake().calls.byContext).toBeUndefined()
  })

  test("every write of a conversation is indexed, whatever the instance lists or the MCP carries", async () => {
    const mcp = { conversation: chat.id, document: "doc-1", act: "edited" as const, via: "mcp" as const }
    for (const capabilities of [{}, { docsByContext: true }, { docsByContext: true, contextByMcp: true }]) {
      const { client, store } = stand({ capabilities })
      await ok(client.link(mcp))
      expect(store.value.accounts[ana.id]?.links).toHaveLength(1)
    }
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
    const anchor = { kind: "range" as const, node: "sheet[Sales]", cells: "A1:B2" }
    const off = stand()
    expectFailure(await off.client.comment({ id: "doc", body: "?", anchor }), "unsupported")
    expect(off.seen).toEqual([])
    const on = stand({ capabilities: { rangeComments: true } })
    await on.client.comment({ id: "doc", body: "?", anchor })
    expect(on.seen.map((entry) => entry.method)).toEqual(["comment"])
  })

  test("a cell range goes as the instance keeps it, and one it would refuse does not go (G08)", async () => {
    const { client, seen } = stand({ version: () => "0.84" })
    await flush()
    const id = (
      await ok(client.upload({ name: "sales.xlsx", bytes: new TextEncoder().encode("Sales\nMonth\tTotal") }))
    ).document.id
    const made = await ok(
      client.comment({ id, body: "Check", anchor: { kind: "range", node: "sheet[Sales]", cells: "b2:d9" } }),
    )
    expect(made.anchor).toEqual({ node: "sheet[Sales]", cells: "B2:D9" })
    expect(seen.at(-1)?.input).toMatchObject({ anchor: { kind: "range", node: "sheet[Sales]", cells: "B2:D9" } })
    const before = seen.length
    for (const cells of ["D9:B2", "XFE1", "A1048577", "Sales!B2"])
      expectFailure(
        await client.comment({ id, body: "?", anchor: { kind: "range", node: "sheet[Sales]", cells } }),
        "invalid",
      )
    expect(seen).toHaveLength(before)
    // A range on a row is the instance's to refuse: it is no sheet
    expectFailure(
      await client.comment({ id, body: "?", anchor: { kind: "range", node: "sheet[Sales]/row[1]", cells: "B2" } }),
      "invalid",
    )
  })

  test("reopen: unsupported without a call until the instance reopens comments; then the thread is open again (G12)", async () => {
    const off = stand()
    const offId = (await ok(off.client.upload({ name: "a.md", bytes: new TextEncoder().encode("Hola") }))).document.id
    const first = await ok(off.client.comment({ id: offId, body: "x", anchor: { kind: "node", node: "n1" } }))
    await ok(off.client.resolve({ id: offId, comment: first.id }))
    expectFailure(await off.client.reopen({ id: offId, comment: first.id }), "unsupported")
    expect(off.fake().calls.reopen).toBeUndefined()
    const on = stand({ version: () => "0.84" })
    await flush()
    expect(on.client.state().capabilities.reopenComments).toBe(true)
    const id = (await ok(on.client.upload({ name: "b.md", bytes: new TextEncoder().encode("Hola") }))).document.id
    const root = await ok(on.client.comment({ id, body: "x", anchor: { kind: "node", node: "n1" } }))
    await ok(on.client.resolve({ id, comment: root.id }))
    const reopened = await ok(on.client.reopen({ id, comment: root.id }))
    expect(reopened).toMatchObject({ id: root.id, reopenedMine: true, reopener: "user-account-ana" })
    expect(reopened.resolved).toBeUndefined()
    expect((await ok(on.client.comments({ id })))[0]?.resolved).toBeUndefined()
    expectFailure(await on.client.reopen({ id, comment: "missing" }), "not-found")
  })

  test("a point on a PDF is no anchor at all: it does not cross to main (D22)", async () => {
    const { client, seen } = stand()
    const page = { kind: "page", page: 1, x: 0.2, y: 0.4 } as unknown as { kind: "node"; node: string }
    await expect(client.comment({ id: "doc", body: "?", anchor: page })).rejects.toThrow()
    expect(seen).toEqual([])
  })
})
