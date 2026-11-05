import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DynWorkInstructions } from "../src/instructions"

// The managed block of the service's global AGENTS.md: the bridge's bytes, the user's own content kept before it, and a
// file that only changes when its content does. The live tests check that OpenCode loads it.

const rule = (id: string, name: string, instructions: string) => ({ id, name, instructions, hosts: ["opencode"] })
const block = (...rules: ReturnType<typeof rule>[]) =>
  DynWorkInstructions.block(DynWorkInstructions.select(rules)) ?? ""
const a = block(rule("a", "First", "first"))
const b = block(rule("b", "Second", "second"))

describe("block", () => {
  test("matches the bridge byte for byte: a blank line after the begin marker, between rules and before the end", () => {
    expect(block(rule("b", "Second", "  second\n"), rule("a", "First", "first"))).toBe(
      "<!-- systemprompt:begin (managed by the bridge; edits are replaced) -->\n" +
        "\n## First\n\nfirst\n" +
        "\n## Second\n\nsecond\n" +
        "\n<!-- systemprompt:end -->\n",
    )
    expect(DynWorkInstructions.block([])).toBeUndefined()
  })
})

describe("splice", () => {
  test("a file of its own holds only the block, and empties on clear", () => {
    expect(DynWorkInstructions.splice("", a)).toBe(a)
    expect(DynWorkInstructions.splice(a, undefined)).toBe("")
    expect(DynWorkInstructions.splice("", undefined)).toBe("")
  })

  test("the user's content stays and the block always goes last", () => {
    const appended = DynWorkInstructions.splice("# Mine\n\nKeep this.\n", a)
    expect(appended).toBe(`# Mine\n\nKeep this.\n\n${a}`)
    expect(DynWorkInstructions.splice(appended, b)).toBe(`# Mine\n\nKeep this.\n\n${b}`)
    expect(DynWorkInstructions.splice(appended, undefined)).toBe("# Mine\n\nKeep this.\n")
    // Like the bridge, the text after the block joins the text before it once the block is cut out.
    expect(DynWorkInstructions.splice(`# Top\n\n${a}\n# Bottom\n`, b)).toBe(`# Top# Bottom\n\n${b}`)
    expect(DynWorkInstructions.splice("# Mine\n", undefined)).toBe("# Mine\n")
  })

  test("the block the bridge left in a file is replaced", () => {
    expect(DynWorkInstructions.splice(`# Mine\n\n${block(rule("old", "Old", "stale"))}`, a)).toBe(`# Mine\n\n${a}`)
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
    await DynWorkInstructions.write(root, a)
    expect(await Bun.file(file).text()).toBe(a)
    const inode = (await stat(file)).ino
    await DynWorkInstructions.write(root, a)
    expect((await stat(file)).ino).toBe(inode)
    await DynWorkInstructions.write(root, b)
    expect(await Bun.file(file).text()).toBe(b)
    expect(await readdir(root)).toEqual(["AGENTS.md"])
    await DynWorkInstructions.write(root, undefined)
    expect(await readdir(root)).toEqual([])
  })
})
