import { afterAll, expect, test } from "bun:test"
import path from "node:path"
import type { Catalog, Manifest, Profile } from "@dynwork/sp-client"
import { DynWorkSyncClient } from "@dynwork/server-plugin/client"
import { DynWorkSyncMain } from "../../src/accounts/sync"

// The plugin side is tested against a real service in dynwork/packages/server-plugin; this pins what main sends.
const requests: Array<{ path: string; authorization: string | null; body: unknown }> = []
const answers: Array<() => Response> = []
const sidecar = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    requests.push({
      path: new URL(request.url).pathname,
      authorization: request.headers.get("authorization"),
      body: await request.json(),
    })
    return answers.shift()?.() ?? Response.json({ output: { skills: 3, agents: 1, mcp: 1, rules: 1 } })
  },
})
afterAll(() => sidecar.stop(true))

const captured: {
  manifest: { payload: Manifest }
  profile: { body: Profile }
  models: { body: { data: Catalog } }
} = await Bun.file(path.join(import.meta.dir, "../../../sp-client/test/fixtures/alpha.json")).json()
const manifest = captured.manifest.payload
const endpoint = {
  id: "sidecar",
  url: sidecar.url.origin + "/",
  headers: { authorization: "Basic c2VjcmV0" },
  sameMachine: true,
}
const sync = (known = true) => DynWorkSyncMain.make({ get: (id) => (known && id === "sidecar" ? endpoint : undefined) })
const account = { label: "Dynapps (Alpha)", url: "http://127.0.0.1:18101" }

test("apply posts the instance, manifest and JWT to the plugin RPC with the sidecar's credential", async () => {
  requests.length = 0
  expect(await sync().apply({ account, manifest, jwt: "a.b.c", expiresAt: 5 })).toEqual({
    skills: 3,
    agents: 1,
    mcp: 1,
    rules: 1,
  })
  expect(requests).toEqual([
    {
      path: "/api/rpc/dynwork.sync/apply",
      authorization: "Basic c2VjcmV0",
      body: {
        input: { instance: { key: "dynapps-alpha", url: account.url }, manifest, jwt: "a.b.c", expiresAt: 5 },
      },
    },
  ])
})

test("apply with the profile adds the gateway models the user is admitted to", async () => {
  requests.length = 0
  await sync().apply({
    account,
    manifest,
    jwt: "a.b.c",
    expiresAt: 5,
    profile: captured.profile.body,
    catalog: captured.models.body.data,
  })
  expect(requests[0]?.body).toMatchObject({
    input: {
      gateway: {
        label: "Dynapps (Alpha)",
        models: [
          { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", api: "messages", context: 1_000_000, output: 128_000 },
          { id: "claude-opus-5-5", name: "Claude Opus 5.5", api: "messages", context: 1_000_000, output: 128_000 },
          { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", api: "messages", context: 1_000_000, output: 128_000 },
        ],
        default: "claude-sonnet-5-5",
      },
    },
  })
  // The profile's internal gateway address never reaches the plugin: it calls the account's own URL.
  const sent = requests[0]?.body as { input: { gateway: unknown } }
  expect(JSON.stringify(sent.input.gateway)).not.toContain("localhost:8080")
})

test("the gateway keeps only models the plugin can serve", () => {
  const profile: Profile = {
    models: ["gpt-x", "dup", "dup", "off", "bad id", "sized", "unknown-kind"],
    default_model: "nope",
    providers: [
      { name: "openai", clients: ["openai"], models: ["gpt-x"] },
      { name: "deepseek", configured: false, models: ["off"] },
      { name: "other", clients: ["gemini"], models: ["unknown-kind"] },
    ],
    model_limits: { sized: { context_window: 0, max_output_tokens: 1.5 } },
  }
  expect(DynWorkSyncMain.gateway("  ", profile, [{ id: "sized", max_input_tokens: 4096, max_tokens: 1024 }])).toEqual({
    label: "Governance",
    models: [
      { id: "gpt-x", api: "chat", clients: ["openai"] },
      { id: "dup", api: "messages" },
      { id: "sized", api: "messages", context: 4096, output: 1024 },
    ],
  })
  expect(DynWorkSyncMain.gateway("A", { models: [] }).models).toEqual([])
  // A configured provider wins over an unconfigured one listed first.
  expect(
    DynWorkSyncMain.gateway("A", {
      models: ["claude-x"],
      providers: [
        { name: "direct", configured: false, models: ["claude-x"] },
        { name: "bedrock", configured: true, clients: ["claude"], models: ["claude-x"] },
      ],
    }).models,
  ).toEqual([{ id: "claude-x", api: "messages", clients: ["claude"] }])
})

test("token pushes a renewed JWT for the account's instance", async () => {
  requests.length = 0
  answers.push(() => Response.json({ output: { accepted: true } }))
  expect(await sync().token({ account, jwt: "d.e.f", expiresAt: 9 })).toBe(true)
  expect(requests).toEqual([
    {
      path: "/api/rpc/dynwork.sync/token",
      authorization: "Basic c2VjcmV0",
      body: { input: { instance: { key: "dynapps-alpha", url: account.url }, jwt: "d.e.f", expiresAt: 9 } },
    },
  ])
})

test("clear posts to the clear method", async () => {
  requests.length = 0
  answers.push(() => Response.json({}))
  expect(await sync().clear()).toBeUndefined()
  expect(requests.map((request) => request.path)).toEqual(["/api/rpc/dynwork.sync/clear"])
})

test("a refused call reports status and type, never the service's message", async () => {
  answers.push(() => Response.json({ type: "rpc.invalid_input", message: "got a.b.c" }, { status: 400 }))
  const error = await sync()
    .apply({ account, manifest, jwt: "a.b.c", expiresAt: 5 })
    .catch((error: unknown) => error)
  expect(error).toBeInstanceOf(DynWorkSyncClient.Failed)
  expect(error).toMatchObject({ status: 400, type: "rpc.invalid_input" })
  expect(String(error)).not.toContain("a.b.c")
})

test("no sidecar yet, or an answer that is not the contract, fails", async () => {
  expect(
    await sync(false)
      .clear()
      .catch((error: unknown) => error),
  ).toMatchObject({ status: 0 })
  answers.push(() => Response.json({ output: { skills: "many" } }))
  expect(
    await sync()
      .apply({ account, manifest, jwt: "a.b.c", expiresAt: 5 })
      .catch((error: unknown) => error),
  ).toMatchObject({ status: 200, type: "invalid_output" })
})

test.each([
  ["Dynapps (Alpha)", "dynapps-alpha"],
  ["127.0.0.1", "127-0-0-1"],
  ["  ¡Ñandú!  ", "and"],
  ["A very long instance label that goes on", "a-very-long-instance-lab"],
  ["---", "sp"],
  ["", "sp"],
])("the label %p keys the instance as %p", (label, expected) => {
  const key = DynWorkSyncMain.key(label)
  expect(key).toBe(expected)
  expect(key).toMatch(/^[a-z0-9][a-z0-9-]{0,23}$/)
})
