#!/usr/bin/env bun
// The steps of the `dynwork canary` workflow that are decisions, not `gh` calls. A thrown error is a non-zero exit.
//
//   bun dynwork/script/canary.ts version <run number>
//     prints the canary's app version: the next patch of DynWork's own, marked canary, with the run number
//   bun dynwork/script/canary.ts guard <isPrerelease of the canary release> <tag of releases/latest>
//     fails unless the canary is a prerelease and the latest release is an internal one
import { Canary } from "../packages/build/src/canary"

const [command, ...args] = process.argv.slice(2)

if (command === "version") console.log(Canary.version(Number(args[0])))
else if (command === "guard") Canary.assertNeverLatest({ isPrerelease: args[0] ?? "", latestTag: args[1] ?? "" })
else throw new Error(`Unknown command "${command}": expected "version" or "guard"`)
