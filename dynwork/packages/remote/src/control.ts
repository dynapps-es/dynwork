import { Schema } from "effect"
import { fromUtf8, utf8 } from "./bytes"
import { idLength } from "./envelope"
import { version } from "./presence"

// A relay control message that is not presence: the relay tells a desktop that something of its user changed on the
// server, so the desktop pulls that feed now instead of at its next poll (relay-protocol.md, "Control messages").
// A `0xFF` message that does not decode as presence is one (a 34-byte hint never has a valid presence event byte).
//
//   0  u8   0xFF
//   1  16   to: the desktop's peer id
//   17      body: UTF-8 JSON with a string `t`, such as {"t":"routines.changed"}

/** What a control message carries: its kind in `t`; any other keys of the JSON are kept as sent. */
export const Control = Schema.StructWithRest(Schema.Struct({ t: Schema.String }), [
  Schema.Record(Schema.String, Schema.Json),
])
export type Control = typeof Control.Type

const decodeBody = Schema.decodeUnknownOption(Schema.fromJsonString(Control))

// A control message, or undefined when the bytes are too short or their body is not JSON with a string `t`. Presence
// never decodes here: its body is a peer id and an event byte.
export function decode(bytes: Uint8Array): { to: Uint8Array; message: Control } | undefined {
  if (bytes[0] !== version || bytes.length <= 1 + idLength) return undefined
  const body = decodeBody(fromUtf8(bytes.subarray(1 + idLength)))
  if (body._tag === "None") return undefined
  return { to: bytes.slice(1, 1 + idLength), message: body.value }
}

// What the relay sends; for tests and fakes.
export function encode(to: Uint8Array, message: Control) {
  const body = utf8(JSON.stringify(message))
  const bytes = new Uint8Array(1 + idLength + body.length)
  bytes[0] = version
  bytes.set(to, 1)
  bytes.set(body, 1 + idLength)
  return bytes
}
