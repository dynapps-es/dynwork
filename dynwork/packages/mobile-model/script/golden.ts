#!/usr/bin/env bun
// Rewrites test/golden/<scenario>.json from test/fixtures/<scenario>.jsonl. Run it after recording the fixtures again or
// changing a grouping rule on purpose, and read the diff: every changed line is a change of what the phone draws.
import path from "node:path"
import { load, names, replay, view } from "../test/support"

const dir = path.join(import.meta.dir, "../test/golden")

await Promise.all(
  names.map(async (name) => {
    const recorded = load(name)
    await Bun.write(path.join(dir, `${name}.json`), JSON.stringify(view(replay(recorded), recorded), null, 2) + "\n")
  }),
)
console.log(`golden: wrote ${names.length} files to ${dir}`)
