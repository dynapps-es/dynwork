#!/usr/bin/env bun
// Packs DynWork for internal testers, unsigned by Apple or Microsoft, into dist/dynwork: the DMG on macOS (signed ad
// hoc, as `desktop.ts` installs it) and the NSIS installer on Windows, for the machine it runs on.
//
//   bun dynwork/script/package.ts
//
// Testers open the app past Gatekeeper or SmartScreen once (dynwork/README.md, "Internal test builds").
import { $ } from "bun"
import { cp, mkdir, readdir, rm } from "node:fs/promises"
import path from "node:path"

const os = new Map([
  ["darwin", "mac"],
  ["win32", "win"],
]).get(process.platform)

if (os === undefined) throw new Error("DynWork test builds pack on macOS or Windows")

const cpu = process.arch

const root = path.resolve(import.meta.dir, "../..")

const desktop = path.join(root, "packages/desktop")

const out = path.join(root, "dist/dynwork")

const version: string = (await Bun.file(path.join(desktop, "package.json")).json()).version

// The developer's OPENCODE_* variables would change the channel, version or service of the build.
const base = Object.fromEntries(Object.entries(process.env).filter((entry) => !entry[0].startsWith("OPENCODE_")))

const started = Date.now()

// As in `desktop.ts`: the CLI on its "latest" channel, without the web UI the desktop never serves. An x64 desktop
// bundles the baseline CLI, which runs on CPUs without AVX2.
const baseline = cpu === "x64" ? ["--baseline"] : []
await $`bun run build --single ${baseline} --skip-install --skip-web-ui`
  .cwd(path.join(root, "packages/cli"))
  .env({ ...base, OPENCODE_CHANNEL: "latest", OPENCODE_VERSION: version })

const env = { ...base, OPENCODE_CHANNEL: "prod", OPENCODE_VERSION: version }

await $`bun run build`.cwd(desktop).env(env)

// The upstream build copies the OpenCode icons just before bundling; swap them in before packing.
await rm(path.join(desktop, "resources/icons"), { recursive: true, force: true })

await cp(path.join(root, "dynwork/packages/branding/icons"), path.join(desktop, "resources/icons"), { recursive: true })

await rm(path.join(desktop, "dist"), { recursive: true, force: true })

// "-" signs ad hoc: Apple Silicon runs no unsigned code, and an ad hoc signature needs no Apple certificate. Without
// a team the hardened runtime's library validation would refuse Electron's own frameworks, so it stays off, as in the
// bundle `desktop.ts` installs.
const flags = [`--${os}`, `--${cpu}`, "--publish", "never", "--config", "electron-builder.config.ts"]
await (os === "mac"
  ? $`bunx electron-builder ${flags} -c.mac.target=dmg -c.mac.identity=- -c.mac.hardenedRuntime=false`
  : $`bunx electron-builder ${flags} -c.win.target=nsis`
).cwd(desktop).env(env)

const ext = os === "mac" ? ".dmg" : ".exe"

const files = (await readdir(path.join(desktop, "dist"))).filter((file) => file.endsWith(ext))

if (files.length !== 1) throw new Error(`Expected one ${ext} in packages/desktop/dist, found ${files.join(", ")}`)

await mkdir(out, { recursive: true })

await cp(path.join(desktop, "dist", files[0]), path.join(out, files[0]))

// The pack's own app bundle would show up in Spotlight and "Open With" next to the installed one.
await rm(path.join(desktop, "dist"), { recursive: true, force: true })

console.log(`Packed dist/dynwork/${files[0]} (v${version}) in ${Math.round((Date.now() - started) / 1000)} s`)
