#!/usr/bin/env bun
// Patch guard: fails when an upstream file differs from the tag in dynwork/UPSTREAM without a row in
// dynwork/PATCHES.md, when a row lists a file that does not differ, or when the modified upstream files exceed the
// budget in PATCHES.md.
//
//   bun dynwork/script/patches.ts
import path from "node:path"
import { Patches } from "../packages/build/src/patches"

const result = await Patches.check(path.resolve(import.meta.dir, "../.."))

console.log(Patches.format(result))

process.exit(result.problems.length === 0 ? 0 : 1)
