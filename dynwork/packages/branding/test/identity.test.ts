import { describe, expect, test } from "bun:test"
import path from "node:path"
import { getConfig } from "../../../../packages/desktop/electron-builder.config"
import { parseCliVersion, stageName } from "../../../../packages/desktop/src/main/service/cli-version"
import { DynWorkIdentity } from "../src/identity"

// Each test file runs in its own process, so the channel is set for this file only.
process.env.OPENCODE_CHANNEL = "prod"

const config = getConfig()

// The installer and the packaged app rely on these: a change moves the app's data directory
// (~/Library/Application Support/<appId>), registers another URL scheme or renames the files the install picks up.
test.each([
  { key: "appId", actual: config.appId, expected: "es.dynapps.dynwork" },
  { key: "productName", actual: config.productName, expected: "Dynwork" },
  { key: "protocols", actual: config.protocols, expected: { name: "Dynwork", schemes: ["dynwork"] } },
  { key: "artifactName", actual: config.artifactName, expected: "dynwork-desktop-${os}-${arch}.${ext}" },
  {
    key: "publish",
    actual: config.publish,
    expected: {
      provider: "generic",
      url: "https://github.com/dynapps-es/dynwork/releases/latest/download/",
      channel: "latest",
    },
  },
  { key: "rpm.packageName", actual: config.rpm?.packageName, expected: "dynwork" },
])("the prod builder config carries the DynWork $key", (row) => {
  expect(row.actual).toEqual(row.expected)
})

// The desktop reuses a staged CLI and a running service while their version is the bundled one's, so each build's CLI
// version must reach it whole and name its own stage.
test("each DynWork build gives the CLI its own version and stage", () => {
  const first = DynWorkIdentity.cliVersion("2.2.5", "eb7cefa49d")
  const second = DynWorkIdentity.cliVersion("2.2.5", "16dbca1e52")
  expect(first).toBe(`2.2.5-dynwork.${DynWorkIdentity.version}+eb7cefa49d`)
  expect(parseCliVersion(`opencode v${first}`)).toBe(first)
  expect(stageName(first, "arm64")).not.toBe(stageName(second, "arm64"))
  expect(stageName(first, "arm64")).not.toBe(stageName("2.2.5", "arm64"))
})

const identityModule = path.join(import.meta.dir, "../src/identity.ts")

// The channel is read once, when the module loads, so each channel is a fresh process with its own environment.
function load(channel: string | undefined) {
  const env = { ...process.env }
  delete env.DYNWORK_CHANNEL
  if (channel !== undefined) env.DYNWORK_CHANNEL = channel

  const run = Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      `import { DynWorkIdentity as I } from ${JSON.stringify(identityModule)}
console.log(JSON.stringify({ channel: I.channel, name: I.name, appId: I.appId, scheme: I.scheme, servicePort: I.servicePort, updateFeed: I.updateFeed, rpmPackage: I.rpmPackage, debPackage: I.debPackage, artifactPrefix: I.artifactPrefix }))`,
    ],
    env,
    stdout: "pipe",
    stderr: "pipe",
  })

  return { exit: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() }
}

describe("the channel", () => {
  test("is internal, and every value is today's, when DYNWORK_CHANNEL is not set", () => {
    const run = load(undefined)

    expect(run.exit).toBe(0)
    expect(JSON.parse(run.out)).toEqual({
      channel: "internal",
      name: "Dynwork",
      appId: "es.dynapps.dynwork",
      scheme: "dynwork",
      servicePort: 17495,
      updateFeed: "https://github.com/dynapps-es/dynwork/releases/latest/download/",
      rpmPackage: "dynwork",
      debPackage: "dynwork",
      artifactPrefix: "dynwork-desktop",
    })
  })

  test("canary has its own app id, name, scheme, port, feed and artifacts", () => {
    const run = load("canary")

    expect(run.exit).toBe(0)
    expect(JSON.parse(run.out)).toEqual({
      channel: "canary",
      name: "Dynwork Canary",
      appId: "es.dynapps.dynwork.canary",
      scheme: "dynwork-canary",
      servicePort: 17496,
      updateFeed: "https://github.com/dynapps-es/dynwork/releases/download/dynwork-canary/",
      rpmPackage: "dynwork-canary",
      debPackage: "dynwork-canary",
      artifactPrefix: "dynwork-canary-desktop",
    })
  })

  test("dev has its own identity and no update feed", () => {
    const run = load("dev")

    expect(run.exit).toBe(0)
    expect(JSON.parse(run.out)).toEqual({
      channel: "dev",
      name: "Dynwork Dev",
      appId: "es.dynapps.dynwork.dev",
      scheme: "dynwork-dev",
      servicePort: 17497,
      updateFeed: "",
      rpmPackage: "dynwork-dev",
      debPackage: "dynwork-dev",
      artifactPrefix: "dynwork-dev-desktop",
    })
  })

  test.each(["beta", "Canary", "", "constructor"])("rejects the unknown channel %p", (value) => {
    const run = load(value)

    expect(run.exit).not.toBe(0)
    expect(run.err).toContain("Unknown DYNWORK_CHANNEL")
  })
})

describe("the channels side by side", () => {
  const rows = Object.entries(DynWorkIdentity.table)

  test("there are internal, canary and dev", () => {
    expect(rows.map((row) => row[0])).toEqual(["internal", "canary", "dev"])
  })

  // Two channels sharing any of these would install over each other, share userData or contend for a port.
  test.each([
    "name",
    "appId",
    "scheme",
    "servicePort",
    "updateFeed",
    "rpmPackage",
    "debPackage",
    "artifactPrefix",
  ] as const)("no two channels share the %s", (key) => {
    const values = rows.map((row) => row[1][key])

    expect(new Set(values).size).toBe(values.length)
  })

  // The ports OpenCode's service takes: 0xC0DE (and 0xC0DF for local builds), 0x70DE on Windows and 0x0C0C for the
  // isolated service. 0x8000 and above is where Windows hands out outgoing connections.
  test.each(rows)("the %s port is free of reserved ports and below 0x8000", (_, row) => {
    expect([0xc0de, 0xc0df, 0x70de, 0x0c0c]).not.toContain(row.servicePort)
    expect(row.servicePort).toBeLessThan(0x8000)
  })

  // Only internal follows the latest release; canary's rolling prerelease must never be reached through it.
  test("only dev has no feed, and only internal reads the latest release", () => {
    expect(rows.filter((row) => row[1].updateFeed === "").map((row) => row[0])).toEqual(["dev"])
    expect(rows.filter((row) => row[1].updateFeed.includes("/latest/")).map((row) => row[0])).toEqual(["internal"])
  })
})
