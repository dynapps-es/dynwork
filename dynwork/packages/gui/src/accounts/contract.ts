import { Schema } from "effect"
import { Ipc } from "@opencode/plugin/gui"

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
  /** `signedIn` while main holds a PAT for the instance. */
  status: Schema.Literals(["signedIn", "signedOut"]),
  /** The instance whose content DynWork syncs. At most one account is active. */
  active: Schema.Boolean,
  /** SHA-256 fingerprint of the manifest key: the pinned one, or the one served and waiting for `trust`. */
  fingerprint: Schema.optional(Schema.String),
  /** The served key is the pinned one. False until the user trusts it, and again after the instance rotates it. */
  trusted: Schema.Boolean,
})
export type Account = typeof Account.Type

/** What main pushes to every window after each change. */
export const State = Schema.Struct({
  accounts: Schema.Array(Account),
  /** The base URL of the browser sign-in in progress, if any. */
  signingIn: Schema.optional(Schema.String),
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
  methods: {
    /** Every known account, as in `state`. */
    list: { output: Schema.Array(Account) },
    /** Adds an instance without signing in, after discovery answers. Adding a known URL returns its account. */
    add: { input: Schema.String, output: Account },
    /** Runs discovery against a URL without storing anything. */
    probe: { input: Schema.String, output: Probe },
    /**
     * Signs in through the system browser: opens the instance's device-link page and waits up to 10 minutes on a
     * loopback listener for the answer. A second call cancels the first. `keep` false (default true) keeps the PAT
     * out of the store: the account stays signed in until the app quits.
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
  },
})
