#!/usr/bin/env bun
// Builds DynWork for this Mac (darwin-arm64) from the checkout and installs it as /Applications/DynWork.app, or as
// <dir>/DynWork.app with --to: the CLI first, then the desktop app with the DynWork icons, packed unsigned and signed
// ad hoc.
//
//   bun dynwork/script/desktop.ts [--to <dir>]
//
// It only ever replaces that one bundle. The OpenCode app and its service are never touched.
import { $ } from "bun"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { installTarget } from "./install-target"

if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("DynWork builds for macOS arm64 only")

const root = path.resolve(import.meta.dir, "../..")

const desktop = path.join(root, "packages/desktop")

const install = installTarget(process.argv.slice(2))

const version: string = (await Bun.file(path.join(desktop, "package.json")).json()).version

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

const env = { ...base, OPENCODE_CHANNEL: "prod", OPENCODE_VERSION: version }

await $`bun run build`.cwd(desktop).env(env)

// The upstream build copies the OpenCode icons just before bundling; swap them in before packing.
await rm(path.join(desktop, "resources/icons"), { recursive: true, force: true })

await $`cp -R ${path.join(root, "dynwork/packages/branding/icons")} ${path.join(desktop, "resources/icons")}`

await $`bun run pack`.cwd(desktop).env(env)

const staging = await mkdtemp(path.join(tmpdir(), "dynwork-install-"))

await $`tar -xf ${path.join(root, "dist/desktop/opencode-desktop-mac-arm64.app.tar")} -C ${staging}`

const bundle = path.join(staging, "DynWork.app")

await $`codesign --force --deep --sign - ${bundle}`

await $`xattr -cr ${bundle}`

await mkdir(path.dirname(install), { recursive: true })

await rm(install, { recursive: true, force: true })

await $`ditto ${bundle} ${install}`

await rm(staging, { recursive: true, force: true })

console.log(`Installed ${install} with CLI ${built} in ${Math.round((Date.now() - started) / 1000)} s`)
