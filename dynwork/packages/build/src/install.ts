export * as Install from "./install"

import { DynWorkIdentity } from "@dynwork/branding/identity"
import path from "node:path"
import { Canary } from "./canary"
import { ChannelBuild } from "./channel-build"

// What `dynwork/script/install.ts` and `desktop.ts` decide per channel on a Mac, kept apart from the shell steps so it
// can be tested. Every Mac install is per channel: it replaces that channel's app and never touches another's.

/** The repository the published builds live in; `gh` in a checkout of the fork defaults to upstream's. */
export const repo = "dynapps-es/dynwork"

/** The channels a published build installs for. */
export const releaseChannels = ["internal", "canary"] as const

/** The channels a local build can go to. Internal is only ever installed from a published release. */
export const localChannels = ["canary", "dev"] as const

export const defaultLocal = "canary"

/** `value` as one of `allowed`, or an error naming them. */
export function choose<const Allowed extends readonly DynWorkIdentity.Channel[]>(
  value: string | undefined,
  allowed: Allowed,
): Allowed[number] {
  const found = allowed.find((channel) => channel === value)
  if (found === undefined) throw new Error(`Unknown channel "${value ?? ""}": expected one of ${allowed.join(", ")}`)
  return found
}

/** Where the channel's app lives. */
export function bundle(channel: DynWorkIdentity.Channel, applications = "/Applications") {
  return path.join(applications, `${DynWorkIdentity.table[channel].name}.app`)
}

export function bundleId(channel: DynWorkIdentity.Channel) {
  return DynWorkIdentity.table[channel].appId
}

/** The DMG a published build of the channel ships for this chip (`process.arch`). */
export function artifact(channel: DynWorkIdentity.Channel, cpu: string) {
  if (cpu !== "arm64" && cpu !== "x64") throw new Error(`DynWork has no Mac build for "${cpu}": expected arm64 or x64`)
  return ChannelBuild.artifacts({ channel, os: "mac", cpu })[0]
}

const internalTag = /^dynwork-v(\d+\.\d+\.\d+)$/

/**
 * The tag to download the channel's build from, given `gh release list --json tagName,isPrerelease,isDraft`: canary's
 * is the rolling prerelease, and internal's the highest published, final `dynwork-v` release.
 */
export function releaseTag(
  channel: DynWorkIdentity.Channel,
  releases: readonly { tagName: string; isPrerelease: boolean; isDraft: boolean }[],
) {
  if (channel === "canary") return Canary.tag
  if (channel !== "internal") throw new Error(`The ${channel} channel has no published build`)

  const [latest] = releases
    .filter((release) => !release.isPrerelease && !release.isDraft)
    .flatMap((release) => {
      const version = internalTag.exec(release.tagName)?.[1]
      return version === undefined ? [] : [{ tag: release.tagName, version }]
    })
    .toSorted((a, b) => Bun.semver.order(b.version, a.version))
  if (latest === undefined) throw new Error("No published internal release (dynwork-v<major>.<minor>.<patch>) found")

  return latest.tag
}

/** AppleScript that quits the channel's app if it runs; `tell` on an app that is not running would open it. */
export function quitScript(channel: DynWorkIdentity.Channel) {
  return `if ${runningScript(channel)} then tell application id "${bundleId(channel)}" to quit`
}

export function runningScript(channel: DynWorkIdentity.Channel) {
  return `application id "${bundleId(channel)}" is running`
}

/**
 * The app version of a local build: the next patch of `base`, marked with the channel and `local`, with the build's
 * stamp. By semver it outranks every published canary of that patch and yields to the internal release that follows.
 */
export function localVersion(channel: DynWorkIdentity.Channel, stamp: number, base = DynWorkIdentity.version) {
  if (channel === "internal") throw new Error("A local build is never internal: install an internal release instead")
  return `${Canary.nextPatch(base)}-${channel}.local.${stamp}`
}
