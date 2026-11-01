import { describe, expect, test } from "bun:test"
import { DynWorkInstructions } from "../src/instructions"
import { DynWorkMapping } from "../src/mapping"
import { alpha, apply, jwt } from "./fixture"

describe("mapping the alpha manifest", () => {
  const mapped = DynWorkMapping.map(apply())

  test("skills are embedded under the instance key with a virtual path", () => {
    expect(mapped.skills.map((skill) => [String(skill.id), String(skill.name), String(skill.path)])).toEqual([
      ["alpha-alpha_notes", "alpha notes", "dynwork://alpha/skills/alpha_notes"],
      ["alpha-alpha_review", "alpha review", "dynwork://alpha/skills/alpha_review"],
      ["alpha-who_am_i", "Who Am I", "dynwork://alpha/skills/who_am_i"],
    ])
    expect(mapped.skills[0]?.content).toContain("Summarize the session in five bullets")
    expect(mapped.skills[0]?.description).toBe("Turn a working session into short alpha-team notes.")
  })

  test("the manifest's agents are not mapped: like the bridge, agents come from plugin bundles", () => {
    expect(alpha.agents).not.toHaveLength(0)
    expect(Object.keys(mapped)).not.toContain("agents")
  })

  test("an MCP server off the instance origin gets no JWT and never OAuth", () => {
    expect(mapped.mcp).toHaveLength(1)
    const [name, config] = mapped.mcp[0] ?? []
    expect(name).toBe("alpha-docs")
    expect(config).toMatchObject({
      type: "remote",
      url: "http://127.0.0.1:9/alpha-docs/mcp",
      headers: {},
      oauth: false,
    })
  })

  test("rules become the bridge's AGENTS.md block, and a rule that names no host reaches none", () => {
    expect(mapped.rules).toBe(1)
    expect(mapped.instructions).toBe(
      `${DynWorkInstructions.begin}\n\n## alpha conventions\n\n# Alpha conventions\n\nAnswer in English and keep commit messages in the imperative mood.\n\n${DynWorkInstructions.end}\n`,
    )
    const unhosted = DynWorkMapping.map(apply({ ...alpha, rules: alpha.rules.map((rule) => ({ ...rule, hosts: [] })) }))
    expect(unhosted.rules).toBe(0)
    expect(unhosted.instructions).toBeUndefined()
  })
})

const server = (url: string, headers?: Record<string, string>) => ({ id: "docs", name: "docs", url, headers })

describe("MCP servers", () => {
  const mcp = (url: string, headers?: Record<string, string>) =>
    DynWorkMapping.map(apply({ ...alpha, managed_mcp_servers: [server(url, headers)] })).mcp

  test("one on the instance origin carries the JWT, replacing any declared authorization", () => {
    expect(
      mcp("http://127.0.0.1:18101/api/v1/mcp/docs/mcp", { authorization: "x", "X-Team": "a" })[0]?.[1],
    ).toMatchObject({
      headers: { "X-Team": "a", Authorization: `Bearer ${jwt}` },
    })
  })

  test("a foreign origin keeps only its declared headers", () => {
    expect(mcp("https://mcp.example.com/mcp", { Authorization: "Basic x", "X-Team": "a" })[0]?.[1]).toMatchObject({
      headers: { "X-Team": "a" },
    })
  })

  test("plain HTTP off loopback and unparsable URLs are left out", () => {
    expect(mcp("http://mcp.example.com/mcp")).toEqual([])
    expect(mcp("not a url")).toEqual([])
    expect(mcp("file:///etc/passwd")).toEqual([])
  })
})

describe("filters", () => {
  test("a manifest whose enabled hosts leave out OpenCode applies nothing", () => {
    expect(DynWorkMapping.map(apply({ ...alpha, enabled_hosts: ["claude-code"] }))).toEqual(DynWorkMapping.empty)
  })

  test("a manifest without enabled hosts applies nothing, like an empty list", () => {
    const { enabled_hosts: _, ...bare } = alpha
    expect(DynWorkMapping.map(apply(bare))).toEqual(DynWorkMapping.empty)
    expect(DynWorkMapping.map(apply({ ...alpha, enabled_hosts: [] }))).toEqual(DynWorkMapping.empty)
  })

  test("entries for other hosts, empty bodies and unsafe ids are skipped", () => {
    const mapped = DynWorkMapping.map(
      apply({
        ...alpha,
        skills: [
          { id: "claude_only", name: "c", instructions: "x", hosts: ["claude-code"] },
          { id: "empty", name: "e", instructions: "  " },
          { id: "../escape", name: "u", instructions: "x" },
          { id: "both", name: "b", instructions: "x", hosts: ["opencode", "claude-code"] },
        ],
      }),
    )
    expect(mapped.skills.map((skill) => String(skill.id))).toEqual(["alpha-both"])
  })

  test("a repeated id keeps the last entry", () => {
    const mapped = DynWorkMapping.map(
      apply({
        ...alpha,
        skills: [
          { id: "a", name: "first", instructions: "1" },
          { id: "a", name: "second", instructions: "2" },
        ],
      }),
    )
    expect(mapped.skills.map((skill) => String(skill.name))).toEqual(["second"])
  })

  test("rules for an OpenCode packaging become the bridge's AGENTS.md block, sorted by id and never cut", () => {
    const opencode = ["opencode"]
    const mapped = DynWorkMapping.map(
      apply({
        ...alpha,
        rules: [
          { id: "b", name: "Second", instructions: "  second\n", hosts: ["opencode-cli"] },
          { id: "a", name: "First", instructions: "first", hosts: opencode },
          { id: "c", name: "Empty", instructions: "", hosts: opencode },
          { id: "d", name: "Claude", instructions: "claude", hosts: ["claude-code"] },
        ],
      }),
    )
    expect(mapped.rules).toBe(3)
    expect(mapped.instructions).toBe(
      `${DynWorkInstructions.begin}\n\n## First\n\nfirst\n\n## Second\n\nsecond\n\n## Empty\n\n\n\n${DynWorkInstructions.end}\n`,
    )
    const long = DynWorkMapping.map(
      apply({ ...alpha, rules: [{ id: "a", name: "a", instructions: "x".repeat(30_000), hosts: opencode }] }),
    )
    expect(long.instructions).toContain("x".repeat(30_000))
    expect(DynWorkInstructions.overBudget(long.instructions)).toBeGreaterThan(DynWorkInstructions.budget)
    expect(DynWorkInstructions.overBudget(mapped.instructions)).toBeUndefined()
  })
})

describe("cli_defaults", () => {
  const withDefaults = (cli_defaults: unknown) =>
    DynWorkMapping.map(apply({ ...alpha, marketplaces: [{ id: "m" }, { id: "o", opencode: { cli_defaults } }] }))

  test("the default model splits at the first slash", () => {
    const mapped = withDefaults({ default_agent: "alpha_helper", model: "systemprompt/claude/sonnet" })
    expect(mapped.defaults).toEqual({ model: { providerID: "systemprompt", modelID: "claude/sonnet" } })
  })

  test("MCP servers are named from their name like the bridge, without the instance key", () => {
    const server = alpha.managed_mcp_servers[0]
    if (server === undefined) throw new Error("alpha has no MCP server")
    const names = (...list: ReadonlyArray<string>) =>
      DynWorkMapping.map(
        apply({ ...alpha, managed_mcp_servers: list.map((name, index) => ({ ...server, id: `s${index}`, name })) }),
      ).mcp.map((entry) => entry[0])
    // Prod's three managed servers
    expect(names("agent-farm", "dynbrain", "systemprompt")).toEqual(["agent-farm", "dynbrain", "systemprompt"])
    expect(names("Dyn Brain", "ACME__Docs!!", "--edge--", "a  b", "Lupa_2")).toEqual([
      "dyn-brain",
      "acme__docs",
      "edge",
      "a-b",
      "lupa_2",
    ])
    expect(names("***", "ñandú")).toEqual(["mcp-server", "and"])
  })

  test("two MCP servers that share a name keep the last one", () => {
    const server = alpha.managed_mcp_servers[0]
    if (server === undefined) throw new Error("alpha has no MCP server")
    const mapped = DynWorkMapping.map(
      apply({
        ...alpha,
        managed_mcp_servers: [
          { ...server, id: "one", name: "Docs", url: "http://127.0.0.1:9/one" },
          { ...server, id: "two", name: "docs", url: "http://127.0.0.1:9/two" },
        ],
      }),
    )
    expect(mapped.mcp.map((entry) => [entry[0], (entry[1] as { url: string }).url])).toEqual([
      ["docs", "http://127.0.0.1:9/two"],
    ])
  })

  test("malformed values set no default", () => {
    expect(withDefaults({ model: "no-slash" }).defaults).toEqual({})
    expect(withDefaults("not an object").defaults).toEqual({})
  })
})
