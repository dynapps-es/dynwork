import { Schema } from "effect"
import { Ipc } from "@opencode/plugin/gui"

/**
 * Why an account needs the user to sign in again: the instance refused the device key DynWork signs in with, saying it
 * `expired`, or with no reason (`revoked`: revoked, deleted or past the instance's key lifetime, which it answers
 * alike); or it refused a JWT minted fresh from a key it still takes (`refused`).
 */
export const Lapse = Schema.Literals(["expired", "revoked", "refused"])
export type Lapse = typeof Lapse.Type

/**
 * DynWork acting as the person in the Drive with the person's own UI session (0.84): `unavailable` when the instance
 * declares no client for it (0.83, or not declared), `off` until the person signs in in the browser (`ended` once a
 * session ran its 12 hours), `signingIn` while that sign-in is under way, `on` while main holds a live session and
 * `renewing` while it waits on a refresh. `until` is when the session ends, epoch milliseconds. Its tokens never leave
 * main.
 */
export const Person = Schema.Struct({
  status: Schema.Literals(["unavailable", "off", "signingIn", "on", "renewing"]),
  ended: Schema.optional(Schema.Boolean),
  until: Schema.optional(Schema.Number),
})
export type Person = typeof Person.Type

/**
 * How the person's browser sign-in ended: as `SignIn`, plus `unavailable` (the instance gives no UI session, or the
 * account is not signed in) and `mismatch` (the browser signed in someone else than the account's user).
 */
export const PersonSignIn = Schema.Literals([
  "signed-in",
  "cancelled",
  "denied",
  "expired",
  "unreachable",
  "refused",
  "unavailable",
  "mismatch",
  "insecure",
  "failed",
])
export type PersonSignIn = typeof PersonSignIn.Type

/** One signed-in or known systemprompt instance as windows see it. Tokens never cross into the renderer. */
export const Account = Schema.Struct({
  /** Local id, stable for the life of the entry. */
  id: Schema.String,
  /** The instance's display name, else its host. */
  label: Schema.String,
  /** The instance base URL. */
  url: Schema.String,
  /** The signed-in user's email or display name, when the instance reported one. */
  user: Schema.optional(Schema.String),
  /** The user's organization, when the instance reported one. */
  org: Schema.optional(Schema.String),
  /**
   * `signedIn` while main holds a PAT for the instance; `needsSignIn` once the instance refused it for good, until the
   * user signs in again or out.
   */
  status: Schema.Literals(["signedIn", "signedOut", "needsSignIn"]),
  /** Why the account needs signing in again, while `status` is `needsSignIn`. */
  lapse: Schema.optional(Lapse),
  /** The instance whose content DynWork syncs. At most one account is active. */
  active: Schema.Boolean,
  /** SHA-256 fingerprint of the manifest key: the pinned one, or the one served and waiting for `trust`. */
  fingerprint: Schema.optional(Schema.String),
  /** The pinned key's fingerprint. Next to a `fingerprint` that is not `trusted`, it is the key the instance replaced. */
  pinned: Schema.optional(Schema.String),
  /** The served key is the pinned one. False until the user trusts it, and again after the instance rotates it. */
  trusted: Schema.Boolean,
  /** DynWork acting as the person in the Drive; absent while main has not looked yet. */
  person: Schema.optional(Person),
})
export type Account = typeof Account.Type

/** What the service holds of the active instance after a sync. */
export const Counts = Schema.Struct({
  skills: Schema.Number,
  agents: Schema.Number,
  mcp: Schema.Number,
  rules: Schema.Number,
  /** What the service left out, such as a plugin bundle file that does not match the manifest. */
  warnings: Schema.optional(Schema.Array(Schema.String)),
})
export type Counts = typeof Counts.Type

/**
 * Why the last sync of the active instance failed: `unreachable` (no answer or a 5xx), `rate-limited`, `refused` (the
 * instance refused the credential), `key-changed` (the instance signs with a key the user has not trusted; sync stops
 * until `trust`), `invalid` (a manifest that does not verify, decode, belong to the user or is older than the last
 * one), `insecure` (the OS secure store does not open the PAT right now) and `service` (DynWork's own service did not
 * take it).
 */
export const SyncError = Schema.Literals([
  "unreachable",
  "rate-limited",
  "refused",
  "key-changed",
  "invalid",
  "insecure",
  "service",
])
export type SyncError = typeof SyncError.Type

/** The live sync of the active instance. `at` is epoch milliseconds. */
export const SyncStatus = Schema.Union([
  Schema.Struct({ status: Schema.Literal("idle") }),
  Schema.Struct({ status: Schema.Literal("syncing"), account: Schema.String }),
  Schema.Struct({ status: Schema.Literal("synced"), account: Schema.String, at: Schema.Number, counts: Counts }),
  Schema.Struct({ status: Schema.Literal("error"), account: Schema.String, kind: SyncError, at: Schema.Number }),
])
export type SyncStatus = typeof SyncStatus.Type

/** What main pushes to every window after each change. */
export const State = Schema.Struct({
  accounts: Schema.Array(Account),
  /** The base URL of the browser sign-in in progress, if any. */
  signingIn: Schema.optional(Schema.String),
  sync: SyncStatus,
})
export type State = typeof State.Type

export const Probe = Schema.Union([
  Schema.Struct({
    reachable: Schema.Literal(true),
    /** The normalized base URL. */
    url: Schema.String,
    host: Schema.String,
    label: Schema.String,
    version: Schema.optional(Schema.String),
    /** Sign-in modes the instance offers (`pat`, `session`, ...). */
    modes: Schema.Array(Schema.String),
    /** The instance's device-link page without a redirect: it shows a one-time code to paste into `signInToken`. */
    deviceLink: Schema.String,
  }),
  Schema.Struct({
    reachable: Schema.Literal(false),
    /** The client error's tag, e.g. `Unreachable` or `Incompatible`. */
    reason: Schema.String,
  }),
])
export type Probe = typeof Probe.Type

/**
 * How a sign-in ended. The failures name what went wrong without carrying the client's error, which would reach the
 * window as plain text: `unreachable` (no answer), `refused` (token or code rejected), `rate-limited`,
 * `incompatible` (not a supported instance), `insecure` (no OS secure storage) and `failed` (anything else).
 */
export const SignIn = Schema.Literals([
  "signed-in",
  "cancelled",
  "denied",
  "expired",
  "unreachable",
  "refused",
  "rate-limited",
  "incompatible",
  "insecure",
  "failed",
])
export type SignIn = typeof SignIn.Type

export const Summary = Schema.Struct({
  skills: Schema.Number,
  agents: Schema.Number,
  servers: Schema.Number,
  /** The user's first role on the instance, when the manifest names one. */
  role: Schema.optional(Schema.String),
})
export type Summary = typeof Summary.Type

/**
 * DynWork's systemprompt accounts, held by the main process: the instances, the active one, and sign-in. PATs are
 * encrypted with the OS secure store and JWTs stay in main memory; windows only see `Account`.
 */
export const Accounts = Ipc.define({
  id: "dynwork.accounts",
  state: State,
  events: {
    /** Every change of `State.sync`, as it happens. */
    sync: SyncStatus,
  },
  methods: {
    /** Every known account, as in `state`. */
    list: { output: Schema.Array(Account) },
    /** Adds an instance without signing in, after discovery answers. Adding a known URL returns its account. */
    add: { input: Schema.String, output: Account },
    /** Runs discovery against a URL without storing anything. */
    probe: { input: Schema.String, output: Probe },
    /**
     * Signs in through the system browser: opens the instance's device-link page and waits up to 10 minutes on a
     * loopback listener for the answer. A second call cancels the first. `keep` false keeps the PAT out of the store:
     * the account stays signed in until the app quits. Without `keep`, an account signing in again keeps its PAT as it
     * did before it lapsed, any other in the store.
     */
    signInBrowser: {
      input: Schema.Struct({ url: Schema.String, keep: Schema.optional(Schema.Boolean) }),
      output: SignIn,
    },
    /**
     * Signs in with a personal access token, or with a one-time code copied from the device-link page. `keep` as in
     * `signInBrowser`.
     */
    signInToken: {
      input: Schema.Struct({ url: Schema.String, token: Schema.String, keep: Schema.optional(Schema.Boolean) }),
      output: SignIn,
    },
    /** What the signed-in account's first manifest holds. Rejects when the account has no served manifest key. */
    summary: { input: Schema.String, output: Summary },
    /** Ends the pending browser sign-in, which then resolves as `cancelled`. */
    cancel: {},
    /** Makes a signed-in account the active one. */
    activate: { input: Schema.String },
    /** Forgets the account's PAT and JWT; the entry stays, signed out. */
    signOut: { input: Schema.String },
    /** Forgets the account entirely. */
    remove: { input: Schema.String },
    /** Pins the offered manifest key, if it still has the fingerprint the user compared. */
    trust: { input: Schema.Struct({ id: Schema.String, fingerprint: Schema.String }) },
    /** Polls the active instance's manifest now. */
    syncNow: {},
    /**
     * Signs the person in through the system browser so DynWork can act as them in the account's Drive (code + PKCE on
     * a loopback listener, up to 10 minutes). A second call cancels the first; so does `personCancel`.
     */
    personSignIn: { input: Schema.String, output: PersonSignIn },
    /** Ends the person's session of the account, at the instance too. */
    personSignOut: { input: Schema.String },
    /** Ends the person's browser sign-in under way, which then resolves as `cancelled`. */
    personCancel: {},
  },
})
