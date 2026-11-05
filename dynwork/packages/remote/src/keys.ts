import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js"
import { Effect, Schema } from "effect"
import { fromBase64Url, fromUtf8, toBase64Url, utf8 } from "./bytes"
import { Incompatible, Malformed, PairingRejected } from "./errors"
import { generateKeyPair, keyPairFromSecret, type KeyPair } from "./noise"

// Static keys, how people and the relay name them, and the pairing payload the desktop shows as a QR.

export type { KeyPair }

export const generate = generateKeyPair
export const fromSecretKey = keyPairFromSecret

// The version of the pairing payload and of the channel this code speaks.
export const version = 1

// What a person compares on both screens: the first 80 bits of SHA-256 of the static public key, as five groups of
// four hex digits ("3f2a 9c01 …").
export function fingerprint(publicKey: Uint8Array) {
  return (bytesToHex(sha256(publicKey).slice(0, 10)).match(/.{4}/g) ?? []).join(" ")
}

// The address the relay routes by: the first 16 bytes of SHA-256 of the static public key. The relay learns no key
// from it, and a peer that knows a key knows its address.
export function peerId(publicKey: Uint8Array) {
  return sha256(publicKey).slice(0, 16)
}

export type Pairing = {
  v: number
  // Base URL of the systemprompt instance both devices are signed in to
  instance: string
  // The desktop's static public key; the phone refuses any other during the handshake
  desktopKey: Uint8Array
  // 32 random bytes, single use. Only ever sent inside the encrypted handshake, never to the relay.
  token: Uint8Array
  // Epoch milliseconds after which the desktop refuses the token
  expires: number
  // The relay's one-time pairing token (`dwp1_…`, 5 minutes), which the phone claims its device credential with
  // (`POST /pairings/claim`). Opaque to this package; the relay never sees `token`, and the desktop never checks this.
  relay?: string
}

export const scheme = "dynwork://pair#"

const Payload = Schema.Struct({
  v: Schema.Number,
  instance: Schema.String,
  desktopKey: Schema.String,
  token: Schema.String,
  expires: Schema.Number,
  relay: Schema.optional(Schema.String),
})

// `dwp1_` and 32 random bytes in base64url, as the relay mints it.
const relayToken = /^dwp1_[A-Za-z0-9_-]{43}$/

const decodePayload = Schema.decodeUnknownOption(Schema.fromJsonString(Payload))

// A fresh pairing for the desktop to show. The token is the only secret in it.
export function createPairing(input: {
  instance: string
  desktopKey: Uint8Array
  now: number
  ttlMs: number
  relay?: string
}) {
  return {
    v: version,
    instance: input.instance,
    desktopKey: input.desktopKey,
    token: randomBytes(32),
    expires: input.now + input.ttlMs,
    ...(input.relay === undefined ? {} : { relay: input.relay }),
  } satisfies Pairing
}

// The QR text: the scheme, then the payload as base64url JSON in the fragment, so it opens the app from the camera and
// no web server ever sees it.
export function encodePairing(pairing: Pairing) {
  const json = JSON.stringify({
    v: pairing.v,
    instance: pairing.instance,
    desktopKey: toBase64Url(pairing.desktopKey),
    token: toBase64Url(pairing.token),
    expires: pairing.expires,
    ...(pairing.relay === undefined ? {} : { relay: pairing.relay }),
  })
  return scheme + toBase64Url(utf8(json))
}

// Reads a scanned QR. Refuses an unknown version, an expired payload, a key or token of the wrong size, a relay token
// that is not `dwp1_` and 43 base64url characters, and an
// instance that is not https (plain http only on loopback, as in `@dynwork/sp-client`).
export function parsePairing(text: string, now: number) {
  return Effect.gen(function* () {
    const malformed = (message: string) => new Malformed({ what: "pairing", message })
    if (!text.startsWith(scheme)) return yield* malformed("not a DynWork pairing code")
    const bytes = fromBase64Url(text.slice(scheme.length))
    if (bytes === undefined) return yield* malformed("not base64url")
    const payload = decodePayload(fromUtf8(bytes))
    if (payload._tag === "None") return yield* malformed("unexpected payload")
    if (payload.value.v !== version)
      return yield* new Incompatible({ supported: String(version), found: String(payload.value.v) })
    const desktopKey = fromBase64Url(payload.value.desktopKey)
    const token = fromBase64Url(payload.value.token)
    if (desktopKey?.length !== 32) return yield* malformed("desktop key is not 32 bytes")
    if (token?.length !== 32) return yield* malformed("token is not 32 bytes")
    const relay = payload.value.relay
    if (relay !== undefined && !relayToken.test(relay)) return yield* malformed("relay token is not a pairing token")
    if (!allowedInstance(payload.value.instance)) return yield* new PairingRejected({ reason: "instance" })
    if (!(payload.value.expires > now)) return yield* new PairingRejected({ reason: "expired" })
    return {
      v: payload.value.v,
      instance: payload.value.instance,
      desktopKey,
      token,
      expires: payload.value.expires,
      ...(relay === undefined ? {} : { relay }),
    } satisfies Pairing
  })
}

// No `URL` here: Hermes has none, and React Native's polyfill is partial.
function allowedInstance(instance: string) {
  const match = /^(https?):\/\/(\[[0-9a-fA-F:.]+\]|[^/?#:@\s[\]]+)(:\d{1,5})?(\/[^?#\s]*)?$/.exec(instance)
  if (!match) return false
  if (match[1] === "https") return true
  return ["127.0.0.1", "localhost", "[::1]"].includes((match[2] ?? "").toLowerCase())
}
