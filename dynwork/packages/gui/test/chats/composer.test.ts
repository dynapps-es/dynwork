import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { ChatsChat } from "../../src/chats/chat"
import type { Model, Thread } from "../../src/chats/contract"
import { ChatsDocument } from "../../src/chats/document"
import { settle } from "./fixture"
import { connect } from "./wire"

const MODELS: Model[] = [
  {
    id: "claude-sonnet-4",
    name: "Claude Sonnet 4",
    provider: "anthropic",
    providerName: "Anthropic",
    reasoning: true,
    tools: true,
  },
  {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 mini",
    provider: "openai",
    providerName: "OpenAI",
    reasoning: false,
    tools: true,
  },
]

// A chat in a window over the Ipc, with ids a test can name.
function open(world: ReturnType<typeof connect>, thread?: () => Thread | undefined) {
  const created: Thread[] = []
  const ids = { count: 0 }
  const chat = createRoot(() =>
    ChatsChat.make({
      client: () => world.client,
      thread: thread ?? (() => undefined),
      models: () => MODELS,
      created: (made) => created.push(made),
      now: () => 1_800_000_000_000,
      id: (prefix) => `${prefix}_test${++ids.count}`,
    }),
  )
  return { chat, created }
}

describe("the cloud composer model", () => {
  test("a new chat's first prompt makes the thread, then prompts with its own message id through the Ipc", async () => {
    const world = connect()
    const { chat, created } = open(world)
    expect(chat.composer.models.map((model) => `${model.provider}/${model.name}`)).toEqual([
      "Anthropic/Claude Sonnet 4",
      "OpenAI/GPT-5.4 mini",
    ])
    chat.composer.onModel({ providerID: "openai", id: "gpt-5.4-mini" })
    expect(await chat.composer.onSubmit("What is in the backup policy?\nSecond line")).toBe(true)

    expect(created.map((thread) => thread.title)).toEqual(["What is in the backup policy?"])
    const asked = world.fake.requests.filter((request) => !request.path.startsWith("/changes"))
    expect(asked.map((request) => `${request.method} ${request.path}`)).toEqual([
      "PUT /threads/ses_test1",
      "POST /threads/ses_test1/prompt",
    ])
    expect(asked[0]?.body).toMatchObject({ model: { providerID: "openai", id: "gpt-5.4-mini" } })
    expect(asked[1]?.body).toEqual({
      messageID: "msg_test2",
      parts: [{ type: "text", text: "What is in the backup policy?\nSecond line" }],
      model: { providerID: "openai", id: "gpt-5.4-mini" },
    })
    // The prompt shows at once, and the composer is working until the reply ends.
    expect(chat.document().messages).toMatchObject([{ type: "user", id: "msg_test2" }])
    expect(chat.composer.working).toBe(true)
  })

  test("the reply streams into the document while followed, and Stop interrupts it through the Ipc", async () => {
    const world = connect()
    const { chat } = open(world)
    await chat.composer.onSubmit("Hello there")
    const following = new AbortController()
    chat.follow(following.signal)
    world.fake.flush(chat.id, 4)
    await settle()
    expect(ChatsDocument.reply(chat.chat())).toBe("You said: ")
    chat.composer.onStop()
    await settle()
    expect(world.fake.requests.filter((request) => request.path === `/threads/${chat.id}/interrupt`)).toHaveLength(1)
    expect(chat.composer.working).toBe(false)
    expect(chat.document().messages.map((message) => message.type)).toEqual(["user", "assistant", "idle"])
    expect(chat.document().messages.at(-1)).toMatchObject({ outcome: "interrupted" })
    expect(ChatsDocument.reply(chat.chat())).toBe("You said: ")
    following.abort()
  })

  test("a prompt the instance refuses keeps the draft and leaves no message behind", async () => {
    const world = connect()
    const { chat } = open(world)
    await chat.composer.onSubmit("First")
    // A second prompt while the first reply runs is refused by the fake.
    expect(await chat.composer.onSubmit("Second")).toBe(false)
    expect(chat.failure()).toMatchObject({ code: "conflict" })
    expect(chat.document().messages.map((message) => message.type === "user" && message.text)).toEqual(["First"])
  })

  test("an existing chat loads its history and continues with the thread's model", async () => {
    const world = connect()
    await world.client.create({ id: "ses_old", title: "Old", model: { providerID: "openai", id: "gpt-5.4-mini" } })
    await world.client.prompt({ id: "ses_old", messageID: "msg_old", text: "Earlier" })
    world.fake.finish("ses_old")
    const thread = () => world.client.state()?.threads.find((item) => item.id === "ses_old")
    const { chat } = open(world, thread)
    await chat.load()
    expect(chat.document().messages.map((message) => message.type)).toEqual(["user", "assistant"])
    expect(chat.composer.model).toEqual({ providerID: "openai", id: "gpt-5.4-mini" })
    await chat.composer.onSubmit("Again")
    expect(world.fake.requests.findLast((request) => request.path.endsWith("/prompt"))?.body).toMatchObject({
      messageID: "msg_test1",
      model: { providerID: "openai", id: "gpt-5.4-mini" },
    })
    expect(world.fake.requests.filter((request) => request.method === "PUT")).toHaveLength(1)
  })
})

describe("a new chat's title", () => {
  // The same inputs run on the phone (`src/core/cloud/title.test.ts` in the mobile app): both name a chat alike.
  test.each([
    ["Hello", "Hello"],
    ["  padded  \n second line", "padded  "],
    ["first line\nsecond line\nthird", "first line"],
    ["\n\n  after blank lines\nrest", "after blank lines"],
    ["a".repeat(60), "a".repeat(60)],
    ["a".repeat(61), `${"a".repeat(59)}…`],
    ["x".repeat(80), `${"x".repeat(59)}…`],
    [`${"x".repeat(80)}\nsecond`, `${"x".repeat(59)}…`],
    ["", ""],
    ["   \n  ", ""],
  ])("the title of %j is %j", (text, title) => {
    expect(ChatsChat.titleOf(text)).toBe(title)
  })
})
