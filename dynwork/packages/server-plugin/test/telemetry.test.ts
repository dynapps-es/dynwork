import { afterAll, beforeEach, expect, test } from "bun:test"
import { DynWorkTelemetry } from "../src/telemetry"
import { alpha, apply } from "./fixture"

// The governance telemetry of the bridge's `systemprompt-hooks.js`, ported: the v5 session id, which plugin reports,
// the hook token minted like the bridge's proxy mints it, the event bodies, and the session stamp on model calls.
// A fake instance answers the bridge's OAuth client, token and track routes as the local 0.76 harness does.

const calls: Array<{ path: string; headers: Record<string, string>; body: string }> = []
const state = { secret: "secret-1", refuseMint: 0, trackStatus: 200, trackDelay: 0 }
const instance = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    const url = new URL(request.url)
    const body = await request.text()
    calls.push({ path: `${url.pathname}${url.search}`, headers: Object.fromEntries(request.headers), body })
    if (url.pathname === "/v1/auth/bridge/oauth-client") {
      if (request.headers.get("authorization") !== "Bearer user-jwt") return new Response("no", { status: 401 })
      state.secret = `secret-${calls.length}`
      return Response.json({
        client_id: "bridge:user",
        client_secret: state.secret,
        scopes: ["hook:govern", "hook:track"],
        token_endpoint: "http://127.0.0.1:1/api/v1/core/oauth/token",
      })
    }
    if (url.pathname === "/api/v1/core/oauth/token") {
      const form = new URLSearchParams(body)
      if (state.refuseMint > 0 || form.get("client_secret") !== state.secret) {
        state.refuseMint -= 1
        return Response.json({ error: "invalid_client" }, { status: 401 })
      }
      return Response.json({
        access_token: `hook-${form.get("plugin_id")}`,
        token_type: "Bearer",
        expires_in: 2_592_000,
        scope: form.get("scope"),
      })
    }
    if (url.pathname === "/api/public/hooks/track") {
      await Bun.sleep(state.trackDelay)
      return new Response(null, { status: state.trackStatus })
    }
    return new Response("not found", { status: 404 })
  },
})
afterAll(() => instance.stop(true))

beforeEach(() => {
  calls.length = 0
  state.refuseMint = 0
  state.trackStatus = 200
  state.trackDelay = 0
})

const base = instance.url.origin
const target = (plugin = "dynapps-commons") => ({ base, plugin, skills: {} })

test("the session id is the bridge's v5 UUID of the native id", () => {
  // uuid.uuid5(UUID("7c1f5b6e-3a2d-4e8f-9b0c-2d6a1e4f8c73"), "ses_123"), the namespace the bridge pins
  expect(DynWorkTelemetry.session("ses_123")).toBe("5de1b7f7-3c8e-5c6a-9885-2317b386feb1")
  expect(DynWorkTelemetry.session("ses_abc123")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

test("only a manifest plugin with hooks.governance reports, with the bridge's skill map", () => {
  const manifest = {
    ...alpha,
    plugins: [
      { id: "alpha-tools", hooks: { governance: false } },
      { id: "dynapps-commons", hooks: { governance: true } },
      { id: "later", hooks: { governance: true } },
    ],
    skills: [
      { id: "who_am_i", name: "Who am I", instructions: "x", plugins: ["dynapps-commons"] },
      { id: "Loose Skill", name: "Loose", instructions: "x" },
      { id: "claude_only", name: "Claude", instructions: "x", hosts: ["claude-code"], plugins: ["alpha-tools"] },
    ],
  }
  expect(DynWorkTelemetry.target(apply(manifest))).toEqual({
    base: "http://127.0.0.1:18101",
    plugin: "dynapps-commons",
    skills: { "who-am-i": "dynapps-commons:who-am-i", "loose-skill": "opencode:loose-skill" },
  })
  expect(
    DynWorkTelemetry.target(apply({ ...manifest, plugins: [{ id: "alpha-tools", hooks: { governance: false } }] })),
  ).toBeUndefined()
  // A cleared host reaches nothing, like the bridge, which writes no hooks plugin for a host it does not sync.
  expect(DynWorkTelemetry.target(apply({ ...manifest, enabled_hosts: [] }))).toBeUndefined()
  // The captured alpha manifest: dynapps-commons owns governance there.
  expect(DynWorkTelemetry.target(apply())?.plugin).toBe("dynapps-commons")
})

test("events go to track with a hook token minted once per plugin, never the user's JWT", async () => {
  const hooks = DynWorkTelemetry.hooks()
  const body = DynWorkTelemetry.lifecycle("session.created", "ses_1", "/work", "evt_1")
  if (!body) throw new Error("no body")
  await DynWorkTelemetry.send(hooks, target(), "user-jwt", body)
  await DynWorkTelemetry.send(hooks, target(), "user-jwt", body)
  await DynWorkTelemetry.send(hooks, target("other"), "user-jwt", body)
  expect(calls.map((call) => call.path)).toEqual([
    "/v1/auth/bridge/oauth-client",
    "/api/v1/core/oauth/token",
    "/api/public/hooks/track?plugin_id=dynapps-commons",
    "/api/public/hooks/track?plugin_id=dynapps-commons",
    "/api/v1/core/oauth/token",
    "/api/public/hooks/track?plugin_id=other",
  ])
  const mint = new URLSearchParams(calls[1]?.body)
  expect(Object.fromEntries(mint)).toMatchObject({
    grant_type: "client_credentials",
    client_id: "bridge:user",
    scope: "hook:govern hook:track",
    audience: "hook",
    plugin_id: "dynapps-commons",
  })
  const track = calls[2]
  expect(track?.headers).toMatchObject({
    authorization: "Bearer hook-dynapps-commons",
    "content-type": "application/json",
    "x-systemprompt-host": "opencode",
    "x-ingestion-event-id": "evt_1",
  })
  expect(JSON.parse(track?.body ?? "")).toEqual({
    hook_event_name: "SessionStart",
    session_id: DynWorkTelemetry.session("ses_1"),
    native_session_id: "ses_1",
    cwd: "/work",
    native_host: "opencode",
    event_id: "evt_1",
  })
  expect(JSON.stringify(calls.slice(2))).not.toContain("user-jwt")
})

test("a refused mint provisions the client again once, like the bridge rotates its secret", async () => {
  const hooks = DynWorkTelemetry.hooks()
  const body = DynWorkTelemetry.lifecycle("session.idle", "ses_2", "/work", "evt_2")
  if (!body) throw new Error("no body")
  await DynWorkTelemetry.send(hooks, target(), "user-jwt", body)
  calls.length = 0
  hooks.tokens.clear()
  state.secret = "rotated-elsewhere"
  await DynWorkTelemetry.send(hooks, target(), "user-jwt", body)
  expect(calls.map((call) => call.path.split("?")[0])).toEqual([
    "/api/v1/core/oauth/token",
    "/v1/auth/bridge/oauth-client",
    "/api/v1/core/oauth/token",
    "/api/public/hooks/track",
  ])
  expect(JSON.parse(calls[3]?.body ?? "").hook_event_name).toBe("Stop")
})

test("errors and a slow instance are swallowed: send never rejects and gives up after 5 s", async () => {
  const hooks = DynWorkTelemetry.hooks()
  const body = DynWorkTelemetry.lifecycle("session.deleted", "ses_3", "/work", "evt_3")
  if (!body) throw new Error("no body")
  state.trackStatus = 500
  expect(await DynWorkTelemetry.send(hooks, target(), "user-jwt", body)).toBeUndefined()
  await expect(DynWorkTelemetry.send(hooks, target(), "bad-jwt", body)).resolves.toBeUndefined()
  await expect(
    DynWorkTelemetry.send(hooks, { ...target(), base: "http://127.0.0.1:9" }, "user-jwt", body),
  ).resolves.toBeUndefined()
  state.trackStatus = 200
  state.trackDelay = 7_000
  const started = Date.now()
  await DynWorkTelemetry.send(hooks, target(), "user-jwt", body)
  expect(Date.now() - started).toBeLessThan(6_500)
}, 15_000)

test("a prompt is reported once per new user message, with the bridge's body", () => {
  const last = new Map<string, string>()
  const messages = [
    { id: "msg_1", role: "user" as const, content: [{ type: "text" as const, text: "first" }] },
    { role: "assistant" as const, content: [{ type: "text" as const, text: "ok" }] },
    { id: "msg_2", role: "user" as const, content: [{ type: "text" as const, text: "line 1" }, { type: "text" as const, text: "line 2" }] },
  ]
  expect(DynWorkTelemetry.prompt(messages, "ses_4", "/work", last)).toEqual({
    hook_event_name: "UserPromptSubmit",
    session_id: DynWorkTelemetry.session("ses_4"),
    native_session_id: "ses_4",
    cwd: "/work",
    prompt: "line 1\nline 2",
    prompt_id: "msg_2",
    native_host: "opencode",
  })
  // The next step of the same turn sees the same latest user message.
  expect(DynWorkTelemetry.prompt([...messages, messages[1]!], "ses_4", "/work", last)).toBeUndefined()
  expect(DynWorkTelemetry.prompt([{ role: "user", content: [{ type: "text", text: "  " }] }], "ses_5", "/w", last)).toBeUndefined()
})

// OpenCode 2's skill tool takes `{ id }`; the bridge's template reads `name`, which that tool never sends, so it reports
// no skill use there. DynWork reads the id (or a `name`) and keeps the bridge's `tool_input: { name }`.
test("every tool completion is reported, a skill with its skill_ref", () => {
  const skills = { "who-am-i": "dynapps-commons:who-am-i" }
  const base = { sessionID: "ses_6", id: "call_1", agent: "build", messageID: "msg_1" }
  expect(
    DynWorkTelemetry.tool(
      { ...base, tool: "bash", input: { command: "ls" }, status: "completed", result: { title: "ls", output: "a", metadata: { exit: 0 } } },
      skills,
      "/work",
    ),
  ).toEqual({
    hook_event_name: "PostToolUse",
    session_id: DynWorkTelemetry.session("ses_6"),
    native_session_id: "ses_6",
    cwd: "/work",
    tool_name: "bash",
    tool_input: { command: "ls" },
    tool_use_id: "call_1",
    tool_response: { title: "ls", output: "a", metadata: { exit: 0 } },
    native_host: "opencode",
  })
  expect(
    DynWorkTelemetry.tool(
      { ...base, tool: "skill", input: { id: "who-am-i", extra: 1 }, status: "completed", result: { title: "t", output: { a: 1 } } },
      skills,
      "/work",
    ),
  ).toMatchObject({ tool_input: { name: "who-am-i" }, tool_response: { output: '{"a":1}' }, skill_ref: "dynapps-commons:who-am-i" })
  expect(
    DynWorkTelemetry.tool({ ...base, tool: "skill", input: { name: "mine" }, status: "error", error: { message: "boom" } }, skills, "/w"),
  ).toMatchObject({ skill_ref: "opencode:mine", tool_response: { output: "boom" } })
  expect(DynWorkTelemetry.tool({ ...base, tool: "skill", input: {}, status: "completed", result: {} }, skills, "/w")).toBeUndefined()
})

test("model calls carry the session in metadata.user_id like the bridge's proxy puts it, and no x-opencode-session", async () => {
  const request = new Request("https://sp.test/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-session": "ses_affinity", "x-session-id": "ses_affinity" },
    body: JSON.stringify({ model: "m", messages: [] }),
  })
  const stamped = await DynWorkTelemetry.stamp(request, "ses_7")
  expect(stamped.headers.get("x-opencode-session")).toBeNull()
  // 0.76 does not reject a session id it did not issue: it is kept as the client's, like the bridge forwards it.
  expect(stamped.headers.get("x-session-id")).toBe("ses_affinity")
  expect(await stamped.json()).toEqual({
    model: "m",
    messages: [],
    metadata: { user_id: JSON.stringify({ session_id: DynWorkTelemetry.session("ses_7") }) },
  })
  const own = new Request("https://sp.test/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ metadata: { user_id: "theirs" } }),
  })
  expect(await (await DynWorkTelemetry.stamp(own, "ses_7")).json()).toEqual({ metadata: { user_id: "theirs" } })
  const text = new Request("https://sp.test/v1/messages", { method: "POST", body: "not json" })
  expect(await (await DynWorkTelemetry.stamp(text, "ses_7")).text()).toBe("not json")
})

// The bridge's proxy strips whatever the hook sent and, when enrolled, re-attaches the device credential and the host
// as the evaluator client kind (`feedback/hooks.rs`); 0.76 refuses `opencode` there (400 "Invalid device host").
test("with the device credential, track carries the bridge proxy's evidence and the client kind", async () => {
  const hooks = DynWorkTelemetry.hooks()
  const body = DynWorkTelemetry.lifecycle("session.created", "ses_8", "/work", "evt_8")
  if (!body) throw new Error("no body")
  await DynWorkTelemetry.send(hooks, target(), "user-jwt", body, "sp_device_held")
  await DynWorkTelemetry.send(hooks, target(), "user-jwt", body)
  const tracks = calls.filter((call) => call.path.startsWith("/api/public/hooks/track"))
  expect(tracks[0]?.headers).toMatchObject({
    "x-systemprompt-device-credential": "sp_device_held",
    "x-systemprompt-host": "open-code",
    authorization: "Bearer hook-dynapps-commons",
  })
  expect(tracks[1]?.headers["x-systemprompt-device-credential"]).toBeUndefined()
  expect(tracks[1]?.headers["x-systemprompt-host"]).toBe("opencode")
  // The credential goes to track only, never to the OAuth client or token routes.
  for (const call of calls.filter((entry) => !entry.path.startsWith("/api/public/hooks/track")))
    expect(JSON.stringify(call)).not.toContain("sp_device_held")
})
