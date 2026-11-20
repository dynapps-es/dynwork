export * as AccountsModel from "./model"

import type { Account, Counts, Lapse, PersonSignIn, SignIn, State, SyncError } from "../contract"

// What the Accounts page and the titlebar pill show, as plain values: the page and the pill only render them, so the
// statuses and the actions an account offers are tested here without a window.

/**
 * A badge beside an instance's name. `key-changed` and `new-key` wait for `trust`; `needs-sign-in` for the user to sign
 * in again.
 */
export type Badge = "active" | "signed-out" | "needs-sign-in" | "key-changed" | "new-key"

/** What an instance says about its sync. Only the active instance syncs, so the others are `idle`. */
export type Sync =
  | { kind: "signed-out" }
  | { kind: "needs-sign-in"; lapse: Lapse }
  | { kind: "idle" }
  | { kind: "waiting" }
  | { kind: "syncing" }
  | { kind: "synced"; at: number; counts: Counts }
  | { kind: "error"; error: SyncError; at: number }

export type Action = "trust" | "sync-now" | "make-active" | "sign-in" | "sign-in-again" | "sign-out" | "remove"

export type Row = {
  account: Account
  /** The label to show: the instance's label, followed by its host when another instance has the same label. */
  name: string
  /** The instance's first letter, for its avatar. */
  initial: string
  host: string
  /** In the order they show: active, signed out, then the key that waits for trust. */
  badges: readonly Badge[]
  sync: Sync
  /** The key waiting for the user's `trust`, with the one it would replace. */
  key: { offered: string; pinned: string | undefined } | undefined
  /** In the order the page lists them; `sync-now` is absent while the sync cannot run. */
  actions: readonly Action[]
}

export function rows(state: State): readonly Row[] {
  return state.accounts.map((account) => row(account, state))
}

export function row(account: Account, state: State): Row {
  const key = pending(account)
  const sync = syncOf(account, state)

  return {
    account,
    name: name(account, state),
    initial: Array.from(account.label.trim())[0]?.toUpperCase() ?? "?",
    host: host(account.url),
    badges: badges(account, key !== undefined),
    sync,
    key,
    actions: actions(account, key !== undefined, sync),
  }
}

/**
 * The label to show for an account. Instances with the same branding read the same, so a label another known account
 * also carries gets the host next to it.
 */
export function name(account: Account, state: State) {
  const label = account.label.trim().toLowerCase()
  const collides = state.accounts.some((other) => other.id !== account.id && other.label.trim().toLowerCase() === label)

  return collides ? `${account.label} (${host(account.url)})` : account.label
}

/** The active account that is signed in, which the pill shows and the sync follows. */
export function active(state: State) {
  return state.accounts.find((account) => account.active && account.status === "signedIn")
}

/** The active account when the instance refused its sign-in for good: it waits for the user to sign in again. */
export function lapsed(state: State) {
  return state.accounts.find((account) => account.active && account.status === "needsSignIn")
}

/** The accounts the pill's dialog lists to switch to: signed in, not active. */
export function others(state: State) {
  return state.accounts.filter((account) => !account.active && account.status === "signedIn")
}

/** Why a sync failed, as the key of the plugin's copy (`sync.error.<kind>`). */
export function errorKey(error: SyncError) {
  return `sync.error.${error}` as const
}

/** The short sentence under an instance's name and what the pill's title says: when it last synced, or what failed. */
export function describe(sync: Sync, now: number, locale?: string) {
  if (sync.kind === "synced") return { key: "sync.synced" as const, time: ago(sync.at, now, locale) }
  if (sync.kind === "error") return { key: errorKey(sync.error), time: ago(sync.at, now, locale) }
  if (sync.kind === "syncing") return { key: "sync.syncing" as const, time: undefined }
  if (sync.kind === "signed-out") return { key: "sync.signedOut" as const, time: undefined }
  if (sync.kind === "needs-sign-in") return { key: `sync.lapse.${sync.lapse}` as const, time: undefined }
  if (sync.kind === "waiting") return { key: "sync.waiting" as const, time: undefined }
  return { key: "sync.idle" as const, time: undefined }
}

/**
 * What the window says when a sign-in again did not end signed in, as the key of the plugin's copy; nothing when it
 * did, or when the user cancelled it.
 */
export function outcome(value: SignIn) {
  if (value === "signed-in" || value === "cancelled") return undefined
  if (value === "denied") return "lapse.outcome.denied" as const
  if (value === "expired") return "lapse.outcome.expired" as const
  if (value === "unreachable") return "lapse.outcome.unreachable" as const
  return "lapse.outcome.failed" as const
}

/**
 * What Settings -> Governance says of DynWork acting as the person in the account's Drive: its badge, its sentence (a
 * key of the plugin's copy, with `until` for the time the session ends) and the one action it offers. Nothing for an
 * account that is not signed in, or whose instance does not offer it.
 */
export function person(account: Account) {
  const value = account.person
  if (account.status !== "signedIn" || value === undefined || value.status === "unavailable") return undefined
  if (value.status === "on")
    return { badge: "on" as const, key: "person.on" as const, action: "sign-out" as const, until: value.until }
  if (value.status === "renewing")
    return { badge: "renewing" as const, key: "person.renewing" as const, action: "sign-out" as const, until: value.until }
  if (value.status === "signingIn")
    return { badge: undefined, key: "person.signingIn" as const, action: "cancel" as const, until: undefined }
  return {
    badge: undefined,
    key: value.ended ? ("person.ended" as const) : ("person.off" as const),
    action: "sign-in" as const,
    until: undefined,
  }
}

/** What the window says when the person's sign-in did not end signed in; nothing when it did, or was cancelled. */
export function personOutcome(value: PersonSignIn) {
  if (value === "signed-in" || value === "cancelled") return undefined
  if (value === "denied") return "lapse.outcome.denied" as const
  if (value === "expired") return "lapse.outcome.expired" as const
  if (value === "unreachable") return "lapse.outcome.unreachable" as const
  if (value === "mismatch") return "person.outcome.mismatch" as const
  if (value === "unavailable") return "person.outcome.unavailable" as const
  return "lapse.outcome.failed" as const
}

/** A time of today as the locale writes it ("14:05"), for when the person's session ends. */
export function clock(at: number, locale?: string) {
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(at)
}

/** "2 minutes ago", in the locale. Under a minute reads as "now". */
export function ago(at: number, now: number, locale?: string) {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" })

  if (seconds < 60) return format.format(0, "second")
  if (seconds < 3600) return format.format(-Math.floor(seconds / 60), "minute")
  if (seconds < 86_400) return format.format(-Math.floor(seconds / 3600), "hour")
  return format.format(-Math.floor(seconds / 86_400), "day")
}

/** A fingerprint as the page shows it: the head of the hash, long enough to compare. */
export function short(fingerprint: string) {
  const [algorithm, hash] = fingerprint.includes(":") ? fingerprint.split(":") : ["", fingerprint]

  if (!hash || hash.length <= 16) return fingerprint
  return `${algorithm ? `${algorithm}:` : ""}${hash.slice(0, 16)}…`
}

/**
 * The titlebar pill: its icon and tone say how the sync stands, since the pill has no room for a dot. Green once
 * synced, red when the sync failed, amber while a new key waits for the user's trust or the user must sign in again;
 * the accent while it syncs or waits to.
 */
export function pill(state: State) {
  const account = active(state) ?? lapsed(state)

  if (!account) return undefined
  const sync = syncOf(account, state)
  const shown = { account, name: name(account, state), sync }

  if (sync.kind === "needs-sign-in") return { ...shown, icon: "circle-exclamation" as const, tone: "warning" as const }
  if (sync.kind === "error") return { ...shown, icon: "circle-exclamation" as const, tone: "danger" as const }
  if (pending(account)) return { ...shown, icon: "circle-exclamation" as const, tone: "warning" as const }
  if (sync.kind === "syncing") return { ...shown, icon: "refresh" as const, tone: undefined }
  if (sync.kind === "synced") return { ...shown, icon: "circle-check" as const, tone: "success" as const }
  return { ...shown, icon: "server" as const, tone: undefined }
}

function pending(account: Account) {
  if (account.status !== "signedIn" || account.trusted || account.fingerprint === undefined) return undefined
  return { offered: account.fingerprint, pinned: account.pinned }
}

function badges(account: Account, keyPending: boolean): readonly Badge[] {
  if (account.status === "signedOut") return ["signed-out"]
  if (account.status === "needsSignIn") return account.active ? ["active", "needs-sign-in"] : ["needs-sign-in"]
  const key: readonly Badge[] = keyPending ? [account.pinned === undefined ? "new-key" : "key-changed"] : []

  return account.active ? ["active", ...key] : key
}

function syncOf(account: Account, state: State): Sync {
  if (account.status === "signedOut") return { kind: "signed-out" }
  if (account.status === "needsSignIn") return { kind: "needs-sign-in", lapse: account.lapse ?? "refused" }
  if (!account.active) return { kind: "idle" }
  const sync = state.sync
  if (sync.status === "idle" || sync.account !== account.id) return { kind: "waiting" }
  if (sync.status === "syncing") return { kind: "syncing" }
  if (sync.status === "synced") return { kind: "synced", at: sync.at, counts: sync.counts }
  return { kind: "error", error: sync.kind, at: sync.at }
}

function actions(account: Account, keyPending: boolean, sync: Sync): readonly Action[] {
  if (account.status === "signedOut") return ["sign-in", "remove"]
  if (account.status === "needsSignIn") return ["sign-in-again", "sign-out", "remove"]
  const rest: readonly Action[] = ["sign-out", "remove"]
  const first: readonly Action[] = keyPending ? ["trust"] : []

  if (!account.active) return [...first, "make-active", ...rest]
  // Sync stops at a key it does not trust and runs one sync at a time.
  const canSync = !keyPending && sync.kind !== "syncing"

  return [...first, ...(canSync ? (["sync-now"] as const) : []), ...rest]
}

function host(url: string) {
  return URL.canParse(url) ? new URL(url).host : url
}
