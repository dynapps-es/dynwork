#!/usr/bin/env bun
// Rebases the DynWork stack onto a newer upstream ref in a throwaway worktree, checks it and writes a Markdown report.
// It never pushes and never touches this checkout or any branch.
//
//   bun dynwork/script/sync-upstream.ts <target-ref> [--report <path>] [--from <ref>] [--remote <name>] [--no-fetch]
//                                       [--no-build] [--quick] [--keep]
//
// --from     the stack to rebase (default main); its dynwork/UPSTREAM is the base
// --remote   the remote fetched with --tags first (default upstream); --no-fetch skips the fetch
// --no-build skips the desktop bundle; --quick runs only the rebase and the patch guard, without installing
// --keep     keeps the worktree, otherwise it is removed
//
// After a rebase it also replays the session fixtures of `@dynwork/mobile-model` against the new server
// (`bun dynwork/script/record-session.ts --check`) and fails on a changed event or message shape, unless --quick.
//
// Exit 0 green, 2 rebase conflicts, 1 a check failed.
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"
import { Sync } from "../packages/build/src/sync"

const args = parseArgs({
  allowPositionals: true,
  options: {
    report: { type: "string" },
    from: { type: "string" },
    remote: { type: "string" },
    "no-fetch": { type: "boolean" },
    "no-build": { type: "boolean" },
    quick: { type: "boolean" },
    keep: { type: "boolean" },
  },
})

const target = args.positionals[0]
if (!target) {
  console.error("Usage: bun dynwork/script/sync-upstream.ts <target-ref> [--report <path>] [--from <ref>]")
  process.exit(1)
}

const result = await Sync.run({
  root: path.resolve(import.meta.dir, "../.."),
  target,
  from: args.values.from,
  remote: args.values["no-fetch"] ? false : args.values.remote,
  checks: args.values.quick ? "guard" : args.values["no-build"] ? "no-build" : "all",
  keep: args.values.keep,
  log: (line) => console.error(line),
})

const report = Sync.report(result)

if (!args.values.report) console.log(report)

if (args.values.report) {
  const file = path.resolve(args.values.report)
  await mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, report)
  console.error(`Report: ${file}`)
}

console.error(
  `${result.conflict ? "Conflicts" : result.exit === 0 ? "Green" : "Checks failed"}: ${result.from.ref} onto ${result.target.ref}, exit ${result.exit}`,
)

process.exit(result.exit)
