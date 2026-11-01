import { afterAll, expect, test } from "bun:test"
import { mkdir, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { DynWorkSyncClient } from "../../src/client"
import type { DynWorkSync } from "../../src/contract"
import { alpha } from "../fixture"
import { boot, until } from "../service"

// The instance's rules in a real OpenCode service, with real Session steps against a fake gateway that records what
// each model call carries. DynWork's own service (OPENCODE_CONFIG_DIR set) gets them in its global AGENTS.md, which
// OpenCode watches and loads by itself; a service without it gets them in the system context and no file.

const token = "eyJhbGciOiJSUzI1NiJ9.cnVsZXM.c2ln"

// Every model call's system text and the rest of its body.
const requests: Array<{ system: string; body: string }> = []
const gateway = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    if (new URL(request.url).pathname !== "/v1/messages") return new Response("not found", { status: 404 })
    const body: { model: string; system?: string | Array<{ text: string }> } = await request.json()
    const system =
      typeof body.system === "string" ? body.system : (body.system ?? []).map((part) => part.text).join("\n")
    requests.push({ system, body: JSON.stringify({ ...body, system: undefined }) })
    return new Response(stream(body.model), { headers: { "content-type": "text/event-stream" } })
  },
})

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

// DynWork's service watches its config dir, as the packaged build does. The other one stands for a service whose
// config dir is the user's: no OPENCODE_CONFIG_DIR, so OpenCode uses XDG_CONFIG_HOME/opencode.
const own = await boot({ OPENCODE_DISABLE_FILEWATCHER: "false" }, { enabled_providers: ["systemprompt"] })
const shared = await boot({ OPENCODE_CONFIG_DIR: undefined }, { enabled_providers: ["systemprompt"] })

afterAll(async () => {
  await Promise.all([own.stop(), shared.stop()])
  gateway.stop(true)
})

const models = [
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", api: "messages" },
] satisfies DynWorkSync.Gateway["models"]
const rule = (id: string, name: string, instructions: string) => ({ id, name, instructions })
const manifest = (rules: DynWorkSync.Manifest["rules"]) => ({ ...alpha, rules, managed_mcp_servers: [] })
const alphaRules = manifest(
  [
    rule("b_style", "Style", "  Prefer short sentences: ALPHA-STYLE.\n"),
    rule("a_language", "Language", "Answer in English: ALPHA-LANGUAGE."),
    rule("c_other", "Other host", "Never applied: ALPHA-OTHER."),
  ].map((entry) => (entry.id === "c_other" ? { ...entry, hosts: ["claude-code"] } : entry)),
)
const betaRules = manifest([rule("only", "Beta only", "Beta's one rule: BETA-ONLY.")])

const apply = (service: Awaited<ReturnType<typeof boot>>, key: string, content: DynWorkSync.Manifest) =>
  DynWorkSyncClient.make(() => ({ url: service.url, headers: service.headers })).apply({
    instance: { key, url: gateway.url.origin },
    manifest: content,
    jwt: token,
    expiresAt: Date.now() + 3_600_000,
    gateway: { label: key, models },
  })

// One step in a new Session: returns what its model call carried.
const step = async (service: Awaited<ReturnType<typeof boot>>) => {
  const [project] = service.projects as [string]
  const created = await service.post("/api/session", {
    location: { directory: project },
    title: "rules test",
    model: { id: "claude-sonnet-5-5", providerID: "systemprompt" },
  })
  expect(created.status).toBe(200)
  const id: string = created.body.data.id
  requests.length = 0
  expect((await service.post(`/api/session/${id}/prompt`, { text: "ping" }, project)).status).toBe(200)
  const waited = await fetch(
    `${service.url}/api/experimental/session/${id}/wait?location[directory]=${encodeURIComponent(project)}`,
    { method: "POST", headers: service.headers },
  )
  expect(waited.status).toBe(204)
  expect(requests).toHaveLength(1)
  return requests[0] ?? { system: "", body: "" }
}

const count = (text: string, part: string) => text.split(part).length - 1
// OpenCode reloads the file when its watcher reports the change: steps run until one carries what is expected.
const settled = (
  service: Awaited<ReturnType<typeof boot>>,
  check: (request: { system: string; body: string }) => boolean,
) => until(() => step(service), check)

const file = path.join(own.config, "AGENTS.md")
const user = "# My own notes\n\nKeep this line: USER-NOTE.\n"
const block = (rules: string) =>
  `<!-- systemprompt:begin (managed by DynWork; edits are replaced) -->\n\n${rules}\n<!-- systemprompt:end -->\n`
const alphaBlock = block(
  "## Language\n\nAnswer in English: ALPHA-LANGUAGE.\n\n## Style\n\nPrefer short sentences: ALPHA-STYLE.",
)

test("apply writes the rules into DynWork's AGENTS.md, after the user's own content", async () => {
  // The Location loads before the file changes, so the rules can only arrive through OpenCode's watcher.
  await own.get("/api/agent", own.projects[0] ?? "")
  await mkdir(own.config, { recursive: true })
  await writeFile(file, user)
  expect(await apply(own, "alpha", alphaRules)).toMatchObject({ rules: 2 })
  expect(await Bun.file(file).text()).toBe(`${user}\n${alphaBlock}`)
  const request = await settled(own, (value) => value.system.includes("ALPHA-STYLE"))
  // Once, from the file: the context hook does not add them again.
  expect(count(request.system, "ALPHA-LANGUAGE")).toBe(1)
  expect(count(request.system, "ALPHA-STYLE")).toBe(1)
  expect(count(request.system, "USER-NOTE")).toBe(1)
  expect(request.system).not.toContain("ALPHA-OTHER")
  expect(request.body).not.toContain("ALPHA-")
}, 60_000)

test("switching replaces the block and keeps the user's content", async () => {
  expect(await apply(own, "beta", betaRules)).toMatchObject({ rules: 1 })
  expect(await Bun.file(file).text()).toBe(`${user}\n${block("## Beta only\n\nBeta's one rule: BETA-ONLY.")}`)
  const request = await settled(own, (value) => value.system.includes("BETA-ONLY"))
  expect(count(request.system, "BETA-ONLY")).toBe(1)
  expect(request.system).not.toContain("ALPHA-")
  expect(count(request.system, "USER-NOTE")).toBe(1)
}, 60_000)

// A cleared service has no gateway provider to run a step on: an instance without rules brings it back, and its apply
// leaves the file as the clear did.
const empty = manifest([])
const clear = (service: Awaited<ReturnType<typeof boot>>) =>
  DynWorkSyncClient.make(() => ({ url: service.url, headers: service.headers })).clear()

test("clear removes the block and leaves the user's content as it was", async () => {
  await clear(own)
  expect(await Bun.file(file).text()).toBe(user)
  expect(await apply(own, "empty", empty)).toMatchObject({ rules: 0 })
  expect(await Bun.file(file).text()).toBe(user)
  const request = await settled(own, (value) => !value.system.includes("BETA-ONLY"))
  expect(request.system).not.toContain("BETA-ONLY")
  expect(count(request.system, "USER-NOTE")).toBe(1)
}, 60_000)

test("a file that only held the block is removed on clear", async () => {
  await Bun.file(file).delete()
  await apply(own, "alpha", alphaRules)
  expect(await Bun.file(file).text()).toBe(alphaBlock)
  await settled(own, (value) => value.system.includes("ALPHA-STYLE"))
  await clear(own)
  expect(await Bun.file(file).exists()).toBe(false)
  expect((await readdir(own.config)).filter((name) => name.includes("AGENTS"))).toEqual([])
  await apply(own, "empty", empty)
  expect(await Bun.file(file).exists()).toBe(false)
  const request = await settled(own, (value) => !value.system.includes("ALPHA-"))
  expect(request.system).not.toContain("ALPHA-")
}, 60_000)

test("without OPENCODE_CONFIG_DIR no file is written: the rules reach the system context once", async () => {
  expect(await apply(shared, "alpha", alphaRules)).toMatchObject({ rules: 2 })
  const request = await step(shared)
  expect(count(request.system, "ALPHA-LANGUAGE")).toBe(1)
  expect(count(request.system, "ALPHA-STYLE")).toBe(1)
  expect(request.body).not.toContain("ALPHA-")
  await clear(shared)
  await apply(shared, "empty", empty)
  expect((await step(shared)).system).not.toContain("ALPHA-")
  expect(await Array.fromAsync(new Bun.Glob("**/AGENTS.md").scan({ cwd: shared.root, dot: true }))).toEqual([])
}, 60_000)
