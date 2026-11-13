export * as DynWorkIdentity from "./identity"

// The prod channel of the desktop app ships as DynWork. Dev and beta keep the upstream identity.
export const name = "Dynwork"

// The desktop main process keeps userData under the app id, so DynWork never shares it with an installed OpenCode.
export const appId = "es.dynapps.dynwork"

export const scheme = "dynwork"

// DynWork's own version: the desktop app, its installers and its GitHub releases (tag `dynwork-v<version>`) carry it.
// The bundled CLI keeps upstream's version, which names its service and staged copies. Bump it for every release.
export const version = "0.1.1"

// The latest GitHub release. Windows updates from its latest.yml; macOS finds none, since Squirrel.Mac refuses an
// update signed ad hoc, and testers install a new DMG themselves. Linux finds none either and installs a new deb or
// AppImage the same way.
export const updateFeed = "https://github.com/dynapps-es/dynwork/releases/latest/download/"

export const rpmPackage = "dynwork"

export const artifactPrefix = "dynwork-desktop"

// DynWork's own background service listens here, never on OpenCode's 0xC0DE, so the two apps never contend for one
// port. 0x4457 is "DW"; it stays below 0x8000, the range Windows reserves for outgoing connections.
export const servicePort = 0x4457
