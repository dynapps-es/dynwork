import { afterAll, beforeAll, expect, test } from "bun:test"
import { DynWorkSyncClient } from "../../src/client"
import { DynWorkSync } from "../../src/contract"
import { alpha } from "../fixture"
import { boot, until } from "../service"

// The `systemprompt` provider in a real OpenCode service, with real Session steps against a fake gateway that answers
// like the instance's `/v1/messages`: the JWT and client header on every call, renewal, one recovery from a refusal,
// sign-out after a second one, an expired JWT never sent, and the provider replaced on switch and gone on clear.

const token = (name: string) => `eyJhbGciOiJSUzI1NiJ9.${btoa(name).replace(/=+$/, "")}.c2ln`

// The gateway accepts only the tokens in `valid`, like the instance accepts only live JWTs.
const valid = new Set<string>()
const calls: Array<{
  path: string
  authorization: string | null
  client: string | null
  protocol: string | null
  apiKey: string | null
}> = []
// The instance's MCP route records the JWT OpenCode connects with.
const mcp: string[] = []
const gateway = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    const path = new URL(request.url).pathname
    if (path === "/api/v1/mcp/routed/mcp") mcp.push(request.headers.get("authorization") ?? "")
    if (path !== "/v1/messages") return new Response("not found", { status: 404 })
    const authorization = request.headers.get("authorization")
    calls.push({
      path,
      authorization,
      client: request.headers.get("x-systemprompt-client"),
      protocol: request.headers.get("x-inference-protocol"),
      apiKey: request.headers.get("x-api-key"),
    })
    if (!valid.has(authorization?.replace(/^Bearer /, "") ?? ""))
      return Response.json({ error: { type: "authentication_error", message: "invalid token" } }, { status: 401 })
    const body: { model: string; stream?: boolean } = await request.json()
    return new Response(stream(body.model), { headers: { "content-type": "text/event-stream" } })
  },
})

function stream(model: string) {
  const events = [
    ["message_start", { type: "message_start", message: message(model) }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "pong" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
    ["message_stop", { type: "message_stop" }],
  ] as const
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("")
}

function message(model: string) {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model,
    content: [],
    stop_reason: null,
    usage: { input_tokens: 1, output_tokens: 0 },
  }
}

// Only the gateway may serve a model: the built-in providers (OpenCode's public endpoint among them) are denied, so no
// call of the test can leave the machine.
const service = await boot({}, { enabled_providers: ["systemprompt"] })
const client = DynWorkSyncClient.make(() => ({ url: service.url, headers: service.headers }))
const [project] = service.projects as [string]
const instance = { key: "alpha", url: gateway.url.origin }
const models = [
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", api: "messages", context: 1_000_000, output: 128_000 },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", api: "messages" },
] satisfies DynWorkSync.Gateway["models"]
const manifest = {
  ...alpha,
  agents: alpha.agents.map((agent) => ({ ...agent, model: "claude-haiku-5-5" })),
  managed_mcp_servers: [{ id: "routed", name: "routed", url: `${gateway.url.origin}/api/v1/mcp/routed/mcp` }],
}
const hour = () => Date.now() + 3_600_000

// Stands in for main: answers `refresh` by pushing the next minted JWT, and records every event.
const heard: Array<{ name: string; data: unknown }> = []
const mints: string[] = []
const listening = new AbortController()
const listen = client.listen(
  {
    refresh: (event) => {
      heard.push({ name: "refresh", data: event })
      const jwt = mints.shift()
      if (jwt) void client.token({ instance, jwt, expiresAt: hour() })
    },
    rejected: (event) => heard.push({ name: "rejected", data: event }),
  },
  listening.signal,
)

afterAll(async () => {
  listening.abort()
  await listen
  await service.stop()
  gateway.stop(true)
})

const step = async () => {
  const created = await service.post("/api/session", {
    location: { directory: project },
    // A titled Session makes no title request: every gateway call is a step of the agent loop.
    title: "gateway test",
    model: { id: "claude-sonnet-5-5", providerID: "systemprompt" },
  })
  expect(created.status).toBe(200)
  const id: string = created.body.data.id
  const prompted = await service.post(`/api/session/${id}/prompt`, { text: "ping" }, project)
  expect(prompted.status).toBe(200)
  const waited = await fetch(
    `${service.url}/api/experimental/session/${id}/wait?location[directory]=${encodeURIComponent(project)}`,
    { method: "POST", headers: service.headers },
  )
  expect(waited.status).toBe(204)
  return JSON.stringify(await service.get(`/api/session/${id}/message`, project))
}

const sent = () => calls.map((call) => call.authorization?.replace(/^Bearer /, "") ?? null)

beforeAll(async () => {
  valid.add(token("one"))
  expect(
    await client.apply({
      instance,
      manifest,
      jwt: token("one"),
      expiresAt: hour(),
      gateway: { label: "Alpha", models },
    }),
  ).toMatchObject({ skills: 3 })
})

test("the instance's models appear as the systemprompt provider", async () => {
  const providers = async () =>
    ((await service.get("/api/provider", project)) as { data: Array<{ id: string }> }).data.map((entry) => entry.id)
  expect(await until(providers, (ids) => ids.includes("systemprompt"))).toContain("systemprompt")
  const provider: { data: { name: string; package: string; settings?: { baseURL?: string } } } = await service.get(
    "/api/provider/systemprompt",
    project,
  )
  expect(provider.data).toMatchObject({
    name: "Alpha",
    package: "@opencode/ai/providers/anthropic-compatible",
    settings: { baseURL: `${gateway.url.origin}/v1` },
  })
  expect(JSON.stringify(provider)).not.toContain(token("one"))
  const listed: { data: Array<{ id: string; providerID: string; name: string }> } = await service.get(
    "/api/model",
    project,
  )
  expect(
    listed.data
      .filter((model) => model.providerID === "systemprompt")
      .map((model) => [model.id, model.name])
      .toSorted(),
  ).toEqual([
    ["claude-haiku-5-5", "Claude Haiku 5.5"],
    ["claude-sonnet-5-5", "Claude Sonnet 5.5"],
  ])
  // An instance agent whose model the gateway serves runs on it.
  const agent: { data: { model?: { providerID: string; id: string } } } = await service.get(
    "/api/agent/alpha-alpha_helper",
    project,
  )
  expect(agent.data.model).toEqual({ providerID: "systemprompt", id: "claude-haiku-5-5" })
}, 30_000)

test("a step calls the instance's /v1/messages with the JWT and the client header", async () => {
  calls.length = 0
  const messages = await step()
  expect(messages).toContain("pong")
  expect(calls.length).toBeGreaterThan(0)
  for (const call of calls)
    expect(call).toEqual({
      path: "/v1/messages",
      authorization: `Bearer ${token("one")}`,
      client: "opencode",
      protocol: "claude,openai",
      apiKey: null,
    })
  const database = await Bun.file(service.database).arrayBuffer()
  expect(Buffer.from(database).includes(token("one"))).toBe(false)
}, 30_000)

test("after a renewal the old JWT is never sent again", async () => {
  valid.add(token("two"))
  expect(await client.token({ instance, jwt: token("two"), expiresAt: hour() })).toBe(true)
  // The instance's MCP server reconnects with the renewed JWT too.
  expect(
    await until(
      async () => mcp,
      (seen) => seen.includes(`Bearer ${token("two")}`),
    ),
  ).toContain(`Bearer ${token("two")}`)
  expect(await client.token({ instance: { ...instance, key: "beta" }, jwt: token("other"), expiresAt: hour() })).toBe(
    false,
  )
  // A renewal that arrives after a newer one is older, and dropped.
  expect(await client.token({ instance, jwt: token("stale"), expiresAt: Date.now() + 60_000 })).toBe(false)
  valid.delete(token("one"))
  calls.length = 0
  expect(await step()).toContain("pong")
  expect(new Set(sent())).toEqual(new Set([token("two")]))
}, 30_000)

test("a refused JWT is renewed once and the step still succeeds", async () => {
  valid.clear()
  valid.add(token("three"))
  mints.push(token("three"))
  heard.length = 0
  calls.length = 0
  expect(await step()).toContain("pong")
  expect(sent().slice(0, 2)).toEqual([token("two"), token("three")])
  expect(new Set(sent().slice(1))).toEqual(new Set([token("three")]))
  expect(heard).toEqual([{ name: "refresh", data: { instance: "alpha", reason: "rejected" } }])
}, 30_000)

test("a second refusal surfaces the error and marks the instance signed out", async () => {
  valid.clear()
  mints.push(token("four"))
  heard.length = 0
  calls.length = 0
  const messages = await step()
  expect(messages).not.toContain("pong")
  expect(messages).toContain("401")
  expect(sent()).toEqual([token("three"), token("four")])
  expect(heard).toEqual([
    { name: "refresh", data: { instance: "alpha", reason: "rejected" } },
    { name: "rejected", data: { instance: "alpha" } },
  ])
  // Signed out: the next call carries no JWT at all and is not retried.
  calls.length = 0
  expect(await step()).not.toContain("pong")
  expect(sent()).toEqual([null])
}, 30_000)

test("an expired JWT is never sent: the call waits for a fresh one", async () => {
  valid.clear()
  valid.add(token("six"))
  mints.push(token("six"))
  expect(
    await client.apply({
      instance,
      manifest,
      jwt: token("five"),
      expiresAt: Date.now() + 1_000,
      gateway: { label: "Alpha", models },
    }),
  ).toMatchObject({ skills: 3 })
  heard.length = 0
  calls.length = 0
  expect(await step()).toContain("pong")
  expect(new Set(sent())).toEqual(new Set([token("six")]))
  expect(heard).toContainEqual({ name: "refresh", data: { instance: "alpha", reason: "expired" } })
}, 30_000)

test("switching replaces the provider and clearing removes it", async () => {
  await client.apply({
    instance: { key: "beta", url: gateway.url.origin },
    manifest,
    jwt: token("beta"),
    expiresAt: hour(),
    gateway: { label: "Beta", models: [{ id: "claude-opus-5-5", api: "messages" }] },
  })
  const provider: { data: { name: string } } = await service.get("/api/provider/systemprompt", project)
  expect(provider.data.name).toBe("Beta")
  const ids = async () => {
    const listed: { data: Array<{ id: string; providerID: string }> } = await service.get("/api/model", project)
    return listed.data.filter((model) => model.providerID === "systemprompt").map((model) => model.id)
  }
  expect(await ids()).toEqual(["claude-opus-5-5"])
  await client.clear()
  expect(await until(ids, (value) => value.length === 0)).toEqual([])
  const response = await fetch(
    `${service.url}/api/provider/systemprompt?location[directory]=${encodeURIComponent(project)}`,
    { headers: service.headers },
  )
  expect(response.ok).toBe(false)
}, 30_000)
