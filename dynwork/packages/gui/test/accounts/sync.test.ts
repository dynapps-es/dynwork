import { afterAll, expect, test } from "bun:test"
import path from "node:path"
import type { Manifest } from "@dynwork/sp-client"
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

const captured: { manifest: { payload: Manifest } } = await Bun.file(
  path.join(import.meta.dir, "../../../sp-client/test/fixtures/alpha.json"),
).json()
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
