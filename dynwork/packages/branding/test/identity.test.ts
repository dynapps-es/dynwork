import { expect, test } from "bun:test"
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
