import { Schema } from "effect"
import { Ipc } from "@opencode/plugin/gui"

/** A phone paired with this desktop on the active instance, as windows see it. Keys and credentials stay in main. */
export const Phone = Schema.Struct({
  /** The phone's peer id (32 hex digits), which the relay routes by. */
  id: Schema.String,
  /** The name the phone claimed with, else its fingerprint. */
  name: Schema.String,
  /** What a person compares: the fingerprint of the phone's key. */
  fingerprint: Schema.String,
  /** Epoch milliseconds. */
  pairedAt: Schema.Number,
  /** The relay reports the phone attached right now. */
  online: Schema.Boolean,
})
export type Phone = typeof Phone.Type

/** One entry of the connection log, newest first, 50 at most. */
export const Audit = Schema.Struct({
  at: Schema.Number,
  /** The phone's name, else its fingerprint. */
  phone: Schema.String,
  event: Schema.Literals(["paired", "connected", "disconnected", "revoked", "refused"]),
})
export type Audit = typeof Audit.Type

/**
 * The tunnel: `off` (the toggle is off), `idle` (on, but no signed-in active instance), `connecting`, `connected` (the
 * relay socket is open) and `error` (`insecure`: the OS secure store cannot hold the desktop's key; `offline`: the
 * relay does not answer, retrying; `refused`: the instance refused the account or has no relay).
 */
export const Status = Schema.Literals(["off", "idle", "connecting", "connected", "error"])
export type Status = typeof Status.Type

export const Failure = Schema.Literals(["insecure", "offline", "refused"])
export type Failure = typeof Failure.Type

/** The QR a window shows: the pairing text (it holds the one-time secrets) and when it stops working. */
export const Pairing = Schema.Struct({ qr: Schema.String, expires: Schema.Number })
export type Pairing = typeof Pairing.Type

export const State = Schema.Struct({
  enabled: Schema.Boolean,
  /** The user has read and accepted what a phone can do. Asked once, before the first enable. */
  confirmed: Schema.Boolean,
  status: Status,
  failure: Schema.optional(Failure),
  /** The instance the tunnel serves: the active account's label. */
  instance: Schema.optional(Schema.String),
  /** The fingerprint of this desktop's key, once it has one. */
  fingerprint: Schema.optional(Schema.String),
  pairing: Schema.optional(Pairing),
  phones: Schema.Array(Phone),
  audit: Schema.Array(Audit),
})
export type State = typeof State.Type

/**
 * Remote control: an outbound, end-to-end encrypted tunnel from this desktop to the active instance's relay, so paired
 * phones reach DynWork's OpenCode service through an allowlist. Held by the main process.
 */
export const Remote = Ipc.define({
  id: "dynwork.remote",
  state: State,
  methods: {
    /** Turns the tunnel on or off and remembers it. Turning it on records the user's confirmation. */
    setEnabled: { input: Schema.Boolean },
    /** Mints a pairing on the relay and shows its QR; one at a time, replaced by a new call. */
    pair: { output: Pairing },
    /** Hides the QR; its secrets stop working. */
    cancelPairing: {},
    /** Revokes a phone: on the relay, and its sessions here end at once. */
    revoke: { input: Schema.String },
  },
})
