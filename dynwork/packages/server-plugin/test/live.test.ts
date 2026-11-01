import { afterAll, beforeAll, expect, test } from "bun:test"
import { DynWorkSyncClient } from "../src/client"
import { DynWorkSync } from "../src/contract"
import { DynWorkShell } from "../src/shell"
import { alpha, jwt } from "./fixture"
import { boot, until } from "./service"

// The plugin in a real OpenCode service: content applied over the RPC shows through the server's own HTTP API in
// every Location, a switch replaces it, clear removes it, the JWT reaches only the instance's MCP route and is
// never written to the database, and shells get the user's XDG values back.

// Stands in for the instance: its MCP route records the Authorization header OpenCode connects with.
const authorizations: string[] = []
const instance = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => {
    authorizations.push(request.headers.get("authorization") ?? "")
    return new Response("not an MCP server", { status: 404 })
  },
})

const service = await boot({
  [DynWorkShell.variable]: JSON.stringify({ XDG_STATE_HOME: "/home/user/.local/state", XDG_DATA_HOME: null }),
})
const client = DynWorkSyncClient.make(() => ({ url: service.url, headers: service.headers }))
const [projectA, projectB] = service.projects as [string, string]

afterAll(async () => {
  await service.stop()
  instance.stop(true)
})

const manifest = {
  ...alpha,
  managed_mcp_servers: [
    ...alpha.managed_mcp_servers,
    { id: "routed", name: "routed", url: `${instance.url.origin}/api/v1/mcp/routed/mcp` },
  ],
}

// MCP servers carry no instance prefix, so they are told apart by the names the manifests give them
const ids = async (route: string, directory: string, field: "id" | "name", owned = /^(alpha|beta)-/) => {
  const body: { data: Array<Record<string, string>> } = await service.get(route, directory)
  return body.data
    .map((entry) => entry[field] ?? "")
    .filter((id) => owned.test(id))
    .toSorted()
}
const content = (directory: string) =>
  Promise.all([
    ids("/api/skill", directory, "id"),
    ids("/api/agent", directory, "id"),
    ids("/api/mcp", directory, "name", /^(alpha-docs|routed)$/),
  ])

beforeAll(async () => {
  // Boot both Locations before the first apply, so the content must reach Locations the call did not target.
  expect(await content(projectA)).toEqual([[], [], []])
  expect(await content(projectB)).toEqual([[], [], []])
})

test("apply adds the instance's skills, agents and MCP servers in every Location", async () => {
  expect(
    await client.apply({
      instance: { key: "alpha", url: instance.url.origin },
      manifest,
      jwt,
      expiresAt: Date.now() + 600_000,
    }),
  ).toEqual({ skills: 3, agents: 1, mcp: 2, rules: 1 })
  const expected = [
    ["alpha-alpha_notes", "alpha-alpha_review", "alpha-who_am_i"],
    ["alpha-alpha_helper"],
    ["alpha-docs", "routed"],
  ] satisfies Awaited<ReturnType<typeof content>>
  expect(await content(projectA)).toEqual(expected)
  expect(
    await until(
      () => content(projectB),
      (value) => JSON.stringify(value) === JSON.stringify(expected),
    ),
  ).toEqual(expected)
  const agent: { data: { mode: string; system?: string } } = await service.get(
    "/api/agent/alpha-alpha_helper",
    projectA,
  )
  expect(agent.data).toMatchObject({
    mode: "subagent",
    system: "You are the alpha helper of the local DynWork harness.",
  })
}, 30_000)

test("the JWT reaches the instance's MCP route and nothing else stores it", async () => {
  const seen = await until(
    async () => authorizations,
    (value) => value.includes(`Bearer ${jwt}`),
  )
  expect(seen).toContain(`Bearer ${jwt}`)
  const mcp = JSON.stringify(await service.get("/api/mcp", projectA))
  expect(mcp).not.toContain(jwt)
  const database = await Bun.file(service.database).arrayBuffer()
  expect(Buffer.from(database).includes(jwt)).toBe(false)
}, 30_000)

test("applying another instance replaces every item of the previous one", async () => {
  const beta = {
    ...alpha,
    skills: [{ id: "beta_notes", name: "beta notes", instructions: "# Beta" }],
    agents: [],
    managed_mcp_servers: [],
  }
  expect(
    await client.apply({
      instance: { key: "beta", url: "http://127.0.0.1:18102" },
      manifest: beta,
      jwt,
      expiresAt: Date.now() + 600_000,
    }),
  ).toEqual({ skills: 1, agents: 0, mcp: 0, rules: 1 })
  expect(await content(projectA)).toEqual([["beta-beta_notes"], [], []])
  expect(await content(projectB)).toEqual([["beta-beta_notes"], [], []])
}, 30_000)

test("clear removes everything", async () => {
  await client.clear()
  expect(await content(projectA)).toEqual([[], [], []])
  expect(await content(projectB)).toEqual([[], [], []])
}, 30_000)

test("while an instance's gateway is applied it is the only provider, and clear brings the others back", async () => {
  const providers = async (directory: string) =>
    ((await service.get("/api/provider", directory)) as { data: Array<{ id: string }> }).data
      .map((entry) => entry.id)
      .toSorted()
  const before = await providers(projectA)
  // OpenCode's free provider is offered while signed out.
  expect(before).toContain("opencode")
  expect(before).not.toContain("systemprompt")
  await client.apply({
    instance: { key: "alpha", url: instance.url.origin },
    manifest,
    jwt,
    expiresAt: Date.now() + 600_000,
    gateway: { label: "Alpha", models: [{ id: "claude-x", api: "messages" }] },
  })
  expect(await providers(projectA)).toEqual(["systemprompt"])
  expect(await until(() => providers(projectB), (ids) => ids.length === 1)).toEqual(["systemprompt"])
  // A provider the user connects while the instance is active is not offered either.
  const connected = await fetch(
    `${service.url}/api/integration/anthropic/connect/key?location[directory]=${encodeURIComponent(projectA)}`,
    {
      method: "POST",
      headers: { ...service.headers, "content-type": "application/json" },
      body: JSON.stringify({ key: "sk-ant-test" }),
    },
  )
  expect(connected.status).toBe(204)
  expect(await providers(projectA)).toEqual(["systemprompt"])
  await client.clear()
  const after = await until(
    () => providers(projectA),
    (ids) => ids.includes("anthropic"),
  )
  expect(after).toEqual([...before, "anthropic"].toSorted())
  expect(await until(() => providers(projectB), (ids) => ids.includes("anthropic"))).toEqual(after)
}, 30_000)

test("an input that fails the contract is refused without echoing it", async () => {
  const error = await client
    .apply({
      instance: { key: "Not A Key", url: instance.url.origin },
      manifest,
      jwt: "bad token\r\nX: y",
      expiresAt: 1,
    })
    .catch((error: unknown) => error)
  expect(error).toBeInstanceOf(DynWorkSyncClient.Failed)
  expect(error).toMatchObject({ type: "rpc.invalid_input" })
  expect(String(error)).not.toContain("bad token")
  const raw = await service.post(`/api/rpc/${DynWorkSync.id}/apply`, { input: { instance: {} } })
  expect(raw.status).toBe(400)
})

test("shells the service starts get the user's XDG values back", async () => {
  const created = await service.post(
    "/api/shell",
    {
      command:
        'printf "S=%s D=%s J=%s" "${XDG_STATE_HOME-unset}" "${XDG_DATA_HOME-unset}" "${DYNWORK_SHELL_ENV-unset}"',
    },
    projectA,
  )
  expect(created.status).toBe(200)
  const id: string = created.body.data.id
  await until(
    async () => ((await service.get(`/api/shell/${id}`, projectA)) as { data: { status: string } }).data.status,
    (status) => status !== "running",
  )
  const output: { data: { output: string } } = await service.get(`/api/shell/${id}/output`, projectA)
  expect(output.data.output).toBe("S=/home/user/.local/state D=unset J=unset")
}, 30_000)
