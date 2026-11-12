#!/usr/bin/env bun
// Packs DynWork, unsigned by Apple or Microsoft, into dist/dynwork for the machine it runs on: the DMG on macOS (signed
// ad hoc, as `desktop.ts` installs it), on Windows the NSIS installer with the latest.yml its updater reads, and on
// Linux a deb and an AppImage. The `dynwork release` workflow attaches them to a GitHub release.
//
//   bun dynwork/script/package.ts
//
// Users open the app past Gatekeeper or SmartScreen once (dynwork/README.md, "Releases").
import { $ } from "bun"
import { cp, mkdir, readdir, rm } from "node:fs/promises"
import path from "node:path"
import { DynWorkIdentity } from "../packages/branding/src/identity"

const os = new Map([
  ["darwin", "mac"],
  ["win32", "win"],
  ["linux", "linux"],
]).get(process.platform)

if (os === undefined) throw new Error("DynWork packs on macOS, Windows or Linux")

const cpu = process.arch

const root = path.resolve(import.meta.dir, "../..")

const desktop = path.join(root, "packages/desktop")

const out = path.join(root, "dist/dynwork")

// Upstream's version, which the CLI keeps; the app carries DynWork's.
const version: string = (await Bun.file(path.join(desktop, "package.json")).json()).version

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

const env = { ...base, OPENCODE_CHANNEL: "prod", OPENCODE_VERSION: DynWorkIdentity.version }

await $`bun run build`.cwd(desktop).env(env)

// The upstream build copies the OpenCode icons just before bundling; swap them in before packing.
await rm(path.join(desktop, "resources/icons"), { recursive: true, force: true })

await cp(path.join(root, "dynwork/packages/branding/icons"), path.join(desktop, "resources/icons"), { recursive: true })

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
  <summary>Dynapps' desktop app for working with AI agents</summary>
  <developer id="es.dynapps">
    <name>Dynapps</name>
  </developer>
  <description>
    <p>${DynWorkIdentity.name} brings the skills, agents and models Dynapps Governance publishes to an AI agent.</p>
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
// it leaves out would need rpmbuild on the runner.
const flags = [`--${cpu}`, "--publish", "never", "--config", "electron-builder.config.ts"]
await (
  os === "mac"
    ? $`bunx electron-builder --mac ${flags} -c.mac.target=dmg -c.mac.identity=- -c.mac.hardenedRuntime=false`
    : os === "win"
      ? $`bunx electron-builder --win ${flags} -c.win.target=nsis`
      : $`bunx electron-builder --linux deb AppImage ${flags}`
)
  .cwd(desktop)
  .env(env)

// Installer names carry no version, so the latest release's download links stay the same. For the same reason no
// blockmap ships: the updater would read the new one as the installed version's and skip the download it needs.
// Linux ships no latest-linux.yml: like macOS it never updates itself, and users install the new deb or AppImage.
// electron-builder names the architecture as each format does, amd64 in the deb and x86_64 in the AppImage.
const files =
  os === "mac"
    ? [`${DynWorkIdentity.artifactPrefix}-mac-${cpu}.dmg`]
    : os === "win"
      ? [`${DynWorkIdentity.artifactPrefix}-win-${cpu}.exe`, "latest.yml"]
      : [
          `${DynWorkIdentity.artifactPrefix}-linux-${cpu === "x64" ? "amd64" : cpu}.deb`,
          `${DynWorkIdentity.artifactPrefix}-linux-${cpu === "x64" ? "x86_64" : cpu}.AppImage`,
        ]

const packed = await readdir(path.join(desktop, "dist"))

const missing = files.filter((file) => !packed.includes(file))

if (missing.length > 0)
  throw new Error(`packages/desktop/dist lacks ${missing.join(", ")}, it holds ${packed.join(", ")}`)

await mkdir(out, { recursive: true })

await Promise.all(files.map((file) => cp(path.join(desktop, "dist", file), path.join(out, file))))

// The pack's own app bundle would show up in Spotlight and "Open With" next to the installed one.
await rm(path.join(desktop, "dist"), { recursive: true, force: true })

console.log(
  `Packed ${files.map((file) => `dist/dynwork/${file}`).join(", ")} (Dynwork ${DynWorkIdentity.version}, CLI ${version}) in ${Math.round((Date.now() - started) / 1000)} s`,
)
