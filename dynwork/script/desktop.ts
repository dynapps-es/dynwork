#!/usr/bin/env bun
// Builds DynWork for this Mac (darwin-arm64) from the checkout and installs it as a channel's app, by default as
// /Applications/Dynwork Canary.app: the CLI first, then the desktop app with the channel's icons, packed unsigned and
// signed ad hoc.
//
//   bun dynwork/script/desktop.ts [--channel <canary|dev>]
//
// It only ever replaces that channel's bundle, and removes the app bundle the pack leaves in packages/desktop/dist, so
// Spotlight and "Open With" never offer an older build. Internal is never installed from a local build (use
// `install.ts internal`), and its app, the OpenCode app and their services are never touched.
import { $ } from "bun"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DynWorkIdentity } from "../packages/branding/src/identity"
import { ChannelBuild } from "../packages/build/src/channel-build"
import { Install } from "../packages/build/src/install"
import { localChannel } from "./install-target"
import { installBundle, lsregister } from "./mac-install"

if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("DynWork builds for macOS arm64 only")

const root = path.resolve(import.meta.dir, "../..")

const desktop = path.join(root, "packages/desktop")

const channel = localChannel(process.argv.slice(2))

const name = DynWorkIdentity.table[channel].name

// Every local build gets its own versions, so the installed app replaces the staged CLI and the running service even
// when the checkout has uncommitted changes.
const stamp = Date.now()

const appVersion = Install.localVersion(channel, stamp)

const version = DynWorkIdentity.cliVersion(
  (await Bun.file(path.join(desktop, "package.json")).json()).version,
  `local.${stamp}`,
  appVersion,
)

// The developer's OPENCODE_* variables would change the channel, version or service of the build.
const base = Object.fromEntries(Object.entries(process.env).filter((entry) => !entry[0].startsWith("OPENCODE_")))

const started = Date.now()

// "latest" is the CLI's release channel: its service files and port match what the desktop expects.
// The desktop never serves the embedded web UI, so the CLI skips building it.
await $`bun run build --single --skip-install --skip-web-ui`
  .cwd(path.join(root, "packages/cli"))
  .env({ ...base, OPENCODE_CHANNEL: "latest", OPENCODE_VERSION: version })

const cli = path.join(root, "packages/cli/dist/cli-darwin-arm64/bin/opencode")

const built = (await $`${cli} --version`.env(base).text()).trim()

if (built !== `opencode v${version}`) throw new Error(`The CLI reports "${built}", expected "opencode v${version}"`)

// The app carries the local build's version, and the channel reaches its bundles and electron-builder's config,
// whatever DYNWORK_CHANNEL the shell exports.
const env = { ...base, DYNWORK_CHANNEL: channel, OPENCODE_CHANNEL: "prod", OPENCODE_VERSION: appVersion }

await $`bun run build`.cwd(desktop).env(env)

// The upstream build copies the OpenCode icons just before bundling; swap in the channel's before packing.
await rm(path.join(desktop, "resources/icons"), { recursive: true, force: true })

await ChannelBuild.copyIcons(
  path.join(root, "dynwork/packages/branding/icons"),
  channel,
  path.join(desktop, "resources/icons"),
)

await $`bun run pack`.cwd(desktop).env(env)

const staging = await mkdtemp(path.join(tmpdir(), "dynwork-install-"))

await $`tar -xf ${path.join(root, "dist/desktop/opencode-desktop-mac-arm64.app.tar")} -C ${staging}`

const bundle = path.join(staging, `${name}.app`)

await $`codesign --force --deep --sign - ${bundle}`

const installed = await installBundle(channel, bundle)

await rm(staging, { recursive: true, force: true })

// Forget the pack's own copy in Launch Services before removing it; `installBundle` made the installed app the one it knows.
const packed = path.join(desktop, `dist/mac-arm64/${name}.app`)
await $`${lsregister} -u ${packed}`.nothrow().quiet()
await rm(packed, { recursive: true, force: true })

console.log(
  `Installed ${installed} (${name} ${appVersion}) with CLI ${built} in ${Math.round((Date.now() - started) / 1000)} s`,
)
