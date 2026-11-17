import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { OpenCode } from "@opencode/client/promise"
import { isFailure, type Definition, type Failure } from "../../src/routines/contract"
import { RoutinesLocal } from "../../src/routines/local/backend"
import { clock, storage } from "./fixture"
import { fakeService } from "./service"

const home = await mkdtemp(path.join(tmpdir(), "routines-connectors-"))
const stops: Array<() => void> = []
afterAll(() => stops.forEach((stop) => stop()))

const servers = ["Odoo", "my.docs server", "github"]

function setup() {
  const time = clock()
  const service = fakeService({ now: time.now, mcp: servers })
  stops.push(service.stop)
  const client = OpenCode.make({ baseUrl: service.url, headers: { authorization: "Basic c2VjcmV0" } })
  const backend = RoutinesLocal.make({
    label: "Test Mac",
    store: storage(RoutinesLocal.Saved, RoutinesLocal.initial),
    client: () => client,
    server: "sidecar",
    home,
    now: time.now,
    retry: 10,
  })
  stops.push(backend.dispose)
  return { service, backend }
}

const prompt = (options: Definition["options"] = {}): Definition => ({
  name: "Weekly report",
  instructions: { kind: "prompt", text: "Summarise the week." },
  enabled: true,
  options: { permissions: "ask", notify: "failures", ...options },
})

async function ok<A>(answer: Promise<A | Failure>): Promise<A> {
  const value = await answer
  if (isFailure(value)) throw new Error(`${value.code}: ${value.message}`)
  return value
}

// The permissions the run's session was created with.
async function permissions(options: Definition["options"]) {
  const { backend, service } = setup()
  const routine = await ok(backend.create(prompt(options)))
  await ok(backend.start(routine.ref.id))
  const child = service.received.find(
    (request) => request.path === "/api/session" && request.method === "POST" && request.body?.parentID,
  )
  return { rules: child?.body?.permissions as Array<{ action: string; effect: string }>, service }
}

const denies = (rules: Array<{ action: string; effect: string }>) =>
  rules.filter((rule) => rule.effect === "deny" && rule.action.endsWith("_*")).map((rule) => rule.action)

describe("the connectors of a run", () => {
  test("a list denies one namespace per server it leaves out, as core names them, after Ask me's and Don't ask's rules", async () => {
    for (const mode of ["ask", "bypass"]) {
      const { rules } = await permissions({ permissions: mode, connectors: ["github"] })
      // Spaces and dots become underscores, as `McpTool.namespace` computes.
      expect(denies(rules)).toEqual(["Odoo_*", "my_docs_server_*"])
      expect(rules.at(-1)).toEqual({ action: "my_docs_server_*", resource: "*", effect: "deny" })
    }
  })

  test("a list of every server current denies none, and an empty list denies them all", async () => {
    expect(denies((await permissions({ connectors: servers })).rules)).toEqual([])
    expect(denies((await permissions({ connectors: [] })).rules)).toHaveLength(3)
  })

  test("\"all\" and a routine made before the option deny none and never ask the service for its servers", async () => {
    for (const options of [{ connectors: "all" }, {}]) {
      const { rules, service } = await permissions(options)
      expect(denies(rules)).toEqual([])
      expect(service.received.some((request) => request.path === "/api/mcp")).toBe(false)
    }
  })

  test("a server added after the list was made is denied; \"all\" is the default of the field", async () => {
    const field = RoutinesLocal.fields.find((candidate) => candidate.key === "connectors")
    expect(field).toMatchObject({ kind: "multiselect", lookup: "connectors", default: "all" })
    expect(RoutinesLocal.denyConnectors([...servers, "new"], ["github"])).toContainEqual({
      action: "new_*",
      resource: "*",
      effect: "deny",
    })
  })

  test("the lookup lists the service's servers", async () => {
    const { backend } = setup()
    expect(await backend.options("connectors")).toEqual(servers.map((name) => ({ value: name, label: name })))
  })

  test("\"all\" and a list of names are valid; anything else is not", async () => {
    const { backend } = setup()
    const check = (connectors: unknown) => backend.validate(prompt({ connectors: connectors as never }))
    expect(await check("all")).toBeUndefined()
    expect(await check(["a", "b"])).toBeUndefined()
    expect(await check("some")).toMatchObject({ code: "invalid", fields: { connectors: expect.any(String) } })
    expect(await check(5)).toMatchObject({ code: "invalid" })
  })
})
