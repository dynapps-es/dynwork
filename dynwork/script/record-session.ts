#!/usr/bin/env bun
// Records scripted OpenCode sessions as fixtures for `@dynwork/mobile-model`: the events `/api/event` carries and
// snapshots of what the REST routes return, one `<scenario>.jsonl` per scenario.
//
//   bun dynwork/script/record-session.ts [scenario...] [--out <dir>] [--list]
//   bun dynwork/script/record-session.ts --check [scenario...]
//
// It starts an OpenCode service of its own (script/record-session/service.ts) on a port the OS picks, with a temp HOME,
// XDG and config directories, and a deterministic fake provider on another loopback port (script/record-session/fake.ts),
// so it needs no network and no model, and it never touches the installed DynWork, its port or the user's profile. The
// processes and the temp root are gone when it exits.
//
// --out      where the fixtures go (default dynwork/packages/mobile-model/test/fixtures)
// --check    records into memory and compares the shape of every event and message type with the committed fixtures,
//            exit 1 when upstream changed one: what `sync-upstream.ts` runs after a rebase
// --list     prints the scenario names
import { mkdir, realpath } from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"
import { Shapes } from "../packages/mobile-model/src/shapes"
import * as Fake from "./record-session/fake"
import * as Recorder from "./record-session/record"
import { scenarios, scripts } from "./record-session/scenarios"
import * as Service from "./record-session/service"

const args = parseArgs({
  allowPositionals: true,
  options: { out: { type: "string" }, check: { type: "boolean" }, list: { type: "boolean" } },
})

const fixtures = path.resolve(args.values.out ?? path.join(import.meta.dir, "../packages/mobile-model/test/fixtures"))

if (args.values.list) {
  scenarios.forEach((scenario) => console.log(`${scenario.name.padEnd(22)} ${scenario.description}`))
  process.exit(0)
}

const chosen =
  args.positionals.length === 0
    ? scenarios
    : args.positionals.map((name) => {
        const scenario = scenarios.find((item) => item.name === name)
        if (!scenario) throw new Error(`unknown scenario ${name}; try --list`)
        return scenario
      })

const fake = await Fake.start(scripts)
const service = await Service.boot({ provider: fake.url, config: { experimental: { todo: true } } }).catch((error) => {
  fake.stop()
  throw error
})

const redact = redactor([await realpath(service.root), service.root], fake.url, service.headers.authorization)

// One text per scenario, kept (or written) as soon as the scenario is done: a later one failing loses nothing
const recorded: Array<{ name: string; text: string }> = []
const failure = await (async () => {
  for (const scenario of chosen) {
    console.error(`record: ${scenario.name}`)
    const lines = await Recorder.run(service, scenario)
    const text = lines.map((line) => redact(JSON.stringify(line))).join("\n") + "\n"
    recorded.push({ name: scenario.name, text })
    if (args.values.check) continue
    await mkdir(fixtures, { recursive: true })
    await Bun.write(path.join(fixtures, `${scenario.name}.jsonl`), text)
  }
})().then(
  () => undefined,
  (error: unknown) => error,
)

await service.stop()
fake.stop()
if (failure) throw failure

if (!args.values.check) {
  console.error(`record: wrote ${recorded.length} fixtures to ${fixtures}`)
  process.exit(0)
}

// --check: the shapes of what was just recorded against the committed fixtures
const committed = await Promise.all(
  (await Array.fromAsync(new Bun.Glob("*.jsonl").scan({ cwd: fixtures }))).map(async (file) =>
    Bun.file(path.join(fixtures, file)).text(),
  ),
)
const parse = (texts: string[]) =>
  texts.flatMap((text) =>
    text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Shapes.Line),
  )
const problems = Shapes.compare(Shapes.of(parse(committed)), Shapes.of(parse(recorded.map((item) => item.text))))
if (problems.length > 0) {
  console.error(
    `record --check: upstream's event or message shapes changed:\n${problems.map((problem) => `  ${problem}`).join("\n")}`,
  )
  process.exit(1)
}
console.error(`record --check: ${recorded.length} scenarios replayed, every shape unchanged`)

function redactor(roots: string[], provider: string, authorization: string) {
  const replacements: Array<[string, string]> = [
    ...roots.map((root): [string, string] => [root, "/work"]),
    [provider, "http://fake.invalid/v1"],
    [authorization, "redacted"],
  ]
  // Anything with the machine in it is a leak: fail rather than ship it
  return (text: string) => {
    const clean = replacements.reduce((value, [from, to]) => value.replaceAll(from, to), text)
    const leak = [process.env.HOME, "/Users/", "/var/folders"].find((needle) => needle && clean.includes(needle))
    if (leak) throw new Error(`a recording holds ${leak}`)
    return clean
  }
}
