import { describe, expect, test } from "bun:test"
import type { Capabilities, Definition } from "../../src/routines/contract"
import { RoutinesDemo } from "../../src/routines/demo"
import { RoutinesValidate } from "../../src/routines/validate"
import { clock } from "./fixture"

const time = clock()
const farm = await RoutinesDemo.remote(time.now).capabilities()
const local = await RoutinesDemo.local(time.now).capabilities()

const agent: Definition = {
  name: "Check",
  instructions: { kind: "agent", agent: "mr-review", input: "Review." },
  enabled: true,
  options: { repository: "https://git.example.com/acme/app.git" },
}

function check(capabilities: Capabilities, patch: Partial<Definition>) {
  return RoutinesValidate.check(capabilities, { ...agent, ...patch })
}

describe("checking a definition against capabilities", () => {
  test("a complete one is fine", () => {
    expect(check(farm, {})).toBeUndefined()
  })

  test("the problems come back as an invalid failure with one message per field", () => {
    const failure = check(farm, { name: " ", options: {} })
    expect(failure).toMatchObject({ code: "invalid", retryable: false })
    expect(Object.keys(failure?.fields ?? {}).sort()).toEqual(["name", "repository"])
  })

  test.each([
    {
      label: "an empty prompt",
      capabilities: farm,
      patch: { instructions: { kind: "prompt" as const, text: " " } },
      key: "instructions",
    },
    {
      label: "a skill where there are none",
      capabilities: farm,
      patch: { instructions: { kind: "skill" as const, skill: "x" } },
      key: "instructions",
    },
    {
      label: "an agent with nothing to do",
      capabilities: farm,
      patch: { instructions: { kind: "agent" as const, agent: "a", input: "" } },
      key: "instructions",
    },
    {
      label: "an agent with no name",
      capabilities: farm,
      patch: { instructions: { kind: "agent" as const, agent: "", input: "x" } },
      key: "instructions",
    },
    { label: "an agent where the instructions name it", capabilities: farm, patch: { agent: "build" }, key: "agent" },
    { label: "a model the agent fixes", capabilities: farm, patch: { model: "opus" }, key: "model" },
    {
      label: "a cron of three fields",
      capabilities: farm,
      patch: { schedule: { cron: "0 9 *", timezone: "UTC" } },
      key: "schedule",
    },
    {
      label: "no time zone",
      capabilities: farm,
      patch: { schedule: { cron: "0 9 * * *", timezone: " " } },
      key: "schedule",
    },
    {
      label: "an end before the start",
      capabilities: farm,
      patch: { schedule: { cron: "0 9 * * *", timezone: "UTC", starts: 10, ends: 5 } },
      key: "schedule",
    },
    {
      label: "no runs at all",
      capabilities: farm,
      patch: { schedule: { cron: "0 9 * * *", timezone: "UTC", max: 0 } },
      key: "schedule",
    },
    {
      label: "a window where there is none",
      capabilities: local,
      patch: {
        instructions: { kind: "prompt" as const, text: "x" },
        options: { folder: "/tmp" },
        schedule: { cron: "0 9 * * *", timezone: "UTC", max: 3 },
      },
      key: "schedule",
    },
  ])("$label is refused under $key", (row) => {
    expect(check(row.capabilities, row.patch)?.fields).toHaveProperty(row.key)
  })

  test("a window is fine where the backend takes one", () => {
    expect(
      check(farm, { schedule: { cron: "0 9 * * *", timezone: "UTC", starts: 5, ends: 10, max: 3 } }),
    ).toBeUndefined()
  })

  test.each<{ label: string; options: Definition["options"]; key: string }>([
    {
      label: "a repository that is not https",
      options: { repository: "ssh://git.example.com/a.git" },
      key: "repository",
    },
    {
      label: "a number over its maximum",
      options: { repository: "https://g.example.com/a", timeLimit: 61 },
      key: "timeLimit",
    },
    {
      label: "a number under its minimum",
      options: { repository: "https://g.example.com/a", timeLimit: 0 },
      key: "timeLimit",
    },
    {
      label: "a number that is text",
      options: { repository: "https://g.example.com/a", timeLimit: "ten" },
      key: "timeLimit",
    },
    {
      label: "a choice that does not exist",
      options: { repository: "https://g.example.com/a", overlap: "queue" },
      key: "overlap",
    },
    {
      label: "a list of too many",
      options: { repository: "https://g.example.com/a", plugins: Array.from({ length: 11 }, (_, i) => `p${i}`) },
      key: "plugins",
    },
    {
      label: "a list that is not strings",
      options: { repository: "https://g.example.com/a", plugins: [1] },
      key: "plugins",
    },
    {
      label: "a toggle that is text",
      options: { repository: "https://g.example.com/a", capped: "yes" },
      key: "capped",
    },
    { label: "a repository that is a number", options: { repository: 3 }, key: "repository" },
  ])("$label is refused under $key", (row) => {
    expect(check(farm, { options: row.options })?.fields).toHaveProperty(row.key)
  })

  test("a field `when` hides is neither required nor checked, and comes back once its condition holds", () => {
    const repository = "https://g.example.com/a"
    expect(check(farm, { options: { repository, budget: -5 } })).toBeUndefined()
    expect(check(farm, { options: { repository, capped: true } })?.fields).toHaveProperty("budget")
    expect(check(farm, { options: { repository, capped: true, budget: 100 } })?.fields).toHaveProperty("budget")
    expect(check(farm, { options: { repository, capped: true, budget: 5 } })).toBeUndefined()
  })

  test("the local fields are checked the same way, with nothing about them special-cased", () => {
    const prompt: Definition = {
      name: "Local",
      instructions: { kind: "prompt", text: "Go." },
      enabled: true,
      options: {},
    }
    expect(RoutinesValidate.check(local, prompt)).toBeUndefined()
    expect(RoutinesValidate.check(local, { ...prompt, options: { catchUp: 49 } })?.fields).toHaveProperty("catchUp")
    expect(RoutinesValidate.check(local, { ...prompt, options: { catchUp: 0 } })?.fields).toHaveProperty("catchUp")
    // Hidden while missed runs are not recovered: then it is not checked.
    expect(RoutinesValidate.check(local, { ...prompt, options: { recover: "none", catchUp: 0 } })).toBeUndefined()
    expect(RoutinesValidate.check(local, { ...prompt, options: { permissions: "root" } })?.fields).toHaveProperty(
      "permissions",
    )
    expect(RoutinesValidate.check(local, { ...prompt, model: "any" })).toBeUndefined()
  })
})
