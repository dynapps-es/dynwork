export * as DynWorkIdentity from "./identity"

// The prod channel of the desktop app ships as DynWork. Dev and beta keep the upstream identity.
export const name = "DynWork"

// The desktop main process keeps userData under the app id, so DynWork never shares it with an installed OpenCode.
export const appId = "es.dynapps.dynwork"

export const scheme = "dynwork"

// No releases are published yet, so the updater fails quietly until the first one.
export const updateFeed = "https://github.com/dynapps-es/dynwork/releases/latest/download/"

export const rpmPackage = "dynwork"

export const artifactPrefix = "dynwork-desktop"

// DynWork's own background service listens here, never on OpenCode's 0xC0DE, so the two apps never contend for one
// port. 0x4457 is "DW"; it stays below 0x8000, the range Windows reserves for outgoing connections.
export const servicePort = 0x4457
