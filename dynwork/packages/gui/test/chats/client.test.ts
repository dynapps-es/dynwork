import { describe, expect, test } from "bun:test"
import { ChatsClient } from "../../src/chats/client"
import { instance, settle, TOKEN } from "./fixture"

const BASE = "https://governance.test/api/dynwork/chats/v1"

// A `fetch` that answers each request with `answer` and records what was asked.
function scripted(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = []
  const fetch = async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      ...(typeof init.body === "string" ? { body: init.body } : {}),
    })
    return answer(url, init)
  }
  return { fetch, calls }
}

const account = (tokens: string[] = [TOKEN]) => {
  const minted = { fresh: 0 }
  return {
    minted,
    value: {
      id: "acc_1",
      url: "https://governance.test/",
      token: async (fresh: boolean) => {
        if (fresh) minted.fresh++
        return tokens[Math.min(minted.fresh, tokens.length - 1)]!
      },
    },
  }
}

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status })

describe("the chats client", () => {
  test("maps each contract route to its method, path, revision and body", async () => {
    const http = scripted((url) => {
      if (url.endsWith("/models")) return json(200, { models: [] })
      if (url.includes("/changes")) return json(200, { threads: [], cursor: "7", more: false })
      if (url.includes("/messages")) return json(200, { messages: [] })
      if (url.endsWith("/prompt")) return json(202, { messageID: "msg_2" })
      if (url.endsWith("/interrupt") || url.endsWith("/ses_1")) return json(204)
      return json(200, { id: "ses_1", title: "A", revision: 4, created_at: 1, updated_at: 2 })
    })
    const client = ChatsClient.make({ account: () => account().value, fetch: http.fetch })
    await client.models()
    await client.changes(undefined)
    await client.changes("cursor 7")
    await client.put("ses_1", { title: "A", model: { providerID: "anthropic", id: "claude" } }, undefined)
    await client.put("ses_1", { archived: true }, 3)
    await client.remove("ses_1", 4)
    await client.messages("ses_1", { before: "msg_9", limit: 20 })
    await client.prompt("ses_1", { messageID: "msg_1", text: "hi" })
    await client.interrupt("ses_1")
    expect(http.calls.map((call) => `${call.method} ${call.url.slice(BASE.length)}`)).toEqual([
      "GET /models",
      "GET /changes",
      "GET /changes?since=cursor%207",
      "PUT /threads/ses_1",
      "PUT /threads/ses_1",
      "DELETE /threads/ses_1",
      "GET /threads/ses_1/messages?before=msg_9&limit=20",
      "POST /threads/ses_1/prompt",
      "POST /threads/ses_1/interrupt",
    ])
    expect(http.calls.map((call) => call.headers["if-match"])).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      '"3"',
      '"4"',
      undefined,
      undefined,
      undefined,
    ])
    expect(http.calls.every((call) => call.headers.authorization === `Bearer ${TOKEN}`)).toBe(true)
    expect(JSON.parse(http.calls[3]!.body!)).toEqual({ title: "A", model: { providerID: "anthropic", id: "claude" } })
    expect(JSON.parse(http.calls[4]!.body!)).toEqual({ archived: true })
    expect(JSON.parse(http.calls[7]!.body!)).toEqual({ messageID: "msg_1", parts: [{ type: "text", text: "hi" }] })
  })

  test("reads the feed's rows, tombstones and models in the instance's shapes", async () => {
    const http = scripted((url) =>
      url.endsWith("/models")
        ? json(200, [{ id: "claude", name: "Claude", provider: { id: "anthropic", name: "Anthropic" }, tools: true }])
        : json(200, {
            threads: [
              {
                id: "ses_1",
                title: "Backups",
                model: "anthropic/claude",
                revision: 2,
                archived_at: null,
                deleted_at: null,
                created_at: "2026-11-17T10:00:00Z",
                updated_at: "2026-11-17T10:05:00Z",
              },
              { id: "ses_2", revision: 5, deleted: true },
            ],
            cursor: "9",
            more: true,
          }),
    )
    const client = ChatsClient.make({ account: () => account().value, fetch: http.fetch })
    expect(await client.changes(undefined)).toEqual({
      threads: [
        {
          id: "ses_1",
          title: "Backups",
          model: { providerID: "anthropic", id: "claude" },
          revision: 2,
          created: Date.parse("2026-11-17T10:00:00Z"),
          updated: Date.parse("2026-11-17T10:05:00Z"),
        },
      ],
      deleted: ["ses_2"],
      cursor: "9",
      more: true,
    })
    expect(await client.models()).toEqual([
      { id: "claude", name: "Claude", provider: "anthropic", providerName: "Anthropic", reasoning: false, tools: true },
    ])
  })

  test("turns statuses and the error envelope into failures, keeping the instance's message", async () => {
    const answers: Record<string, Response | (() => never)> = {
      "/threads/a/messages": json(404, { error: { key: "not_found", message: "No such chat." } }),
      "/threads/b/messages": json(500, { error: { key: "internal", message: "Database down." } }),
      "/threads/c/messages": json(422, { error: { key: "invalid", message: "Bad limit." } }),
      "/threads/d/messages": json(418),
    }
    const http = scripted((url) => {
      const answer = answers[url.slice(BASE.length).split("?")[0]!]
      if (typeof answer === "function") return answer()
      if (answer) return answer
      throw new TypeError("fetch failed")
    })
    const client = ChatsClient.make({ account: () => account().value, fetch: http.fetch })
    expect(await client.messages("a", {})).toEqual({ code: "not-found", message: "No such chat.", retryable: false })
    expect(await client.messages("b", {})).toEqual({ code: "unreachable", message: "Database down.", retryable: true })
    expect(await client.messages("c", {})).toEqual({ code: "invalid", message: "Bad limit.", retryable: false })
    expect(await client.messages("d", {})).toEqual({
      code: "failed",
      message: "Governance answered 418.",
      retryable: false,
    })
    expect(await client.messages("e", {})).toEqual({
      code: "unreachable",
      message: "Governance did not answer.",
      retryable: true,
    })
  })

  test("a 409 on a write answers conflict with the current row", async () => {
    const http = scripted(() =>
      json(409, { current: { id: "ses_1", title: "Theirs", revision: 8, created_at: 1, updated_at: 5 } }),
    )
    const client = ChatsClient.make({ account: () => account().value, fetch: http.fetch })
    expect(await client.put("ses_1", { title: "Mine" }, 7)).toEqual({
      code: "conflict",
      message: "This chat changed on another device.",
      retryable: false,
      current: { id: "ses_1", title: "Theirs", revision: 8, created: 1, updated: 5 },
    })
  })

  test("a refused JWT is minted again once; refused again, the account is signed out", async () => {
    const renewed = account(["old", "new"])
    const once = scripted((_, init) =>
      new Headers(init.headers).get("authorization") === "Bearer new" ? json(200, { models: [] }) : json(401),
    )
    expect(await ChatsClient.make({ account: () => renewed.value, fetch: once.fetch }).models()).toEqual([])
    expect(renewed.minted.fresh).toBe(1)

    const refused = account(["old", "still refused"])
    const always = scripted(() => json(401, { error: { key: "token_invalid", message: "Sign in again." } }))
    expect(await ChatsClient.make({ account: () => refused.value, fetch: always.fetch }).models()).toEqual({
      code: "signed-out",
      message: "Sign in again.",
      retryable: false,
    })
    expect(always.calls).toHaveLength(2)
  })

  test("without an active account nothing is sent", async () => {
    const http = scripted(() => json(200))
    const client = ChatsClient.make({ account: () => undefined, fetch: http.fetch })
    expect(await client.models()).toMatchObject({ code: "signed-out" })
    expect(http.calls).toEqual([])
  })

  test("the log's SSE is parsed across chunk boundaries, comments and CRLF", async () => {
    const events = [
      { type: "session.text.delta", durable: { seq: 4 }, data: { sessionID: "s", delta: "Hel" } },
      { type: "session.text.delta", durable: { seq: 5 }, data: { sessionID: "s", delta: "lo" } },
    ]
    const wire = `: keep-alive\r\n\r\nid: 4\r\ndata: ${JSON.stringify(events[0])}\r\n\r\nid: 5\ndata: ${JSON.stringify(events[1])}\n\n`
    const http = scripted(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              const bytes = new TextEncoder().encode(wire)
              Array.from({ length: Math.ceil(bytes.length / 7) }, (_, index) =>
                controller.enqueue(bytes.slice(index * 7, index * 7 + 7)),
              )
              controller.close()
            },
          }),
          { status: 200 },
        ),
    )
    const client = ChatsClient.make({ account: () => account().value, fetch: http.fetch })
    const seen: unknown[] = []
    expect(await client.log("s", 3, (event) => seen.push(event), new AbortController().signal)).toBe("ended")
    expect(seen).toEqual(events)
    expect(http.calls[0]?.url).toBe(`${BASE}/threads/s/log?follow=1&after=3`)
    expect(http.calls[0]?.headers.accept).toBe("text/event-stream")
  })

  test("against the fake instance: a thread is created, prompted and its reply streams over the log", async () => {
    const { fake, client } = instance()
    expect(await client.put("ses_x", { title: "Hi" }, undefined)).toMatchObject({ revision: 1 })
    expect(await client.prompt("ses_x", { messageID: "msg_a", text: "Hello there" })).toEqual({
      messageID: "msg_fake0001",
    })
    const seen: { type: string }[] = []
    const stop = new AbortController()
    const following = client.log("ses_x", undefined, (event) => seen.push(event as { type: string }), stop.signal)
    fake.finish("ses_x")
    await settle()
    stop.abort()
    expect(await following).toBe("ended")
    expect(seen.map((event) => event.type)).toEqual([
      "session.created",
      "session.execution.started",
      "session.step.started",
      "session.text.started",
      "session.text.delta",
      "session.text.delta",
      "session.text.delta",
      "session.text.ended",
      "session.step.ended",
      "session.execution.succeeded",
    ])
  })
})
