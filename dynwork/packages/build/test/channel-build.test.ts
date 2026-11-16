import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DynWorkIdentity } from "@dynwork/branding/identity"
import { ChannelBuild } from "../src/channel-build"

const channels = Object.keys(DynWorkIdentity.table) as DynWorkIdentity.Channel[]

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const write = async (root: string, file: string, content = "") => {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true })
  await Bun.write(path.join(root, file), content)
}

const dist = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dynwork-channel-build-"))
  roots.push(root)
  return root
}

describe("appVersion", () => {
  test("is DynWork's own version unless DYNWORK_VERSION says another", () => {
    expect(ChannelBuild.appVersion(undefined)).toBe(DynWorkIdentity.version)
    expect(ChannelBuild.appVersion("")).toBe(DynWorkIdentity.version)
    expect(ChannelBuild.appVersion("0.1.2-canary.0")).toBe("0.1.2-canary.0")
    expect(ChannelBuild.appVersion("0.2.0")).toBe("0.2.0")
  })

  // macOS and Windows take build metadata badly: only the CLI version carries the commit.
  test.each(["0.1.2-canary.0+abc1234567", "v0.1.2", "0.1", "canary", "0.1.2-"])("rejects %s", (value) => {
    expect(() => ChannelBuild.appVersion(value)).toThrow("DYNWORK_VERSION")
  })

  test("the CLI version is upstream's marked with the app version and the commit", () => {
    expect(DynWorkIdentity.cliVersion("2.2.5", "eb7cefa49d", "0.1.2-canary.0")).toBe(
      "2.2.5-dynwork.0.1.2-canary.0+eb7cefa49d",
    )
    expect(DynWorkIdentity.cliVersion("2.2.5", "eb7cefa49d")).toBe(
      `2.2.5-dynwork.${DynWorkIdentity.version}+eb7cefa49d`,
    )
  })
})

describe("artifacts", () => {
  // The installers' names are the download links of the latest release: internal's must not move.
  test.each([
    { os: "mac", cpu: "arm64", files: ["dynwork-desktop-mac-arm64.dmg"] },
    { os: "mac", cpu: "x64", files: ["dynwork-desktop-mac-x64.dmg"] },
    { os: "win", cpu: "x64", files: ["dynwork-desktop-win-x64.exe", "latest.yml"] },
    { os: "linux", cpu: "x64", files: ["dynwork-desktop-linux-amd64.deb", "dynwork-desktop-linux-x86_64.AppImage"] },
    { os: "linux", cpu: "arm64", files: ["dynwork-desktop-linux-arm64.deb", "dynwork-desktop-linux-arm64.AppImage"] },
  ] as const)("internal keeps today's names on $os $cpu", (row) => {
    expect(ChannelBuild.artifacts({ channel: "internal", os: row.os, cpu: row.cpu })).toEqual([...row.files])
  })

  test.each(channels)("%s names its installers from its own prefix", (channel) => {
    const prefix = DynWorkIdentity.table[channel].artifactPrefix

    expect(ChannelBuild.artifacts({ channel, os: "mac", cpu: "arm64" })).toEqual([`${prefix}-mac-arm64.dmg`])
    expect(ChannelBuild.artifacts({ channel, os: "win", cpu: "x64" })).toEqual([`${prefix}-win-x64.exe`, "latest.yml"])
    expect(ChannelBuild.artifacts({ channel, os: "linux", cpu: "x64" })).toEqual([
      `${prefix}-linux-amd64.deb`,
      `${prefix}-linux-x86_64.AppImage`,
    ])
  })

  test("no two channels produce the same file", () => {
    const files = channels.flatMap((channel) =>
      (["mac", "win", "linux"] as const)
        .flatMap((os) => ChannelBuild.artifacts({ channel, os, cpu: "x64" }))
        .filter((file) => file !== "latest.yml"),
    )

    expect(new Set(files).size).toBe(files.length)
  })
})

describe("builderFlags", () => {
  // Existing Windows installs of internal keep their updater cache folder, so internal passes nothing.
  test("internal passes no extra flag", () => {
    expect(ChannelBuild.builderFlags("internal")).toEqual([])
  })

  test.each([
    { channel: "canary", name: "dynwork-canary" },
    { channel: "dev", name: "dynwork-dev" },
  ] as const)("$channel names the package, and so its updater cache, $name", (row) => {
    expect(ChannelBuild.builderFlags(row.channel)).toEqual([`-c.extraMetadata.name=${row.name}`])
  })
})

describe("the electron-builder config", () => {
  // The post-pack check compares the bundle with `expected`; this pins `expected` to what the config really asks for.
  test.each(channels)("%s asks electron-builder for what the check expects", (channel) => {
    const config = path.join(import.meta.dir, "../../../../packages/desktop/electron-builder.config.ts")
    const env = { ...process.env, DYNWORK_CHANNEL: channel, OPENCODE_CHANNEL: "prod" }

    const run = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        `import config from ${JSON.stringify(config)}
console.log(JSON.stringify({ appId: config.appId, productName: config.productName, url: config.publish.url, artifactName: config.artifactName, rpm: config.rpm.packageName }))`,
      ],
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
    const wanted = ChannelBuild.expected(channel, "0.1.2")

    expect(run.stderr.toString()).toBe("")
    expect(JSON.parse(run.stdout.toString())).toEqual({
      appId: wanted.identifier,
      productName: wanted.app.replace(/\.app$/, ""),
      url: wanted.feed,
      artifactName: `${DynWorkIdentity.table[channel].artifactPrefix}-\${os}-\${arch}.\${ext}`,
      rpm: wanted.debPackage,
    })
  })
})

describe("expected", () => {
  test("canary is its own app, feed and updater cache", () => {
    expect(ChannelBuild.expected("canary", "0.1.2-canary.0")).toEqual({
      app: "Dynwork Canary.app",
      identifier: "es.dynapps.dynwork.canary",
      version: "0.1.2-canary.0",
      feed: "https://github.com/dynapps-es/dynwork/releases/download/dynwork-canary/",
      cacheDir: "dynwork-canary-updater",
      debPackage: "dynwork-canary",
    })
  })

  // Internal's package name stays upstream's, so its updater cache has no name to compare with.
  test("internal expects no updater cache name", () => {
    const wanted = ChannelBuild.expected("internal", "0.1.1")

    expect(wanted.cacheDir).toBeUndefined()
    expect(wanted.identifier).toBe("es.dynapps.dynwork")
    expect(wanted.feed).toBe("https://github.com/dynapps-es/dynwork/releases/latest/download/")
  })
})

describe("assertCarries", () => {
  test("passes when every expected value is there", () => {
    expect(() =>
      ChannelBuild.assertCarries(
        "the app",
        "canary",
        { identifier: "es.dynapps.dynwork.canary", cacheDir: undefined },
        { identifier: "es.dynapps.dynwork.canary", cacheDir: "whatever" },
      ),
    ).not.toThrow()
  })

  // The bug this guards: the channel does not reach the main bundle and canary packs with internal's identity.
  test("names each value that carries another channel's identity", () => {
    expect(() =>
      ChannelBuild.assertCarries("Dynwork Canary.app", "canary", ChannelBuild.expected("canary", "0.1.2-canary.0"), {
        app: "Dynwork Canary.app",
        identifier: "es.dynapps.dynwork",
        version: "0.1.2-canary.0",
        feed: "https://github.com/dynapps-es/dynwork/releases/latest/download/",
        cacheDir: "dynwork-canary-updater",
        debPackage: undefined,
      }),
    ).toThrow(
      'Dynwork Canary.app does not carry the canary identity: identifier is "es.dynapps.dynwork", expected "es.dynapps.dynwork.canary"; feed is "https://github.com/dynapps-es/dynwork/releases/latest/download/", expected "https://github.com/dynapps-es/dynwork/releases/download/dynwork-canary/"',
    )
  })

  test("a value the bundle lacks is reported as missing", () => {
    expect(() => ChannelBuild.assertCarries("the app", "canary", { feed: "x" }, {})).toThrow(
      'feed is missing, expected "x"',
    )
  })
})

describe("the packed bundle on disk", () => {
  test("finds the mac app and reads its update config", async () => {
    const root = await dist()
    await write(
      root,
      "mac-arm64/Dynwork Canary.app/Contents/Resources/app-update.yml",
      "provider: generic\nurl: https://example.test/feed/\nchannel: latest\nupdaterCacheDirName: dynwork-canary-updater\n",
    )
    await write(root, "builder-debug.yml")

    const found = await ChannelBuild.locateMac(root)

    expect(found.app).toBe(path.join(root, "mac-arm64/Dynwork Canary.app"))
    expect(found.resources).toBe(path.join(found.app, "Contents/Resources"))
    expect(await ChannelBuild.readUpdate(path.join(found.resources, "app-update.yml"))).toEqual({
      url: "https://example.test/feed/",
      cacheDir: "dynwork-canary-updater",
    })
  })

  test("finds the Windows unpacked app, whatever its architecture", async () => {
    const root = await dist()
    await write(root, "win-arm64-unpacked/resources/app-update.yml", "url: ''\n")

    const found = await ChannelBuild.locateWin(root)

    expect(found.resources).toBe(path.join(root, "win-arm64-unpacked/resources"))
    expect(await ChannelBuild.readUpdate(path.join(found.resources, "app-update.yml"))).toEqual({
      url: "",
      cacheDir: undefined,
    })
  })

  test("reads the version and installer a latest.yml names", async () => {
    const root = await dist()
    await write(
      root,
      "latest.yml",
      "version: 0.1.2-canary.0\nfiles:\n  - url: dynwork-canary-desktop-win-x64.exe\n    sha512: abc\npath: dynwork-canary-desktop-win-x64.exe\nsha512: abc\nreleaseDate: '2026-11-16T10:00:00.000Z'\n",
    )

    expect(await ChannelBuild.readLatest(path.join(root, "latest.yml"))).toEqual({
      version: "0.1.2-canary.0",
      path: "dynwork-canary-desktop-win-x64.exe",
    })
  })

  test.each(["mac", "win"] as const)("refuses a %s pack that left no app, or two", async (os) => {
    const empty = await dist()
    const two = await dist()
    const names =
      os === "mac"
        ? ["mac/A.app/Contents/Resources/x", "mac-arm64/B.app/Contents/Resources/x"]
        : ["win-unpacked/resources/x", "win-arm64-unpacked/resources/x"]
    await Promise.all(names.map((file) => write(two, file)))

    const locate = os === "mac" ? ChannelBuild.locateMac : ChannelBuild.locateWin

    await expect(locate(empty)).rejects.toThrow("expected one")
    await expect(locate(two)).rejects.toThrow("expected one")
  })
})
