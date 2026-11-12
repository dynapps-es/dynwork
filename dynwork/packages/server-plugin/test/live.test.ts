import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdir, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DynWorkSyncClient } from "../src/client"
import { DynWorkSync } from "../src/contract"
import { DynWorkShell } from "../src/shell"
import { alpha, jwt } from "./fixture"
import { boot, until } from "./service"

// The plugin in a real OpenCode service: content applied over the RPC shows through the server's own HTTP API in
// every Location, a switch replaces it, clear removes it, the JWT reaches only the instance's MCP route and is
// never written to the database, and shells get the user's XDG values back. DynWork's own service (a config dir, and
// OpenCode's watcher on) gets the skills, the bundle agents and plugins as files, which OpenCode loads by itself, and
// the bridge's `policies`; one without a config dir gets the skills in memory.

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

// Where the bundle plugin below records each time OpenCode loads it
const marker = path.join(tmpdir(), `dynwork-bundle-plugin-${crypto.randomUUID()}`)
// A provider the user declared in config: while an instance is applied the bridge's `policies` block it too.
const declared = {
  providers: {
    mine: {
      name: "Mine",
      package: "aisdk:@ai-sdk/openai-compatible",
      settings: { baseURL: "http://127.0.0.1:9/v1", apiKey: "not-a-key" },
      models: { small: { name: "Small" } },
    },
  },
}
const service = await boot(
  {
    OPENCODE_DISABLE_FILEWATCHER: "false",
    DYNWORK_TEST_MARKER: marker,
    [DynWorkShell.variable]: JSON.stringify({ XDG_STATE_HOME: "/home/user/.local/state", XDG_DATA_HOME: null }),
  },
  declared,
)
// A service whose config dir is the user's: OPENCODE_CONFIG_DIR is not set, so the plugin never writes files.
const shared = await boot({ OPENCODE_CONFIG_DIR: undefined })
const client = DynWorkSyncClient.make(() => ({ url: service.url, headers: service.headers }))
const [projectA, projectB] = service.projects as [string, string]

afterAll(async () => {
  await Promise.all([service.stop(), shared.stop(), rm(marker, { force: true })])
  instance.stop(true)
})

// The alpha-tools bundle as the instance would serve it: an agent, an OpenCode plugin, and a file only Claude uses.
const bundle = {
  "agents/alpha_helper.md":
    "---\ndescription: Helps the alpha team\n---\n\nYou are the alpha helper of the local DynWork harness.\n",
  "hosts/opencode/plugins/loaded.js":
    'export default { id: "alpha.loaded", setup: async () => { await Bun.write(process.env.DYNWORK_TEST_MARKER, "loaded") } }\n',
  "skills/alpha-notes/SKILL.md": "# Claude only",
}
const sha = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex")
// What main fetched for the plugin: every file the projection wants
const files = Object.entries(bundle)
  .filter((entry) => !entry[0].startsWith("skills/"))
  .map(([file, text]) => ({ plugin: "alpha-tools", path: file, content: Buffer.from(text).toString("base64") }))

const manifest = {
  ...alpha,
  plugins: [
    { id: "alpha-tools", files: Object.entries(bundle).map(([file, text]) => ({ path: file, sha256: sha(text) })) },
  ],
  managed_mcp_servers: [
    ...alpha.managed_mcp_servers,
    { id: "routed", name: "routed", url: `${instance.url.origin}/api/v1/mcp/routed/mcp` },
  ],
}

// MCP servers carry no instance prefix, so they are told apart by the names the manifests give them
const ids = async (
  route: string,
  directory: string,
  field: "id" | "name",
  owned = /^(alpha|beta)-/,
  from: typeof service = service,
) => {
  const body: { data: Array<Record<string, string>> } = await from.get(route, directory)
  return body.data
    .map((entry) => entry[field] ?? "")
    .filter((id) => owned.test(id))
    .toSorted()
}
const content = (directory: string, from: typeof service = service) =>
  Promise.all([
    ids("/api/skill", directory, "id", /^(alpha|beta|who)-/, from),
    ids("/api/agent", directory, "id", /^(alpha|beta)[-_]/, from),
    ids("/api/mcp", directory, "name", /^(alpha-docs|routed)$/, from),
  ])

// OpenCode reloads the skill files when its watcher reports them: read until the Location lists what is expected.
const settled = (directory: string, expected: Awaited<ReturnType<typeof content>>, from: typeof service = service) =>
  until(
    () => content(directory, from),
    (value) => JSON.stringify(value) === JSON.stringify(expected),
  )

const skills = path.join(service.config, "skills")
const ledger = path.join(skills, ".systemprompt-managed.json")
// The skill directories on disk, whoever wrote them
const directories = async () =>
  (await readdir(skills).catch(() => [])).filter((name) => !name.startsWith(".")).toSorted()
// Every skill the Location lists, with how many times each id appears
const listed = async (directory: string, from: typeof service = service) => {
  const body: { data: Array<{ id: string; name: string }> } = await from.get("/api/skill", directory)
  return body.data
}

beforeAll(async () => {
  // Boot both Locations before the first apply, so the content must reach Locations the call did not target. The
  // service's skills directory does not exist yet: the watcher has to pick it up once the plugin creates it.
  expect(await content(projectA)).toEqual([[], [], []])
  expect(await content(projectB)).toEqual([[], [], []])
  expect(await directories()).toEqual([])
})

test("apply adds the instance's skills, agents and MCP servers in every Location", async () => {
  expect(
    await client.apply({
      instance: { key: "alpha", url: instance.url.origin },
      manifest,
      jwt,
      expiresAt: Date.now() + 600_000,
      files,
    }),
  ).toEqual({ skills: 3, agents: 1, mcp: 2, rules: 1 })
  // Skills are the bridge's files, named after their directory: the id is the kebab-cased manifest id
  const expected = [
    ["alpha-notes", "alpha-review", "who-am-i"],
    ["alpha_helper"],
    ["alpha-docs", "routed"],
  ] satisfies Awaited<ReturnType<typeof content>>
  expect(await settled(projectA, expected)).toEqual(expected)
  expect(await settled(projectB, expected)).toEqual(expected)
  expect(await directories()).toEqual(["alpha-notes", "alpha-review", "who-am-i"])
  expect(JSON.parse(await Bun.file(ledger).text()).ids).toEqual(["alpha-notes", "alpha-review", "who-am-i"])
  // Once each: not from the files and again from memory
  const all = await listed(projectA)
  expect(all.map((entry) => entry.id).filter((id) => id === "alpha-notes")).toHaveLength(1)
  expect(all.find((entry) => entry.id === "who-am-i")).toMatchObject({ name: "who-am-i" })
  // The bundle's agent, made a sub-agent like the bridge does
  const agent: { data: { mode: string; description?: string } } = await service.get("/api/agent/alpha_helper", projectA)
  expect(agent.data).toMatchObject({ mode: "subagent", description: "Helps the alpha team" })
  expect(JSON.parse(await Bun.file(path.join(service.config, ".systemprompt-owned.json")).text())).toEqual({
    files: ["agents/alpha_helper.md", "plugins/alpha-tools-loaded.js"],
  })
}, 30_000)

test("OpenCode loads the bundle's plugin from the service's plugins directory", async () => {
  expect(await until(() => Bun.file(marker).exists(), Boolean)).toBe(true)
  expect(await Bun.file(path.join(service.config, "plugins/alpha-tools-loaded.js")).text()).toBe(
    bundle["hosts/opencode/plugins/loaded.js"],
  )
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

test("a skill the user keeps beside the instance's survives a switch and a sign-out", async () => {
  await mkdir(path.join(skills, "mine"))
  await Bun.write(
    path.join(skills, "mine", "SKILL.md"),
    "---\nname: mine\ndescription: The user's own.\n---\n\nMine.\n",
  )
  const mine = await until(
    async () => (await listed(projectA)).map((entry) => entry.id),
    (found) => found.includes("mine"),
  )
  expect(mine).toContain("mine")
}, 30_000)

test("applying another instance replaces every item of the previous one", async () => {
  const beta = {
    ...alpha,
    skills: [{ id: "beta_notes", name: "beta notes", instructions: "# Beta" }],
    agents: [],
    plugins: [],
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
  expect(await settled(projectA, [["beta-notes"], [], []])).toEqual([["beta-notes"], [], []])
  expect(await settled(projectB, [["beta-notes"], [], []])).toEqual([["beta-notes"], [], []])
  expect(await directories()).toEqual(["beta-notes", "mine"])
  expect(JSON.parse(await Bun.file(ledger).text()).ids).toEqual(["beta-notes"])
  // Beta ships no bundle: alpha's agent and plugin go, with the ledger
  expect(await Bun.file(path.join(service.config, "plugins/alpha-tools-loaded.js")).exists()).toBe(false)
  expect(await Bun.file(path.join(service.config, ".systemprompt-owned.json")).exists()).toBe(false)
}, 30_000)

test("clear removes everything", async () => {
  await client.clear()
  expect(await settled(projectA, [[], [], []])).toEqual([[], [], []])
  expect(await settled(projectB, [[], [], []])).toEqual([[], [], []])
  expect(await directories()).toEqual(["mine"])
  expect(await Bun.file(ledger).exists()).toBe(false)
  expect((await listed(projectA)).map((entry) => entry.id)).toContain("mine")
  // The bridge's policies leave with the instance, and nothing else was in the file
  expect(await Bun.file(path.join(service.config, "opencode.json")).exists()).toBe(false)
}, 30_000)

test("without OPENCODE_CONFIG_DIR the skills are added in memory and no file is written", async () => {
  const [sharedA] = shared.projects as [string]
  expect(await content(sharedA, shared)).toEqual([[], [], []])
  expect(
    await DynWorkSyncClient.make(() => ({ url: shared.url, headers: shared.headers })).apply({
      instance: { key: "alpha", url: instance.url.origin },
      manifest,
      jwt,
      expiresAt: Date.now() + 600_000,
    }),
  ).toMatchObject({ skills: 3 })
  expect((await content(sharedA, shared))[0]).toEqual(["alpha-alpha_notes", "alpha-alpha_review", "alpha-who_am_i"])
  expect(
    await Array.fromAsync(new Bun.Glob("**/.systemprompt-managed.json").scan({ cwd: shared.root, dot: true })),
  ).toEqual([])
  expect(
    await Array.fromAsync(new Bun.Glob("{config,xdg-config}/**/SKILL.md").scan({ cwd: shared.root, dot: true })),
  ).toEqual([])
  await DynWorkSyncClient.make(() => ({ url: shared.url, headers: shared.headers })).clear()
  expect((await content(sharedA, shared))[0]).toEqual([])
}, 30_000)

test("while an instance's gateway is applied it is the only provider and the only one offered, and clear brings the others back", async () => {
  const providers = async (directory: string) =>
    ((await service.get("/api/provider", directory)) as { data: Array<{ id: string }> }).data
      .map((entry) => entry.id)
      .toSorted()
  const integrations = async (directory: string) =>
    ((await service.get("/api/integration", directory)) as { data: Array<{ id: string }> }).data.map(
      (entry) => entry.id,
    )
  const connect = (integration: string) =>
    fetch(
      `${service.url}/api/integration/${integration}/connect/key?location[directory]=${encodeURIComponent(projectA)}`,
      {
        method: "POST",
        headers: { ...service.headers, "content-type": "application/json" },
        body: JSON.stringify({ key: "sk-test" }),
      },
    )
  // A provider the user connected before signing in.
  expect((await connect("anthropic")).status).toBe(204)
  const before = await until(
    () => providers(projectA),
    (ids) => ids.includes("anthropic"),
  )
  // OpenCode's free provider is offered while signed out, and so is the one the user declared in config.
  expect(before).toContain("opencode")
  expect(before).toContain("mine")
  expect(before).not.toContain("systemprompt")
  const offered = await integrations(projectA)
  expect(offered).toContain("openai")
  expect(offered).toContain("claude-agent")
  // Without gateway models the lock holds all the same: the policies leave no provider.
  await client.apply({
    instance: { key: "alpha", url: instance.url.origin },
    manifest,
    jwt,
    expiresAt: Date.now() + 600_000,
  })
  expect(JSON.parse(await Bun.file(path.join(service.config, "opencode.json")).text()).policies).toEqual([
    { effect: "deny", action: "provider.use", resource: "*" },
    { effect: "allow", action: "provider.use", resource: "systemprompt" },
  ])
  expect(
    await until(
      () => providers(projectA),
      (ids) => ids.length === 0,
    ),
  ).toEqual([])
  await client.apply({
    instance: { key: "alpha", url: instance.url.origin },
    manifest,
    jwt,
    expiresAt: Date.now() + 600_000,
    gateway: { label: "Alpha", models: [{ id: "claude-x", api: "messages" }] },
  })
  expect(await providers(projectA)).toEqual(["systemprompt"])
  expect(
    await until(
      () => providers(projectB),
      (ids) => ids.length === 1,
    ),
  ).toEqual(["systemprompt"])
  // Nor is a provider offered that would vanish once connected, connected or not, and connecting one is refused.
  const blocked = await integrations(projectA)
  expect(blocked).not.toContain("anthropic")
  expect(blocked).not.toContain("openai")
  expect(blocked).not.toContain("claude-agent")
  expect((await connect("openai")).status).toBe(404)
  await client.clear()
  const after = await until(
    () => providers(projectA),
    (ids) => ids.includes("anthropic"),
  )
  expect(after).toEqual(before)
  expect(await integrations(projectA)).toEqual(offered)
  expect(
    await until(
      () => providers(projectB),
      (ids) => ids.includes("anthropic"),
    ),
  ).toEqual(after)
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
