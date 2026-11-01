import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DynWorkInstructions } from "../src/instructions"

// The managed block of the service's global AGENTS.md: the bridge's format, the user's own content kept around it, and
// a file that only changes when its content does. The live tests check that OpenCode loads it.

const block = (rules: string) => `${DynWorkInstructions.begin}\n\n${rules}\n${DynWorkInstructions.end}\n`

describe("merge", () => {
  test("a file of its own holds only the block, and goes away on clear", () => {
    expect(DynWorkInstructions.merge("", "## a\n\nfirst")).toBe(
      "<!-- systemprompt:begin (managed by DynWork; edits are replaced) -->\n\n## a\n\nfirst\n<!-- systemprompt:end -->\n",
    )
    expect(DynWorkInstructions.merge(block("## a\n\nfirst"), undefined)).toBeUndefined()
    expect(DynWorkInstructions.merge("", undefined)).toBeUndefined()
  })

  test("the user's content stays: the block is appended, replaced in place and removed", () => {
    const appended = DynWorkInstructions.merge("# Mine\n\nKeep this.\n", "## a\n\nfirst")
    expect(appended).toBe(`# Mine\n\nKeep this.\n\n${block("## a\n\nfirst")}`)
    expect(DynWorkInstructions.merge(appended ?? "", "## b\n\nsecond")).toBe(
      `# Mine\n\nKeep this.\n\n${block("## b\n\nsecond")}`,
    )
    expect(DynWorkInstructions.merge(appended ?? "", undefined)).toBe("# Mine\n\nKeep this.\n")
    const between = `# Top\n\n${block("## a\n\nfirst")}\n# Bottom\n`
    expect(DynWorkInstructions.merge(between, "## b\n\n$& $1")).toBe(`# Top\n\n${block("## b\n\n$& $1")}\n# Bottom\n`)
    expect(DynWorkInstructions.merge("# Mine\n", undefined)).toBe("# Mine\n")
  })

  test("a block an older writer left is replaced", () => {
    const old = "<!-- systemprompt:begin (managed by systemprompt) -->\n\n## old\n\nstale\n<!-- systemprompt:end -->\n"
    expect(DynWorkInstructions.merge(old, "## a\n\nfirst")).toBe(block("## a\n\nfirst"))
  })
})

describe("write", () => {
  const roots: string[] = []
  afterEach(() => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))
  const directory = async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dynwork-instructions-"))
    roots.push(root)
    return root
  }

  test("writes only on change, leaves no temporary file and removes an emptied file", async () => {
    const root = await directory()
    const file = path.join(root, "AGENTS.md")
    await DynWorkInstructions.write(root, undefined)
    expect(await Bun.file(file).exists()).toBe(false)
    await DynWorkInstructions.write(root, "## a\n\nfirst")
    expect(await Bun.file(file).text()).toBe(block("## a\n\nfirst"))
    const inode = (await stat(file)).ino
    await DynWorkInstructions.write(root, "## a\n\nfirst")
    expect((await stat(file)).ino).toBe(inode)
    await DynWorkInstructions.write(root, "## b\n\nsecond")
    expect(await Bun.file(file).text()).toBe(block("## b\n\nsecond"))
    expect(await readdir(root)).toEqual(["AGENTS.md"])
    await DynWorkInstructions.write(root, undefined)
    expect(await readdir(root)).toEqual([])
  })
})
