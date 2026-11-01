import { $ } from "bun"
import path from "node:path"

// DynWork's own paths are never patches: `dynwork/` is the overlay and `plans/` is local and never pushed.
const own = [":(exclude)dynwork", ":(exclude)plans"]

// Compares HEAD against the upstream tag in `dynwork/UPSTREAM` and checks every upstream file that differs against the
// `dynwork/PATCHES.md` table and its budget. `problems` is empty when the guard passes.
async function check(root: string) {
  const base = (await Bun.file(path.join(root, "dynwork/UPSTREAM")).text()).trim()
  const patches = await Bun.file(path.join(root, "dynwork/PATCHES.md")).text()
  const budget = readBudget(patches)
  const rows = readRows(patches)

  const git = (...args: string[]) => $`git -c core.quotepath=off ${args}`.cwd(root).quiet().nothrow()

  const tag = await git("rev-parse", "--verify", "--quiet", `${base}^{commit}`)
  if (tag.exitCode !== 0)
    throw new Error(
      `The upstream tag ${base} from dynwork/UPSTREAM is not in this clone; fetch it: git fetch upstream tag ${base}`,
    )

  const range = [base, "HEAD", "--", ".", ...own]
  const [names, counts] = await Promise.all([
    git("diff", "--name-status", "--no-renames", ...range),
    git("diff", "--numstat", "--no-renames", ...range),
  ])
  if (names.exitCode !== 0 || counts.exitCode !== 0)
    throw new Error(`git diff ${base}..HEAD failed: ${names.stderr.toString() || counts.stderr.toString()}`)

  const lines = new Map(
    counts
      .text()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [added, removed, ...file] = line.split("\t")
        // Binary files report "-" for both counts.
        return [file.join("\t"), { added: Number(added) || 0, removed: Number(removed) || 0 }] as const
      }),
  )

  const files = names
    .text()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      // The status letter: A added, M modified, D deleted, T type changed.
      const [status = "", ...file] = line.split("\t")
      const name = file.join("\t")
      return {
        file: name,
        status: status.slice(0, 1),
        ...(lines.get(name) ?? { added: 0, removed: 0 }),
        listed: rows.has(name),
      }
    })

  const stale = [...rows].filter((row) => !files.some((item) => item.file === row))

  // A new file cannot conflict with an upstream rebase, and the lockfile is regenerated rather than merged, so only the
  // other files upstream also has count toward the budget.
  const used = files
    .filter((item) => item.status !== "A" && item.file !== "bun.lock")
    .reduce((sum, item) => sum + item.added + item.removed, 0)

  const problems = [
    ...files
      .filter((item) => !item.listed)
      .map((item) => `${item.file} differs from ${base} but PATCHES.md does not list it`),
    ...stale.map((row) => `PATCHES.md lists ${row} but it does not differ from ${base}`),
    ...(used > budget ? [`Modified upstream files change ${used} lines, over the budget of ${budget}`] : []),
  ]

  return { base, files, stale, budget, used, problems }
}

function format(result: Awaited<ReturnType<typeof check>>) {
  const width = Math.max(4, ...result.files.map((item) => item.file.length), ...result.stale.map((row) => row.length))
  const row = (file: string, status: string, added: string, removed: string, listed: string) =>
    `${file.padEnd(width)}  ${status.padEnd(6)}  ${added.padStart(5)}  ${removed.padStart(5)}  ${listed}`
  return [
    row("File", "Status", "+", "-", "Listed"),
    ...result.files.map((item) =>
      row(item.file, item.status, String(item.added), String(item.removed), item.listed ? "yes" : "NO"),
    ),
    ...result.stale.map((file) => row(file, "-", "-", "-", "stale")),
    "",
    `Base ${result.base}: ${result.files.length} upstream files differ, ${result.used} of ${result.budget} budgeted lines used.`,
    ...result.problems.map((problem) => `FAIL ${problem}`),
  ].join("\n")
}

// `Budget: 250 lines` on a line of its own, so a reader of PATCHES.md sees the number next to the table it limits.
function readBudget(patches: string) {
  const match = patches.match(/^Budget: (\d+) lines\s*$/m)
  if (!match) throw new Error("dynwork/PATCHES.md has no `Budget: <n> lines` line")
  return Number(match[1])
}

// Table rows are `| \`path\` | why | risk |`; the header and the separator have no backticked first cell.
function readRows(patches: string) {
  return new Set(
    patches
      .split("\n")
      .filter((line) => line.startsWith("|"))
      .flatMap(
        (line) =>
          line
            .split("|")[1]
            ?.trim()
            .match(/^`([^`]+)`$/)?.[1] ?? [],
      ),
  )
}

export const Patches = { check, format }
