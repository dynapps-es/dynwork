export * as DynWorkIdentity from "./identity"

// DynWork ships in channels that install side by side: each one has its own app id (so its own userData), name, URL
// scheme, service port, update feed and artifact names. `internal` is DynWork as it has always shipped.
//
// A channel is not an OpenCode channel: the desktop keeps running as OpenCode's `prod` for all of them, because only
// that one gets DynWork's own service (`gui/src/service.ts`).
const channels = {
  internal: {
    name: "Dynwork",
    // The desktop main process keeps userData under the app id, so DynWork never shares it with an installed OpenCode.
    appId: "es.dynapps.dynwork",
    scheme: "dynwork",
    // The latest GitHub release. Windows updates from its latest.yml; macOS finds none, since Squirrel.Mac refuses an
    // update signed ad hoc, and testers install a new DMG themselves. Linux finds none either and installs a new deb or
    // AppImage the same way.
    updateFeed: "https://github.com/dynapps-es/dynwork/releases/latest/download/",
    rpmPackage: "dynwork",
    debPackage: "dynwork",
    artifactPrefix: "dynwork-desktop",
    // DynWork's own background service listens here, never on OpenCode's 0xC0DE, so the two apps never contend for one
    // port. 0x4457 is "DW"; it stays below 0x8000, the range Windows reserves for outgoing connections.
    servicePort: 0x4457,
  },
  canary: {
    name: "Dynwork Canary",
    appId: "es.dynapps.dynwork.canary",
    scheme: "dynwork-canary",
    // The rolling prerelease that CI rebuilds after every merge to main. It is never the latest release.
    updateFeed: "https://github.com/dynapps-es/dynwork/releases/download/dynwork-canary/",
    rpmPackage: "dynwork-canary",
    debPackage: "dynwork-canary",
    artifactPrefix: "dynwork-canary-desktop",
    servicePort: 0x4458,
  },
  dev: {
    name: "Dynwork Dev",
    appId: "es.dynapps.dynwork.dev",
    scheme: "dynwork-dev",
    // Dev builds are never published: no feed, and an empty string because the builder config expects a string.
    updateFeed: "",
    rpmPackage: "dynwork-dev",
    debPackage: "dynwork-dev",
    artifactPrefix: "dynwork-dev-desktop",
    servicePort: 0x4459,
  },
}

export type Channel = keyof typeof channels

/** Every channel's identity, as data for the tests that keep them apart. */
export const table = channels

/**
 * The channel this process runs as. The desktop build fixes it with a `define` on this very expression
 * (`@dynwork/build/vite`), so a packaged app ignores the user's environment.
 */
export const channel = resolve(process.env.DYNWORK_CHANNEL)

const current = channels[channel]

export const name = current.name

export const appId = current.appId

export const scheme = current.scheme

// DynWork's own version: the desktop app, its installers and its GitHub releases (tag `dynwork-v<version>`) carry it.
// Bump it for every release.
export const version = "0.1.1"

// The bundled CLI's version: upstream's, marked with DynWork's version and the build. The desktop keeps running a staged
// CLI and its service while their version is the bundled one's, so with upstream's alone a DynWork update would keep
// the previous build's CLI and service.
export function cliVersion(upstream: string, build: string) {
  return `${upstream}-dynwork.${version}+${build}`
}

export const updateFeed = current.updateFeed

export const rpmPackage = current.rpmPackage

export const debPackage = current.debPackage

export const artifactPrefix = current.artifactPrefix

export const servicePort = current.servicePort

function resolve(value: string | undefined): Channel {
  if (value === undefined) return "internal"
  if (Object.hasOwn(channels, value)) return value as Channel
  throw new Error(`Unknown DYNWORK_CHANNEL "${value}": expected one of ${Object.keys(channels).join(", ")}`)
}
