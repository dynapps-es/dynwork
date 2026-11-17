#!/usr/bin/env bun
// Packs DynWork, unsigned by Apple or Microsoft, into dist/dynwork for the machine it runs on: the DMG on macOS (signed
// ad hoc, as `desktop.ts` installs it), on Windows the NSIS installer with the latest.yml its updater reads, and on
// Linux a deb and an AppImage. The `dynwork release` workflow attaches them to a GitHub release.
//
//   bun dynwork/script/package.ts
//
// DYNWORK_CHANNEL picks the channel to pack (internal when unset), and DYNWORK_VERSION the app version of a canary build.
// The pack ends by reading the identity back from the packed app: it fails if a canary carries internal's app id or feed.
//
//   DYNWORK_CHANNEL=canary DYNWORK_VERSION=0.1.2-canary.0 bun dynwork/script/package.ts
//
// Users open the app past Gatekeeper or SmartScreen once (dynwork/README.md, "Releases").
import { $ } from "bun"
import { cp, mkdir, readdir, rm } from "node:fs/promises"
import path from "node:path"
import { DynWorkIdentity } from "../packages/branding/src/identity"
import { ChannelBuild } from "../packages/build/src/channel-build"

const os = new Map<string, "mac" | "win" | "linux">([
  ["darwin", "mac"],
  ["win32", "win"],
  ["linux", "linux"],
]).get(process.platform)

if (os === undefined) throw new Error("DynWork packs on macOS, Windows or Linux")

const cpu = process.arch

const root = path.resolve(import.meta.dir, "../..")

const desktop = path.join(root, "packages/desktop")

const out = path.join(root, "dist/dynwork")

const channel = DynWorkIdentity.channel

// The app carries DynWork's version, or the canary's; the CLI carries upstream's marked with it and the commit. The
// commit never goes in the app version: macOS and Windows take build metadata badly.
const appVersion = ChannelBuild.appVersion(process.env.DYNWORK_VERSION)

const version = DynWorkIdentity.cliVersion(
  (await Bun.file(path.join(desktop, "package.json")).json()).version,
  (await $`git rev-parse --short=10 HEAD`.cwd(root).text()).trim(),
  appVersion,
)

// The developer's OPENCODE_* variables would change the channel, version or service of the build.
const base = Object.fromEntries(Object.entries(process.env).filter((entry) => !entry[0].startsWith("OPENCODE_")))

const started = Date.now()

// As in `desktop.ts`: the CLI on its "latest" channel, without the web UI the desktop never serves. An x64 desktop
// bundles the baseline CLI, which runs on CPUs without AVX2. On Linux `--single --baseline` also picks the musl
// baseline build, whose pty package `--skip-install` leaves out, so Linux names the glibc target the desktop bundles.
const baseline = cpu === "x64" ? ["--baseline"] : []
const target = os === "linux" ? { OPENCODE_TARGET: `linux-${cpu}${cpu === "x64" ? "-baseline" : ""}` } : {}
await $`bun run build --single ${baseline} --skip-install --skip-web-ui`
  .cwd(path.join(root, "packages/cli"))
  .env({ ...base, ...target, OPENCODE_CHANNEL: "latest", OPENCODE_VERSION: version })

// The desktop build fixes DYNWORK_CHANNEL into its bundles, and electron-builder's config reads it for the app id, the
// feed and the artifact names.
const env = { ...base, DYNWORK_CHANNEL: channel, OPENCODE_CHANNEL: "prod", OPENCODE_VERSION: appVersion }

await $`bun run build`.cwd(desktop).env(env)

// The upstream build copies the OpenCode icons just before bundling; swap them in before packing. A channel with a
// folder of its own in icons/ uses it; the others use the icons beside it, without the channels' folders.
await rm(path.join(desktop, "resources/icons"), { recursive: true, force: true })

await ChannelBuild.copyIcons(
  path.join(root, "dynwork/packages/branding/icons"),
  channel,
  path.join(desktop, "resources/icons"),
)

const summary = "Dynapps' desktop app for working with AI agents"

const description = `${DynWorkIdentity.name} brings the skills, agents and models Dynapps Governance publishes to an AI agent.`

// The deb installs the AppStream metainfo the prod config names after the app id; upstream's build writes OpenCode's.
if (os === "linux")
  await Bun.write(
    path.join(desktop, `resources/${DynWorkIdentity.appId}.metainfo.xml`),
    `<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>${DynWorkIdentity.appId}</id>
  <metadata_license>CC0-1.0</metadata_license>
  <project_license>MIT</project_license>
  <name>${DynWorkIdentity.name}</name>
  <summary>${summary}</summary>
  <developer id="es.dynapps">
    <name>Dynapps</name>
  </developer>
  <description>
    <p>${description}</p>
  </description>
  <launchable type="desktop-id">${DynWorkIdentity.appId}.desktop</launchable>
  <content_rating type="oars-1.1" />
</component>
`,
  )

await rm(path.join(desktop, "dist"), { recursive: true, force: true })

// "-" signs ad hoc: Apple Silicon runs no unsigned code, and an ad hoc signature needs no Apple certificate. Without
// a team the hardened runtime's library validation would refuse Electron's own frameworks, so it stays off, as in the
// bundle `desktop.ts` installs. Linux names its targets on the command line, which replaces the config's list; the rpm
// it leaves out would need rpmbuild on the runner. The deb's maintainer, homepage and description would otherwise come
// from upstream's package.json.
const flags = [`--${cpu}`, "--publish", "never", "--config", "electron-builder.config.ts"]
const debian = [
  "-c.linux.maintainer=Dynapps",
  "-c.linux.vendor=Dynapps",
  `-c.linux.synopsis=${summary}`,
  `-c.linux.description=${description}`,
  "-c.extraMetadata.homepage=https://github.com/dynapps-es/dynwork",
]
// A channel other than internal packs under its own package name, which names its deb and the updater's cache folder.
const named = ChannelBuild.builderFlags(channel)
// The sidebar glass addon (`@dynwork/gui`'s `views/glass`) loads from a real file, so it stays out of the asar and is
// signed with the app.
const glass = "-c.asarUnpack=out/main/sidebar-glass.node"
await (
  os === "mac"
    ? $`bunx electron-builder --mac ${flags} ${named} ${glass} -c.mac.target=dmg -c.mac.identity=- -c.mac.hardenedRuntime=false`
    : os === "win"
      ? $`bunx electron-builder --win ${flags} ${named} -c.win.target=nsis`
      : $`bunx electron-builder --linux deb AppImage ${flags} ${named} ${debian}`
)
  .cwd(desktop)
  .env(env)

// Installer names carry no version, so the latest release's download links stay the same. For the same reason no
// blockmap ships: the updater would read the new one as the installed version's and skip the download it needs.
// Linux ships no latest-linux.yml: like macOS it never updates itself, and users install the new deb or AppImage.
// electron-builder names the architecture as each format does, amd64 in the deb and x86_64 in the AppImage.
const files = ChannelBuild.artifacts({ channel, os, cpu })

const packed = await readdir(path.join(desktop, "dist"))

const missing = files.filter((file) => !packed.includes(file))

if (missing.length > 0)
  throw new Error(`packages/desktop/dist lacks ${missing.join(", ")}, it holds ${packed.join(", ")}`)

// The pack must carry the channel's identity: if the channel did not reach the build, a canary would install over
// internal. Read it back from the packed app before anything is published.
const dist = path.join(desktop, "dist")

const wanted = ChannelBuild.expected(channel, appVersion)

if (os === "mac") {
  const found = await ChannelBuild.locateMac(dist)
  const plist = path.join(found.app, "Contents/Info.plist")
  const read = async (key: string) => (await $`plutil -extract ${key} raw -o - ${plist}`.text()).trim()
  const update = await ChannelBuild.readUpdate(path.join(found.resources, "app-update.yml"))

  ChannelBuild.assertCarries(
    path.basename(found.app),
    channel,
    {
      app: wanted.app,
      identifier: wanted.identifier,
      version: wanted.version,
      feed: wanted.feed,
      cacheDir: wanted.cacheDir,
    },
    {
      app: path.basename(found.app),
      identifier: await read("CFBundleIdentifier"),
      version: await read("CFBundleShortVersionString"),
      feed: update.url,
      cacheDir: update.cacheDir,
    },
  )
}

if (os === "win") {
  const found = await ChannelBuild.locateWin(dist)
  const update = await ChannelBuild.readUpdate(path.join(found.resources, "app-update.yml"))
  const latest = await ChannelBuild.readLatest(path.join(dist, "latest.yml"))

  ChannelBuild.assertCarries(
    found.resources,
    channel,
    { feed: wanted.feed, cacheDir: wanted.cacheDir },
    {
      feed: update.url,
      cacheDir: update.cacheDir,
    },
  )
  ChannelBuild.assertCarries("latest.yml", channel, { version: wanted.version, path: files[0] }, latest)
}

if (os === "linux")
  ChannelBuild.assertCarries(
    files[0],
    channel,
    { debPackage: wanted.debPackage },
    {
      debPackage: (await $`dpkg-deb -f ${path.join(dist, files[0])} Package`.text()).trim(),
    },
  )

await mkdir(out, { recursive: true })

await Promise.all(files.map((file) => cp(path.join(desktop, "dist", file), path.join(out, file))))

// The pack's own app bundle would show up in Spotlight and "Open With" next to the installed one.
await rm(path.join(desktop, "dist"), { recursive: true, force: true })

console.log(
  `Packed ${files.map((file) => `dist/dynwork/${file}`).join(", ")} (${DynWorkIdentity.name} ${appVersion}, CLI ${version}) in ${Math.round((Date.now() - started) / 1000)} s`,
)
