import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { DynWorkSyncClient } from "../src/client"
import { DynWorkDocuments } from "../src/documents"
import type { DynWorkSync } from "../src/contract"
import { alpha } from "./fixture"
import { boot, until } from "./service"

// The agent's documents in a real OpenCode service: a real Session step against a fake instance that serves the
// gateway's `/v1/messages` and a `documents` MCP server, and records what arrives. The model creates a document first
// directly and then inside a Code Mode program; this test plays main, answering the plugin's asks and listening to its
// touches, deciding on its shares as the user would on the card, and checks what the MCP server received.

const gateway: Array<{ tools: string[]; results: number; messages: string }> = []
// What the model does in the next Session: runs `code` as a Code Mode program, or, where Code Mode is off, calls the one
// tool `direct` names.
const program: { code: string; direct?: { name: string; input: unknown } } = { code: "" }
const mcp: Array<{ method: string; arguments?: Record<string, unknown>; name?: string; auth?: string }> = []

const rpcResult = (id: unknown, result: unknown) => Response.json({ jsonrpc: "2.0", id, result })
const refusal = (id: unknown, text: string) => rpcResult(id, { isError: true, content: [{ type: "text", text }] })

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
          tools: [
            "documents_create",
            "documents_edit",
            "documents_upload",
            "documents_share",
            "documents_people",
            "documents_comment",
            "documents_folder",
          ].map(
            (name) => ({
              name,
              description: `The ${name} tool.`,
              inputSchema: { type: "object", properties: {}, additionalProperties: true },
            }),
          ),
        })
      if (call.method === "tools/call") {
        if (call.params?.arguments?.name === "missing.md")
          return rpcResult(call.id, { isError: true, content: [{ type: "text", text: "no such folder" }] })
        // 0.84's refusals, in the words the instance writes them.
        if (call.params?.name === "documents_folder" && call.params.arguments?.name === "Artifacts")
          return refusal(
            call.id,
            `a folder named "Artifacts" already exists there; choose another name or use that folder`,
          )
        if (call.params?.arguments?.name === "stale.md")
          return refusal(
            call.id,
            `context ${String(call.params.arguments.context_id)} is not one of your conversations: send the id of a conversation you own (POST /api/v1/core/contexts creates one), or none to write without one`,
          )
        if (call.params?.name === "documents_people")
          return rpcResult(call.id, {
            content: [{ type: "text", text: "1 people" }],
            structuredContent: { people: [{ user_id: "e51c808f-1", name: "Jesús Pérez", email: "jesus@dynapps.es" }] },
          })
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
    gateway.push({
      tools: (body.tools ?? []).map((tool) => tool.name),
      results,
      messages: JSON.stringify(body.messages),
    })
    const call = program.direct
      ? tool(body.model, program.direct.name, program.direct.input)
      : tool(body.model, "execute", { code: program.code })
    return new Response(results > 0 ? text(body.model) : call, {
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
const jwt = "eyJhbGciOiJSUzI1NiJ9.dXNlcg.c2ln"
const models = [
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", api: "messages" },
] satisfies DynWorkSync.Gateway["models"]
type Service = typeof service

// Main: it answers each ask with a folder and a message, keeps each touch, says what became of each page it imports as
// `main.imports` says, and decides each share as `decision` says.
const asks: DynWorkDocuments.Ask[] = []
const touches: DynWorkDocuments.Touch[] = []
const confirms: DynWorkDocuments.Share[] = []
const seen: DynWorkDocuments.Seen[] = []
const stales: DynWorkDocuments.Stale[] = []
const decision = { allow: false, listening: true }
// On 0.84 main gives each write its conversation's context: here `ctx-<session>`. A page main imports becomes
// `doc-page`, fails with the instance's refusal, or main says nothing.
const main: { contexts: boolean; imports: "imported" | "failed" | "mute" } = { contexts: false, imports: "imported" }
const answerOf = (ask: DynWorkDocuments.Ask): DynWorkDocuments.Answer =>
  ask.verb === "folder" && ask.making
    ? { id: ask.id, name: "Chat" }
    : ask.verb === "folder"
    ? { id: ask.id, folder: `folder-${ask.name}` }
    : {
        id: ask.id,
        folder: "folder-chat",
        message: "Chat by DynWork",
        ...(main.contexts ? { context: `ctx-${ask.session}` } : {}),
      }
const importOf = (touch: DynWorkDocuments.Touch): DynWorkDocuments.Imported =>
  main.imports === "imported"
    ? { id: touch.call, document: "doc-page", name: touch.input.name }
    : { id: touch.call, failure: "The instance refused the page: it is larger than the Drive takes." }
const listening = new AbortController()

afterAll(async () => {
  listening.abort()
  await service.stop()
  instance.stop(true)
})

const manifest = {
  ...alpha,
  managed_mcp_servers: [{ id: "documents", name: "documents", url: `${instance.url.origin}/api/v1/mcp/documents/mcp` }],
}

beforeAll(async () => {
  await client.apply({
    instance: { key: "alpha", url: instance.url.origin },
    manifest,
    jwt,
    expiresAt: Date.now() + 3_600_000,
    gateway: { label: "Alpha", models },
  })
  await listen(service)
})

// Plays main on a service: follows the plugin's events and answers them over its RPC.
async function listen(on: Service) {
  const types = ["ask", "touch", "confirm", "people", "stale"]
    .map((name) => `types=rpc.${DynWorkDocuments.id}.${name}`)
    .join("&")
  const events = await fetch(`${on.url}/api/event?${types}`, {
    headers: { ...on.headers, accept: "text/event-stream" },
    signal: listening.signal,
  })
  const rpc = (method: string, input: unknown) =>
    fetch(`${on.url}/api/rpc/${DynWorkDocuments.id}/${method}`, {
      method: "POST",
      headers: { ...on.headers, "content-type": "application/json" },
      body: JSON.stringify({ input }),
    })
  void (async () => {
    const decoder = new TextDecoder()
    for await (const chunk of events.body!) {
      for (const line of decoder.decode(chunk, { stream: true }).split("\n")) {
        if (!line.startsWith("data:")) continue
        const event: { type: string; data: never } = JSON.parse(line.slice(5))
        if (event.type.endsWith(".ask")) {
          asks.push(event.data)
          await rpc("answer", answerOf(event.data))
        }
        if (event.type.endsWith(".touch")) {
          const touch: DynWorkDocuments.Touch = event.data
          touches.push(touch)
          if (touch.verb === "upload" && main.imports !== "mute") await rpc("imported", importOf(touch))
        }
        if (event.type.endsWith(".people")) seen.push(event.data)
        if (event.type.endsWith(".stale")) stales.push(event.data)
        if (event.type.endsWith(".confirm")) {
          const share: DynWorkDocuments.Share = event.data
          confirms.push(share)
          // Main gone: nothing says the card is up, and nothing decides.
          if (!decision.listening) continue
          await rpc("shown", { id: share.id })
          await rpc("decide", { id: share.id, allow: decision.allow })
        }
      }
    }
  })().catch(() => undefined)
}

// One Session on a service (the one booted first unless named) whose model runs `code` as a Code Mode program, or the
// direct call `program.direct` names, and the calls the MCP server received from it.
async function run(code: string, session?: string, on: Service = service) {
  program.code = code
  const [project] = on.projects as [string]
  const before = mcp.filter((entry) => entry.method === "tools/call").length
  const created = await on.post("/api/session", {
    ...(session === undefined ? {} : { id: session }),
    location: { directory: project },
    title: "documents test",
    model: { id: "claude-sonnet-5-5", providerID: "systemprompt" },
  })
  const id: string = created.body.data.id
  expect((await on.post(`/api/session/${id}/prompt`, { text: "make a plan" }, project)).status).toBe(200)
  const waited = await fetch(
    `${on.url}/api/experimental/session/${id}/wait?location[directory]=${encodeURIComponent(project)}`,
    { method: "POST", headers: on.headers },
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

// The page the agent uploads on a 0.82 or 0.83 instance: DynWork imports it, and the agent reads what became of it in
// the upload's own result, in the same turn (Aylen's run, 20-11: two uploads, no document, nobody told).
const page = `tools.documents.documents_upload({ name: "minusval-cuadro-planificacion.html", mime: "text/html", content_base64: "PGgxPkRhc2g8L2gxPg==" })`

describe("a page the agent uploads", () => {
  afterAll(() => {
    main.imports = "imported"
  })

  test("from a Code Mode program waits for DynWork's import, and the program reads which document it became", async () => {
    main.imports = "imported"
    const heard = touches.length
    await run(`return await ${page}`)
    expect(touches.slice(heard)).toMatchObject([{ verb: "upload", output: { blob_ref: "blob-1" } }])
    expect(gateway.at(-1)?.messages).toContain(
      "Dynwork imported this page as the document minusval-cuadro-planificacion.html (document_id doc-page)",
    )
  }, 60_000)

  test("whose import fails tells the agent in the same turn what failed and where the user retries it", async () => {
    main.imports = "failed"
    await run(`return await ${page}`)
    const read = gateway.at(-1)?.messages ?? ""
    expect(read).toContain(
      "Dynwork could not import this page as a document: The instance refused the page: it is larger than the Drive takes.",
    )
    expect(read).toContain("retry the import from the conversation's Artifacts tab")
  }, 60_000)

  describe("called directly, where Code Mode is off", () => {
    const direct = { value: undefined as Service | undefined }

    beforeAll(async () => {
      direct.value = await boot(
        {},
        {
          enabled_providers: ["systemprompt"],
          permission: "allow",
          permissions: [{ action: "execute", resource: "*", effect: "deny" }],
        },
      )
      const on = direct.value
      await DynWorkSyncClient.make(() => ({ url: on.url, headers: on.headers })).apply({
        instance: { key: "alpha", url: instance.url.origin },
        manifest,
        jwt,
        expiresAt: Date.now() + 3_600_000,
        gateway: { label: "Alpha", models },
      })
      await listen(on)
    }, 60_000)

    afterAll(async () => {
      program.direct = undefined
      await direct.value?.stop()
    })

    test("is heard, imported and said to the agent the same way", async () => {
      main.imports = "imported"
      program.direct = {
        name: "documents_documents_upload",
        input: { name: "direct.html", mime: "text/html", content_base64: "PGgxPkRhc2g8L2gxPg==" },
      }
      const heard = touches.length
      const done = await run("", undefined, direct.value)
      expect(gateway.at(-1)?.tools).toContain("documents_documents_upload")
      expect(gateway.at(-1)?.tools).not.toContain("execute")
      expect(touches.slice(heard)).toMatchObject([
        { session: done.id, verb: "upload", input: { name: "direct.html" }, output: { blob_ref: "blob-1" } },
      ])
      expect(gateway.at(-1)?.messages).toContain(
        "Dynwork imported this page as the document direct.html (document_id doc-page)",
      )
    }, 60_000)
  })
})

test("the agent is told about the server in the service's AGENTS.md, after the instance's own rules", async () => {
  const rules = await Bun.file(`${service.config}/AGENTS.md`).text()
  expect(rules).toContain("## Documents in Dynwork")
  expect(rules).toContain("documents_upload")
  expect(rules.indexOf("alpha conventions")).toBeLessThan(rules.indexOf("Documents in Dynwork"))
})

const share = `tools.documents.documents_share({ document_id: "d1", subject_kind: "user", subject_value: "user-luis", level: "edit" })`
// The program returns what the call threw, so the model's next request carries it as the program's result.
const caught = `try { return await ${share} } catch (error) { return "threw: " + (error?.message ?? String(error)) }`
const shared = () => mcp.filter((entry) => entry.method === "tools/call" && entry.name === "documents_share")

test("a share the user rejects never reaches the instance, and the agent reads what the user declined", async () => {
  decision.allow = false
  const before = shared().length
  const done = await run(caught)
  expect(confirms.at(-1)).toMatchObject({
    session: done.id,
    kind: "grant",
    document: "d1",
    subject: { kind: "user", value: "user-luis" },
    level: "edit",
  })
  expect(shared().length).toBe(before)
  expect(gateway.at(-1)?.messages).toContain("The user declined to share document d1 with user user-luis (edit)")
}, 60_000)

test("a share the user allows reaches the instance as the agent wrote it", async () => {
  decision.allow = true
  const confirmed = confirms.length
  const done = await run(`return await ${share}`)
  expect(confirms.length - confirmed).toBe(1)
  expect(done.calls).toEqual([
    expect.objectContaining({
      name: "documents_share",
      arguments: { document_id: "d1", subject_kind: "user", subject_value: "user-luis", level: "edit" },
    }),
  ])
}, 60_000)

test("a share in a scheduled task's run is refused at once, with no card", async () => {
  decision.allow = true
  const confirmed = confirms.length
  const before = shared().length
  await run(caught, `ses_aut_dynwork_${crypto.randomUUID().replaceAll("-", "")}`)
  expect(confirms.length).toBe(confirmed)
  expect(shared().length).toBe(before)
  expect(gateway.at(-1)?.messages).toContain("nobody is there to answer in a scheduled task")
}, 60_000)

test("a person the program looked up shows on the card by name and email", async () => {
  decision.allow = false
  await run(
    `await tools.documents.documents_people({ query: "jes" }); try { return await tools.documents.documents_share({ document_id: "d1", subject_kind: "user", subject_value: "e51c808f-1", level: "view" }) } catch (error) { return "threw" }`,
  )
  expect(confirms.at(-1)?.subject).toEqual({
    kind: "user",
    value: "e51c808f-1",
    name: "Jesús Pérez",
    email: "jesus@dynapps.es",
  })
  // Main hears whom the lookup found, to keep them for the account.
  await until(
    async () => seen.length,
    (count) => count > 0,
  )
  expect(seen.at(-1)).toEqual({ people: [{ user_id: "e51c808f-1", name: "Jesús Pérez", email: "jesus@dynapps.es" }] })
}, 60_000)

test("a share nobody in Dynwork hears is refused, not left waiting", async () => {
  decision.listening = false
  const before = shared().length
  await run(caught)
  decision.listening = true
  expect(shared().length).toBe(before)
  expect(gateway.at(-1)?.messages).toContain("Dynwork could not ask the user to confirm this share")
}, 60_000)

// 0.84: main applies the instance's switches, and the agent's calls and rules follow them.
describe("on a 0.84 instance", () => {
  const at84 = { rawHtmlByMcp: true, mcpFolders: true, contextByMcp: true, peopleByRest: true }

  beforeAll(async () => {
    main.contexts = true
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
      documents: at84,
    })
  })

  test("the agent reads the 0.84 rules in the service's AGENTS.md", async () => {
    const rules = await Bun.file(`${service.config}/AGENTS.md`).text()
    expect(rules).toContain("documents_folder {action: create, name, parent_id}")
    expect(rules).toContain("leave out context_id")
    expect(rules).not.toContain("look them up with documents_people")
  })

  test("each write carries its own conversation's context, never another's, and the agent's own is dropped", async () => {
    const code = `await tools.documents.documents_create({ template_id: "blank-markdown", name: "A.md", context_id: "ctx-ses_other" }); return await tools.documents.documents_comment({ action: "create", document_id: "d1", body: "Looks good", context_id: "ctx-ses_other" })`
    const first = await run(code)
    const second = await run(code)
    for (const done of [first, second]) {
      expect(done.calls.map((call) => [call.name, call.arguments?.context_id])).toEqual([
        ["documents_create", `ctx-${done.id}`],
        ["documents_comment", `ctx-${done.id}`],
      ])
      // A comment is not signed and gets no folder: only the conversation.
      expect(done.calls[1]?.arguments).toEqual({
        action: "create",
        document_id: "d1",
        body: "Looks good",
        context_id: `ctx-${done.id}`,
      })
    }
    expect(first.id).not.toBe(second.id)
  }, 60_000)

  test("a comment read is not asked about and goes as the agent wrote it", async () => {
    const asked = asks.length
    const done = await run(`return await tools.documents.documents_comment({ action: "list", document_id: "d1" })`)
    expect(asks.length).toBe(asked)
    expect(done.calls[0]?.arguments).toEqual({ action: "list", document_id: "d1" })
  }, 60_000)

  test("a folder refused as name_taken reaches the agent with the folder to use", async () => {
    await run(
      `try { return await tools.documents.documents_folder({ action: "create", name: "Artifacts" }) } catch (error) { return "threw: " + (error?.message ?? String(error)) }`,
    )
    expect(asks.at(-1)).toMatchObject({ verb: "folder", name: "Artifacts" })
    expect(gateway.at(-1)?.messages).toContain("It is folder_id folder-Artifacts: use that folder.")
  }, 60_000)

  test("a folder the agent makes inside another takes the name main gives it, and main hears it under that name", async () => {
    const done = await run(
      `return await tools.documents.documents_folder({ action: "create", name: "VAT analysis", parent_id: "f-bill" })`,
    )
    expect(asks.at(-1)).toMatchObject({ verb: "folder", name: "VAT analysis", parent: "f-bill", making: true })
    expect(done.calls.map((call) => [call.name, call.arguments?.name])).toEqual([["documents_folder", "Chat"]])
    await until(
      async () => touches.filter((touch) => touch.session === done.id && touch.verb === "folder"),
      (found) => found.length > 0,
    )
    expect(touches.findLast((touch) => touch.session === done.id)?.input).toMatchObject({ name: "Chat", parent_id: "f-bill" })
  }, 60_000)

  test("a page uploaded is the agent's to import with documents_import: the upload waits for nothing", async () => {
    main.imports = "mute"
    const heard = touches.length
    await run(`return await ${page}`)
    main.imports = "imported"
    expect(touches.slice(heard)).toMatchObject([{ verb: "upload" }])
    // An upload that waited for main's word, which a mute main never gives, would read that it was not confirmed.
    expect(gateway.at(-1)?.messages).not.toContain("Dynwork did not confirm")
    expect(gateway.at(-1)?.messages).not.toContain("Dynwork imported this page")
  }, 60_000)

  test("a write refused for a context the instance does not know tells main which one to forget", async () => {
    const done = await run(
      `try { return await tools.documents.documents_create({ template_id: "blank-markdown", name: "stale.md" }) } catch (error) { return "threw" }`,
    )
    await until(
      async () => stales.length,
      (count) => count > 0,
    )
    expect(stales.at(-1)).toEqual({ session: done.id, context: `ctx-${done.id}` })
  }, 60_000)
})
