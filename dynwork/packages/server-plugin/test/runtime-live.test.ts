import { afterAll, expect, test } from "bun:test"
import path from "node:path"
import { DynWorkSyncClient } from "../src/client"
import { alpha, instance, jwt } from "./fixture"
import { boot, until } from "./service"

// The `materialize` and `inspect` RPC methods in a real OpenCode service: a skill's runtime files land beside the
// SKILL.md `apply` wrote in DynWork's config dir, OpenCode still lists the skill once (the `.systemprompt-source` copy
// is hidden from its scan), and a service without a config dir of its own writes nothing.

const consumer: {
  plans: Record<string, { runtime_files: Array<{ path: string; bytes: number[]; executable: boolean }> }>
} = await Bun.file(path.join(import.meta.dir, "../../sp-client/test/fixtures/consumer.json")).json()

const service = await boot({ OPENCODE_DISABLE_FILEWATCHER: "false" })
const shared = await boot({ OPENCODE_CONFIG_DIR: undefined })
const client = DynWorkSyncClient.make(() => ({ url: service.url, headers: service.headers }))
const sharedClient = DynWorkSyncClient.make(() => ({ url: shared.url, headers: shared.headers }))
const project = service.projects[0] ?? ""

afterAll(() => Promise.all([service.stop(), shared.stop()]))

const files = (consumer.plans.alpha_notes?.runtime_files ?? []).map((file) => ({
  path: file.path,
  content: Buffer.from(file.bytes).toString("base64"),
  executable: file.executable,
}))
const apply = { instance, manifest: alpha, jwt, expiresAt: Date.now() + 3_600_000 }

test("writes the runtime files beside the applied skill, reads them back, and OpenCode lists the skill once", async () => {
  await client.apply(apply)
  const written = await client.materialize({ instance, skill: "alpha_notes", files })
  expect(written.outcome).toBe("written")
  expect(written.files.every((file) => file.content === "verified" && file.mode === "verified")).toBe(true)
  const dir = path.join(service.config, "skills", "alpha-notes")
  expect(await Bun.file(path.join(dir, "config.yaml")).text()).toStartWith("id: alpha_notes\n")
  expect(await Bun.file(path.join(dir, ".systemprompt-runtime.json")).json()).toEqual(files.map((file) => file.path))
  // The projected SKILL.md is back once the bundle's was read back
  expect(await Bun.file(path.join(dir, "SKILL.md")).text()).toStartWith("---\nname: alpha-notes\n")
  const recorded = written.files.map((file) => ({
    path: file.path,
    digest: file.digest,
    bytes: file.bytes,
    executable: file.executable,
  }))
  expect(await client.inspect({ instance, skill: "alpha_notes", files: recorded })).toBe(true)
  const listed = await until(
    async () => ((await service.get("/api/skill", project)) as { data: Array<{ id: string }> }).data,
    (data) => data.some((skill) => skill.id === "alpha-notes"),
  )
  expect(listed.filter((skill) => skill.id === "alpha-notes")).toHaveLength(1)
  // OpenCode's watcher may take seconds to report the files under a loaded suite
}, 30_000)

test("another instance's skill, or a service without a config dir of its own, gets nothing written", async () => {
  await client.apply(apply)
  const other = { key: "beta", url: "http://127.0.0.1:18102" }
  expect(await client.materialize({ instance: other, skill: "alpha_notes", files })).toEqual({
    outcome: "missing",
    files: [],
  })
  expect(await client.inspect({ instance: other, skill: "alpha_notes", files: [] })).toBe(false)
  await sharedClient.apply(apply)
  expect(await sharedClient.materialize({ instance, skill: "alpha_notes", files })).toEqual({
    outcome: "unsupported",
    files: [],
  })
})
