export * as Canary from "./canary"

import { DynWorkIdentity } from "@dynwork/branding/identity"

// What `dynwork canary` (.github/workflows/dynwork-canary.yml) decides, kept apart from the workflow so it can be tested.

/** The tag of the one rolling prerelease every canary build is published to, and the one the canary feed reads. */
export const tag = "dynwork-canary"

const plain = /^(\d+)\.(\d+)\.(\d+)$/

// What internal releases are tagged: the only thing `releases/latest` may ever be.
const internalTag = /^dynwork-v\d+\.\d+\.\d+$/

/** The patch release after `base`, which must be a plain major.minor.patch. */
export function nextPatch(base: string) {
  const parts = plain.exec(base)
  if (!parts) throw new Error(`The base version "${base}" must be major.minor.patch, with no prerelease or build`)

  return `${parts[1]}.${parts[2]}.${Number(parts[3]) + 1}`
}

/**
 * A canary build's app version: the next patch of `base` with the workflow's run number as the prerelease. By semver it
 * outranks the internal version it follows and every earlier canary, and yields to the internal release that comes next.
 */
export function version(run: number, base = DynWorkIdentity.version) {
  if (!Number.isSafeInteger(run) || run < 1) throw new Error(`The run number "${run}" must be a positive integer`)

  return `${nextPatch(base)}-canary.${run}`
}

/**
 * The guard that follows publishing: the canary release must be a prerelease and `releases/latest` must still be an
 * internal release, because colleagues' Windows installs follow the latest. It takes the raw answers of `gh` and passes
 * only on the exact expected ones, so an empty, failed or garbled answer is a refusal.
 */
export function assertNeverLatest(input: { isPrerelease: string; latestTag: string }) {
  if (input.isPrerelease !== "true")
    throw new Error(`${tag} is not a prerelease (gh reported "${input.isPrerelease}"): it could become the latest`)
  if (!internalTag.test(input.latestTag))
    throw new Error(`The latest release is "${input.latestTag}", not an internal dynwork-v<major>.<minor>.<patch> one`)
}
