import { Schema } from "effect"

// Every failure the channel reports. None carries key material, a pairing token or plaintext: keys are named by
// fingerprint and messages are described, never quoted.

// A handshake message that is out of turn, too short, too long or carries an invalid public key.
export class Handshake extends Schema.TaggedError<Handshake>("Remote.Handshake")("Handshake", {
  message: Schema.String,
}) {}

// Authenticated decryption failed: the ciphertext was tampered with, replayed, reordered or sealed with another key.
export class Decrypt extends Schema.TaggedError<Decrypt>("Remote.Decrypt")("Decrypt", {
  stage: Schema.Literals(["handshake", "transport"]),
}) {}

// The peer proved a static key other than the expected one: a desktop key that is not the one in the QR, or a phone
// the desktop never paired.
export class KeyMismatch extends Schema.TaggedError<KeyMismatch>("Remote.KeyMismatch")("KeyMismatch", {
  expected: Schema.optional(Schema.String),
  found: Schema.String,
}) {}

// The peer speaks no protocol version this side does. Closes the channel.
export class Incompatible extends Schema.TaggedError<Incompatible>("Remote.Incompatible")("Incompatible", {
  supported: Schema.String,
  found: Schema.String,
}) {}

// A pairing the desktop refuses, or a QR the phone refuses before dialing.
export class PairingRejected extends Schema.TaggedError<PairingRejected>("Remote.PairingRejected")("PairingRejected", {
  reason: Schema.Literals(["expired", "token", "instance", "used", "cancelled"]),
}) {}

// Bytes that do not decode: a frame, an envelope, a handshake payload or a QR. `what` names the structure.
export class Malformed extends Schema.TaggedError<Malformed>("Remote.Malformed")("Malformed", {
  what: Schema.String,
  message: Schema.String,
}) {}

// A sequenced frame arrived out of order after decryption: a gap the session cannot fill.
export class Replay extends Schema.TaggedError<Replay>("Remote.Replay")("Replay", {
  expected: Schema.Number,
  found: Schema.Number,
}) {}

// The peer resumed from a point this side no longer holds: the replay window moved past it, or the session is
// unknown. The streams of the old session are lost.
export class ResumeFailed extends Schema.TaggedError<ResumeFailed>("Remote.ResumeFailed")("ResumeFailed", {
  message: Schema.String,
}) {}

// The peer reset a stream, or sent more than its credit allowed on it.
export class StreamReset extends Schema.TaggedError<StreamReset>("Remote.StreamReset")("StreamReset", {
  stream: Schema.Number,
  code: Schema.String,
}) {}

// The channel is closed. `reason` is the peer's close code or the local cause.
export class Closed extends Schema.TaggedError<Closed>("Remote.Closed")("Closed", {
  reason: Schema.String,
}) {}

export type RemoteError =
  | Handshake
  | Decrypt
  | KeyMismatch
  | Incompatible
  | PairingRejected
  | Malformed
  | Replay
  | ResumeFailed
  | StreamReset
  | Closed
