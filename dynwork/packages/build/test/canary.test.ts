import { describe, expect, test } from "bun:test"
import path from "node:path"
import { DynWorkIdentity } from "@dynwork/branding/identity"
import { Canary } from "../src/canary"
import { ChannelBuild } from "../src/channel-build"

const script = path.resolve(import.meta.dir, "../../../script/canary.ts")

const run = async (...args: string[]) => {
  const child = Bun.spawn(["bun", script, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, , exit] = await Promise.all([child.stdout.text(), child.stderr.text(), child.exited])
  return { stdout: stdout.trim(), exit }
}

describe("version", () => {
  test("is the next patch of the base, marked canary, with the run number", () => {
    expect(Canary.version(7, "0.1.1")).toBe("0.1.2-canary.7")
    expect(Canary.version(120, "1.9.9")).toBe("1.9.10-canary.120")
  })

  test("defaults to DynWork's own version", () => {
    expect(Canary.version(3)).toMatch(/^\d+\.\d+\.\d+-canary\.3$/)
    expect(Bun.semver.order(Canary.version(3), DynWorkIdentity.version)).toBe(1)
  })

  // The Windows updater compares versions as semver: a build must outrank the previous one and the internal version it
  // follows, and yield to the internal release that comes next.
  test("orders by run above the internal version and below the next release", () => {
    expect(Bun.semver.order(Canary.version(99, "0.1.1"), Canary.version(100, "0.1.1"))).toBe(-1)
    expect(Bun.semver.order(Canary.version(1, "0.1.1"), "0.1.1")).toBe(1)
    expect(Bun.semver.order(Canary.version(1000, "0.1.1"), "0.1.2")).toBe(-1)
  })

  test("is a version the packaging accepts for the app", () => {
    expect(ChannelBuild.appVersion(Canary.version(42))).toBe(Canary.version(42))
  })

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects the run number %p", (value) => {
    expect(() => Canary.version(value, "0.1.1")).toThrow("run number")
  })

  test.each(["0.1.2-canary.1", "0.1.1+abc", "v0.1.1", "0.1", ""])("rejects the base %p", (base) => {
    expect(() => Canary.version(1, base)).toThrow("base version")
  })
})

describe("assertNeverLatest", () => {
  test("accepts a prerelease canary while the latest release is an internal one", () => {
    expect(() => Canary.assertNeverLatest({ isPrerelease: "true", latestTag: "dynwork-v0.1.1" })).not.toThrow()
    expect(() => Canary.assertNeverLatest({ isPrerelease: "true", latestTag: "dynwork-v12.34.56" })).not.toThrow()
  })

  // Fail closed: only the exact expected answers pass, so a failed or garbled `gh` call never reads as safe.
  test.each(["false", "", "True", "1", "null", "true\n"])("refuses a canary release reported as %p", (isPrerelease) => {
    expect(() => Canary.assertNeverLatest({ isPrerelease, latestTag: "dynwork-v0.1.1" })).toThrow("prerelease")
  })

  test.each([
    "",
    "dynwork-canary",
    "dynwork-v0.1.2-canary.3",
    "dynwork-v0.1",
    "v0.1.1",
    "canary",
    "dynwork-v0.1.1\n",
    "null",
  ])("refuses the latest release %p", (latestTag) => {
    expect(() => Canary.assertNeverLatest({ isPrerelease: "true", latestTag })).toThrow("latest")
  })

  test("names the canary tag as the one the canary channel's feed reads", () => {
    expect(DynWorkIdentity.table.canary.updateFeed).toContain(`/releases/download/${Canary.tag}/`)
  })
})

describe("script/canary.ts", () => {
  test("prints the version, and guards with an exit code", async () => {
    const [version, safe, notPrerelease, wrongLatest, noArguments, unknown, badRun] = await Promise.all([
      run("version", "7"),
      run("guard", "true", "dynwork-v0.1.1"),
      run("guard", "false", "dynwork-v0.1.1"),
      run("guard", "true", "dynwork-canary"),
      run("guard"),
      run("publish"),
      run("version", "abc"),
    ])

    expect(version).toEqual({ stdout: Canary.version(7), exit: 0 })
    expect(safe.exit).toBe(0)
    expect(notPrerelease.exit).not.toBe(0)
    expect(wrongLatest.exit).not.toBe(0)
    expect(noArguments.exit).not.toBe(0)
    expect(unknown.exit).not.toBe(0)
    expect(badRun.exit).not.toBe(0)
  })
})
