import { afterAll, beforeAll, expect, test } from "bun:test"
import { DynWorkSyncClient } from "../src/client"
import { DynWorkDocuments } from "../src/documents"
import type { DynWorkSync } from "../src/contract"
import { alpha } from "./fixture"
import { boot, until } from "./service"

// The agent's documents in a real OpenCode service: a real Session step against a fake instance that serves the
// gateway's `/v1/messages` and a `documents` MCP server, and records what arrives. The model creates a document first
// directly and then inside a Code Mode program; this test plays main, answering the plugin's asks and listening to its
// touches, and checks what the MCP server received.

const gateway: Array<{ tools: string[]; results: number }> = []
// What the model's Code Mode program does in the next Session.
const program = { code: "" }
const mcp: Array<{ method: string; arguments?: Record<string, unknown>; name?: string; auth?: string }> = []

const rpcResult = (id: unknown, result: unknown) => Response.json({ jsonrpc: "2.0", id, result })

const instance = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    const url = new URL(request.url)
    if (url.pathname === "/api/v1/mcp/documents/mcp") {
      // Streamable HTTP's optional event stream and session end: this server has neither.
      if (request.method !== "POST") return new Response(null, { status: 405 })
      const call: { id?: unknown; method: string; params?: { name?: string; arguments?: Record<string, unknown> } } =
        await request.json()
      mcp.push({
        method: call.method,
        name: call.params?.name,
        arguments: call.params?.arguments,
        auth: request.headers.get("authorization") ?? undefined,
      })
      if (call.method === "initialize")
        return rpcResult(call.id, {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "documents", version: "0" },
        })
      if (call.method === "tools/list")
        return rpcResult(call.id, {
          tools: ["documents_create", "documents_edit", "documents_upload"].map((name) => ({
            name,
            description: `The ${name} tool.`,
            inputSchema: { type: "object", properties: {}, additionalProperties: true },
          })),
        })
      if (call.method === "tools/call") {
        if (call.params?.arguments?.name === "missing.md")
          return rpcResult(call.id, { isError: true, content: [{ type: "text", text: "no such folder" }] })
        const output =
          call.params?.name === "documents_upload"
            ? { mode: "inline", blob_ref: "blob-1", mime: "text/html" }
            : { document_id: `doc-${mcp.length}`, revision_id: `rev-${mcp.length}`, format: "markdown" }
        return rpcResult(call.id, { content: [{ type: "text", text: "done" }], structuredContent: output })
      }
      return new Response(null, { status: 202 })
    }
    if (url.pathname !== "/v1/messages") return new Response("not found", { status: 404 })
    const body: { model: string; tools?: Array<{ name: string }>; messages: Array<{ content: unknown }> } =
      await request.json()
    const results = JSON.stringify(body.messages).split("tool_result").length - 1
    gateway.push({ tools: (body.tools ?? []).map((tool) => tool.name), results })
    return new Response(results > 0 ? text(body.model) : tool(body.model, "execute", { code: program.code }), {
      headers: { "content-type": "text/event-stream" },
    })
  },
})

function sse(events: ReadonlyArray<readonly [string, unknown]>) {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("")
}

const start = (model: string) =>
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
  ] as const

function tool(model: string, name: string, input: unknown) {
  return sse([
    start(model),
    [
      "content_block_start",
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_docs_1", name, input: {} },
      },
    ],
    [
      "content_block_delta",
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
      },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } }],
    ["message_stop", { type: "message_stop" }],
  ])
}

function text(model: string) {
  return sse([
    start(model),
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
    ["message_stop", { type: "message_stop" }],
  ])
}

const service = await boot({}, { enabled_providers: ["systemprompt"], permission: "allow" })
const client = DynWorkSyncClient.make(() => ({ url: service.url, headers: service.headers }))
const [project] = service.projects as [string]
const jwt = "eyJhbGciOiJSUzI1NiJ9.dXNlcg.c2ln"
const models = [
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", api: "messages" },
] satisfies DynWorkSync.Gateway["models"]

// Main: it answers each ask with a folder and a message, and keeps each touch.
const asks: DynWorkDocuments.Ask[] = []
const touches: DynWorkDocuments.Touch[] = []
const listening = new AbortController()

afterAll(async () => {
  listening.abort()
  await service.stop()
  instance.stop(true)
})

beforeAll(async () => {
  await client.apply({
    instance: { key: "alpha", url: instance.url.origin },
    manifest: {
      ...alpha,
      managed_mcp_servers: [
        { id: "documents", name: "documents", url: `${instance.url.origin}/api/v1/mcp/documents/mcp` },
      ],
    },
    jwt,
    expiresAt: Date.now() + 3_600_000,
    gateway: { label: "Alpha", models },
  })
  const types = ["ask", "touch"].map((name) => `types=rpc.${DynWorkDocuments.id}.${name}`).join("&")
  const events = await fetch(`${service.url}/api/event?${types}`, {
    headers: { ...service.headers, accept: "text/event-stream" },
    signal: listening.signal,
  })
  void (async () => {
    const decoder = new TextDecoder()
    for await (const chunk of events.body!) {
      for (const line of decoder.decode(chunk, { stream: true }).split("\n")) {
        if (!line.startsWith("data:")) continue
        const event: { type: string; data: never } = JSON.parse(line.slice(5))
        if (event.type.endsWith(".ask")) {
          asks.push(event.data)
          const ask: DynWorkDocuments.Ask = event.data
          await fetch(`${service.url}/api/rpc/${DynWorkDocuments.id}/answer`, {
            method: "POST",
            headers: { ...service.headers, "content-type": "application/json" },
            body: JSON.stringify({ input: { id: ask.id, folder: "folder-chat", message: "Chat by DynWork" } }),
          })
        }
        if (event.type.endsWith(".touch")) touches.push(event.data)
      }
    }
  })().catch(() => undefined)
})

// One Session whose model runs `code` as a Code Mode program, and the calls the MCP server received from it.
async function run(code: string) {
  program.code = code
  const before = mcp.filter((entry) => entry.method === "tools/call").length
  const created = await service.post("/api/session", {
    location: { directory: project },
    title: "documents test",
    model: { id: "claude-sonnet-5-5", providerID: "systemprompt" },
  })
  const id: string = created.body.data.id
  expect((await service.post(`/api/session/${id}/prompt`, { text: "make a plan" }, project)).status).toBe(200)
  const waited = await fetch(
    `${service.url}/api/experimental/session/${id}/wait?location[directory]=${encodeURIComponent(project)}`,
    { method: "POST", headers: service.headers },
  )
  expect(waited.status).toBe(204)
  return { id, calls: mcp.filter((entry) => entry.method === "tools/call").slice(before) }
}

const create = `await tools.documents.documents_create({ template_id: "blank-markdown", name: "Plan.md" })`

test("a document a Code Mode program creates is given the conversation's folder and message, and main hears of it", async () => {
  const done = await run(`return ${create}`)
  expect(done.calls).toEqual([
    expect.objectContaining({
      name: "documents_create",
      arguments: {
        template_id: "blank-markdown",
        name: "Plan.md",
        folder_id: "folder-chat",
        message: "Chat by DynWork",
      },
    }),
  ])
  // The MCP tools are the program's, not the model's: no direct tool carries them.
  expect(gateway.at(-1)?.tools).toContain("execute")
  expect(gateway.at(-1)?.tools).not.toContain("documents_documents_create")
  expect(asks.at(-1)).toMatchObject({ session: done.id, verb: "create" })
  await until(
    async () => touches.length,
    (count) => count > 0,
  )
  expect(touches.at(-1)).toMatchObject({
    session: done.id,
    verb: "create",
    output: { document_id: expect.any(String), revision_id: expect.any(String), format: "markdown" },
  })
}, 60_000)

test("a folder the program names stays, and its message is signed after its own", async () => {
  const done = await run(
    `return await tools.documents.documents_create({ template_id: "blank-markdown", name: "Plan.md", folder_id: "mine", message: "Draft the plan" })`,
  )
  expect(done.calls[0]?.arguments).toEqual({
    template_id: "blank-markdown",
    name: "Plan.md",
    folder_id: "mine",
    message: "Draft the plan (Chat by DynWork)",
  })
}, 60_000)

test("an edit is signed but gets no folder, and several writes of one program are each asked about", async () => {
  const asked = asks.length
  const done = await run(
    `return await Promise.all([tools.documents.documents_edit({ document_id: "d1", ops: [] }), tools.documents.documents_create({ template_id: "blank-markdown", name: "B.md" })])`,
  )
  const byName = Object.fromEntries(done.calls.map((entry) => [entry.name, entry.arguments]))
  expect(byName.documents_edit).toEqual({ document_id: "d1", ops: [], message: "Chat by DynWork" })
  expect(byName.documents_create).toMatchObject({ folder_id: "folder-chat", message: "Chat by DynWork" })
  expect(asks.length - asked).toBe(2)
}, 60_000)

test("an upload is heard with the blob to import, and a write that fails is not heard at all", async () => {
  const heard = touches.length
  const asked = asks.length
  await run(
    `await tools.documents.documents_upload({ name: "page.html", mime: "text/html", content_base64: "PHA+PC9wPg==" }); try { await tools.documents.documents_create({ template_id: "blank-markdown", name: "missing.md" }) } catch (error) { return "failed" }`,
  )
  await until(
    async () => touches.length,
    (count) => count > heard,
  )
  // Past what the upload said, nothing else arrives.
  await Bun.sleep(300)
  expect(touches.slice(heard)).toMatchObject([
    {
      verb: "upload",
      input: { name: "page.html", mime: "text/html" },
      output: { blob_ref: "blob-1", mime: "text/html" },
    },
  ])
  // The upload carries no message and no folder, so only the creation that failed was asked about.
  expect(asks.slice(asked).map((ask) => ask.verb)).toEqual(["create"])
}, 60_000)

test("the agent is told about the server in the service's AGENTS.md, after the instance's own rules", async () => {
  const rules = await Bun.file(`${service.config}/AGENTS.md`).text()
  expect(rules).toContain("## Documents in Dynwork")
  expect(rules).toContain("documents_upload")
  expect(rules.indexOf("alpha conventions")).toBeLessThan(rules.indexOf("Documents in Dynwork"))
})
