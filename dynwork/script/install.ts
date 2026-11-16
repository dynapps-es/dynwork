#!/usr/bin/env bun
// Installs a published DynWork build on this Mac, for one channel: it downloads the channel's DMG from GitHub, quits
// only that channel's app and replaces it in /Applications. The other channel's app and its service are left alone.
//
//   bun dynwork/script/install.ts <internal|canary>
//
// internal is the latest `dynwork-v*` release, canary the rolling `dynwork-canary` prerelease. It needs the `gh` CLI
// signed in to GitHub. The first launch of a build packed without an Apple certificate asks to be opened anyway
// (dynwork/releases/install.md).
import { $ } from "bun"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DynWorkIdentity } from "../packages/branding/src/identity"
import { Install } from "../packages/build/src/install"
import { installBundle } from "./mac-install"

if (process.platform !== "darwin")
  throw new Error("install.ts installs on macOS only: Windows and Linux use the installers")

const channel = Install.choose(process.argv[2], Install.releaseChannels)

if (process.argv.length > 3)
  throw new Error(`Unknown argument "${process.argv[3]}": expected install.ts <${Install.releaseChannels.join("|")}>`)

const name = DynWorkIdentity.table[channel].name

const file = Install.artifact(channel, process.arch)

const releases = JSON.parse(
  await $`gh release list -R ${Install.repo} --limit 100 --json tagName,isPrerelease,isDraft`.text(),
) as { tagName: string; isPrerelease: boolean; isDraft: boolean }[]

const tag = Install.releaseTag(channel, releases)

const work = await mkdtemp(path.join(tmpdir(), "dynwork-install-"))

const mount = path.join(work, "mount")

try {
  console.log(`Downloading ${file} from ${tag}`)
  await $`gh release download ${tag} -R ${Install.repo} -p ${file} -D ${work}`.quiet()

  await $`hdiutil attach -nobrowse -readonly -mountpoint ${mount} ${path.join(work, file)}`.quiet()
  try {
    const installed = await installBundle(channel, path.join(mount, `${name}.app`))
    console.log(`Installed ${installed} from ${tag}`)
  } finally {
    await $`hdiutil detach ${mount}`.nothrow().quiet()
  }
} finally {
  await rm(work, { recursive: true, force: true })
}
