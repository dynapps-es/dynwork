import { Effect } from "effect"
import { view, writeU32 } from "./bytes"
import { Malformed } from "./errors"
import { maxMessage, tagLength } from "./noise"

// The plaintext of one Noise transport message. Big-endian header, then the payload, then zero padding up to the next
// bucket, so the relay sees five ciphertext sizes and nothing finer:
//
//   0  u8   version (1)
//   1  u8   kind
//   2  u8   flags
//   3  u8   reserved, 0
//   4  u32  stream (0 is the session itself)
//   8  u32  seq: this frame's place in the sender's sequence, 0 for unsequenced kinds
//   12 u32  ack: the highest sequence number the sender has received in order
//   16 u32  payload length
//   20      payload, then zeros

export const version = 1
export const headerLength = 20

// The largest plaintext a Noise transport message carries.
export const maxLength = maxMessage - tagLength
export const maxPayload = maxLength - headerLength
export const buckets = [256, 1024, 4096, 16384, maxLength] as const

export const Kind = {
  // Opens a stream; payload is the JSON open request (mux)
  Open: 1,
  // The response head of a stream; payload is JSON
  Headers: 2,
  Data: 3,
  // Grants the peer more bytes on a stream; payload is a u32 increment
  Credit: 4,
  // Cancels a stream; payload is the UTF-8 reason code
  Reset: 5,
  // Carries only `ack`, unsequenced
  Ack: 6,
  Ping: 7,
  Pong: 8,
  // Closes the session; payload is the UTF-8 reason code
  Close: 9,
} as const

export type Kind = (typeof Kind)[keyof typeof Kind]

export const Flag = {
  // The sender's last frame on this stream
  Fin: 0x01,
  // A WebSocket text message
  Text: 0x02,
  // A WebSocket message continues in the next data frame
  More: 0x04,
  // The sender rekeys its sending cipher after this frame; the receiver rekeys its receiving one
  Rekey: 0x80,
} as const

const knownFlags = Flag.Fin | Flag.Text | Flag.More | Flag.Rekey
const kinds = new Set<number>(Object.values(Kind))

// Kinds outside the sequence: they are not retransmitted on resume.
export const unsequenced = new Set<number>([Kind.Ack, Kind.Ping, Kind.Pong])

export type Frame = {
  kind: Kind
  flags: number
  stream: number
  seq: number
  ack: number
  payload: Uint8Array
}

export function bucket(length: number) {
  return buckets.find((size) => size >= length) ?? maxLength
}

export function encode(frame: Frame) {
  const bytes = new Uint8Array(bucket(headerLength + frame.payload.length))
  bytes[0] = version
  bytes[1] = frame.kind
  bytes[2] = frame.flags
  writeU32(bytes, 4, frame.stream)
  writeU32(bytes, 8, frame.seq)
  writeU32(bytes, 12, frame.ack)
  writeU32(bytes, 16, frame.payload.length)
  bytes.set(frame.payload, headerLength)
  return bytes
}

// Strict: one frame has exactly one encoding, so anything else is refused rather than guessed at.
export function decode(bytes: Uint8Array) {
  return Effect.suspend(() => {
    const malformed = (message: string) => Effect.fail(new Malformed({ what: "frame", message }))
    if (!(buckets as readonly number[]).includes(bytes.length)) return malformed("size is not a padding bucket")
    const header = view(bytes)
    if (header.getUint8(0) !== version) return malformed(`unknown frame version ${header.getUint8(0)}`)
    if (!kinds.has(header.getUint8(1))) return malformed(`unknown kind ${header.getUint8(1)}`)
    if ((header.getUint8(2) & ~knownFlags) !== 0) return malformed("unknown flags")
    if (header.getUint8(3) !== 0) return malformed("reserved byte is set")
    const length = header.getUint32(16)
    if (length > bytes.length - headerLength) return malformed("payload longer than the frame")
    if (bucket(headerLength + length) !== bytes.length) return malformed("padded past its bucket")
    if (bytes.subarray(headerLength + length).some((byte) => byte !== 0)) return malformed("padding is not zero")
    const frame: Frame = {
      kind: header.getUint8(1) as Kind,
      flags: header.getUint8(2),
      stream: header.getUint32(4),
      seq: header.getUint32(8),
      ack: header.getUint32(12),
      payload: bytes.slice(headerLength, headerLength + length),
    }
    if (unsequenced.has(frame.kind) !== (frame.seq === 0)) return malformed("sequence number does not fit the kind")
    return Effect.succeed(frame)
  })
}
