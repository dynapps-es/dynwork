import { describe, expect, test } from "bun:test"
import type { Capabilities, Choice, Field } from "../../../src/routines/contract"
import {
  choicesOf,
  control,
  defaults,
  layout,
  picked,
  shown,
  toggled,
  valueOf,
  wide,
  type Control,
} from "../../../src/views/agents/fields"
import { setup } from "./fixture"

const field = (patch: Partial<Field> & Pick<Field, "key" | "kind">): Field => ({
  section: "workspace",
  label: patch.key,
  ...patch,
})
const choices: Choice[] = [
  { value: "a", label: "A" },
  { value: "b", label: "B" },
]

// One field of every kind the contract has, in the section the demo backends put theirs.
const everyKind: Field[] = [
  field({ key: "name1", kind: "text" }),
  field({ key: "notes", kind: "textarea" }),
  field({ key: "limit", kind: "number", min: 1 }),
  field({ key: "flag", kind: "toggle", default: false }),
  field({ key: "mode", kind: "select", choices }),
  field({ key: "many", kind: "multiselect", lookup: "plugins" }),
  field({ key: "dir", kind: "folder" }),
  field({ key: "repo", kind: "repo" }),
  field({ key: "tags", kind: "list" }),
]

describe("every field kind has a control", () => {
  test.each<[Field["kind"], Control]>([
    ["text", "text"],
    ["textarea", "textarea"],
    ["number", "number"],
    ["toggle", "toggle"],
    ["select", "radio"],
    ["multiselect", "choices"],
    ["folder", "folder"],
    ["repo", "repo"],
    ["list", "list"],
  ])("%s is drawn as %s", (kind, expected) => {
    const base = everyKind.find((candidate) => candidate.kind === kind)
    expect(base && control(base, base.choices ?? [])).toBe(expected)
  })

  test("a select of a few fixed choices is a radio list, a long or looked-up one a dropdown", () => {
    const many = Array.from({ length: 5 }, (_, index) => ({ value: `v${index}`, label: `V${index}` }))
    expect(control(field({ key: "a", kind: "select", choices }), choices)).toBe("radio")
    expect(control(field({ key: "a", kind: "select", choices: many }), many)).toBe("select")
    expect(control(field({ key: "a", kind: "select", lookup: "credentials:git_token" }), choices)).toBe("select")
    expect(control(field({ key: "a", kind: "select", lookup: "credentials:git_token" }), [])).toBe("select")
  })

  test("the kinds that hold long content take the whole row", () => {
    expect(
      everyKind.filter((candidate) => wide(control(candidate, candidate.choices ?? []))).map((c) => c.key),
    ).toEqual(["notes", "flag", "mode", "many", "tags"])
  })

  test("a select's choices come from the field, or from its lookup once loaded", () => {
    const lookup = (name: string) => (name === "plugins" ? choices : [])
    expect(choicesOf(field({ key: "a", kind: "select", choices }), lookup)).toEqual(choices)
    expect(choicesOf(field({ key: "a", kind: "multiselect", lookup: "plugins" }), lookup)).toEqual(choices)
    expect(choicesOf(field({ key: "a", kind: "multiselect", lookup: "other" }), lookup)).toEqual([])
    expect(choicesOf(field({ key: "a", kind: "text" }), lookup)).toEqual([])
  })
})

describe("a field's `when`", () => {
  const capped = field({ key: "capped", kind: "toggle", default: false })
  const budget = field({ key: "budget", kind: "number", when: { key: "capped", equals: true } })
  const fields = [capped, budget]

  test("hides it until the other field has the value", () => {
    expect(shown(budget, fields, {})).toBe(false)
    expect(shown(budget, fields, { capped: false })).toBe(false)
    expect(shown(budget, fields, { capped: true })).toBe(true)
  })

  test("reads the other field's default while the user has not touched it", () => {
    const on = field({ key: "capped", kind: "toggle", default: true })
    expect(shown(budget, [on, budget], {})).toBe(true)
    expect(valueOf(on, {})).toBe(true)
    expect(valueOf(on, { capped: false })).toBe(false)
  })

  test("compares arrays and objects by what they hold", () => {
    const picked = field({ key: "picked", kind: "multiselect", default: ["a"] })
    const extra = field({ key: "extra", kind: "text", when: { key: "picked", equals: ["a", "b"] } })
    expect(shown(extra, [picked, extra], { picked: ["a", "b"] })).toBe(true)
    expect(shown(extra, [picked, extra], {})).toBe(false)
  })

  test("a field without `when` is always shown", () => {
    expect(shown(capped, fields, {})).toBe(true)
  })

  test("a `when` on a key no field declares reads the options", () => {
    const orphan = field({ key: "x", kind: "text", when: { key: "elsewhere", equals: "yes" } })
    expect(shown(orphan, [orphan], { elsewhere: "yes" })).toBe(true)
    expect(shown(orphan, [orphan], {})).toBe(false)
  })
})

describe("the form's blocks come from the backend's fields", () => {
  const sectioned = (section: string, key: string) => field({ key, section, kind: "text" })
  const caps = (fields: Field[]) => ({ fields })

  test("workspace, permissions, plugins and limits are the backend's own block; the rest follow", () => {
    const fields = [
      sectioned("workspace", "w"),
      sectioned("permissions", "p"),
      sectioned("plugins", "pl"),
      sectioned("limits", "l"),
      sectioned("schedule", "s"),
      sectioned("custom", "c"),
      sectioned("advanced", "a"),
      sectioned("notifications", "n"),
      sectioned("connectors", "k"),
    ]
    const blocks = layout(caps(fields), {})
    const keys = (list: Field[]) => list.map((candidate) => candidate.key)
    expect(keys(blocks.where)).toEqual(["w", "p", "pl", "l"])
    expect(keys(blocks.extra)).toEqual(["s", "c"])
    expect(keys(blocks.advanced)).toEqual(["a"])
    expect(keys(blocks.notifications)).toEqual(["n"])
    expect(keys(blocks.connectors)).toEqual(["k"])
  })

  test("a hidden field is in no block, and shows up once its condition holds", () => {
    const budget = field({ key: "budget", kind: "number", section: "limits", when: { key: "capped", equals: true } })
    const capped = field({ key: "capped", kind: "toggle", section: "limits", default: false })
    const flat = (options: Record<string, boolean>) =>
      Object.values(layout(caps([capped, budget]), options))
        .flat()
        .map((candidate) => candidate.key)
    expect(flat({})).toEqual(["capped"])
    expect(flat({ capped: true })).toEqual(["capped", "budget"])
  })

  test("every field of every kind lands in exactly one block", () => {
    const placed = Object.values(layout(caps(everyKind), {})).flat()
    expect(placed.map((candidate) => candidate.key).toSorted()).toEqual(everyKind.map((c) => c.key).toSorted())
  })

  test("the defaults are the fields' own, and none for a field without one", () => {
    expect(defaults(caps(everyKind))).toEqual({ flag: false })
  })

  test("the demo backends lay out as the mockup: folder and permissions locally, repository and limits remotely", async () => {
    const view = await setup()
    const keys = (backend: string, options = {}) => {
      const blocks = layout(view.model.capabilities(backend) as Capabilities, options)
      return Object.fromEntries(Object.entries(blocks).map(([name, list]) => [name, list.map((item) => item.key)]))
    }
    expect(keys("local")).toEqual({
      where: ["folder", "permissions", "timeLimit", "recover", "catchUp"],
      extra: [],
      advanced: [],
      notifications: ["notify"],
      connectors: ["connectors"],
    })
    expect(keys("farm").where).toEqual(["repository", "branch", "access", "plugins", "timeLimit", "capped"])
    expect(keys("farm", { capped: true }).where).toContain("budget")
    expect(keys("farm").extra).toEqual(["overlap"])
    expect(keys("farm").advanced).toEqual(["profile", "label"])
  })
})

describe("a multiselect whose default is all", () => {
  const servers = field({ key: "connectors", kind: "multiselect", default: "all" })
  const some: Choice[] = [
    { value: "a", label: "a" },
    { value: "b", label: "b" },
  ]

  test("holds all until one is unpicked, then the rest; picking every one again goes back to all", () => {
    expect(picked(servers, "all", some)).toEqual(["a", "b"])
    expect(toggled(servers, "all", some, "a")).toEqual(["b"])
    expect(toggled(servers, ["b"], some, "a")).toBe("all")
    expect(toggled(servers, ["b"], some, "b")).toEqual([])
  })

  test("a multiselect without that default keeps lists", () => {
    const plain = field({ key: "plugins", kind: "multiselect" })
    expect(picked(plain, undefined, some)).toEqual([])
    expect(toggled(plain, ["a"], some, "b")).toEqual(["a", "b"])
  })
})
