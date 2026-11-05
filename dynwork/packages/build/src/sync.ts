import { $ } from "bun"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Patches } from "./patches"

type Step = {
  name: string
  cwd: string
  command: string
  status: "pass" | "fail" | "skip"
  ms: number
  output: string
}

type Commit = { sha: string; subject: string }

// Rebases the DynWork stack (`from`, an upstream tag from `dynwork/UPSTREAM` plus DynWork commits) onto `target` in a
// throwaway worktree under the system temp dir, then checks the result. It never pushes, and never moves a branch or
// touches the checkout at `root`: the rebase runs on a detached HEAD. `checks` is `all`, `no-build` (no desktop build) or
// `guard` (the patch guard only, no install). Exit 0 is green, 2 a rebase conflict, 1 a failed check.
async function run(input: {
  root: string
  target: string
  from?: string
  remote?: string | false
  checks?: "all" | "no-build" | "guard"
  keep?: boolean
  log?: (line: string) => void
}) {
  const started = Date.now()
  const log = input.log ?? (() => {})
  const steps: Step[] = []
  const record = (step: Step) => {
    steps.push(step)
    log(`${step.status.padEnd(4)}  ${step.name} (${duration(step.ms)})`)
    return step
  }

  if (input.remote !== false) {
    const fetched = record(await exec("fetch", input.root, ".", ["git", "fetch", input.remote ?? "upstream", "--tags"]))
    if (fetched.status === "fail") throw new Error(`git fetch failed:\n${fetched.output}`)
  }

  const from = { ref: input.from ?? "main", sha: await resolve(input.root, input.from ?? "main") }
  const target = {
    ref: input.target,
    sha: await resolve(input.root, input.target),
    tag: (await git(input.root, "show-ref", "--verify", "--quiet", `refs/tags/${input.target}`)).exitCode === 0,
  }
  const baseRef = (await must(input.root, "show", `${from.sha}:dynwork/UPSTREAM`)).trim()
  const base = { ref: baseRef, sha: await resolve(input.root, baseRef) }
  const commits = parseCommits(
    await must(input.root, "log", "--reverse", "--format=%H%x09%s", `${base.sha}..${from.sha}`),
  )

  const worktree = await mkdtemp(path.join(tmpdir(), "dynwork-sync-"))

  try {
    const added = await timed(() => git(input.root, "worktree", "add", "--detach", worktree, from.sha))
    record({
      name: "worktree",
      cwd: ".",
      command: `git worktree add --detach <worktree> ${from.ref}`,
      status: added.value.exitCode === 0 ? "pass" : "fail",
      ms: added.ms,
      output: tail(added.value.stderr.toString()),
    })
    if (added.value.exitCode !== 0) throw new Error(`git worktree add failed:\n${added.value.stderr.toString()}`)

    const rebase = await timed(() =>
      git(
        worktree,
        // A user's rebase.updateRefs would move every local branch inside the stack, `main` included.
        "-c",
        "rebase.updateRefs=false",
        "-c",
        "commit.gpgsign=false",
        "rebase",
        "--no-autosquash",
        "--onto",
        target.sha,
        base.sha,
      ),
    )
    record({
      name: "rebase",
      cwd: ".",
      command: `git rebase --onto ${target.ref} ${base.ref}`,
      status: rebase.value.exitCode === 0 ? "pass" : "fail",
      ms: rebase.ms,
      output: tail(rebase.value.stdout.toString() + rebase.value.stderr.toString()),
    })

    const conflict =
      rebase.value.exitCode === 0 ? undefined : await readConflict(worktree, rebase.value.stderr.toString())
    const rangeDiff = await must(
      worktree,
      "range-diff",
      "--no-color",
      `${base.sha}..${from.sha}`,
      `${target.sha}..HEAD`,
    )

    if (conflict) {
      await must(worktree, "rebase", "--abort")
      return finish({ started, from, target, base, commits, worktree, keep: input.keep, conflict, rangeDiff, steps })
    }

    // The patch guard measures the stack against `dynwork/UPSTREAM`. A tag target is what a real sync commits; any
    // other ref is a rehearsal, so it gets its commit hash in the working tree only.
    await Bun.write(path.join(worktree, "dynwork/UPSTREAM"), `${target.tag ? target.ref : target.sha}\n`)
    if (target.tag && target.ref !== base.ref)
      await must(
        worktree,
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-q",
        "-m",
        `chore(dynwork): track upstream ${target.ref}`,
        "--",
        "dynwork/UPSTREAM",
      )

    const guard = await timed(() =>
      Patches.check(worktree).then(
        (result) => ({ pass: result.problems.length === 0, output: Patches.format(result) }),
        (error: Error) => ({ pass: false, output: error.message }),
      ),
    )
    record({
      name: "patch guard",
      cwd: ".",
      command: "Patches.check",
      status: guard.value.pass ? "pass" : "fail",
      ms: guard.ms,
      output: guard.value.output,
    })

    if (input.checks === "guard")
      return finish({ started, from, target, base, commits, worktree, keep: input.keep, rangeDiff, steps })

    const install = record(await exec("install", worktree, ".", ["bun", "install"]))
    const packages = (await readdir(path.join(worktree, "dynwork/packages"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => `dynwork/packages/${entry.name}`)
      .sort()
    // The session recorder replays the fixtures of `@dynwork/mobile-model` against the rebased server: a changed event or
    // message shape fails here, before a phone meets it
    const recorder = await Bun.file(path.join(worktree, "dynwork/script/record-session.ts")).exists()
    const planned = [
      ...packages.flatMap((dir) => [
        { name: `${path.basename(dir)} test`, cwd: dir, argv: ["bun", "run", "test"] },
        { name: `${path.basename(dir)} typecheck`, cwd: dir, argv: ["bun", "run", "typecheck"] },
      ]),
      ...(recorder
        ? [{ name: "session shapes", cwd: ".", argv: ["bun", "dynwork/script/record-session.ts", "--check"] }]
        : []),
      { name: "desktop typecheck", cwd: "packages/desktop", argv: ["bun", "run", "typecheck"] },
      // Only the bundle: no CLI download, no packing, nothing installed in /Applications or launched.
      ...(input.checks === "no-build"
        ? []
        : [{ name: "desktop build", cwd: "packages/desktop", argv: ["bunx", "electron-vite", "build"] }]),
    ]
    for (const item of planned)
      record(
        install.status === "fail"
          ? { name: item.name, cwd: item.cwd, command: item.argv.join(" "), status: "skip", ms: 0, output: "" }
          : await exec(item.name, worktree, item.cwd, item.argv),
      )

    return finish({ started, from, target, base, commits, worktree, keep: input.keep, rangeDiff, steps })
  } finally {
    if (!input.keep) {
      await git(input.root, "worktree", "remove", "--force", worktree)
      await rm(worktree, { recursive: true, force: true })
      await git(input.root, "worktree", "prune")
    }
  }
}

function finish(input: {
  started: number
  from: { ref: string; sha: string }
  target: { ref: string; sha: string; tag: boolean }
  base: { ref: string; sha: string }
  commits: Commit[]
  worktree: string
  keep?: boolean
  conflict?: { commit: Commit; files: string[] }
  rangeDiff: string
  steps: Step[]
}) {
  return {
    from: input.from,
    target: input.target,
    base: input.base,
    commits: input.commits,
    worktree: { path: input.worktree, kept: input.keep === true },
    conflict: input.conflict,
    rangeDiff: input.rangeDiff,
    steps: input.steps,
    started: new Date(input.started).toISOString(),
    ms: Date.now() - input.started,
    exit: input.conflict ? 2 : input.steps.some((step) => step.status === "fail") ? 1 : 0,
  }
}

type Result = ReturnType<typeof finish>

function report(result: Result) {
  const short = (sha: string) => sha.slice(0, 10)
  const verdict = result.conflict ? "conflicts" : result.exit === 0 ? "green" : "checks failed"
  const failed = result.steps.filter((step) => step.status === "fail" && step.name !== "patch guard")
  const guard = result.steps.find((step) => step.name === "patch guard")
  return [
    `# Upstream sync: ${result.target.ref}`,
    "",
    `Result: **${verdict}** (exit ${result.exit})`,
    "",
    "| | |",
    "| --- | --- |",
    `| Target | \`${result.target.ref}\` at \`${short(result.target.sha)}\`${result.target.tag ? " (tag)" : ""} |`,
    `| Base | \`${result.base.ref}\` at \`${short(result.base.sha)}\` (\`dynwork/UPSTREAM\`) |`,
    `| Source | \`${result.from.ref}\` at \`${short(result.from.sha)}\`, ${result.commits.length} DynWork commits |`,
    `| Worktree | \`${result.worktree.path}\` (${result.worktree.kept ? "kept" : "removed"}) |`,
    `| Started | ${result.started} |`,
    `| Duration | ${duration(result.ms)} |`,
    "",
    ...(result.conflict
      ? [
          "## Conflicts",
          "",
          `The rebase stopped on \`${short(result.conflict.commit.sha)} ${result.conflict.commit.subject}\` (commit ${
            result.commits.findIndex((commit) => commit.sha === result.conflict?.commit.sha) + 1
          } of ${result.commits.length}), with conflicts in:`,
          "",
          ...result.conflict.files.map((file) => `- \`${file}\``),
          "",
          "The rebase was aborted, so the commits after it were not tried and no check ran.",
          "",
        ]
      : []),
    "## Steps",
    "",
    "| Step | Directory | Command | Result | Time |",
    "| --- | --- | --- | --- | --- |",
    ...result.steps.map(
      (step) => `| ${step.name} | \`${step.cwd}\` | \`${step.command}\` | ${step.status} | ${duration(step.ms)} |`,
    ),
    "",
    ...failed.flatMap((step) => [`### ${step.name} output`, "", ...fence(step.output), ""]),
    ...(guard ? ["## Patch guard", "", ...fence(guard.output), ""] : []),
    "## Stack",
    "",
    ...result.commits.map((commit) => `- \`${short(commit.sha)}\` ${commit.subject}`),
    "",
    "## range-diff",
    "",
    `\`git range-diff ${result.base.ref}..${result.from.ref} ${result.target.ref}..HEAD\`${
      result.conflict ? ", up to the commit that conflicted" : ""
    }:`,
    "",
    ...fence(result.rangeDiff),
    "",
  ].join("\n")
}

// Reads the commit the rebase stopped on and its unmerged files. Anything else that stops a rebase is an error.
async function readConflict(worktree: string, stderr: string) {
  const stopped = await git(worktree, "log", "-1", "--format=%H%x09%s", "REBASE_HEAD")
  const files = (await must(worktree, "diff", "--name-only", "--diff-filter=U")).split("\n").filter(Boolean)
  const commit = parseCommits(stopped.text())[0]
  if (stopped.exitCode !== 0 || !commit || files.length === 0) throw new Error(`git rebase failed:\n${stderr}`)
  return { commit, files }
}

function parseCommits(text: string) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", ...subject] = line.split("\t")
      return { sha, subject: subject.join("\t") }
    })
}

// Hooks never run in the throwaway worktree, and paths stay readable.
function git(cwd: string, ...args: string[]) {
  return $`git -c core.hooksPath=/dev/null -c core.quotepath=off ${args}`.cwd(cwd).quiet().nothrow()
}

async function must(cwd: string, ...args: string[]) {
  const result = await git(cwd, ...args)
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed:\n${result.stderr.toString()}`)
  return result.text()
}

async function resolve(cwd: string, ref: string) {
  return (await must(cwd, "rev-parse", "--verify", `${ref}^{commit}`)).trim()
}

// The developer's OPENCODE_* variables would change channels and services; HUSKY=0 keeps `bun install` from
// rewriting the hooks path in the config the worktree shares with the checkout.
async function exec(name: string, root: string, cwd: string, argv: string[]) {
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry) => !entry[0].startsWith("OPENCODE_"))),
    BUN_CONFIG_REGISTRY: "https://registry.npmjs.org/",
    HUSKY: "0",
  }
  const result = await timed(() => $`${argv}`.cwd(path.join(root, cwd)).env(env).quiet().nothrow())
  return {
    name,
    cwd,
    command: argv.join(" "),
    status: result.value.exitCode === 0 ? "pass" : "fail",
    ms: result.ms,
    output: tail(result.value.stdout.toString() + result.value.stderr.toString()),
  } satisfies Step
}

async function timed<T>(fn: () => Promise<T>) {
  const started = Date.now()
  const value = await fn()
  return { value, ms: Date.now() - started }
}

function tail(text: string) {
  return text.trimEnd().split("\n").slice(-80).join("\n")
}

function duration(ms: number) {
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`
}

// A fence one backtick longer than any run of backticks in the text, so command output cannot close it.
function fence(text: string) {
  const ticks = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((match) => match[0].length + 1)))
  return [`${ticks}text`, text || "(empty)", ticks]
}

export const Sync = { run, report }
