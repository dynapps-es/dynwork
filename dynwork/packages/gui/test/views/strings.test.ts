import { describe, expect, test } from "bun:test"
import { RunState } from "../../src/routines/contract"
import { tabs } from "../../src/views/agents/model"
import { statuses, wheres } from "../../src/views/agents/routine"
import strings from "../../src/views/en"

const table: Record<string, string> = strings

describe("the views' strings", () => {
  // The plugin's `t` interpolates `{{name}}` only: a single-brace placeholder reaches the screen as written.
  test("use the {{name}} placeholder syntax", () => {
    const single = Object.entries(strings).filter(([, value]) => /(^|[^{])\{[a-zA-Z]+\}([^}]|$)/.test(value))
    expect(single).toEqual([])
  })

  // The platform behind the accounts is never named on screen: it is Governance.
  test("never name the platform behind Governance", () => {
    expect(Object.entries(strings).filter(([, value]) => /system\s*prompt/i.test(value))).toEqual([])
  })

  test("have every key the Agents view builds from data", () => {
    const keys = [
      ...[...RunState.literals, "waiting"].map((state) => `agents.run.${state}`),
      ...statuses.map((status) => `agents.filter.${status}`),
      ...wheres.map((where) => `agents.where.${where}`),
      ...tabs.map((tab) => `agents.tab.${tab}`),
      ...["ready", "signed-out", "unreachable", "disabled"].map((status) => `agents.backend.${status}`),
      ...["local", "remote"].map((kind) => `agents.backend.${kind}.ready`),
      ...Array.from({ length: 7 }, (_, day) => [`agents.repeat.weekly.${day}`, `agents.day.short.${day}`]).flat(),
      // The reasons the local routines' clock writes (`RoutinesClock.Reason`).
      ...["closed", "grouped", "overlap", "restart", "start"].map((reason) => `agents.why.${reason}`),
    ]
    expect(keys.filter((key) => !table[key])).toEqual([])
  })
})
