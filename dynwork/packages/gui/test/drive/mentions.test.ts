import { describe, expect, test } from "bun:test"
import type { OpenCodeClient } from "@opencode/client/promise"
import type { DriveCapabilities } from "../../src/drive/capabilities"
import { DriveFake } from "../../src/drive/fake"
import { DriveIpc } from "../../src/drive/ipc"
import { DriveMentions } from "../../src/drive/mentions"
import { storage } from "../routines/fixture"
import { ok } from "./conformance"
import { connect, flush, manualTimers } from "./wire"

// @Agent in a comment: written as a mention of the user themself, attended once whatever the source, and never for a
// conversation of another account. The Drive is the in-memory fake (which announces its own mentions on its stream, as
// the instance does) and the service is the real one, so the index, the record and the attribution are a window's.

const ana = { id: "account-ana", user: "Ana", userId: "user-ana", url: "https://ana.example" }
const bob = { id: "account-bob", user: "Bob", userId: "user-bob", url: "https://bob.example" }
const chat = { id: "ses_q3", name: "Q3 report" }
const text = (value: string) => new TextEncoder().encode(value)
const node = { kind: "node", node: "n2", find: "Primera" } as const

interface Standing {
  sessions?: string[]
  /** Makes the service refuse the prompt. */
  wake?: "fails" | "throws"
  store?: ReturnType<typeof storage<typeof DriveIpc.Saved>>
  /** The Drives of an earlier run of the app: what the accounts hold stays where it is. */
  backends?: Record<string, DriveFake.Fake>
  account?: typeof ana | typeof bob | { id: string; user: string; url: string }
  capabilities?: Partial<DriveCapabilities.Capabilities>
}

function stand(options: Standing = {}) {
  const backends = options.backends ?? {
    [ana.id]: DriveFake.make({ user: ana.userId }),
    [bob.id]: DriveFake.make({ user: bob.userId }),
  }
  const active: { value: Standing["account"] } = { value: options.account ?? ana }
  const clock = { value: 1_000 }
  const store = options.store ?? storage(DriveIpc.Saved, DriveIpc.initial)
  const timers = manualTimers()
  const service = DriveIpc.make({
    account: () => active.value,
    backend: (account) => backends[account.id] ?? DriveFake.make(),
    store,
    changed: () => {},
    timers,
    capabilities: () => options.capabilities ?? {},
    // Each write is a moment later than the one before, so that "the last" is not a tie
    now: () => (clock.value += 1),
  })
  const sessions = new Set(options.sessions ?? [chat.id])
  const woken: Array<{ session: string; text: string; document: string; comment: string }> = []
  const mentions = DriveMentions.make({
    service,
    session: async (id) => sessions.has(id),
    wake: async (wake) => {
      if (options.wake === "throws") throw new Error("the service is away")
      if (options.wake === "fails") return false
      woken.push(wake)
      return true
    },
  })
  // What `DriveMentions.setup` does with the comments the service writes.
  const off = service.listen.asked((asked) => void mentions.attend(asked.account, asked.document, asked.comment))
  const client = connect(service)
  const document = async (conversation: typeof chat | null = chat) =>
    (
      await ok(
        client.upload({
          name: "report.md",
          bytes: text("# Hola\nPrimera frase del informe.\n"),
          mime: "text/markdown",
          conversation: conversation ?? undefined,
        }),
      )
    ).document.id
  const ask = (id: string, body = "@Agent resume esto") => ok(client.comment({ id, body, anchor: node }))
  const state = () => client.state()
  return { backends, active, store, service, sessions, woken, mentions, client, document, ask, state, off, timers }
}

describe("the text of a comment", () => {
  test("@Agent and @Agente, as words of their own, ask for the agent", () => {
    expect(DriveMentions.asks("@Agent resume")).toBe(true)
    expect(DriveMentions.asks("Please @agente resume")).toBe(true)
    expect(DriveMentions.asks("@Agent")).toBe(true)
    expect(DriveMentions.asks("@Agents are many")).toBe(false)
    expect(DriveMentions.asks("write to ana@Agent.com")).toBe(false)
    expect(DriveMentions.asks("nothing to ask")).toBe(false)
  })

  test("the first @Agent is written as the user's own mention, and read back as @Agent", () => {
    const written = DriveMentions.write("@Agent resume @Agent", { id: "user-ana", name: "Ana [Dev]" })
    expect(written).toBe("@[Ana Dev](user:user-ana) resume @Agent")
    expect(DriveMentions.read(written, "user-ana")).toEqual({ text: "@Agent resume @Agent", agent: true })
  })

  test("a mention of someone else reads as their name and is no job for the agent", () => {
    expect(DriveMentions.read("hi @[Bob](user:user-bob), see this", "user-ana")).toEqual({
      text: "hi @Bob, see this",
      agent: false,
    })
  })
})

describe("writing the comment", () => {
  test("a comment that asks for the agent is a real mention of the user, handed to their agent", async () => {
    const subject = stand()
    const sent: unknown[] = []
    const backend = subject.backends[ana.id]
    const comment = backend.comment
    backend.comment = (id, input) => (sent.push(input), comment(id, input))
    const created = await subject.ask(await subject.document(), "@Agent resume esto")
    expect(sent).toEqual([expect.objectContaining({ body: "@[Ana](user:user-ana) resume esto", agent: true })])
    // The window reads it as it was typed, with the flag that says it is a job for the agent
    expect(created).toMatchObject({ body: "@Agent resume esto", agent: true })
  })

  test("a reply can ask for the agent too", async () => {
    const subject = stand()
    const id = await subject.document()
    const root = await subject.ask(id, "first")
    const reply = await ok(subject.client.reply({ id, parent: root.id, body: "now @Agent, please" }))
    expect(reply).toMatchObject({ body: "now @Agent, please", agent: true, parent: root.id })
    await flush()
    expect(subject.woken.map((wake) => wake.comment)).toEqual([reply.id])
  })

  test("a comment that does not ask is written as it is and wakes nothing", async () => {
    const subject = stand()
    const created = await subject.ask(await subject.document(), "just a note")
    expect(created.body).toBe("just a note")
    expect(created.agent).toBeUndefined()
    await flush()
    expect(subject.woken).toEqual([])
    expect(subject.state().mentions).toEqual([])
  })

  test("an account that does not know its user keeps the text, and nothing is woken", async () => {
    const subject = stand({ account: { id: ana.id, user: "Ana", url: ana.url } })
    const created = await subject.ask(await subject.document(), "@Agent resume")
    expect(created.body).toBe("@Agent resume")
    await flush()
    expect(subject.woken).toEqual([])
  })
})

describe("waking the conversation", () => {
  test("the conversation the document is linked to is prompted with the thread and where it points", async () => {
    const subject = stand()
    const id = await subject.document()
    const created = await subject.ask(id, "@Agent resume esto")
    await flush()
    expect(subject.woken).toHaveLength(1)
    const wake = subject.woken[0]!
    expect(wake).toMatchObject({ session: chat.id, document: id, comment: created.id })
    expect(wake.text).toContain("“report.md”")
    expect(wake.text).toContain(`document_id ${id}`)
    expect(wake.text).toContain("node n2, on the words “Primera”")
    expect(wake.text).toContain("(this comment): @Agent resume esto")
    expect(wake.text).toContain(`parent_id ${created.id}`)
    expect(subject.state().mentions).toEqual([
      { comment: created.id, document: id, outcome: "woken", conversation: chat.id, at: expect.any(Number) },
    ])
  })

  test("a reply in a thread brings the whole thread", async () => {
    const subject = stand()
    const id = await subject.document()
    const root = await subject.ask(id, "first thought")
    await ok(subject.client.reply({ id, parent: root.id, body: "second thought" }))
    const asking = await ok(subject.client.reply({ id, parent: root.id, body: "@Agent decide" }))
    await flush()
    const text = subject.woken.find((wake) => wake.comment === asking.id)!.text
    expect(text.indexOf("first thought")).toBeLessThan(text.indexOf("second thought"))
    expect(text.indexOf("second thought")).toBeLessThan(text.indexOf("(this comment): @Agent decide"))
  })

  test("with several conversations, the last to work with the document is woken", async () => {
    const subject = stand({ sessions: ["ses_old", "ses_new"] })
    const id = await subject.document({ id: "ses_old", name: "Old" })
    // The index orders by time, not by the order of the writes
    await ok(subject.client.link({ conversation: "ses_new", document: id, act: "attached", via: "rest" }))
    await subject.ask(id)
    await flush()
    expect(subject.woken.map((wake) => wake.session)).toEqual(["ses_new"])
  })

  test("a conversation that is gone is passed over for the next one", async () => {
    const subject = stand({ sessions: ["ses_old"] })
    const id = await subject.document({ id: "ses_old", name: "Old" })
    await ok(subject.client.link({ conversation: "ses_gone", document: id, act: "attached", via: "rest" }))
    await subject.ask(id)
    await flush()
    expect(subject.woken.map((wake) => wake.session)).toEqual(["ses_old"])
  })

  test("a document no conversation holds wakes nothing and says so", async () => {
    const subject = stand()
    const id = await subject.document(null)
    const created = await subject.ask(id)
    await flush()
    expect(subject.woken).toEqual([])
    expect(subject.state().mentions).toEqual([
      { comment: created.id, document: id, outcome: "unlinked", at: expect.any(Number) },
    ])
  })

  test("a conversation the service will not prompt is a failure, kept, and not tried again", async () => {
    for (const wake of ["fails", "throws"] as const) {
      const subject = stand({ wake })
      const id = await subject.document()
      const created = await subject.ask(id)
      await flush()
      expect(subject.state().mentions).toEqual([
        { comment: created.id, document: id, outcome: "failed", conversation: chat.id, at: expect.any(Number) },
      ])
    }
  })
})

describe("once per comment", () => {
  test("the write and the stream both announce a comment: one conversation prompt", async () => {
    const subject = stand()
    const id = await subject.document()
    const created = await subject.ask(id)
    // The instance announces the mention on the stream too: it arrives after the write's own, and again
    await subject.mentions.heard({ document: id, comment: created.id, user: "user-ana", author: "user-ana" })
    await subject.mentions.heard({ document: id, comment: created.id, user: "user-ana", author: "user-ana" })
    await flush()
    expect(subject.woken).toHaveLength(1)
    expect(subject.state().mentions).toHaveLength(1)
  })

  test("two announcements at the same moment prompt once", async () => {
    const subject = stand()
    const id = await subject.document()
    const created = await subject.ask(id)
    const heard = { document: id, comment: created.id, user: "user-ana", author: "user-ana" }
    await Promise.all([
      subject.mentions.heard(heard),
      subject.mentions.heard(heard),
      subject.mentions.attend("account-ana", id, created.id),
    ])
    await flush()
    expect(subject.woken).toHaveLength(1)
  })

  test("what was attended survives a restart: the same comment is not woken again", async () => {
    const store = storage(DriveIpc.Saved, DriveIpc.initial)
    const first = stand({ store })
    const id = await first.document()
    const created = await first.ask(id)
    await flush()
    expect(first.woken).toHaveLength(1)
    first.off()
    first.service.dispose()
    // The app starts again over the same storage, and the stream says the same comment
    const second = stand({ store, backends: first.backends })
    await second.mentions.heard({ document: id, comment: created.id, user: "user-ana", author: "user-ana" })
    expect(second.woken).toEqual([])
  })

  test("the record keeps the newest 200", async () => {
    const subject = stand()
    const id = await subject.document()
    Array.from({ length: 205 }, (_, index) =>
      subject.service.mention.add(ana.id, { comment: `c${index}`, document: id, outcome: "unlinked", at: index }),
    )
    const kept = subject.state().mentions
    expect(kept).toHaveLength(200)
    expect(kept[0]?.comment).toBe("c5")
    expect(kept.at(-1)?.comment).toBe("c204")
  })
})

describe("only the user's own", () => {
  test("a conversation of another account is never woken", async () => {
    const subject = stand()
    const id = await subject.document()
    // Bob's index holds the same document id with a conversation of his: the comment is Ana's
    subject.service.record(bob.id, { conversation: "ses_bob", document: id, act: "edited", via: "rest" })
    subject.sessions.add("ses_bob")
    await subject.ask(id)
    await flush()
    expect(subject.woken.map((wake) => wake.session)).toEqual([chat.id])
    expect(subject.state().mentions.map((entry) => entry.conversation)).toEqual([chat.id])
  })

  test("an account that is no longer the active one is not read and its conversation is not woken", async () => {
    const subject = stand()
    const id = await subject.document()
    const created = await subject.ask(id)
    await flush()
    subject.woken.length = 0
    // Another comment of Ana's is announced late, when Bob is the active account
    const late = await ok(subject.client.comment({ id, body: "second", anchor: node }))
    await flush()
    subject.active.value = bob
    subject.service.account()
    await subject.mentions.attend(ana.id, id, late.id)
    await subject.mentions.attend(ana.id, id, created.id)
    expect(subject.woken).toEqual([])
    expect(subject.state().mentions).toEqual([])
    expect(subject.service.mention.get(ana.id, late.id)).toBeUndefined()
  })

  test("a mention the stream says someone else made, or of someone else, is not a job", async () => {
    const subject = stand()
    const id = await subject.document()
    const created = await subject.ask(id)
    await flush()
    subject.woken.length = 0
    subject.service.mention.add(ana.id, { comment: "other", document: id, outcome: "woken", at: 1 })
    const plain = await ok(subject.client.comment({ id, body: "a note", anchor: node }))
    // A comment of Ana's that asks for the agent and that nothing has attended yet: written straight to the Drive
    const web = await ok(
      subject.backends[ana.id].comment(id, { body: "@[Ana](user:user-ana) from the web", anchor: node, agent: true }),
    )
    for (const heard of [
      // The stream names another user as its author: left to Governance, whatever its attention, even for this comment
      { document: id, comment: web.id, user: "user-ana", author: "user-bob" },
      // The stream says Bob was mentioned, not the user
      { document: id, comment: web.id, user: "user-bob", author: "user-ana" },
      // Ana wrote a comment that does not ask for the agent
      { document: id, comment: plain.id, user: "user-ana", author: "user-ana" },
      // A comment that is not in the document
      { document: id, comment: "nowhere", user: "user-ana", author: "user-ana" },
    ])
      await subject.mentions.heard(heard)
    expect(subject.woken).toEqual([])
    expect(created.agent).toBe(true)
    expect(subject.state().mentions.map((entry) => entry.comment)).toEqual([created.id, "other"])
    // The same comment, announced as the user's own, is one
    await subject.mentions.heard({ document: id, comment: web.id, user: "user-ana", author: "user-ana" })
    expect(subject.woken.map((wake) => wake.comment)).toEqual([web.id])
  })
})

describe("following the stream", () => {
  const quick: DriveMentions.Timing = {
    retry: 1,
    lifetime: 60_000,
    sleep: (ms, signal) =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, ms)
        signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true })
      }),
  }
  const until = async (done: () => boolean) => {
    for (const _ of Array.from({ length: 200 })) {
      if (done()) return
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    throw new Error("it did not happen")
  }

  test("a comment written by another route (the web) that asks for the agent wakes the conversation", async () => {
    const subject = stand()
    const id = await subject.document()
    const life = new AbortController()
    void subject.mentions.follow(life.signal, quick)
    await until(() => (subject.backends[ana.id].calls.stream ?? 0) === 1)
    // Written straight to the Drive, not through the service: only the stream can tell
    const created = await ok(
      subject.backends[ana.id].comment(id, { body: "@[Ana](user:user-ana) from the web", anchor: node, agent: true }),
    )
    await until(() => subject.woken.length === 1)
    expect(subject.woken[0]).toMatchObject({ session: chat.id, comment: created.id })
    life.abort()
  })

  test("a stream that ends is opened again", async () => {
    const subject = stand()
    const life = new AbortController()
    void subject.mentions.follow(life.signal, { ...quick, lifetime: 20 })
    await until(() => (subject.backends[ana.id].calls.stream ?? 0) >= 3)
    life.abort()
  })

  test("a switch of account ends the stream of the one that left and follows the new one", async () => {
    const subject = stand()
    const life = new AbortController()
    void subject.mentions.follow(life.signal, quick)
    await until(() => (subject.backends[ana.id].calls.stream ?? 0) === 1)
    subject.active.value = bob
    subject.service.account()
    await until(() => (subject.backends[bob.id].calls.stream ?? 0) === 1)
    expect(subject.backends[ana.id].calls.stream).toBe(1)
    life.abort()
  })

  test("pushChanges on: a change of the Drive the stream announces reads the account's Drive again (G09)", async () => {
    const subject = stand({ capabilities: { pushChanges: true } })
    await flush()
    const life = new AbortController()
    void subject.mentions.follow(life.signal, quick)
    await until(() => (subject.backends[ana.id].calls.stream ?? 0) === 1)
    const reads = subject.backends[ana.id].calls.list ?? 0
    // Written straight to the Drive, as from the web: only the change says so
    await subject.backends[ana.id].upload({ name: "web.md", bytes: text("x"), mime: "text/markdown" })
    subject.backends[ana.id].changed()
    await until(() => subject.state().documents.some((document) => document.name === "web.md"))
    expect(subject.backends[ana.id].calls.list).toBe(reads + 1)
    expect(subject.woken).toEqual([])
    life.abort()
  })

  test("on a 0.84 instance, the change it announces reads the Drive, and a watched Drive drops its fast poll while the stream is open", async () => {
    const subject = stand({
      backends: { [ana.id]: DriveFake.make({ user: ana.userId, version: "0.84" }) },
    })
    await flush()
    expect(subject.state().capabilities.pushChanges).toBe(true)
    const window = new AbortController()
    const watching = subject.client.watch({ signal: window.signal })
    await flush()
    expect(subject.timers.pending()).toEqual([20_000])
    const life = new AbortController()
    void subject.mentions.follow(life.signal, quick)
    await until(() => (subject.backends[ana.id].calls.stream ?? 0) === 1)
    // The poll armed before the stream opened still fires, and reads what the stream could not have told.
    subject.timers.fire()
    await flush()
    expect(subject.timers.pending()).toEqual([5 * 60_000])
    const reads = subject.backends[ana.id].calls.list ?? 0
    await subject.backends[ana.id].upload({ name: "web.md", bytes: text("x"), mime: "text/markdown" })
    subject.backends[ana.id].changed()
    await until(() => subject.state().documents.some((document) => document.name === "web.md"))
    expect(subject.backends[ana.id].calls.list).toBe(reads + 1)
    // The stream ends: the fast poll is back.
    life.abort()
    await until(() => subject.timers.pending()[0] === 20_000)
    window.abort()
    await watching
  })

  test("pushChanges off: a change is heard and nothing is read; the mentions after it are still attended", async () => {
    const subject = stand()
    const id = await subject.document()
    await flush()
    const life = new AbortController()
    void subject.mentions.follow(life.signal, quick)
    await until(() => (subject.backends[ana.id].calls.stream ?? 0) === 1)
    const reads = subject.backends[ana.id].calls.list ?? 0
    subject.backends[ana.id].changed()
    // The stream keeps its order: once the mention after the change is attended, the change was heard
    await ok(subject.backends[ana.id].comment(id, { body: "@[Ana](user:user-ana) then", anchor: node, agent: true }))
    await until(() => subject.woken.length === 1)
    expect(subject.backends[ana.id].calls.list).toBe(reads)
    life.abort()
  })

  test("with no account, or one without its user's id, nothing is followed", async () => {
    const subject = stand({ account: { id: ana.id, user: "Ana", url: ana.url } })
    const life = new AbortController()
    void subject.mentions.follow(life.signal, quick)
    await new Promise((resolve) => setTimeout(resolve, 30))
    life.abort()
    expect(subject.backends[ana.id].calls.stream).toBeUndefined()
  })
})

describe("setup", () => {
  test("a comment the service writes with @Agent prompts the conversation through the service's session API", async () => {
    const subject = stand()
    const prompts: unknown[] = []
    const client = {
      session: {
        get: async (input: { sessionID: string }) => {
          if (input.sessionID !== chat.id) throw new Error("no such session")
          return { id: input.sessionID }
        },
        prompt: async (input: unknown) => void prompts.push(input),
      },
    } as unknown as OpenCodeClient
    const cleanups: Array<() => void> = []
    DriveMentions.setup(
      { onCleanup: (cleanup) => void cleanups.push(cleanup) },
      { service: subject.service, client: () => client },
    )
    subject.off()
    const id = await subject.document()
    const created = await subject.ask(id)
    await flush()
    await flush()
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatchObject({
      sessionID: chat.id,
      text: expect.stringContaining(`parent_id ${created.id}`),
      metadata: { dynwork: { drive: { document: id, comment: created.id } } },
    })
    cleanups.forEach((cleanup) => cleanup())
  })

  test("while the service is not there, the conversation is a failure and nothing is thrown", async () => {
    const subject = stand()
    const cleanups: Array<() => void> = []
    DriveMentions.setup(
      { onCleanup: (cleanup) => void cleanups.push(cleanup) },
      { service: subject.service, client: () => undefined },
    )
    subject.off()
    const id = await subject.document()
    const created = await subject.ask(id)
    await flush()
    await flush()
    // No service means no session to find: nothing is linked that exists
    expect(subject.state().mentions.map((entry) => [entry.comment, entry.outcome])).toEqual([[created.id, "unlinked"]])
    cleanups.forEach((cleanup) => cleanup())
  })
})
