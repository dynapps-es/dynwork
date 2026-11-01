import { afterAll, beforeEach, expect, test } from "bun:test"
import { Effect } from "effect"
import { SpClient, SpPlugins } from "../src"
import { startFake } from "./fake"

// `GET /v1/bridge/plugins/{plugin}/{path}`: one file of a plugin bundle, the bytes the manifest's `sha256` covers.

const fake = startFake()

afterAll(() => fake.stop())

beforeEach(() => {
  fake.state.override = undefined
  fake.state.requests.length = 0
  fake.state.files = {}
})

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const fail = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(effect))
const jwt = async () => (await run(SpClient.mintJwt(fake.url, fake.issuePat()))).token

test("returns a bundle file's exact bytes, asked for with the JWT and each path segment encoded", async () => {
  // Every byte value, so a text decode on the way would show
  const bytes = Uint8Array.from({ length: 256 }, (_, index) => index)
  fake.state.files["dynwork-common/hosts/opencode/plugins/session header.js"] = bytes
  const token = await jwt()
  const file = await run(SpPlugins.file(fake.url, token, "dynwork-common", "hosts/opencode/plugins/session header.js"))
  expect(file).toEqual(bytes)
  const request = fake.state.requests.at(-1)
  expect(request?.path).toBe("/v1/bridge/plugins/dynwork-common/hosts/opencode/plugins/session%20header.js")
  expect(request?.headers.authorization).toBe(`Bearer ${token}`)
})

test("a file the instance does not serve is a protocol error, a refused JWT is Unauthorized", async () => {
  const missing = await fail(SpPlugins.file(fake.url, await jwt(), "dynwork-common", "agents/none.md"))
  expect(missing).toBeInstanceOf(SpClient.Protocol)
  expect(missing).toMatchObject({ status: 404 })
  const refused = await fail(SpPlugins.file(fake.url, fake.staleJwt(), "dynwork-common", "agents/none.md"))
  expect(refused).toBeInstanceOf(SpClient.Unauthorized)
})

test("a plugin id or path that would leave the plugin's route is refused without a request", async () => {
  const token = await jwt()
  for (const [plugin, file] of [
    ["../admin", "agents/a.md"],
    ["", "agents/a.md"],
    ["dynwork-common", "../other/agents/a.md"],
    ["dynwork-common", "/etc/hosts"],
    ["dynwork-common", "agents//a.md"],
    ["dynwork-common", "agents\\a.md"],
  ] as const) {
    const error = await fail(SpPlugins.file(fake.url, token, plugin, file))
    expect(error).toBeInstanceOf(SpClient.Protocol)
  }
  expect(fake.state.requests.filter((request) => request.path.startsWith("/v1/bridge/plugins"))).toEqual([])
})
