import { describe, expect, test } from "bun:test"
import type { Capabilities } from "../../../src/routines/contract"
import { actions, facts, openable, routineStatus, runTone, stateKey, waiting } from "../../../src/views/agents/routine"
import { setup, t } from "./fixture"

const said = (words?: { key: string; params: Record<string, string> }) => words && t(words.key, words.params)

describe("the status tag", () => {
  test.each([
    ["Weekly ticket summary", "Active", "success"],
    ["Nightly test run", "Last run failed", "danger"],
    ["Timesheet draft", "Waiting for Home laptop", "warning"],
    ["Sort the Brain inbox", "Paused", undefined],
    ["Sync CRM", "Running", "info"],
    ["Release notes", "Manual only", undefined],
    ["Module audit", "Paused", undefined],
  ] as const)("%s reads %s", async (name, text, tone) => {
    const view = await setup()
    const routine = view.find(name)
    const status = routineStatus(routine, view.model.capabilities(routine.ref.backend))
    expect([said(status), status.tone]).toEqual([text, tone])
  })

  test("a backend that cannot serve says so on each of its routines", async () => {
    const view = await setup()
    view.farm.setStatus("signed-out")
    await view.wire.client.refresh()
    const crm = view.find("Sync CRM")
    expect(said(routineStatus(crm, view.model.capabilities("farm")))).toBe("Signed out")
    expect(said(routineStatus(view.find("Weekly ticket summary"), view.model.capabilities("local")))).toBe("Active")
  })
})

describe("actions follow the capabilities", () => {
  test("a ready backend allows every action of its own routine", async () => {
    const view = await setup()
    const tickets = view.find("Weekly ticket summary")
    const allowed = actions(tickets, view.model.capabilities("local"))
    expect(Object.values(allowed).every((action) => action.enabled)).toBe(true)
    expect(allowed.edit.reason).toBeUndefined()
  })

  test("a signed-out backend disables them all, with its own reason when it gives one", async () => {
    const view = await setup()
    view.farm.setStatus("signed-out")
    await view.wire.client.refresh()
    const crm = view.find("Sync CRM")
    const plain = actions(crm, view.model.capabilities("farm"))
    expect(Object.values(plain).map((action) => [action.enabled, said(action.reason)])).toEqual(
      Array.from({ length: 6 }, () => [false, "Signed out"]),
    )

    view.farm.setStatus("unreachable", "The Agent Farm does not answer.")
    await view.wire.client.refresh()
    expect(said(actions(crm, view.model.capabilities("farm")).start.reason)).toBe("The Agent Farm does not answer.")
  })

  test("a routine of another device runs only there, but can still be paused", async () => {
    const view = await setup()
    const allowed = actions(view.find("Timesheet draft"), view.model.capabilities("local"))
    expect([allowed.start.enabled, said(allowed.start.reason)]).toEqual([false, "Runs only on Home laptop."])
    expect(allowed.toggle.enabled).toBe(true)
  })

  test("an edit that replaces the routine says so; a backend without cancel cannot stop a run", async () => {
    const view = await setup()
    const crm = view.find("Sync CRM")
    const farm = view.model.capabilities("farm")!
    expect(said(actions(crm, farm).edit.reason)).toBe("Saving changes creates a new schedule.")
    const withoutCancel: Capabilities = { ...farm, actions: { ...farm.actions, cancel: false } }
    expect([actions(crm, withoutCancel).cancel.enabled, said(actions(crm, withoutCancel).cancel.reason)]).toEqual([
      false,
      "This backend cannot stop a run.",
    ])
  })

  test("a finished schedule cannot be switched back on, and an unknown backend allows nothing", async () => {
    const view = await setup()
    const crm = view.find("Sync CRM")
    expect(actions({ ...crm, state: "finished" }, view.model.capabilities("farm")).toggle.enabled).toBe(false)
    expect(actions(crm, undefined).start.enabled).toBe(false)
  })

  test("a run that never started has nothing to open", async () => {
    const view = await setup()
    await view.model.loadHistory(view.find("Weekly ticket summary").ref)
    const runs = view.model.history(view.find("Weekly ticket summary").ref).runs
    expect(runs.map(openable)).toEqual([true, true, false, true, true])
  })
})

describe("the detail's facts, the same layout for both kinds", () => {
  test("a local routine fills where, permissions and notifications from its backend's fields", async () => {
    const view = await setup()
    const tests = view.find("Nightly test run")
    const grouped = facts(tests, view.model.capabilities("local"), () => [])
    expect(grouped.where.map((fact) => [fact.label, fact.value])).toEqual([
      ["Project folder", "/Users/demo/Projects/portal"],
      ["Time limit (minutes)", "30"],
      ["Recover missed runs", "If recent"],
      ["Within (hours)", "6"],
    ])
    expect(grouped.permissions.map((fact) => [fact.label, fact.value])).toEqual([
      ["Permissions", "Don't ask"],
    ])
    expect(grouped.notifications.map((fact) => fact.value)).toEqual(["Only when something fails"])
    expect(grouped.options).toEqual([])
  })

  test("a remote routine fills where and its own options block, with lookup labels and `when` applied", async () => {
    const view = await setup()
    await view.model.loadChoices("farm", "plugins")
    const crm = view.find("Sync CRM")
    const grouped = facts(crm, view.model.capabilities("farm"), (lookup) => view.model.choices("farm", lookup))
    expect(grouped.where.map((fact) => [fact.key, fact.value])).toEqual([
      ["repository", "https://git.example.com/crm/sync.git"],
      ["branch", "main"],
      ["access", "crm-git"],
      ["plugins", ["CRM tools", "Odoo connector"]],
      ["timeLimit", "15"],
      ["capped", false],
    ])
    expect(grouped.options.map((fact) => [fact.key, fact.value])).toEqual([
      ["overlap", "Skip this one"],
      ["profile", "Standard"],
    ])
    expect([grouped.permissions, grouped.notifications]).toEqual([[], []])
  })

  test("a field shows only while its `when` holds", async () => {
    const view = await setup()
    const crm = view.find("Sync CRM")
    const capped = {
      ...crm,
      definition: { ...crm.definition, options: { ...crm.definition.options, capped: true, budget: 2 } },
    }
    const keys = facts(capped, view.model.capabilities("farm"), () => []).where.map((fact) => fact.key)
    expect(keys).toContain("budget")
    expect(facts(crm, view.model.capabilities("farm"), () => []).where.map((fact) => fact.key)).not.toContain("budget")
  })
})

describe("a run waiting for a permission", () => {
  test("is a running run with the reason `permission`: its own words, in the warning tone, and nothing else is", () => {
    const asking = { state: "running", reason: "permission" } as const
    expect([waiting(asking), waiting({ state: "running" }), waiting({ state: "failed", reason: "permission" })]).toEqual([
      true,
      false,
      false,
    ])
    expect(t(stateKey(asking))).toBe("Waiting for your permission")
    expect(t(stateKey({ state: "running" }))).toBe("Running")
    expect([runTone("running", "permission"), runTone("running"), runTone("failed", "permission")]).toEqual([
      "warning",
      "info",
      "danger",
    ])
  })
})
