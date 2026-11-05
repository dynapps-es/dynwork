#!/usr/bin/env bun
// Builds DynWork for this Mac (darwin-arm64) from the checkout and installs it as /Applications/DynWork.app:
// the CLI first, then the desktop app with the DynWork icons, packed unsigned and signed ad hoc.
//
//   bun dynwork/script/desktop.ts
//
// It only ever replaces /Applications/DynWork.app, and removes the app bundle the pack leaves in packages/desktop/dist,
// so this Mac only ever has one DynWork: Spotlight and "Open With" never offer an older build. The OpenCode app and its
// service are never touched.
import { $ } from "bun"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("DynWork builds for macOS arm64 only")

const root = path.resolve(import.meta.dir, "../..")

const desktop = path.join(root, "packages/desktop")

const install = "/Applications/DynWork.app"

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

await rm(install, { recursive: true, force: true })

await $`ditto ${bundle} ${install}`

await rm(staging, { recursive: true, force: true })

// Forget the pack's own copy in Launch Services before removing it, then make the installed app the one it knows.
const lsregister =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
const packed = path.join(desktop, "dist/mac-arm64/DynWork.app")
await $`${lsregister} -u ${packed}`.nothrow().quiet()
await rm(packed, { recursive: true, force: true })
await $`${lsregister} -f ${install}`.nothrow().quiet()

console.log(`Installed ${install} with CLI ${built} in ${Math.round((Date.now() - started) / 1000)} s`)
