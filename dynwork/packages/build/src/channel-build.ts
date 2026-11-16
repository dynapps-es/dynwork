export * as ChannelBuild from "./channel-build"

import { DynWorkIdentity } from "@dynwork/branding/identity"
import { readdir } from "node:fs/promises"
import path from "node:path"

// What `dynwork/script/package.ts` decides per channel, kept apart from the packing so it can be tested without one.

// macOS and Windows take build metadata badly, so the app version never has a `+`: only the CLI version carries the commit.
const release = /^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/

/** The app's version: `DYNWORK_VERSION` when set (a canary build), else DynWork's own. */
export function appVersion(fromEnv: string | undefined) {
  if (!fromEnv) return DynWorkIdentity.version
  if (!release.test(fromEnv))
    throw new Error(
      `DYNWORK_VERSION "${fromEnv}" must be major.minor.patch with an optional -prerelease, and no +build`,
    )
  return fromEnv
}

/**
 * The installers one pack leaves in `dist`. Their names carry no version, so a channel's download links never change.
 * electron-builder names the architecture as each format does: amd64 in the deb and x86_64 in the AppImage.
 */
export function artifacts(input: {
  channel: DynWorkIdentity.Channel
  os: "mac" | "win" | "linux"
  cpu: string
}): [installer: string, ...rest: string[]] {
  const prefix = DynWorkIdentity.table[input.channel].artifactPrefix

  if (input.os === "mac") return [`${prefix}-mac-${input.cpu}.dmg`]
  if (input.os === "win") return [`${prefix}-win-${input.cpu}.exe`, "latest.yml"]
  return [
    `${prefix}-linux-${input.cpu === "x64" ? "amd64" : input.cpu}.deb`,
    `${prefix}-linux-${input.cpu === "x64" ? "x86_64" : input.cpu}.AppImage`,
  ]
}

/**
 * Extra electron-builder flags. A channel other than internal gets its own package name, which names the deb and the
 * updater's cache folder, so installs of different channels never share either. Internal passes nothing: its Windows
 * installs keep the cache folder they already have.
 */
export function builderFlags(channel: DynWorkIdentity.Channel) {
  if (channel === "internal") return []
  return [`-c.extraMetadata.name=${DynWorkIdentity.table[channel].debPackage}`]
}

/** What a packed bundle must say about itself for the channel. */
export function expected(channel: DynWorkIdentity.Channel, version: string) {
  const identity = DynWorkIdentity.table[channel]

  return {
    app: `${identity.name}.app`,
    identifier: identity.appId,
    version,
    feed: identity.updateFeed,
    cacheDir: channel === "internal" ? undefined : `${identity.debPackage}-updater`,
    debPackage: identity.debPackage,
  }
}

/** Throws naming each value that is not the one expected; an expected `undefined` is not compared. */
export function assertCarries(
  where: string,
  channel: DynWorkIdentity.Channel,
  wanted: Record<string, string | undefined>,
  found: Record<string, string | undefined>,
) {
  const wrong = Object.entries(wanted)
    .filter((entry) => entry[1] !== undefined && found[entry[0]] !== entry[1])
    .map(
      (entry) =>
        `${entry[0]} is ${found[entry[0]] === undefined ? "missing" : `"${found[entry[0]]}"`}, expected "${entry[1]}"`,
    )

  if (wrong.length > 0) throw new Error(`${where} does not carry the ${channel} identity: ${wrong.join("; ")}`)
}

/**
 * The macOS app electron-builder leaves in `dist`, in a `mac` folder, and the resources it keeps `app-update.yml`, the
 * feed the updater reads, in.
 */
export async function locateMac(dist: string) {
  const apps = (
    await Promise.all(
      (await folders(dist, /^mac(-.+)?$/)).map(async (folder) =>
        (await readdir(folder)).filter((name) => name.endsWith(".app")).map((name) => path.join(folder, name)),
      ),
    )
  ).flat()

  return one(
    dist,
    "mac",
    apps.map((app) => ({ app, resources: path.join(app, "Contents/Resources") })),
  )
}

/** The resources of the Windows app electron-builder leaves in `dist` (its `win` unpacked folder), which hold `app-update.yml`. */
export async function locateWin(dist: string) {
  return one(
    dist,
    "win",
    (await folders(dist, /^win(-.+)?-unpacked$/)).map((folder) => ({ resources: path.join(folder, "resources") })),
  )
}

/** The feed and the updater cache folder `app-update.yml` carries. */
export async function readUpdate(file: string) {
  const config = await readYaml(file)

  return { url: text(config.url), cacheDir: text(config.updaterCacheDirName) }
}

/** The version and installer `latest.yml`, which the Windows updater reads, names. */
export async function readLatest(file: string) {
  const config = await readYaml(file)

  return { version: text(config.version), path: text(config.path) }
}

async function folders(dist: string, pattern: RegExp) {
  return (await readdir(dist, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && pattern.test(entry.name))
    .map((entry) => path.join(dist, entry.name))
}

function one<T>(dist: string, os: string, found: T[]) {
  const [only] = found
  if (found.length !== 1 || only === undefined)
    throw new Error(`${dist} holds ${found.length} packed ${os} apps, expected one`)
  return only
}

async function readYaml(file: string) {
  return Bun.YAML.parse(await Bun.file(file).text()) as Record<string, unknown>
}

function text(value: unknown) {
  return value === undefined || value === null ? undefined : String(value)
}
