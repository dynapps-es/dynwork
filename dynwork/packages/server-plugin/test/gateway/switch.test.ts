import { afterAll, beforeAll, expect, test } from "bun:test"
import { DynWorkSyncClient } from "../../src/client"
import type { DynWorkSync } from "../../src/contract"
import { alpha } from "../fixture"
import { boot } from "../service"

// A tenant switch while a model step waits for main to renew the JWT, in a real OpenCode service with two fake
// gateways: the step that started on alpha must never carry beta's JWT to alpha's gateway, and it ends on beta's.

const token = (name: string) => `eyJhbGciOiJSUzI1NiJ9.${btoa(name).replace(/=+$/, "")}.c2ln`

// Each gateway accepts only its own live tokens and records the Authorization header of every model call.
function gateway(valid: Set<string>) {
  const seen: Array<string | null> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      if (new URL(request.url).pathname !== "/v1/messages") return new Response("not found", { status: 404 })
      const authorization = request.headers.get("authorization")
      seen.push(authorization)
      if (!valid.has(authorization?.replace(/^Bearer /, "") ?? ""))
        return Response.json({ error: { type: "authentication_error", message: "invalid token" } }, { status: 401 })
      const body: { model: string } = await request.json()
      return new Response(stream(body.model), { headers: { "content-type": "text/event-stream" } })
    },
  })
  return { server, seen, sent: () => seen.map((value) => value?.replace(/^Bearer /, "") ?? null) }
}

function stream(model: string) {
  const message = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model,
    content: [],
    stop_reason: null,
    usage: { input_tokens: 1, output_tokens: 0 },
  }
  const events = [
    ["message_start", { type: "message_start", message }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "pong" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
    ["message_stop", { type: "message_stop" }],
  ] as const
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("")
}

const alphaGateway = gateway(new Set([token("alpha-fresh")]))
const betaGateway = gateway(new Set([token("beta-one"), token("beta-two")]))

// Only the gateway may serve a model, so no call of the test can leave the machine.
const service = await boot({}, { enabled_providers: ["systemprompt"] })
const client = DynWorkSyncClient.make(() => ({ url: service.url, headers: service.headers }))
const [project] = service.projects as [string]
const models = [
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", api: "messages" },
] satisfies DynWorkSync.Gateway["models"]
const alphaInstance = { key: "alpha", url: alphaGateway.server.url.origin }
const betaInstance = { key: "beta", url: betaGateway.server.url.origin }
const hour = () => Date.now() + 3_600_000

// Stands in for main. alpha's renewal never comes: the user switches to beta instead while the step waits for it.
// beta's refresh is answered with beta's next JWT.
const heard: DynWorkSync.Refresh[] = []
const switched = Promise.withResolvers<void>()
const listening = new AbortController()
const listen = client.listen(
  {
    refresh: (event) => {
      heard.push(event)
      if (event.instance === "alpha")
        void client
          .apply({
            instance: betaInstance,
            manifest: alpha,
            jwt: token("beta-one"),
            expiresAt: hour(),
            gateway: { label: "Beta", models },
          })
          .then(() => switched.resolve())
      if (event.instance === "beta")
        void client.token({ instance: betaInstance, jwt: token("beta-two"), expiresAt: hour() })
    },
    rejected: () => {},
  },
  listening.signal,
)

afterAll(async () => {
  listening.abort()
  await listen
  await service.stop()
  alphaGateway.server.stop(true)
  betaGateway.server.stop(true)
})

beforeAll(async () => {
  // alpha's JWT is inside the renewal skew: the first call of a step waits for main to push a newer one.
  await client.apply({
    instance: alphaInstance,
    manifest: alpha,
    jwt: token("alpha-expiring"),
    expiresAt: Date.now() + 1_000,
    gateway: { label: "Alpha", models },
  })
})

test("a switch during a JWT renewal never sends the new instance's JWT to the old gateway", async () => {
  const created = await service.post("/api/session", {
    location: { directory: project },
    title: "switch test",
    model: { id: "claude-sonnet-5-5", providerID: "systemprompt" },
  })
  expect(created.status).toBe(200)
  const id: string = created.body.data.id
  expect((await service.post(`/api/session/${id}/prompt`, { text: "ping" }, project)).status).toBe(200)
  const waited = await fetch(
    `${service.url}/api/experimental/session/${id}/wait?location[directory]=${encodeURIComponent(project)}`,
    { method: "POST", headers: service.headers },
  )
  expect(waited.status).toBe(204)
  await switched.promise
  const messages = JSON.stringify(await service.get(`/api/session/${id}/message`, project))

  expect(heard[0]).toEqual({ instance: "alpha", reason: "expired" })
  // The call that waited on alpha went to alpha's gateway without any JWT: alpha's expired and beta's both withheld.
  expect(alphaGateway.sent()).toEqual([null])
  expect(
    alphaGateway.seen.some((value) => value?.includes(token("beta-one")) || value?.includes(token("beta-two"))),
  ).toBe(false)
  // The retry follows the instance that is current then: beta's gateway, with beta's JWTs only, and the step succeeds.
  expect(betaGateway.sent().length).toBeGreaterThan(0)
  expect(betaGateway.sent().every((value) => value === token("beta-one") || value === token("beta-two"))).toBe(true)
  expect(messages).toContain("pong")
}, 60_000)
