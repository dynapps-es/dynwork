export * as RemoteStore from "./store"

import { createHash } from "node:crypto"
import { Schema } from "effect"
import type { Remote } from "@dynwork/remote"
import { Audit } from "./contract"

/** A phone paired on one account (instance). Only its public key is kept; it proves itself in every handshake. */
export const StoredPhone = Schema.Struct({
  account: Schema.String,
  /** The phone's static public key, base64url. */
  key: Schema.String,
  name: Schema.optional(Schema.String),
  pairedAt: Schema.Number,
})
export type StoredPhone = typeof StoredPhone.Type

/** A used pairing token: its SHA-256 only, kept until its pairing expires. */
export const UsedToken = Schema.Struct({ hash: Schema.String, expires: Schema.Number })

export const Store = Schema.Struct({
  enabled: Schema.Boolean,
  confirmed: Schema.Boolean,
  /** The desktop's static secret key, sealed by the OS secure store, base64. */
  keyCipher: Schema.optional(Schema.String),
  phones: Schema.Array(StoredPhone),
  tokens: Schema.Array(UsedToken),
  audit: Schema.Array(Audit),
})
export type Store = typeof Store.Type

export const initial: Store = { enabled: false, confirmed: false, phones: [], tokens: [], audit: [] }

/** Entries the connection log keeps. */
export const auditLength = 50

/** What main's `ctx.storage.store` returns. */
export type Persisted = { readonly value: Store; set(value: Store): void }

/**
 * The desktop's used pairing tokens over the store: persisted, so a token stays single use across restarts, and pruned
 * once its pairing has expired, when the desktop refuses it anyway.
 */
export function tokens(store: Persisted, now: () => number): Remote.Tokens {
  const hash = (token: Uint8Array) => createHash("sha256").update(token).digest("hex")
  const live = () => store.value.tokens.filter((entry) => entry.expires > now())
  return {
    used: (token) => live().some((entry) => entry.hash === hash(token)),
    claim: (token, expires) => {
      const kept = live()
      if (kept.some((entry) => entry.hash === hash(token))) return false
      store.set({ ...store.value, tokens: [...kept, { hash: hash(token), expires }] })
      return true
    },
  }
}

/** Adds an entry to the connection log, newest first. */
export function audit(store: Persisted, entry: Audit) {
  store.set({ ...store.value, audit: [entry, ...store.value.audit].slice(0, auditLength) })
}
