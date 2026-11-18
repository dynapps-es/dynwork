import { describe, expect, test } from "bun:test"
import type { Caller, IpcImpl, MainContext } from "@opencode/plugin/gui/main"
import { createRoot } from "solid-js"
import type { ChatsBackend } from "../../src/chats/backend"
import { ChatsChat } from "../../src/chats/chat"
import { Chats, type Event } from "../../src/chats/contract"
import { ChatsDocument } from "../../src/chats/document"
import { ChatsFake } from "../../src/chats/fake"
import { ChatsMain } from "../../src/chats/main"
import en from "../../src/views/en"
import { entries } from "../../src/views/entries"
import { views } from "../../src/views/route"
import { settle, TOKEN } from "./fixture"

type Impl = IpcImpl<(typeof Chats)["spec"]>

// Main as Electron runs it, but with no OpenCode service: reading a server endpoint fails the test. What main provides
// is handed to the window as its Ipc client, events included.
function desktop() {
  const fake = ChatsFake.make({ token: () => TOKEN })
  const provided: { impl?: Impl } = {}
  const listeners = new Set<(event: Event) => void>()
  const cleanups: (() => void)[] = []
  const ctx = {
    get serverEndpoints(): never {
      throw new Error("the Chats view reached OpenCode's service")
    },
    provide: (_: typeof Chats, impl: Impl) => {
      provided.impl = impl
      return {
        changed: () => {},
        emit: (_name: "event", event: Event) => listeners.forEach((listener) => listener(event)),
      }
    },
    onCleanup: (cleanup: () => void) => void cleanups.push(cleanup),
  } as unknown as MainContext
  const main = ChatsMain.setup(ctx, {
    focused: true,
    fetch: fake.fetch,
    accounts: {
      list: () => [{ id: "acc_1", url: "https://governance.test", status: "signedIn", active: true }],
      session: async () => ({ token: TOKEN }),
    },
  })
  const impl = provided.impl!
  const never = new AbortController().signal
  // SAFETY: the window calls each method by name with its input, as the bridge does.
  const methods = impl as unknown as Record<string, (input: unknown, caller: Caller) => unknown>
  const client = new Proxy(
    {},
    {
      get: (_, name: string) => {
        if (name === "state") return () => impl.state(1)
        if (name === "on")
          return (_event: "event", listener: (event: Event) => void) => {
            listeners.add(listener)
            return () => void listeners.delete(listener)
          }
        return (input: unknown, options?: { signal?: AbortSignal }) =>
          methods[name]?.(input, { window: 1, signal: options?.signal ?? never })
      },
    },
  ) as ChatsBackend.Client
  return { fake, main, client, dispose: () => cleanups.forEach((cleanup) => cleanup()) }
}

describe("the Chats view", () => {
  test("holds a whole cloud chat with no OpenCode service: list, new chat, streamed reply, follow-up", async () => {
    const world = desktop()
    const models = await world.client.models()
    expect(Array.isArray(models) && models.map((model) => model.name)).toEqual(["Claude Sonnet 4", "GPT-5.4 mini"])
    const chat = createRoot(() =>
      ChatsChat.make({
        client: () => world.client,
        thread: () => undefined,
        models: () => (Array.isArray(models) ? models : []),
      }),
    )
    expect(await chat.composer.onSubmit("How long are backups kept?")).toBe(true)
    const following = new AbortController()
    chat.follow(following.signal)
    world.fake.flush(chat.id, 4)
    await settle()
    // The timeline's document while the reply streams: the prompt and the text so far, busy.
    expect(chat.document().status).toEqual({ type: "busy" })
    expect(ChatsDocument.reply(chat.chat())).toBe("You said: ")
    world.fake.finish(chat.id)
    await settle()
    expect(chat.document().status).toEqual({ type: "idle" })
    expect(ChatsDocument.reply(chat.chat())).toBe("You said: How long are backups kept?")
    await world.client.refresh()
    expect(world.client.state()?.threads.map((thread) => thread.title)).toEqual(["How long are backups kept?"])
    expect(await chat.composer.onSubmit("And in staging?")).toBe(true)
    world.fake.finish(chat.id)
    await settle()
    expect(
      chat
        .document()
        .messages.filter((message) => message.type === "user")
        .map((message) => message.text),
    ).toEqual(["How long are backups kept?", "And in staging?"])
    following.abort()
    world.dispose()
  })

  test("the relay hint reads the feed at once", async () => {
    const world = desktop()
    await world.client.refresh()
    const reads = () => world.fake.requests.filter((request) => request.path.startsWith("/changes")).length
    const before = reads()
    world.main.pull()
    await settle()
    expect(reads()).toBe(before + 1)
    world.dispose()
  })

  test("is the sidebar's Chats row and its page, with its strings", () => {
    const table: Record<string, string> = en
    expect(entries.find((entry) => entry.id === "chats")).toMatchObject({ icon: "speech-bubble", pages: ["chats"] })
    expect(views.has("chats")).toBe(true)
    expect(table["views.nav.chats"]).toBe("Chats")
    expect(table["chats.title"]).toBe("Chats")
  })
})
