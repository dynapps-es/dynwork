import { Effect } from "effect"
import { readU32, writeU32 } from "./bytes"
import { Malformed } from "./errors"
import { maxMessage } from "./noise"

// What the relay sees: one WebSocket binary message per envelope (relay-protocol.md).
//
//   0  u8   version (1)
//   1  16   to: the recipient's peer id
//   17 16   from: the sender's peer id (the relay overwrites it with the authenticated sender)
//   33 u32  seq: this message's index on its channel; 0 starts a new channel (a first handshake message)
//   37      ciphertext: a Noise handshake or transport message

export const version = 1
export const headerLength = 37
export const idLength = 16
export const maxLength = headerLength + maxMessage

export type Envelope = {
  to: Uint8Array
  from: Uint8Array
  seq: number
  ciphertext: Uint8Array
}

export function encode(envelope: Envelope) {
  const bytes = new Uint8Array(headerLength + envelope.ciphertext.length)
  bytes[0] = version
  bytes.set(envelope.to, 1)
  bytes.set(envelope.from, 17)
  writeU32(bytes, 33, envelope.seq)
  bytes.set(envelope.ciphertext, headerLength)
  return bytes
}

export function decode(bytes: Uint8Array) {
  return Effect.suspend(() => {
    const malformed = (message: string) => Effect.fail(new Malformed({ what: "envelope", message }))
    if (bytes.length < headerLength + 1) return malformed("too short")
    if (bytes.length > maxLength) return malformed("too long")
    if (bytes[0] !== version) return malformed(`unknown envelope version ${bytes[0]}`)
    return Effect.succeed<Envelope>({
      to: bytes.slice(1, 17),
      from: bytes.slice(17, 33),
      seq: readU32(bytes, 33),
      ciphertext: bytes.slice(headerLength),
    })
  })
}
