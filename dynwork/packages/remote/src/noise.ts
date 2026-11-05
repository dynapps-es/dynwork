import { chacha20poly1305 } from "@noble/ciphers/chacha.js"
import { x25519 } from "@noble/curves/ed25519.js"
import { hkdf } from "@noble/hashes/hkdf.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { concatBytes } from "@noble/hashes/utils.js"
import { Effect } from "effect"
import { empty, utf8 } from "./bytes"
import { Decrypt, Handshake } from "./errors"

// The Noise Protocol Framework, revision 34 (https://noiseprotocol.org/noise.html), for exactly two protocols:
// `Noise_XX_25519_ChaChaPoly_SHA256` (first pairing) and `Noise_IK_25519_ChaChaPoly_SHA256` (reconnects). Only the
// state machine is written here; X25519, ChaCha20-Poly1305, SHA-256, HMAC and HKDF are the audited `@noble`
// implementations. The published test vectors (test/noise.test.ts) gate this file.

export type KeyPair = { publicKey: Uint8Array; secretKey: Uint8Array }

export type Pattern = "XX" | "IK"

export const maxMessage = 65535
export const tagLength = 16
const keyLength = 32

type Token = "e" | "s" | "ee" | "es" | "se" | "ss"

// Message patterns from section 7.5; IK's `<- s` pre-message means the initiator knows the responder's static key.
const patterns: Record<Pattern, { preResponder: boolean; messages: Token[][] }> = {
  XX: { preResponder: false, messages: [["e"], ["e", "ee", "s", "es"], ["s", "se"]] },
  IK: {
    preResponder: true,
    messages: [
      ["e", "es", "s", "ss"],
      ["e", "ee", "se"],
    ],
  },
}

export function protocolName(pattern: Pattern) {
  return `Noise_${pattern}_25519_ChaChaPoly_SHA256`
}

export function generateKeyPair(): KeyPair {
  const secretKey = x25519.utils.randomSecretKey()
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) }
}

export function keyPairFromSecret(secretKey: Uint8Array): KeyPair {
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) }
}

// Section 5.1. The nonce is 32 zero bits then the 64-bit little-endian counter. The counter stays below 2^53, far
// past any channel's life (rekeying does not reset it).
export class CipherState {
  #key: Uint8Array | undefined
  #nonce = 0

  constructor(key?: Uint8Array) {
    this.#key = key
  }

  get hasKey() {
    return this.#key !== undefined
  }

  get nonce() {
    return this.#nonce
  }

  encrypt(ad: Uint8Array, plaintext: Uint8Array) {
    return Effect.suspend(() => {
      const key = this.#key
      if (key === undefined) return Effect.succeed(plaintext)
      if (this.#nonce >= Number.MAX_SAFE_INTEGER) return Effect.fail(new Handshake({ message: "nonce exhausted" }))
      const sealed = chacha20poly1305(key, nonce(this.#nonce), ad).encrypt(plaintext)
      this.#nonce++
      return Effect.succeed(sealed)
    })
  }

  // The nonce advances only on success, so a forged message does not desynchronise the channel.
  decrypt(ad: Uint8Array, ciphertext: Uint8Array, stage: "handshake" | "transport") {
    return Effect.suspend(() => {
      const key = this.#key
      if (key === undefined) return Effect.succeed(ciphertext)
      if (ciphertext.length < tagLength) return Effect.fail(new Decrypt({ stage }))
      return Effect.try({
        try: () => chacha20poly1305(key, nonce(this.#nonce), ad).decrypt(ciphertext),
        catch: () => new Decrypt({ stage }),
      }).pipe(
        Effect.map((plaintext) => {
          this.#nonce++
          return plaintext
        }),
      )
    })
  }

  copy() {
    const copy = new CipherState(this.#key)
    copy.#nonce = this.#nonce
    return copy
  }

  // Section 11.3: REKEY(k) = ENCRYPT(k, 2^64 - 1, zerolen, zeros)[0:32]. Both ends call it at the same message.
  rekey() {
    const key = this.#key
    if (key === undefined) return
    this.#key = chacha20poly1305(key, maxNonce, empty).encrypt(new Uint8Array(keyLength)).slice(0, keyLength)
  }
}

const maxNonce = new Uint8Array([0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])

function nonce(counter: number) {
  const bytes = new Uint8Array(12)
  const low = counter % 0x100000000
  const high = Math.floor(counter / 0x100000000)
  ;[low, high].forEach((word, half) =>
    [0, 1, 2, 3].forEach((index) => (bytes[4 + half * 4 + index] = (word >>> (index * 8)) & 0xff)),
  )
  return bytes
}

// Section 5.2.
class SymmetricState {
  chainingKey: Uint8Array
  hash: Uint8Array
  cipher = new CipherState()

  constructor(name: string) {
    const bytes = utf8(name)
    this.hash = bytes.length <= 32 ? concatBytes(bytes, new Uint8Array(32 - bytes.length)) : sha256(bytes)
    this.chainingKey = this.hash
  }

  mixHash(data: Uint8Array) {
    this.hash = sha256(concatBytes(this.hash, data))
  }

  // HKDF(ck, ikm) of section 4.3 is RFC 5869 with salt = ck and empty info.
  mixKey(material: Uint8Array) {
    const output = hkdf(sha256, material, this.chainingKey, empty, 64)
    this.chainingKey = output.slice(0, 32)
    this.cipher = new CipherState(output.slice(32, 64))
  }

  encryptAndHash(plaintext: Uint8Array) {
    return this.cipher.encrypt(this.hash, plaintext).pipe(
      Effect.map((ciphertext) => {
        this.mixHash(ciphertext)
        return ciphertext
      }),
    )
  }

  decryptAndHash(ciphertext: Uint8Array) {
    return this.cipher.decrypt(this.hash, ciphertext, "handshake").pipe(
      Effect.map((plaintext) => {
        this.mixHash(ciphertext)
        return plaintext
      }),
    )
  }

  split() {
    const output = hkdf(sha256, empty, this.chainingKey, empty, 64)
    return [new CipherState(output.slice(0, 32)), new CipherState(output.slice(32, 64))] as const
  }
}

export type HandshakeOptions = {
  pattern: Pattern
  initiator: boolean
  prologue: Uint8Array
  // This side's static key pair
  staticKey: KeyPair
  // The responder's static public key, which an IK initiator must know beforehand
  remoteStatic?: Uint8Array
  // A fixed ephemeral key pair, for the published test vectors only; a fresh one is generated otherwise
  ephemeral?: KeyPair
}

// The channel after the handshake: one cipher per direction, the handshake hash (a channel binding) and the peer's
// authenticated static key.
export type Transport = {
  send: CipherState
  receive: CipherState
  hash: Uint8Array
  remoteStatic: Uint8Array
}

// Section 5.3, for the two patterns above.
export class HandshakeState {
  readonly #options: HandshakeOptions
  readonly #symmetric: SymmetricState
  #ephemeral: KeyPair | undefined
  #remoteEphemeral: Uint8Array | undefined
  #remoteStatic: Uint8Array | undefined
  #index = 0

  private constructor(options: HandshakeOptions) {
    this.#options = options
    this.#symmetric = new SymmetricState(protocolName(options.pattern))
    this.#remoteStatic = options.remoteStatic
    this.#symmetric.mixHash(options.prologue)
    if (patterns[options.pattern].preResponder)
      this.#symmetric.mixHash(options.initiator ? (options.remoteStatic as Uint8Array) : options.staticKey.publicKey)
  }

  static make(options: HandshakeOptions) {
    if (options.pattern === "IK" && options.initiator && options.remoteStatic?.length !== 32)
      return Effect.fail(new Handshake({ message: "IK needs the responder's static key" }))
    return Effect.succeed(new HandshakeState(options))
  }

  get finished() {
    return this.#index >= patterns[this.#options.pattern].messages.length
  }

  // True when the next message is this side's to write.
  get writing() {
    return !this.finished && this.#index % 2 === (this.#options.initiator ? 0 : 1)
  }

  get remoteStatic() {
    return this.#remoteStatic
  }

  get hash() {
    return this.#symmetric.hash
  }

  write(payload: Uint8Array) {
    const self = this
    return Effect.gen(function* () {
      if (!self.writing) return yield* new Handshake({ message: "not this side's turn to write" })
      const parts: Uint8Array[] = []
      for (const token of self.#tokens()) {
        if (token === "e") {
          const ephemeral = self.#options.ephemeral ?? generateKeyPair()
          self.#ephemeral = ephemeral
          parts.push(ephemeral.publicKey)
          self.#symmetric.mixHash(ephemeral.publicKey)
          continue
        }
        if (token === "s") {
          parts.push(yield* self.#symmetric.encryptAndHash(self.#options.staticKey.publicKey))
          continue
        }
        yield* self.#mix(token)
      }
      parts.push(yield* self.#symmetric.encryptAndHash(payload))
      const message = concatBytes(...parts)
      if (message.length > maxMessage) return yield* new Handshake({ message: "message too long" })
      self.#index++
      return message
    })
  }

  // A message that fails leaves the state as it was, so the next message can still be read (the desktop tries the
  // envelopes of its live channel against a new handshake before handing them back).
  read(message: Uint8Array) {
    return Effect.suspend(() => this.#read(message))
  }

  #read(message: Uint8Array) {
    const self = this
    const saved = {
      chainingKey: self.#symmetric.chainingKey,
      hash: self.#symmetric.hash,
      cipher: self.#symmetric.cipher.copy(),
      remoteEphemeral: self.#remoteEphemeral,
      remoteStatic: self.#remoteStatic,
    }
    const restore = Effect.sync(() => {
      self.#symmetric.chainingKey = saved.chainingKey
      self.#symmetric.hash = saved.hash
      self.#symmetric.cipher = saved.cipher
      self.#remoteEphemeral = saved.remoteEphemeral
      self.#remoteStatic = saved.remoteStatic
    })
    return Effect.gen(function* () {
      if (self.finished || self.writing) return yield* new Handshake({ message: "not this side's turn to read" })
      if (message.length > maxMessage) return yield* new Handshake({ message: "message too long" })
      let rest = message
      for (const token of self.#tokens()) {
        if (token === "e") {
          if (rest.length < 32) return yield* new Handshake({ message: "message too short" })
          self.#remoteEphemeral = rest.slice(0, 32)
          self.#symmetric.mixHash(self.#remoteEphemeral)
          rest = rest.subarray(32)
          continue
        }
        if (token === "s") {
          const length = self.#symmetric.cipher.hasKey ? 32 + tagLength : 32
          if (rest.length < length) return yield* new Handshake({ message: "message too short" })
          self.#remoteStatic = yield* self.#symmetric.decryptAndHash(rest.slice(0, length))
          rest = rest.subarray(length)
          continue
        }
        yield* self.#mix(token)
      }
      const payload = yield* self.#symmetric.decryptAndHash(rest)
      self.#index++
      return payload
    }).pipe(Effect.tapError(() => restore))
  }

  // The initiator sends with the first key of Split(), the responder with the second.
  split() {
    if (!this.finished || this.#remoteStatic === undefined)
      return Effect.fail(new Handshake({ message: "handshake not finished" }))
    const [first, second] = this.#symmetric.split()
    const initiator = this.#options.initiator
    return Effect.succeed<Transport>({
      send: initiator ? first : second,
      receive: initiator ? second : first,
      hash: this.#symmetric.hash,
      remoteStatic: this.#remoteStatic,
    })
  }

  #tokens() {
    return patterns[this.#options.pattern].messages[this.#index] ?? []
  }

  // `es` is DH(e, rs) on the initiator and DH(s, re) on the responder; `se` the other way round.
  #mix(token: "ee" | "es" | "se" | "ss") {
    const initiator = this.#options.initiator
    const local = token[initiator ? 0 : 1] === "e" ? this.#ephemeral : this.#options.staticKey
    const remote = token[initiator ? 1 : 0] === "e" ? this.#remoteEphemeral : this.#remoteStatic
    if (local === undefined || remote === undefined)
      return Effect.fail(new Handshake({ message: `missing key for ${token}` }))
    // noble rejects the low-order points (section 12.1 allows aborting on them)
    return Effect.try({
      try: () => x25519.getSharedSecret(local.secretKey, remote),
      catch: () => new Handshake({ message: "invalid public key" }),
    }).pipe(Effect.map((shared) => this.#symmetric.mixKey(shared)))
  }
}
