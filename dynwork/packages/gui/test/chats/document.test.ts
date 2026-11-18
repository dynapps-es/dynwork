import { describe, expect, test } from "bun:test"
import { ChatsDocument } from "../../src/chats/document"
import { RECORDED_TEXT as TEXT, recorded, SESSION } from "./fixture"

describe("a cloud chat's document", () => {
  test("is built from the recorded cloud reply with the full streamed text", async () => {
    const events = await recorded()
    const chat = ChatsDocument.events(
      ChatsDocument.prompted(ChatsDocument.empty(SESSION), {
        id: "msg_user",
        text: "How long are backups kept?",
        created: 1,
      }),
      events,
    )
    const document = ChatsDocument.document(chat)
    expect(document.sessionID).toBe(SESSION)
    expect(document.status).toEqual({ type: "idle" })
    expect(document.diffs).toEqual([])
    expect(document.messages.map((message) => message.type)).toEqual(["user", "assistant", "idle"])
    const assistant = document.messages[1]
    expect(assistant).toMatchObject({
      type: "assistant",
      id: "msg_01M7MBR3K8M2AAN4E0NJYXKZ27",
      agent: "chat",
      model: { id: "claude-sonnet", providerID: "anthropic" },
      content: [{ type: "text", text: TEXT }],
      finish: "stop",
      cost: 0,
    })
    expect(document.messages[2]).toMatchObject({ type: "idle", outcome: "succeeded" })
    expect(chat.seq).toBe(11)
  })

  test("shows the text as it streams, delta by delta, and stays busy until the reply ends", async () => {
    const events = await recorded()
    const deltas = events
      .filter((event) => event.type === "session.text.delta")
      .map((event) => String(event.data.delta))
    expect(deltas.length).toBeGreaterThanOrEqual(3)
    const upTo = (count: number) => ChatsDocument.events(ChatsDocument.empty(SESSION), events.slice(0, count))
    // Events 0-3 are created, execution started, step started and text started; the deltas follow.
    expect(ChatsDocument.reply(upTo(5))).toBe(deltas[0]!)
    expect(ChatsDocument.reply(upTo(7))).toBe(deltas.slice(0, 3).join(""))
    expect(upTo(7).status).toEqual({ type: "busy" })
    expect(ChatsDocument.reply(upTo(events.length))).toBe(TEXT)
  })

  test("a replayed event, another session's event and an unknown one change nothing", async () => {
    const events = await recorded()
    const chat = ChatsDocument.events(ChatsDocument.empty(SESSION), events.slice(0, 4))
    expect(ChatsDocument.event(chat, events[3])).toBe(chat)
    expect(ChatsDocument.event(chat, { ...events[4], data: { ...events[4]!.data, sessionID: "ses_other" } })).toBe(chat)
    expect(ChatsDocument.event(chat, { type: "session.shell.started", data: { sessionID: SESSION } })).toBe(chat)
    expect(ChatsDocument.event(chat, "not an event")).toBe(chat)
  })

  test("a message that did not change keeps its identity while the reply streams", async () => {
    const events = await recorded()
    const chat = ChatsDocument.events(
      ChatsDocument.prompted(ChatsDocument.empty(SESSION), { id: "msg_user", text: "Hi", created: 1 }),
      events.slice(0, 4),
    )
    const next = ChatsDocument.event(chat, events[4]!)
    expect(next.messages[0]).toBe(chat.messages[0]!)
    expect(next.messages[1]).not.toBe(chat.messages[1]!)
  })

  test("an interrupted reply keeps its partial text and ends interrupted", async () => {
    const events = await recorded()
    const cut = [
      ...events.slice(0, 5),
      {
        type: "session.execution.interrupted",
        created: 2,
        durable: { seq: 12 },
        id: "evt_x",
        data: { sessionID: SESSION, reason: "user" },
      },
    ]
    const chat = ChatsDocument.events(ChatsDocument.empty(SESSION), cut)
    expect(ChatsDocument.reply(chat)).toBe(String(events[4]!.data.delta))
    expect(chat.status).toEqual({ type: "idle" })
    expect(chat.messages.at(-1)).toMatchObject({ type: "idle", outcome: "interrupted" })
  })

  test("a prompt and its reply stamped in the same millisecond load user first, whatever their ids", () => {
    // Found on a real instance: the reply carries the prompt's time and its id sorts before the prompt's.
    const reply = {
      type: "assistant",
      id: "msg_01A",
      agent: "chat",
      model: { id: "m", providerID: "p" },
      time: { created: 5 },
      content: [],
    }
    const prompt = { type: "user", id: "msg_01B", text: "Hi", time: { created: 5 } }
    const chat = ChatsDocument.load(ChatsDocument.empty(SESSION), [reply, prompt])
    expect(chat.messages.map((message) => message.type)).toEqual(["user", "assistant"])
  })

  test("the history loads in order, in OpenCode's shape or as stored info and parts, and a reload keeps identity", () => {
    const user = { type: "user", id: "msg_1", text: "Hi", time: { created: 10 } }
    const stored = {
      info: {
        type: "assistant",
        id: "msg_2",
        agent: "build",
        model: { id: "m", providerID: "p" },
        time: { created: 20 },
      },
      parts: [{ type: "text", text: "Hello" }],
    }
    const chat = ChatsDocument.load(ChatsDocument.empty(SESSION), [stored, user, { junk: true }])
    expect(chat.messages.map((message) => message.id)).toEqual(["msg_1", "msg_2"])
    expect(chat.messages[1]).toMatchObject({ content: [{ type: "text", text: "Hello" }] })
    const again = ChatsDocument.load(chat, [user])
    expect(again.messages[0]).toBe(chat.messages[0]!)
  })
})
