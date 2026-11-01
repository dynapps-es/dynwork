import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm, stat, symlink } from "node:fs/promises"
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

const consumer: {
  plans: Record<string, { runtime_files: Array<{ path: string; bytes: number[]; executable: boolean }> }>
} = await Bun.file(path.join(import.meta.dir, "../../sp-client/test/fixtures/consumer.json")).json()

// A skill's runtime files from its publication bundle, as the bridge's `readback::materialize` writes them beside the
// SKILL.md the projection wrote: the plan observed on the local harness for `alpha_notes`.
describe("runtime files", () => {
  const roots: string[] = []
  afterEach(() => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))
  const planned = async (id = "alpha_notes") =>
    consumer.plans[id]?.runtime_files.map((file) => ({
      path: file.path,
      content: Buffer.from(file.bytes).toString("base64"),
      executable: file.executable,
    })) ?? []
  const file = (path: string, text: string, executable = false) => ({
    path,
    content: Buffer.from(text).toString("base64"),
    executable,
  })
  const setup = async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dynwork-runtime-"))
    roots.push(root)
    const projection = DynWorkMapping.map(apply()).skillFiles
    await DynWorkSkills.write(root, projection)
    return { root, projection, dir: path.join(root, "skills", "alpha-notes") }
  }
  const mode = async (file: string) => (await stat(file)).mode & 0o777

  test("writes every file beside SKILL.md with the bridge's modes and sidecar, reads them back, keeps our SKILL.md", async () => {
    const { root, projection, dir } = await setup()
    const projected = await Bun.file(path.join(dir, "SKILL.md")).text()
    const files = [...(await planned()), file("scripts/run.sh", "#!/bin/sh\necho ok\n", true)]
    const result = await DynWorkSkills.install(root, projection, "alpha_notes", files)
    expect(result.outcome).toBe("written")
    expect(result.files.map((entry) => [entry.path, entry.content, entry.mode])).toEqual(
      files.map((entry) => [entry.path, "verified", "verified"]),
    )
    const config = result.files.find((entry) => entry.path === "config.yaml")
    expect(config?.digest).toBe(
      new Bun.CryptoHasher("sha256").update(await Bun.file(path.join(dir, "config.yaml")).bytes()).digest("hex"),
    )
    expect(await Bun.file(path.join(dir, "config.yaml")).text()).toStartWith("id: alpha_notes\n")
    expect(await mode(path.join(dir, "config.yaml"))).toBe(0o644)
    expect(await mode(path.join(dir, "scripts/run.sh"))).toBe(0o755)
    // The sidecar is the bridge's: compact JSON of the paths, mode 0600
    expect(await Bun.file(path.join(dir, ".systemprompt-runtime.json")).text()).toBe(
      JSON.stringify(files.map((entry) => entry.path)),
    )
    expect(await mode(path.join(dir, ".systemprompt-runtime.json"))).toBe(0o600)
    // The bundle's SKILL.md was read back, then the projected one restored, as the bridge's next sync does
    expect(result.files.find((entry) => entry.path === "SKILL.md")?.bytes).not.toBe(projected.length)
    expect(await Bun.file(path.join(dir, "SKILL.md")).text()).toBe(projected)
  })

  test("a new plan prunes what the previous one listed and no longer does, and nothing else", async () => {
    const { root, projection, dir } = await setup()
    await DynWorkSkills.install(root, projection, "alpha_notes", [
      ...(await planned()),
      file("references/old.md", "old"),
    ])
    await Bun.write(path.join(dir, "notes-of-the-user.md"), "mine")
    const second = await DynWorkSkills.install(root, projection, "alpha_notes", [
      ...(await planned()),
      file("references/new.md", "new"),
    ])
    expect(second.outcome).toBe("written")
    expect(await Bun.file(path.join(dir, "references/old.md")).exists()).toBe(false)
    expect(await Bun.file(path.join(dir, "references/new.md")).text()).toBe("new")
    expect(await Bun.file(path.join(dir, "notes-of-the-user.md")).text()).toBe("mine")
  })

  test("runtime files survive the projection's rewrites and go with the skill's directory", async () => {
    const { root, projection, dir } = await setup()
    await DynWorkSkills.install(root, projection, "alpha_notes", [...(await planned()), file("references/a.md", "a")])
    await DynWorkSkills.write(
      root,
      DynWorkMapping.map(
        apply({
          ...alpha,
          skills: alpha.skills.map((entry) => ({ ...entry, instructions: `${entry.instructions}\nmore` })),
        }),
      ).skillFiles,
    )
    expect(await Bun.file(path.join(dir, "references/a.md")).text()).toBe("a")
    expect(await Bun.file(path.join(dir, ".systemprompt-runtime.json")).exists()).toBe(true)
    await DynWorkSkills.write(root, undefined)
    expect(await readdir(path.join(root, "skills"))).toEqual([])
  })

  test("refuses a plan without SKILL.md, a path that leaves the directory, a duplicate, and an unmanaged skill", async () => {
    const { root, projection, dir } = await setup()
    const base = await planned()
    expect(
      (
        await DynWorkSkills.install(
          root,
          projection,
          "alpha_notes",
          base.filter((entry) => entry.path !== "SKILL.md"),
        )
      ).outcome,
    ).toBe("invalid")
    expect(
      (await DynWorkSkills.install(root, projection, "alpha_notes", [...base, file("../escape.md", "x")])).outcome,
    ).toBe("invalid")
    expect(
      (await DynWorkSkills.install(root, projection, "alpha_notes", [...base, file("a/./b.md", "x")])).outcome,
    ).toBe("invalid")
    expect(
      (await DynWorkSkills.install(root, projection, "alpha_notes", [...base, file("config.yaml", "again")])).outcome,
    ).toBe("invalid")
    expect((await DynWorkSkills.install(root, projection, "not_in_manifest", base)).outcome).toBe("missing")
    expect((await DynWorkSkills.install(root, undefined, "alpha_notes", base)).outcome).toBe("missing")
    expect(await Bun.file(path.join(root, "skills", "escape.md")).exists()).toBe(false)
    expect(await Bun.file(path.join(dir, ".systemprompt-runtime.json")).exists()).toBe(false)
  })

  test("never writes through a symbolic link", async () => {
    const { root, projection, dir } = await setup()
    const outside = await mkdtemp(path.join(tmpdir(), "dynwork-outside-"))
    roots.push(outside)
    await symlink(outside, path.join(dir, "references"))
    const result = await DynWorkSkills.install(root, projection, "alpha_notes", [
      ...(await planned()),
      file("references/x.md", "x"),
    ])
    expect(result.outcome).toBe("invalid")
    expect(await readdir(outside)).toEqual([])
  })

  test("inspect: the files a receipt recorded are still there, SKILL.md aside since the projection owns it", async () => {
    const { root, projection, dir } = await setup()
    const result = await DynWorkSkills.install(root, projection, "alpha_notes", await planned())
    const recorded = result.files.map((entry) => ({
      path: entry.path,
      digest: entry.digest,
      bytes: entry.bytes,
      executable: entry.executable,
    }))
    expect(await DynWorkSkills.inspect(root, projection, "alpha_notes", recorded)).toBe(true)
    await Bun.write(path.join(dir, "config.yaml"), "changed")
    expect(await DynWorkSkills.inspect(root, projection, "alpha_notes", recorded)).toBe(false)
    await rm(dir, { recursive: true })
    expect(await DynWorkSkills.inspect(root, projection, "alpha_notes", recorded)).toBe(false)
  })
})
