import { idLength } from "./envelope"

// What the relay itself writes to a desktop: one 34-byte binary message when a phone of the same user attaches or goes
// away (relay-protocol.md, "Presence"). It has the envelope's offsets and the reserved version 0xFF, which no client
// can send: the relay drops every envelope whose version is not 1.
//
//   0  u8   0xFF
//   1  16   to: the desktop's peer id
//   17 16   phone: the phone's peer id
//   33 u8   event: 1 connected, 2 disconnected

export const version = 0xff
export const length = 1 + idLength + idLength + 1

export type Event = "connected" | "disconnected"

export type Presence = { to: Uint8Array; phone: Uint8Array; event: Event }

const events: Record<number, Event> = { 1: "connected", 2: "disconnected" }

// What a relay message is, read from byte 0 before anything is decoded: an envelope, a presence message, or nothing
// this code knows (ignored).
export function kind(bytes: Uint8Array): "envelope" | "presence" | "ignored" {
  if (bytes[0] === 1) return "envelope"
  if (bytes[0] === version) return "presence"
  return "ignored"
}

// A presence message, or undefined when the bytes are not exactly one.
export function decode(bytes: Uint8Array): Presence | undefined {
  if (bytes.length !== length || bytes[0] !== version) return undefined
  const event = events[bytes[33] ?? 0]
  if (event === undefined) return undefined
  return { to: bytes.slice(1, 17), phone: bytes.slice(17, 33), event }
}

// What the relay sends; for tests and fakes.
export function encode(presence: Presence) {
  const bytes = new Uint8Array(length)
  bytes[0] = version
  bytes.set(presence.to, 1)
  bytes.set(presence.phone, 17)
  bytes[33] = presence.event === "connected" ? 1 : 2
  return bytes
}
