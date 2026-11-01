import { describe, expect, test } from "bun:test"
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

  test("agents become namespaced sub-agents with their system prompt", () => {
    expect(mapped.agents).toEqual([
      {
        id: "alpha-alpha_helper",
        name: "alpha helper",
        description: "Local test agent of the alpha instance",
        system: "You are the alpha helper of the local DynWork harness.",
        mode: "subagent",
      },
    ])
  })

  test("an MCP server off the instance origin gets no JWT and never OAuth", () => {
    expect(mapped.mcp).toHaveLength(1)
    const [name, config] = mapped.mcp[0] ?? []
    expect(name).toBe("alpha-alpha-docs")
    expect(config).toMatchObject({
      type: "remote",
      url: "http://127.0.0.1:9/alpha-docs/mcp",
      headers: {},
      oauth: false,
    })
  })

  test("rules become AGENTS.md sections named after each rule", () => {
    expect(mapped.rules).toBe(1)
    expect(mapped.instructions).toBe(
      "## alpha conventions\n\n# Alpha conventions\n\nAnswer in English and keep commit messages in the imperative mood.",
    )
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

  test("entries for other hosts, disabled agents, empty bodies and unsafe ids are skipped", () => {
    const mapped = DynWorkMapping.map(
      apply({
        ...alpha,
        skills: [
          { id: "claude_only", name: "c", instructions: "x", hosts: ["claude-code"] },
          { id: "empty", name: "e", instructions: "  " },
          { id: "../escape", name: "u", instructions: "x" },
          { id: "both", name: "b", instructions: "x", hosts: ["opencode", "claude-code"] },
        ],
        agents: [{ id: "off", name: "off", enabled: false }],
      }),
    )
    expect(mapped.skills.map((skill) => String(skill.id))).toEqual(["alpha-both"])
    expect(mapped.agents).toEqual([])
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

  test("rules are sorted by id and capped at the reading budget", () => {
    const mapped = DynWorkMapping.map(
      apply({
        ...alpha,
        rules: [
          { id: "b", name: "Second", instructions: "  second\n" },
          { id: "a", name: "First", instructions: "first" },
        ],
      }),
    )
    expect(mapped.instructions).toBe("## First\n\nfirst\n\n## Second\n\nsecond")
    const long = DynWorkMapping.map(
      apply({ ...alpha, rules: [{ id: "a", name: "a", instructions: "x".repeat(30_000) }] }),
    )
    expect(long.instructions).toHaveLength(DynWorkMapping.rulesBudget)
  })
})

describe("cli_defaults", () => {
  const withDefaults = (cli_defaults: unknown) =>
    DynWorkMapping.map(apply({ ...alpha, marketplaces: [{ id: "m" }, { id: "o", opencode: { cli_defaults } }] }))

  test("the default agent becomes selectable and default; the model splits at the first slash", () => {
    const mapped = withDefaults({ default_agent: "alpha_helper", model: "systemprompt/claude/sonnet" })
    expect(mapped.defaults).toEqual({
      agent: "alpha-alpha_helper",
      model: { providerID: "systemprompt", modelID: "claude/sonnet" },
    })
    expect(mapped.agents[0]?.mode).toBe("all")
  })

  test("a default agent whose surviving entry is disabled sets no default", () => {
    const helper = alpha.agents[0]
    if (helper === undefined) throw new Error("alpha has no agent")
    const mapped = DynWorkMapping.map(
      apply({
        ...alpha,
        agents: [helper, { ...helper, enabled: false }],
        marketplaces: [{ id: "o", opencode: { cli_defaults: { default_agent: helper.id } } }],
      }),
    )
    expect(mapped.defaults.agent).toBeUndefined()
  })

  test("a long MCP server name is cut to 32 characters and stays unique", () => {
    const server = alpha.managed_mcp_servers[0]
    if (server === undefined) throw new Error("alpha has no MCP server")
    const long = (id: string) => ({ ...server, id })
    const mapped = DynWorkMapping.map(
      apply({
        ...alpha,
        managed_mcp_servers: [long("customer-erp-connector-production"), long("customer-erp-connector-production-eu")],
      }),
    )
    const names = mapped.mcp.map((entry) => entry[0])
    expect(names).toHaveLength(2)
    expect(names.every((name) => name.length <= 32)).toBe(true)
    expect(new Set(names).size).toBe(2)
  })

  test("unknown agents and malformed values set no default", () => {
    expect(withDefaults({ default_agent: "nobody", model: "no-slash" }).defaults).toEqual({})
    expect(withDefaults("not an object").defaults).toEqual({})
  })
})

describe("agent models", () => {
  const gateway = { label: "Alpha", models: [{ id: "claude-opus-5-5", api: "messages" as const }] }
  const agents = [
    { id: "served", name: "served", model: "claude-opus-5-5" },
    { id: "unserved", name: "unserved", model: "gpt-9" },
    { id: "none", name: "none" },
  ]

  test("an agent whose model the gateway serves runs on it; any other keeps the Session's model", () => {
    const mapped = DynWorkMapping.map(apply({ ...alpha, agents }, { gateway }))
    expect(mapped.agents.map((agent) => [agent.id, agent.model])).toEqual([
      ["alpha-served", "claude-opus-5-5"],
      ["alpha-unserved", undefined],
      ["alpha-none", undefined],
    ])
  })

  test("without a gateway no agent names a model", () => {
    const mapped = DynWorkMapping.map(apply({ ...alpha, agents }))
    expect(mapped.agents.every((agent) => agent.model === undefined)).toBe(true)
  })
})
