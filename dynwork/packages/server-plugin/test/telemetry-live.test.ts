import { afterAll, beforeAll, expect, test } from "bun:test"
import { DynWorkSyncClient } from "../src/client"
import { DynWorkSync } from "../src/contract"
import { DynWorkTelemetry } from "../src/telemetry"
import { alpha } from "./fixture"
import { boot, until } from "./service"

// The governance telemetry in a real OpenCode service: a real Session step against a fake instance that serves the
// gateway's `/v1/messages`, the bridge's OAuth client and token routes and `/api/public/hooks/track`, and records what
// arrives. The model loads a skill with the skill tool, then answers; deleting the Session ends it.

const tracked: Array<{ query: string; headers: Record<string, string>; body: Record<string, unknown> }> = []
const model: Array<{ headers: Record<string, string>; body: { metadata?: { user_id?: string } } }> = []
const minted: string[] = []

const instance = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    const url = new URL(request.url)
    if (url.pathname === "/v1/auth/bridge/oauth-client")
      return Response.json({
        client_id: "bridge:dev",
        client_secret: "client-secret",
        scopes: ["hook:govern", "hook:track"],
        token_endpoint: `${url.origin}/api/v1/core/oauth/token`,
      })
    if (url.pathname === "/api/v1/core/oauth/token") {
      const plugin = new URLSearchParams(await request.text()).get("plugin_id") ?? ""
      minted.push(plugin)
      return Response.json({ access_token: `hook-${plugin}`, token_type: "Bearer", expires_in: 2_592_000 })
    }
    if (url.pathname === "/api/public/hooks/track") {
      tracked.push({ query: url.search, headers: Object.fromEntries(request.headers), body: await request.json() })
      return new Response(null, { status: 200 })
    }
    if (url.pathname !== "/v1/messages") return new Response("not found", { status: 404 })
    const body: { model: string; messages: Array<{ content: unknown }>; metadata?: { user_id?: string } } =
      await request.json()
    model.push({ headers: Object.fromEntries(request.headers), body })
    const answered = JSON.stringify(body.messages).includes("tool_result")
    return new Response(answered ? text(body.model) : skill(body.model), {
      headers: { "content-type": "text/event-stream" },
    })
  },
})

function sse(events: ReadonlyArray<readonly [string, unknown]>) {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("")
}

function start(model: string) {
  return [
    "message_start",
    {
      type: "message_start",
      message: { id: "msg_1", type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } },
    },
  ] as const
}

function skill(model: string) {
  return sse([
    start(model),
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_skill_1", name: "skill", input: {} } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ id: "who-am-i" }) } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } }],
    ["message_stop", { type: "message_stop" }],
  ])
}

function text(model: string) {
  return sse([
    start(model),
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "pong" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
    ["message_stop", { type: "message_stop" }],
  ])
}

// Only the gateway may serve a model, so no call of the test can leave the machine.
const service = await boot({}, { enabled_providers: ["systemprompt"], permission: { skill: "allow" } })
const client = DynWorkSyncClient.make(() => ({ url: service.url, headers: service.headers }))
const [project] = service.projects as [string]
const jwt = "eyJhbGciOiJSUzI1NiJ9.dXNlcg.c2ln"
const models = [{ id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", api: "messages" }] satisfies DynWorkSync.Gateway["models"]
const manifest = {
  ...alpha,
  plugins: [
    { id: "alpha-tools", hooks: { governance: false } },
    { id: "dynapps-commons", hooks: { governance: true } },
  ],
  skills: alpha.skills.map((entry) => (entry.id === "who_am_i" ? { ...entry, plugins: ["dynapps-commons"] } : entry)),
}

afterAll(async () => {
  await service.stop()
  instance.stop(true)
})

beforeAll(async () => {
  await client.apply({
    instance: { key: "alpha", url: instance.url.origin },
    manifest,
    jwt,
    expiresAt: Date.now() + 3_600_000,
    gateway: { label: "Alpha", models },
  })
})

const named = (name: string) => tracked.filter((call) => call.body.hook_event_name === name)

test("a Session step reports its lifecycle, prompt and skill use to track, and stamps its model calls", async () => {
  const created = await service.post("/api/session", {
    location: { directory: project },
    title: "telemetry test",
    model: { id: "claude-sonnet-5-5", providerID: "systemprompt" },
  })
  expect(created.status).toBe(200)
  const id: string = created.body.data.id
  const session = DynWorkTelemetry.session(id)
  expect((await service.post(`/api/session/${id}/prompt`, { text: "who am I?" }, project)).status).toBe(200)
  const waited = await fetch(
    `${service.url}/api/experimental/session/${id}/wait?location[directory]=${encodeURIComponent(project)}`,
    { method: "POST", headers: service.headers },
  )
  expect(waited.status).toBe(204)
  expect(JSON.stringify(await service.get(`/api/session/${id}/message`, project))).toContain("pong")
  await until(
    async () => tracked.length,
    () => named("Stop").length > 0 && named("PostToolUse").length > 0,
  )

  // Every call is the governance plugin's, with its hook token and the bridge's host stamp; never the user's JWT.
  expect(new Set(minted)).toEqual(new Set(["dynapps-commons"]))
  for (const call of tracked) {
    expect(call.query).toBe("?plugin_id=dynapps-commons")
    expect(call.headers).toMatchObject({
      authorization: "Bearer hook-dynapps-commons",
      "x-systemprompt-host": "opencode",
      "content-type": "application/json",
    })
    expect(call.body).toMatchObject({ session_id: session, native_session_id: id, cwd: project, native_host: "opencode" })
    expect(JSON.stringify(call)).not.toContain(jwt)
  }
  expect(named("SessionStart")).toHaveLength(1)
  expect(named("UserPromptSubmit").map((call) => call.body.prompt)).toEqual(["who am I?"])
  const used = named("PostToolUse")
  expect(used).toHaveLength(1)
  expect(used[0]?.body).toMatchObject({
    tool_name: "skill",
    tool_input: { name: "who-am-i" },
    tool_use_id: "toolu_skill_1",
    skill_ref: "dynapps-commons:who-am-i",
  })
  expect(String((used[0]?.body.tool_response as { output?: unknown }).output)).toContain("who")
  expect(used[0]?.headers["x-ingestion-event-id"]).toBe("toolu_skill_1")

  // Both model calls of the step land on the hook events' context, as the bridge's proxy stamps them.
  expect(model.length).toBe(2)
  for (const call of model) {
    expect(call.body.metadata?.user_id).toBe(JSON.stringify({ session_id: session }))
    expect(call.headers["x-opencode-session"]).toBeUndefined()
    expect(call.headers.authorization).toBe(`Bearer ${jwt}`)
  }

  const removed = await fetch(`${service.url}/api/session/${id}?location[directory]=${encodeURIComponent(project)}`, {
    method: "DELETE",
    headers: service.headers,
  })
  expect(removed.ok).toBe(true)
  expect(await until(async () => named("SessionEnd").length, (count) => count > 0)).toBe(1)
}, 30_000)

test("without a governance plugin nothing is reported", async () => {
  await client.apply({
    instance: { key: "alpha", url: instance.url.origin },
    manifest: { ...manifest, plugins: [{ id: "dynapps-commons", hooks: { governance: false } }] },
    jwt,
    expiresAt: Date.now() + 3_600_000,
    gateway: { label: "Alpha", models },
  })
  tracked.length = 0
  model.length = 0
  const created = await service.post("/api/session", {
    location: { directory: project },
    title: "quiet",
    model: { id: "claude-sonnet-5-5", providerID: "systemprompt" },
  })
  const id: string = created.body.data.id
  await service.post(`/api/session/${id}/prompt`, { text: "hi" }, project)
  await fetch(`${service.url}/api/experimental/session/${id}/wait?location[directory]=${encodeURIComponent(project)}`, {
    method: "POST",
    headers: service.headers,
  })
  await Bun.sleep(500)
  expect(model.length).toBeGreaterThan(0)
  // The stamp belongs to the hooks plugin, like the bridge's: without governance the calls go as OpenCode builds them.
  expect(model.every((call) => call.body.metadata?.user_id === undefined)).toBe(true)
  expect(tracked).toEqual([])
}, 30_000)
