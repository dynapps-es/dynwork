import path from "node:path"
import { Schema } from "effect"
import { DynWorkSync } from "../src/contract"

// The alpha instance's manifest as the sp-local harness captured it (phase 07's fixture), decoded like the RPC does.
const captured: { manifest: { payload: unknown } } = await Bun.file(
  path.join(import.meta.dir, "../../sp-client/test/fixtures/alpha.json"),
).json()

export const alpha = Schema.decodeUnknownSync(DynWorkSync.Manifest)(captured.manifest.payload)

export const jwt = "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJkZXYifQ.c2lnbmF0dXJl"

export const instance = { key: "alpha", url: "http://127.0.0.1:18101" }

export function apply(manifest: DynWorkSync.Manifest = alpha, overrides: Partial<DynWorkSync.Apply> = {}) {
  return { instance, manifest, jwt, expiresAt: 1_900_000_000_000, ...overrides } satisfies DynWorkSync.Apply
}
