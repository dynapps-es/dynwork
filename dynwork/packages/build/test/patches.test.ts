import { afterEach, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Patches } from "../src/patches"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const git = (root: string, ...args: string[]) =>
  $`git -c user.name=test -c user.email=test@example.com -c commit.gpgsign=false ${args}`.cwd(root).quiet()

const write = async (root: string, file: string, text: string) => {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true })
  await Bun.write(path.join(root, file), text)
}

const lines = (count: number, prefix = "line") => Array.from({ length: count }, (_, i) => `${prefix} ${i}\n`).join("")

const table = (files: string[]) => files.map((file) => `| \`${file}\` | why | risk |`).join("\n")

const patchesFile = (files: string[], budget = "Budget: 250 lines") =>
  `# Upstream patches\n\n${budget}\n\n| File | Why | Risk |\n| --- | --- | --- |\n${table(files)}\n`

// An upstream tag `v1.0.0` with `src/a.ts` (10 lines), `src/b.ts` and `src/gone.ts`, then a DynWork commit on top.
// `change` edits the working tree for that commit.
const fixture = async (change: (root: string) => Promise<void>, listed: string[], budget?: string) => {
  const root = await mkdtemp(path.join(tmpdir(), "dynwork-patches-"))
  roots.push(root)
  await git(root, "init", "-q", "-b", "main")
  await write(root, "src/a.ts", lines(10))
  await write(root, "src/b.ts", lines(10, "b"))
  await write(root, "src/gone.ts", lines(3, "gone"))
  await write(root, "README.md", "upstream\n")
  await write(root, "bun.lock", lines(5, "lock"))
  await git(root, "add", "-A")
  await git(root, "commit", "-q", "-m", "upstream release")
  await git(root, "tag", "v1.0.0")
  await write(root, "dynwork/UPSTREAM", "v1.0.0\n")
  await write(root, "dynwork/PATCHES.md", patchesFile(listed, budget))
  await write(root, "dynwork/packages/x/index.ts", "export {}\n")
  await write(root, "plans/active/plan.md", "local\n")
  await change(root)
  await git(root, "add", "-A")
  await git(root, "commit", "-q", "-m", "feat(dynwork): stack")
  return root
}

describe("patch guard", () => {
  test("passes when every modified upstream file is listed and no other file differs", async () => {
    const root = await fixture(
      async (root) => {
        await write(root, "src/a.ts", lines(10) + "extra\n")
      },
      ["src/a.ts"],
    )

    const result = await Patches.check(root)

    expect(result.problems).toEqual([])
    expect(result.base).toBe("v1.0.0")
    expect(result.files).toEqual([{ file: "src/a.ts", status: "M", added: 1, removed: 0, listed: true }])
    expect(result.used).toBe(1)
  })

  test("passes with no upstream change at all, when only dynwork/ and plans/ differ", async () => {
    const root = await fixture(async () => {}, [])

    const result = await Patches.check(root)

    expect(result.problems).toEqual([])
    expect(result.files).toEqual([])
  })

  test("fails on a modified upstream file the table does not list", async () => {
    const root = await fixture(
      async (root) => {
        await write(root, "src/a.ts", lines(10) + "extra\n")
        await write(root, "src/b.ts", lines(10, "b") + "extra\n")
      },
      ["src/a.ts"],
    )

    const result = await Patches.check(root)

    expect(result.problems).toEqual(["src/b.ts differs from v1.0.0 but PATCHES.md does not list it"])
  })

  test("fails on a new upstream-path file the table does not list", async () => {
    const root = await fixture(async (root) => {
      await write(root, ".github/workflows/dynwork.yml", "name: dynwork\n")
    }, [])

    const result = await Patches.check(root)

    expect(result.problems).toEqual([
      ".github/workflows/dynwork.yml differs from v1.0.0 but PATCHES.md does not list it",
    ])
  })

  test("fails on a deleted upstream file the table does not list, and passes once it is listed", async () => {
    const remove = async (root: string) => {
      await rm(path.join(root, "src/gone.ts"))
    }

    const unlisted = await Patches.check(await fixture(remove, []))
    const listed = await Patches.check(await fixture(remove, ["src/gone.ts"]))

    expect(unlisted.problems).toEqual(["src/gone.ts differs from v1.0.0 but PATCHES.md does not list it"])
    expect(listed.problems).toEqual([])
    expect(listed.files).toEqual([{ file: "src/gone.ts", status: "D", added: 0, removed: 3, listed: true }])
  })

  test("fails on a stale row: the table lists a file that does not differ from the tag", async () => {
    const root = await fixture(
      async (root) => {
        await write(root, "src/a.ts", lines(10) + "extra\n")
      },
      ["src/a.ts", "src/b.ts"],
    )

    const result = await Patches.check(root)

    expect(result.stale).toEqual(["src/b.ts"])
    expect(result.problems).toEqual(["PATCHES.md lists src/b.ts but it does not differ from v1.0.0"])
  })

  test("fails when a patch was reverted to the upstream content but its row stayed", async () => {
    const root = await fixture(
      async (root) => {
        await write(root, "src/a.ts", lines(10) + "extra\n")
      },
      ["src/a.ts"],
    )
    await write(root, "src/a.ts", lines(10))
    await git(root, "commit", "-q", "-am", "revert the patch")

    const result = await Patches.check(root)

    expect(result.problems).toEqual(["PATCHES.md lists src/a.ts but it does not differ from v1.0.0"])
  })

  test("fails when added plus removed lines of modified upstream files exceed the budget", async () => {
    // 6 added + 4 removed on src/a.ts and 3 added on src/b.ts is 13 lines.
    const change = async (root: string) => {
      await write(root, "src/a.ts", lines(6) + lines(6, "new"))
      await write(root, "src/b.ts", lines(10, "b") + lines(3, "more"))
    }

    const over = await Patches.check(await fixture(change, ["src/a.ts", "src/b.ts"], "Budget: 12 lines"))
    const at = await Patches.check(await fixture(change, ["src/a.ts", "src/b.ts"], "Budget: 13 lines"))

    expect(over.used).toBe(13)
    expect(over.problems).toEqual(["Modified upstream files change 13 lines, over the budget of 12"])
    expect(at.used).toBe(13)
    expect(at.problems).toEqual([])
  })

  test("does not count new files toward the budget, but still requires their row", async () => {
    const root = await fixture(
      async (root) => {
        await write(root, "src/a.ts", lines(10) + "extra\n")
        await write(root, ".github/workflows/dynwork.yml", lines(100, "step"))
      },
      ["src/a.ts", ".github/workflows/dynwork.yml"],
      "Budget: 5 lines",
    )

    const result = await Patches.check(root)

    expect(result.used).toBe(1)
    expect(result.problems).toEqual([])
  })

  test("does not count the regenerated lockfile toward the budget, but still requires its row", async () => {
    const root = await fixture(
      async (root) => {
        await write(root, "bun.lock", lines(40, "relocked"))
      },
      ["bun.lock"],
      "Budget: 5 lines",
    )

    const result = await Patches.check(root)

    expect(result.used).toBe(0)
    expect(result.problems).toEqual([])
  })

  test("lists a symlink like any other file", async () => {
    const link = async (root: string) => {
      await mkdir(path.join(root, "src/themes"), { recursive: true })
      await symlink("../../dynwork/packages/x/index.ts", path.join(root, "src/themes/deep.json"))
    }

    const unlisted = await Patches.check(await fixture(link, []))
    const listed = await Patches.check(await fixture(link, ["src/themes/deep.json"], "Budget: 0 lines"))

    expect(unlisted.problems).toEqual(["src/themes/deep.json differs from v1.0.0 but PATCHES.md does not list it"])
    expect(listed.problems).toEqual([])
    expect(listed.files).toEqual([{ file: "src/themes/deep.json", status: "A", added: 1, removed: 0, listed: true }])
  })

  test("ignores changes under dynwork/ and plans/", async () => {
    const root = await fixture(async (root) => {
      await write(root, "dynwork/packages/x/index.ts", lines(500))
      await write(root, "plans/active/plan.md", lines(500))
    }, [])

    const result = await Patches.check(root)

    expect(result.problems).toEqual([])
    expect(result.files).toEqual([])
  })

  test("reads the base from dynwork/UPSTREAM", async () => {
    const root = await fixture(
      async (root) => {
        await write(root, "src/a.ts", lines(10) + "extra\n")
      },
      ["src/a.ts"],
    )
    await git(root, "tag", "v1.1.0")
    await write(root, "src/b.ts", lines(10, "b") + "extra\n")
    await write(root, "dynwork/UPSTREAM", "v1.1.0\n")
    await git(root, "commit", "-q", "-am", "rebase onto v1.1.0")

    const result = await Patches.check(root)

    expect(result.base).toBe("v1.1.0")
    expect(result.files.map((item) => item.file)).toEqual(["src/b.ts"])
    expect(result.stale).toEqual(["src/a.ts"])
  })

  test("throws when PATCHES.md has no budget line", async () => {
    const root = await fixture(async () => {}, [])
    await write(root, "dynwork/PATCHES.md", "| File | Why |\n| --- | --- |\n")

    await expect(Patches.check(root)).rejects.toThrow("no `Budget: <n> lines` line")
  })

  test("throws when the base tag is not in the clone", async () => {
    const root = await fixture(async () => {}, [])
    await write(root, "dynwork/UPSTREAM", "v9.9.9\n")

    await expect(Patches.check(root)).rejects.toThrow("upstream tag v9.9.9")
  })

  test("prints a table row per file with its counts, and a FAIL line per problem", async () => {
    const root = await fixture(
      async (root) => {
        await write(root, "src/a.ts", lines(10) + "extra\n")
        await write(root, "src/b.ts", lines(10, "b") + "extra\n")
      },
      ["src/a.ts", "src/gone.ts"],
    )

    const output = Patches.format(await Patches.check(root)).split("\n")

    expect(output[0]).toMatch(/^File\s+Status\s+\+\s+-\s+Listed$/)
    expect(output).toContainEqual(expect.stringMatching(/^src\/a\.ts\s+M\s+1\s+0\s+yes$/))
    expect(output).toContainEqual(expect.stringMatching(/^src\/b\.ts\s+M\s+1\s+0\s+NO$/))
    expect(output).toContainEqual(expect.stringMatching(/^src\/gone\.ts\s+-\s+-\s+-\s+stale$/))
    expect(output).toContainEqual("Base v1.0.0: 2 upstream files differ, 2 of 250 budgeted lines used.")
    expect(output.filter((line) => line.startsWith("FAIL "))).toHaveLength(2)
  })
})
