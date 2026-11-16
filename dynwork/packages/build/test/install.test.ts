import { describe, expect, test } from "bun:test"
import { DynWorkIdentity } from "@dynwork/branding/identity"
import { Install } from "../src/install"

describe("channels", () => {
  test("a published build installs for internal and canary, a local build goes to canary or dev", () => {
    expect(Install.releaseChannels).toEqual(["internal", "canary"])
    expect(Install.localChannels).toEqual(["canary", "dev"])
    expect(Install.defaultLocal).toBe("canary")
  })

  test("choose returns the channel when it is allowed and names the options when it is not", () => {
    expect(Install.choose("canary", Install.releaseChannels)).toBe("canary")
    expect(() => Install.choose("internal", Install.localChannels)).toThrow('Unknown channel "internal"')
    expect(() => Install.choose("internal", Install.localChannels)).toThrow("canary, dev")
    expect(() => Install.choose(undefined, Install.releaseChannels)).toThrow("expected one of internal, canary")
    expect(() => Install.choose("constructor", Install.releaseChannels)).toThrow("Unknown channel")
  })
})

describe("bundle", () => {
  test("each channel installs to its own app in /Applications", () => {
    expect(Install.bundle("internal")).toBe("/Applications/Dynwork.app")
    expect(Install.bundle("canary")).toBe("/Applications/Dynwork Canary.app")
    expect(Install.bundle("dev")).toBe("/Applications/Dynwork Dev.app")
  })

  test("no two channels share a bundle or a bundle id", () => {
    const channels = Object.keys(DynWorkIdentity.table) as DynWorkIdentity.Channel[]

    expect(new Set(channels.map((channel) => Install.bundle(channel))).size).toBe(channels.length)
    expect(new Set(channels.map((channel) => Install.bundleId(channel))).size).toBe(channels.length)
  })
})

describe("published artifact", () => {
  test("is the channel's DMG for the machine's chip", () => {
    expect(Install.artifact("internal", "arm64")).toBe("dynwork-desktop-mac-arm64.dmg")
    expect(Install.artifact("canary", "arm64")).toBe("dynwork-canary-desktop-mac-arm64.dmg")
    expect(Install.artifact("canary", "x64")).toBe("dynwork-canary-desktop-mac-x64.dmg")
  })

  test("is refused for a chip DynWork does not pack for", () => {
    expect(() => Install.artifact("canary", "ia32")).toThrow('"ia32"')
  })
})

describe("release tag", () => {
  const release = (tagName: string, extra: { isPrerelease?: boolean; isDraft?: boolean } = {}) => ({
    tagName,
    isPrerelease: false,
    isDraft: false,
    ...extra,
  })

  test("canary is the one rolling prerelease, whatever else is published", () => {
    expect(Install.releaseTag("canary", [release("dynwork-v0.1.1")])).toBe("dynwork-canary")
    expect(Install.releaseTag("canary", [])).toBe("dynwork-canary")
  })

  test("internal is the highest published dynwork-v release, compared as semver", () => {
    expect(
      Install.releaseTag("internal", [
        release("dynwork-v0.1.9"),
        release("dynwork-v0.1.10"),
        release("dynwork-v0.1.2"),
        release("dynwork-canary", { isPrerelease: true }),
      ]),
    ).toBe("dynwork-v0.1.10")
  })

  test("internal skips drafts, prereleases and tags that are not dynwork-vX.Y.Z", () => {
    expect(
      Install.releaseTag("internal", [
        release("dynwork-v0.2.0", { isDraft: true }),
        release("dynwork-v0.3.0", { isPrerelease: true }),
        release("dynwork-v0.4.0-rc.1"),
        release("v1.16.0"),
        release("dynwork-v0.1.1"),
      ]),
    ).toBe("dynwork-v0.1.1")
  })

  test("internal fails when no internal release is published", () => {
    expect(() => Install.releaseTag("internal", [release("dynwork-canary", { isPrerelease: true })])).toThrow(
      "No published internal release",
    )
  })

  test("dev has no published build", () => {
    expect(() => Install.releaseTag("dev", [release("dynwork-v0.1.1")])).toThrow("dev")
  })
})

describe("quit and running scripts", () => {
  test("address the channel's own bundle id and no other", () => {
    const channels = Object.keys(DynWorkIdentity.table) as DynWorkIdentity.Channel[]

    for (const channel of channels)
      for (const script of [Install.quitScript(channel), Install.runningScript(channel)]) {
        expect(script).toContain(`application id "${DynWorkIdentity.table[channel].appId}"`)
        // internal's id is a prefix of the others': only the quoted, complete id may appear.
        const ids = [...script.matchAll(/application id "([^"]+)"/g)].map((match) => match[1])
        expect(new Set(ids)).toEqual(new Set([DynWorkIdentity.table[channel].appId]))
      }
  })

  test("the quit script never launches an app that is not running", () => {
    expect(Install.quitScript("canary")).toStartWith('if application id "es.dynapps.dynwork.canary" is running then')
    expect(Install.runningScript("canary")).toBe('application id "es.dynapps.dynwork.canary" is running')
  })
})

describe("local version", () => {
  test("is the next patch, marked with the channel and local, with the stamp", () => {
    expect(Install.localVersion("canary", 1731800000000, "0.1.1")).toBe("0.1.2-canary.local.1731800000000")
    expect(Install.localVersion("dev", 5, "0.1.1")).toBe("0.1.2-dev.local.5")
  })

  test("follows the published canaries and yields to the next internal release", () => {
    expect(Bun.semver.order(Install.localVersion("canary", 1731800000000, "0.1.1"), "0.1.2-canary.99")).toBe(1)
    expect(Bun.semver.order(Install.localVersion("canary", 1731800000000, "0.1.1"), "0.1.2")).toBe(-1)
  })

  test("is refused for internal, which is never installed from a local build", () => {
    expect(() => Install.localVersion("internal", 1, "0.1.1")).toThrow("internal")
  })
})
