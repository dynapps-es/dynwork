import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { DynWorkSync } from "../src/contract"
import { DynWorkMapping } from "../src/mapping"
import { DynWorkSkills } from "../src/skills"
import { alpha, apply } from "./fixture"

// The skill files of the systemprompt bridge: its bytes for the same manifest, its ledger, and a directory that keeps
// the user's own skills. The live tests check that OpenCode loads them. The expected texts below are what the bridge
// wrote into `~/.config/opencode/skills` for prod's skills (a quoted description, a plain one, a body of its own).

type Entry = DynWorkSync.Manifest["skills"][number]
const skill = (id: string, fields: Partial<Entry> = {}): Entry => ({
  id,
  name: id,
  description: "Plain description.",
  instructions: "# Body\n\nDo it.\n",
  ...fields,
})
const render = (entry: Entry, dir = DynWorkSkills.kebab(entry.id)) => DynWorkSkills.markdown(entry, dir)

describe("kebab", () => {
  test("lowercases, joins runs of other characters with one dash and trims the edges, as the bridge's kebab_dir", () => {
    expect(DynWorkSkills.kebab("who_am_i")).toBe("who-am-i")
    expect(DynWorkSkills.kebab("Dev__Pre.PR--Self check")).toBe("dev-pre-pr-self-check")
    expect(DynWorkSkills.kebab("_lead_")).toBe("lead")
    expect(DynWorkSkills.kebab("_")).toBe("")
    expect(DynWorkSkills.kebab(`${"a".repeat(63)}_b`)).toBe("a".repeat(63))
    expect(DynWorkSkills.kebab("a".repeat(70))).toBe("a".repeat(64))
  })
})

describe("markdown", () => {
  test("a body without front matter gets name, description and the body, ending in a newline", () => {
    expect(render(skill("agent_farm_runs", { instructions: "# Agent farm runs\n\nUse when someone asks.\n" }))).toBe(
      "---\nname: agent-farm-runs\ndescription: Plain description.\n---\n\n# Agent farm runs\n\nUse when someone asks.\n",
    )
    expect(render(skill("x", { instructions: "No final newline" }))).toBe(
      "---\nname: x\ndescription: Plain description.\n---\n\nNo final newline\n",
    )
  })

  test("a description is quoted when YAML would read it differently, with only the quotes escaped", () => {
    const description = (text: string) => render(skill("x", { description: text })).split("\n")[2]
    expect(description('Operate the farm ("la farm"). Use it ONLY when: it is named.')).toBe(
      'description: "Operate the farm (\\"la farm\\"). Use it ONLY when: it is named."',
    )
    expect(description("Use # sparingly")).toBe('description: "Use # sparingly"')
    expect(description("- starts like a list")).toBe('description: "- starts like a list"')
    expect(description("Route Odoo questions - DynBrain for how-to")).toBe(
      "description: Route Odoo questions - DynBrain for how-to",
    )
    // Bare, the bridge's `description: ` is null to YAML and OpenCode would skip the skill
    expect(description("")).toBe('description: ""')
  })

  test("front matter in the body keeps its keys in order but its name is forced to the directory", () => {
    expect(
      render(
        skill("my_skill", {
          instructions: "\n---\nname: Display Name\ndescription: Own\n\nlicense: MIT\n  name: indented\n---\n# Body",
        }),
      ),
    ).toBe("---\nname: my-skill\ndescription: Own\nlicense: MIT\n---\n# Body\n")
  })

  test("the author's other front matter keys follow the description, sorted, without the platform's own", () => {
    expect(
      render(
        skill("x", {
          frontmatter: {
            tags: ["a"],
            name: "ignored",
            title: "ignored",
            hosts: ["opencode"],
            metadata: { zeta: 1, alpha: ["one", { b: true, a: null }] },
            license: "MIT",
            "allowed-tools": "Bash(git:*)",
            empty: [],
            flagged: "true",
            number: "42",
          },
        }),
      ),
    ).toBe(
      [
        "---",
        "name: x",
        "description: Plain description.",
        "allowed-tools: Bash(git:*)",
        "empty: []",
        "flagged: 'true'",
        "license: MIT",
        "metadata:",
        "  alpha:",
        "  - one",
        "  - a: null",
        "    b: true",
        "  zeta: 1",
        "number: '42'",
        "---",
        "",
        "# Body",
        "",
        "Do it.",
        "",
      ].join("\n"),
    )
    // Only platform-owned keys: nothing is added
    expect(render(skill("x", { frontmatter: { tags: ["a"], hosts: [] } }))).toBe(
      "---\nname: x\ndescription: Plain description.\n---\n\n# Body\n\nDo it.\n",
    )
  })
})

describe("the alpha manifest", () => {
  const files = DynWorkMapping.map(apply()).skillFiles

  test("projects the bridge's files and its bundle version, and the marketplaces its ledger records", () => {
    expect(files?.files.map((file) => file.dir)).toEqual(["alpha-notes", "alpha-review", "who-am-i"])
    expect(files?.files[0]?.markdown).toBe(
      "---\nname: alpha-notes\ndescription: Turn a working session into short alpha-team notes.\n---\n\n# Alpha notes\n\nSummarize the session in five bullets: goal, decisions, open questions, next step, owner.\n",
    )
    // SHA-256 of `<dir>\0<file>\0` for each, computed apart from this code
    expect(DynWorkSkills.version(files?.files ?? [])).toBe("2591dede1da91341")
    expect(files?.marketplaces).toEqual(["alpha-local", "dynapps-commons"])
    expect(files?.skipped).toEqual([])
  })

  test("a skill for another host, or without a body, is not written; no skills at all means remove everything", () => {
    const other = {
      ...alpha,
      skills: [skill("kept"), skill("other", { hosts: ["claude-code"] }), skill("bare", { instructions: " " })],
    }
    expect(DynWorkMapping.map(apply(other)).skillFiles?.files.map((file) => file.dir)).toEqual(["kept"])
    expect(DynWorkMapping.map(apply({ ...alpha, skills: [] })).skillFiles).toBeUndefined()
    expect(
      DynWorkMapping.map(apply({ ...alpha, skills: [skill("other", { hosts: ["claude-code"] })] })).skillFiles,
    ).toEqual({
      files: [],
      marketplaces: ["alpha-local", "dynapps-commons"],
      skipped: [],
    })
    expect(DynWorkMapping.map(apply({ ...alpha, enabled_hosts: undefined })).skillFiles).toBeUndefined()
  })

  test("two skills for one directory, or an id that cannot name one, are reported and the first stays", () => {
    const clash = { ...alpha, skills: [skill("a_b"), skill("a-b"), skill("a.b")] }
    const projected = DynWorkMapping.map(apply(clash)).skillFiles
    expect(projected?.files.map((file) => file.dir)).toEqual(["a-b"])
    expect(projected?.skipped).toEqual(["a-b", "a.b"])
    // The mapping already drops ids that do not start alphanumeric; the projection itself refuses an empty directory
    expect(DynWorkSkills.project(clash, [skill("_")])?.skipped).toEqual(["_"])
  })
})

describe("write", () => {
  const roots: string[] = []
  afterEach(() => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))
  const directory = async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dynwork-skills-"))
    roots.push(root)
    return root
  }
  const projection = (...ids: string[]) => {
    const manifest = { ...alpha, skills: ids.map((id) => skill(id)) }
    return DynWorkSkills.project(manifest, manifest.skills)
  }
  const tree = async (root: string) =>
    (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: root, dot: true }))).toSorted()

  test("writes the files and the bridge's ledger, and a second write of the same content touches nothing", async () => {
    const root = await directory()
    await DynWorkSkills.write(root, projection("b_two", "a_one"))
    expect(await tree(root)).toEqual([
      "skills/.systemprompt-managed.json",
      "skills/a-one/SKILL.md",
      "skills/b-two/SKILL.md",
    ])
    expect(await Bun.file(path.join(root, "skills/a-one/SKILL.md")).text()).toBe(render(skill("a_one")))
    // serde_json's pretty print: two spaces, no final newline
    expect(await Bun.file(path.join(root, "skills/.systemprompt-managed.json")).text()).toBe(
      `{\n  "version": "${DynWorkSkills.version(projection("a_one", "b_two")?.files ?? [])}",\n  "ids": [\n    "a-one",\n    "b-two"\n  ],\n  "marketplaces": [\n    "alpha-local",\n    "dynapps-commons"\n  ]\n}`,
    )
    const inodes = await Promise.all(
      ["skills/a-one/SKILL.md", "skills/.systemprompt-managed.json"].map(
        async (file) => (await stat(path.join(root, file))).ino,
      ),
    )
    await DynWorkSkills.write(root, projection("a_one", "b_two"))
    expect(
      await Promise.all(
        ["skills/a-one/SKILL.md", "skills/.systemprompt-managed.json"].map(
          async (file) => (await stat(path.join(root, file))).ino,
        ),
      ),
    ).toEqual(inodes)
  })

  test("a skill that left the manifest goes with its directory, the user's own skills and runtime files stay", async () => {
    const root = await directory()
    await DynWorkSkills.write(root, projection("one", "two"))
    await mkdir(path.join(root, "skills/mine"))
    await Bun.write(path.join(root, "skills/mine/SKILL.md"), "---\nname: mine\ndescription: Mine.\n---\n")
    // What phase 07 puts beside SKILL.md of a skill that stays
    await Bun.write(path.join(root, "skills/one/references/notes.md"), "kept")
    await Bun.write(path.join(root, "skills/two/references/notes.md"), "goes with its skill")
    const changed = { ...alpha, skills: [skill("one", { instructions: "# New body\n" })] }
    await DynWorkSkills.write(root, DynWorkSkills.project(changed, changed.skills))
    expect(await tree(root)).toEqual([
      "skills/.systemprompt-managed.json",
      "skills/mine/SKILL.md",
      "skills/one/SKILL.md",
      "skills/one/references/notes.md",
    ])
    expect(await Bun.file(path.join(root, "skills/one/SKILL.md")).text()).toContain("# New body")
    expect(JSON.parse(await Bun.file(path.join(root, "skills/.systemprompt-managed.json")).text()).ids).toEqual(["one"])
  })

  test("without skills everything managed and the ledger are removed, and nothing else", async () => {
    const root = await directory()
    await DynWorkSkills.write(root, undefined)
    expect(await readdir(root)).toEqual([])
    await DynWorkSkills.write(root, projection("one"))
    await Bun.write(path.join(root, "skills/mine/SKILL.md"), "mine")
    await Bun.write(path.join(root, "skills/one/references/notes.md"), "gone")
    await DynWorkSkills.write(root, undefined)
    expect(await tree(root)).toEqual(["skills/mine/SKILL.md"])
  })

  test("a corrupt ledger fails and leaves every file as it was", async () => {
    const root = await directory()
    await DynWorkSkills.write(root, projection("one"))
    const ledger = path.join(root, "skills/.systemprompt-managed.json")
    await Bun.write(ledger, "{ not json")
    await expect(DynWorkSkills.write(root, projection("two"))).rejects.toThrow("is corrupt")
    await expect(DynWorkSkills.write(root, undefined)).rejects.toThrow("is corrupt")
    await Bun.write(ledger, JSON.stringify({ version: "x", ids: ["../escape"] }))
    await expect(DynWorkSkills.write(root, undefined)).rejects.toThrow("is corrupt")
    expect(await tree(root)).toEqual(["skills/.systemprompt-managed.json", "skills/one/SKILL.md"])
  })
})
