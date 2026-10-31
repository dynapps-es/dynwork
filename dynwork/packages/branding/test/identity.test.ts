import { expect, test } from "bun:test"
import { getConfig } from "../../../../packages/desktop/electron-builder.config"

// Each test file runs in its own process, so the channel is set for this file only.
process.env.OPENCODE_CHANNEL = "prod"

const config = getConfig()

// The installer and the packaged app rely on these: a change moves the app's data directory
// (~/Library/Application Support/<appId>), registers another URL scheme or renames the files the install picks up.
test.each([
  { key: "appId", actual: config.appId, expected: "es.dynapps.dynwork" },
  { key: "productName", actual: config.productName, expected: "DynWork" },
  { key: "protocols", actual: config.protocols, expected: { name: "DynWork", schemes: ["dynwork"] } },
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
