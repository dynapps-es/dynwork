import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SpClient } from "@dynwork/sp-client"
import { DynWorkSync } from "@dynwork/server-plugin/contract"
import { DynWorkBundleFiles } from "../../src/sync/bundles"
import { setup, startFake, type Fake } from "../accounts/fixture"

// Main fetches the plugin bundle files the server plugin projects for OpenCode (agents, OpenCode plugins, pinned
// themes) from `GET /v1/bridge/plugins/{plugin}/{path}` with the account's JWT, and hands their bytes to the plugin,
// which checks each against the signed manifest before writing it.

let fake: Fake

beforeAll(() => {
  fake = startFake()
})

afterAll(() => fake.stop())

const cleanups: Array<() => void> = []

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  fake.state.override = undefined
  fake.state.requests.length = 0
  fake.state.files = {}
})

const sha = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex")
const decode = Schema.decodeUnknownSync(DynWorkSync.Manifest)

// A manifest whose one plugin ships an agent, an OpenCode plugin and a file only Claude uses
function manifest(files: Record<string, string>) {
  return decode({
    rules: [],
    skills: [],
    agents: [],
    managed_mcp_servers: [],
    enabled_hosts: ["opencode"],
    plugins: [
      { id: "dynwork-common", files: Object.entries(files).map(([file, text]) => ({ path: file, sha256: sha(text) })) },
    ],
  })
}
const shipped = {
  "agents/helper.md": "# Helper",
  "hosts/opencode/plugins/session-header.js": "export default {}\n",
  "skills/notes/SKILL.md": "# Claude only",
}
const serve = (files: Record<string, string>) =>
  Object.entries(files).forEach(([file, text]) => (fake.state.files[`dynwork-common/${file}`] = text))
const fetches = () => fake.state.requests.filter((request) => request.path.startsWith("/v1/bridge/plugins/"))

async function boot() {
  const signed = setup(fake)
  cleanups.push(() => signed.accounts.dispose())
  await signed.accounts.signInToken({ url: fake.url, token: fake.issuePat() })
  const id = signed.accounts.active() ?? ""
  const files = DynWorkBundleFiles.make(signed.accounts)
  return { ...signed, id, files, fetch: (served = manifest(shipped)) => files.fetch({ id, url: fake.url }, served) }
}

describe("fetch", () => {
  test("downloads only the files the plugin projects, with the account's JWT, as base64", async () => {
    serve(shipped)
    const booted = await boot()
    const fetched = await booted.fetch()
    expect(fetched).toEqual([
      { plugin: "dynwork-common", path: "agents/helper.md", content: Buffer.from("# Helper").toString("base64") },
      {
        plugin: "dynwork-common",
        path: "hosts/opencode/plugins/session-header.js",
        content: Buffer.from("export default {}\n").toString("base64"),
      },
    ])
    expect(fetches().map((request) => request.path)).toEqual([
      "/v1/bridge/plugins/dynwork-common/agents/helper.md",
      "/v1/bridge/plugins/dynwork-common/hosts/opencode/plugins/session-header.js",
    ])
    expect(fetches()[0]?.headers.authorization).toBe(`Bearer ${await booted.accounts.jwt(booted.id)}`)
  })

  test("a file already fetched at the manifest's digest is not downloaded again; a new digest is", async () => {
    serve(shipped)
    const booted = await boot()
    await booted.fetch()
    fake.state.requests.length = 0
    expect(await booted.fetch()).toHaveLength(2)
    expect(fetches()).toEqual([])
    const changed = { ...shipped, "agents/helper.md": "# Helper v2" }
    serve(changed)
    const fetched = await booted.fetch(manifest(changed))
    expect(fetches().map((request) => request.path)).toEqual(["/v1/bridge/plugins/dynwork-common/agents/helper.md"])
    expect(Buffer.from(fetched[0]?.content ?? "", "base64").toString()).toBe("# Helper v2")
  })

  test("a file the instance does not serve is left out, one with other bytes is handed on but never kept", async () => {
    serve({ "agents/helper.md": "# Not what was signed" })
    const booted = await boot()
    const fetched = await booted.fetch()
    // The plugin reports both: one missing, one that does not match the manifest
    expect(fetched.map((file) => file.path)).toEqual(["agents/helper.md"])
    fake.state.requests.length = 0
    await booted.fetch()
    expect(fetches()).toHaveLength(2)
  })

  test("an unreachable instance fails the fetch, so the sync is tried again", async () => {
    const booted = await boot()
    fake.state.override = { path: "/v1/bridge/plugins/dynwork-common/agents/helper.md", status: 503 }
    const error = await booted.fetch().catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(SpClient.Unreachable)
  })
})
