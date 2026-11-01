import { afterAll, expect, test } from "bun:test"
import { DynWorkSyncClient } from "../../src/client"

// What main sends with `token` and how it reads the plugin's events, against a fake service.
const requests: Array<{ path: string; query: string; authorization: string | null; body?: unknown }> = []
const answers: Array<() => Response> = []
const service = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    const url = new URL(request.url)
    requests.push({
      path: url.pathname,
      query: url.search,
      authorization: request.headers.get("authorization"),
      ...(request.method === "POST" ? { body: await request.json() } : {}),
    })
    return answers.shift()?.() ?? Response.json({ output: { accepted: true } })
  },
})
afterAll(() => service.stop(true))

const client = DynWorkSyncClient.make(() => ({
  url: `${service.url.origin}/`,
  headers: { authorization: "Basic eA==" },
}))
const instance = { key: "alpha", url: "http://127.0.0.1:18101" }

test("token posts the renewed JWT and reads whether the plugin took it", async () => {
  requests.length = 0
  expect(await client.token({ instance, jwt: "a.b.c", expiresAt: 5 })).toBe(true)
  answers.push(() => Response.json({ output: { accepted: false } }))
  expect(await client.token({ instance, jwt: "a.b.c", expiresAt: 5 })).toBe(false)
  expect(requests[0]).toEqual({
    path: "/api/rpc/dynwork.sync/token",
    query: "",
    authorization: "Basic eA==",
    body: { input: { instance, jwt: "a.b.c", expiresAt: 5 } },
  })
  answers.push(() => Response.json({ output: {} }))
  expect(await client.token({ instance, jwt: "a.b.c", expiresAt: 5 }).catch((error: unknown) => error)).toMatchObject({
    status: 200,
    type: "invalid_output",
  })
})

test("listen hands over the three events, split across chunks, and skips everything else", async () => {
  const frames = [
    `data: ${JSON.stringify({ type: "server.connected", data: {} })}\n\n`,
    `event: message\ndata: ${JSON.stringify({ type: "rpc.dynwork.sync.refresh", data: { instance: "alpha", reason: "expired" } })}\n\n`,
    `data: not json\n\n`,
    `data: ${JSON.stringify({ type: "rpc.dynwork.sync.refresh", data: { instance: "alpha", reason: "bogus" } })}\n\n`,
    `data: ${JSON.stringify({ type: "rpc.dynwork.sync.rejected", data: { instance: "alpha" } })}\r\n\r\n`,
    `data: ${JSON.stringify({ type: "rpc.dynwork.sync.session", data: { instance: "alpha" } })}\n\n`,
    `data: ${JSON.stringify({ type: "rpc.dynwork.sync.session", data: { instance: "alpha", session: "5de1b7f7-3c8e-5c6a-9885-2317b386feb1" } })}\n\n`,
  ].join("")
  const encoder = new TextEncoder()
  answers.push(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            // Cut the text at arbitrary points: frames reach the client in pieces.
            for (let index = 0; index < frames.length; index += 7)
              controller.enqueue(encoder.encode(frames.slice(index, index + 7)))
            controller.close()
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  )
  requests.length = 0
  const heard: unknown[] = []
  await client.listen(
    {
      refresh: (event) => heard.push(["refresh", event]),
      rejected: (event) => heard.push(["rejected", event]),
      session: (event) => heard.push(["session", event]),
    },
    new AbortController().signal,
  )
  expect(heard).toEqual([
    ["refresh", { instance: "alpha", reason: "expired" }],
    ["rejected", { instance: "alpha" }],
    ["session", { instance: "alpha", session: "5de1b7f7-3c8e-5c6a-9885-2317b386feb1" }],
  ])
  expect(requests).toEqual([
    {
      path: "/api/event",
      query: "?types=rpc.dynwork.sync.refresh&types=rpc.dynwork.sync.rejected&types=rpc.dynwork.sync.session",
      authorization: "Basic eA==",
    },
  ])
})

test("listen settles when aborted, and fails when the service refuses or is missing", async () => {
  const controller = new AbortController()
  answers.push(() => new Response(new ReadableStream({}), { headers: { "content-type": "text/event-stream" } }))
  const listening = client.listen({}, controller.signal)
  await Bun.sleep(20)
  controller.abort()
  expect(await listening).toBeUndefined()
  answers.push(() => new Response("no", { status: 401 }))
  expect(await client.listen({}, new AbortController().signal).catch((error: unknown) => error)).toMatchObject({
    method: "events",
    status: 401,
  })
  const missing = DynWorkSyncClient.make(() => undefined)
  expect(await missing.listen({}, new AbortController().signal).catch((error: unknown) => error)).toMatchObject({
    status: 0,
  })
})
