import { afterAll, beforeAll, expect, test } from "bun:test"
import { DynWorkSyncClient } from "../src/client"
import { DynWorkSync } from "../src/contract"
import { alpha } from "./fixture"
import { boot, until } from "./service"

// A scheduled task's run is a child session of the task's anchor, made by DynWork's main process
// (`gui/src/routines/local/backend.ts`). In a real OpenCode service, a child reports its result to its parent and wakes
// it each time it goes idle, so the anchor would answer every run; a child whose id has the automation-run prefix
// (`ses_aut_`) finishes quietly. This pins the upstream behavior the runs rely on: the gateway serves every model call.

const calls: string[] = []

const instance = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    if (new URL(request.url).pathname !== "/v1/messages") return new Response("not found", { status: 404 })
    const body: { model: string } = await request.json()
    calls.push(body.model)
    return new Response(pong(body.model), { headers: { "content-type": "text/event-stream" } })
  },
})

function pong(model: string) {
  return [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
    ],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "pong" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
    ["message_stop", { type: "message_stop" }],
  ]
    .map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("")
}

const service = await boot({}, { enabled_providers: ["systemprompt"] })
const client = DynWorkSyncClient.make(() => ({ url: service.url, headers: service.headers }))
const [project] = service.projects as [string]
const model = { id: "claude-sonnet-5-5", providerID: "systemprompt" }
const models = [
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", api: "messages" },
] satisfies DynWorkSync.Gateway["models"]

afterAll(async () => {
  await service.stop()
  instance.stop(true)
})

beforeAll(async () => {
  await client.apply({
    instance: { key: "alpha", url: instance.url.origin },
    manifest: alpha,
    jwt: "eyJhbGciOiJSUzI1NiJ9.dXNlcg.c2ln",
    expiresAt: Date.now() + 3_600_000,
    gateway: { label: "Alpha", models },
  })
})

// An anchor with one run that is prompted and waited for; returns the anchor's id.
async function run(id?: string) {
  const anchor = await service.post("/api/session", { location: { directory: project }, title: "Task", model })
  expect(anchor.status).toBe(200)
  const child = await service.post(
    "/api/session",
    { ...(id ? { id } : {}), parentID: anchor.body.data.id, title: "Task · run", model },
    project,
  )
  expect(child.status).toBe(200)
  const session: string = child.body.data.id
  expect((await service.post(`/api/session/${session}/prompt`, { text: "ping" }, project)).status).toBe(200)
  const waited = await fetch(
    `${service.url}/api/experimental/session/${session}/wait?location[directory]=${encodeURIComponent(project)}`,
    { method: "POST", headers: service.headers },
  )
  expect(waited.status).toBe(204)
  return anchor.body.data.id as string
}

const messages = async (session: string) =>
  ((await service.get(`/api/session/${session}/message`, project)).data as unknown[]).length

test("a run whose id has the automation-run prefix leaves its anchor alone; any other child wakes it", async () => {
  const quiet = await run(`ses_aut_dynwork_${crypto.randomUUID().replaceAll("-", "")}`)
  expect(calls).toHaveLength(1)

  // The control: a plain child's report reaches its anchor, which answers it with a model call of its own.
  const loud = await run()
  expect(
    await until(
      () => messages(loud),
      (count) => count > 0,
    ),
  ).toBeGreaterThan(0)
  await until(
    async () => calls.length,
    (count) => count >= 3,
  )

  // By now the quiet run's report would have arrived long ago.
  expect(await messages(quiet)).toBe(0)
  expect(calls).toHaveLength(3)
}, 60_000)
