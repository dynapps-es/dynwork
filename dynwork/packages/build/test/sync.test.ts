import { afterEach, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { appendFile, exists, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Sync } from "../src/sync"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const git = (root: string, ...args: string[]) => $`git ${args}`.cwd(root).quiet()

const text = async (root: string, ...args: string[]) => (await git(root, ...args).text()).trim()

const write = async (root: string, file: string, content: string) => {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true })
  await Bun.write(path.join(root, file), content)
}

const commit = async (root: string, message: string) => {
  await git(root, "add", "-A")
  await git(root, "commit", "-q", "-m", message)
}

const lines = (first: string) => [first, ...Array.from({ length: 9 }, (_, i) => `line ${i + 1}`)].join("\n") + "\n"

// An upstream tag `v1.0.0`, a DynWork stack on `main` (the overlay, then a patch to `src/a.ts`), and two upstream
// targets from the tag: `next` changes `src/b.ts` and is tagged `v1.1.0`, `clash` changes the line DynWork patched.
// The checkout is left on `main` with a clean tree.
const fixture = async (listed = ["src/a.ts"]) => {
  const root = await mkdtemp(path.join(tmpdir(), "dynwork-sync-test-"))
  roots.push(root)
  await git(root, "init", "-q", "-b", "main")
  // Repo-local identity in one write; the worktree shares this config.
  await appendFile(
    path.join(root, ".git/config"),
    "[user]\n\tname = test\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n",
  )
  await write(root, "src/a.ts", lines("a"))
  await write(root, "src/b.ts", lines("b"))
  await commit(root, "upstream release")
  await git(root, "tag", "v1.0.0")

  await git(root, "switch", "-q", "-c", "next")
  await write(root, "src/b.ts", lines("b upstream"))
  await commit(root, "upstream change to b")
  await git(root, "tag", "v1.1.0")

  await git(root, "switch", "-q", "-c", "clash", "v1.0.0")
  await write(root, "src/a.ts", lines("a upstream"))
  await commit(root, "upstream change to a")

  await git(root, "switch", "-q", "main")
  await write(root, "dynwork/UPSTREAM", "v1.0.0\n")
  await write(
    root,
    "dynwork/PATCHES.md",
    `Budget: 250 lines\n\n| File | Why | Risk |\n| --- | --- | --- |\n${listed.map((file) => `| \`${file}\` | why | risk |`).join("\n")}\n`,
  )
  await commit(root, "feat(dynwork): add the overlay")
  await write(root, "src/a.ts", lines("a dynwork"))
  await commit(root, "feat(dynwork): patch a")
  return root
}

// What a sync must never change in the checkout it runs from.
const snapshot = async (root: string) => ({
  branches: await text(root, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"),
  head: await text(root, "symbolic-ref", "HEAD"),
  status: await text(root, "status", "--porcelain"),
})

describe("upstream sync", () => {
  test("rebases the stack onto a branch in a throwaway worktree and leaves the checkout alone", async () => {
    const root = await fixture()
    const before = await snapshot(root)

    const result = await Sync.run({ root, target: "next", remote: false, checks: "guard" })

    expect(result.exit).toBe(0)
    expect(result.conflict).toBeUndefined()
    expect(result.base.ref).toBe("v1.0.0")
    expect(result.target).toEqual({ ref: "next", sha: await text(root, "rev-parse", "next"), tag: false })
    expect(result.commits.map((item) => item.subject)).toEqual([
      "feat(dynwork): add the overlay",
      "feat(dynwork): patch a",
    ])
    expect(result.steps.map((step) => [step.name, step.status])).toEqual([
      ["worktree", "pass"],
      ["rebase", "pass"],
      ["patch guard", "pass"],
    ])
    expect(result.rangeDiff).toMatch(/^1: {2}\w+ = 1: {2}\w+ feat\(dynwork\): add the overlay$/m)
    expect(result.rangeDiff).toMatch(/^2: {2}\w+ = 2: {2}\w+ feat\(dynwork\): patch a$/m)
    // The guard measured the stack against the target commit, not the old tag.
    expect(result.steps[2]?.output).toContain(`Base ${result.target.sha}: 1 upstream files differ`)
    expect(await snapshot(root)).toEqual(before)
    expect(await exists(result.worktree.path)).toBe(false)
    expect(await text(root, "worktree", "list", "--porcelain")).not.toContain(result.worktree.path)
  })

  test("reports the conflicted files and the DynWork commit that hit them, then aborts the rebase", async () => {
    const root = await fixture()
    const before = await snapshot(root)
    const main = await text(root, "rev-parse", "main")

    const result = await Sync.run({ root, target: "clash", remote: false, checks: "guard", keep: true })

    expect(result.exit).toBe(2)
    expect(result.conflict?.files).toEqual(["src/a.ts"])
    expect(result.conflict?.commit).toEqual({
      sha: await text(root, "rev-parse", "main"),
      subject: "feat(dynwork): patch a",
    })
    expect(result.steps.map((step) => [step.name, step.status])).toEqual([
      ["worktree", "pass"],
      ["rebase", "fail"],
    ])
    // The first commit applied before the conflict; the range-diff shows how far it got.
    expect(result.rangeDiff).toMatch(/^1: {2}\w+ = 1: {2}\w+ feat\(dynwork\): add the overlay$/m)
    expect(result.worktree.kept).toBe(true)
    expect(await text(result.worktree.path, "rev-parse", "HEAD")).toBe(main)
    expect(await text(result.worktree.path, "status", "--porcelain")).toBe("")
    expect(await snapshot(root)).toEqual(before)

    const report = Sync.report(result)
    expect(report).toContain("Result: **conflicts** (exit 2)")
    expect(report).toContain("feat(dynwork): patch a` (commit 2 of 2), with conflicts in:\n\n- `src/a.ts`")
    expect(report).toContain(`| Worktree | \`${result.worktree.path}\` (kept) |`)
    expect(report).toContain("## range-diff")

    await git(root, "worktree", "remove", "--force", result.worktree.path)
  })

  test("commits a tag target to dynwork/UPSTREAM in the worktree only", async () => {
    const root = await fixture()

    const result = await Sync.run({ root, target: "v1.1.0", remote: false, checks: "guard", keep: true })

    expect(result.exit).toBe(0)
    expect(result.target.tag).toBe(true)
    expect(await Bun.file(path.join(result.worktree.path, "dynwork/UPSTREAM")).text()).toBe("v1.1.0\n")
    expect(await text(result.worktree.path, "log", "-1", "--format=%s")).toBe("chore(dynwork): track upstream v1.1.0")
    expect(await text(result.worktree.path, "status", "--porcelain")).toBe("")
    expect(result.steps.find((step) => step.name === "patch guard")?.output).toContain("Base v1.1.0: 1 upstream files")
    expect(await Bun.file(path.join(root, "dynwork/UPSTREAM")).text()).toBe("v1.0.0\n")
    expect(await text(root, "show", "main:dynwork/UPSTREAM")).toBe("v1.0.0")

    await git(root, "worktree", "remove", "--force", result.worktree.path)
  })

  test("fails the checks when the rebased stack changes an upstream file PATCHES.md does not list", async () => {
    const root = await fixture([])

    const result = await Sync.run({ root, target: "next", remote: false, checks: "guard" })

    expect(result.exit).toBe(1)
    expect(result.steps.find((step) => step.name === "patch guard")?.status).toBe("fail")
    const report = Sync.report(result)
    expect(report).toContain("Result: **checks failed** (exit 1)")
    expect(report).toContain("| patch guard | `.` | `Patches.check` | fail |")
    expect(report).toContain("FAIL src/a.ts differs from")
  })

  // A workspace without dependencies, so `bun install` needs no network; the scripts stand in for the real suites.
  test("installs, then runs every DynWork package's test and typecheck and the desktop typecheck", async () => {
    const root = await fixture(["src/a.ts", "package.json", "packages/desktop/package.json"])
    const scripts = async (dir: string, name: string, test: string) =>
      write(
        root,
        `${dir}/package.json`,
        JSON.stringify({ name, private: true, scripts: { test, typecheck: "echo ok" } }),
      )
    await write(
      root,
      "package.json",
      JSON.stringify({ name: "fixture", private: true, workspaces: ["dynwork/packages/*", "packages/*"] }),
    )
    await scripts("dynwork/packages/good", "good", "echo good")
    await scripts("dynwork/packages/bad", "bad", "echo 1 fail && exit 1")
    await scripts("packages/desktop", "desktop", "echo ok")
    await commit(root, "feat(dynwork): add the workspace")

    const result = await Sync.run({ root, target: "next", remote: false, checks: "no-build" })

    expect(result.steps.map((step) => [step.name, step.cwd, step.command, step.status])).toEqual([
      ["worktree", ".", "git worktree add --detach <worktree> main", "pass"],
      ["rebase", ".", "git rebase --onto next v1.0.0", "pass"],
      ["patch guard", ".", "Patches.check", "pass"],
      ["install", ".", "bun install", "pass"],
      ["bad test", "dynwork/packages/bad", "bun run test", "fail"],
      ["bad typecheck", "dynwork/packages/bad", "bun run typecheck", "pass"],
      ["good test", "dynwork/packages/good", "bun run test", "pass"],
      ["good typecheck", "dynwork/packages/good", "bun run typecheck", "pass"],
      ["desktop typecheck", "packages/desktop", "bun run typecheck", "pass"],
    ])
    expect(result.exit).toBe(1)
    expect(Sync.report(result)).toMatch(/### bad test output\n\n```text\n[^`]*1 fail/)
    expect(await exists(result.worktree.path)).toBe(false)
  })

  test("replays the session shapes after the rebase when the recorder is there, and fails on a changed shape", async () => {
    const root = await fixture(["src/a.ts", "package.json", "packages/desktop/package.json"])
    await write(
      root,
      "package.json",
      JSON.stringify({ name: "fixture", private: true, workspaces: ["dynwork/packages/*", "packages/*"] }),
    )
    await write(
      root,
      "packages/desktop/package.json",
      JSON.stringify({ name: "desktop", private: true, scripts: { typecheck: "echo ok" } }),
    )
    await write(
      root,
      "dynwork/packages/good/package.json",
      JSON.stringify({ name: "good", private: true, scripts: { test: "echo ok", typecheck: "echo ok" } }),
    )
    await write(
      root,
      "dynwork/script/record-session.ts",
      'console.error("event session.text.ended: was a, now b")\nprocess.exit(1)\n',
    )
    await commit(root, "feat(dynwork): add the recorder")

    const result = await Sync.run({ root, target: "next", remote: false, checks: "no-build" })

    const shapes = result.steps.find((step) => step.name === "session shapes")
    expect([shapes?.cwd, shapes?.command, shapes?.status]).toEqual([
      ".",
      "bun dynwork/script/record-session.ts --check",
      "fail",
    ])
    expect(shapes?.output).toContain("event session.text.ended: was a, now b")
    expect(result.exit).toBe(1)
  })

  test("never moves a branch inside the stack, even with rebase.updateRefs set", async () => {
    const root = await fixture()
    await appendFile(path.join(root, ".git/config"), "[rebase]\n\tupdateRefs = true\n")
    await git(root, "branch", "overlay", "main~1")
    await git(root, "switch", "-q", "-c", "stack")
    const before = await snapshot(root)

    const result = await Sync.run({ root, target: "next", from: "stack", remote: false, checks: "guard" })

    expect(result.exit).toBe(0)
    expect(result.from.ref).toBe("stack")
    expect(await snapshot(root)).toEqual(before)
  })

  test("renders every step and fences output that itself contains a fence", () => {
    const report = Sync.report({
      from: { ref: "main", sha: "a".repeat(40) },
      target: { ref: "upstream/dev", sha: "b".repeat(40), tag: false },
      base: { ref: "v1.0.0", sha: "c".repeat(40) },
      commits: [{ sha: "d".repeat(40), subject: "feat(dynwork): stack" }],
      worktree: { path: "/tmp/dynwork-sync-x", kept: false },
      conflict: undefined,
      rangeDiff: "1:  ddddddd = 1:  eeeeeee feat(dynwork): stack",
      steps: [
        { name: "rebase", cwd: ".", command: "git rebase", status: "pass", ms: 120, output: "" },
        {
          name: "build test",
          cwd: "dynwork/packages/build",
          command: "bun run test",
          status: "fail",
          ms: 1500,
          output: "```\n1 fail",
        },
        {
          name: "desktop build",
          cwd: "packages/desktop",
          command: "bunx electron-vite build",
          status: "skip",
          ms: 0,
          output: "",
        },
      ],
      started: "2026-11-01T00:00:00.000Z",
      ms: 61_000,
      exit: 1,
    })

    expect(report).toContain("| Target | `upstream/dev` at `bbbbbbbbbb` |")
    expect(report).toContain("| Base | `v1.0.0` at `cccccccccc` (`dynwork/UPSTREAM`) |")
    expect(report).toContain("| Source | `main` at `aaaaaaaaaa`, 1 DynWork commits |")
    expect(report).toContain("| Duration | 1 min 1 s |")
    expect(report).toContain("| rebase | `.` | `git rebase` | pass | 120 ms |")
    expect(report).toContain("| desktop build | `packages/desktop` | `bunx electron-vite build` | skip | 0 ms |")
    expect(report).toContain("### build test output\n\n````text\n```\n1 fail\n````")
    expect(report).toContain("- `dddddddddd` feat(dynwork): stack")
    expect(report).toContain(
      "## range-diff\n\n`git range-diff v1.0.0..main upstream/dev..HEAD`:\n\n```text\n1:  ddddddd = 1:  eeeeeee feat(dynwork): stack\n```",
    )
    expect(report).not.toContain("## Conflicts")
  })
})
