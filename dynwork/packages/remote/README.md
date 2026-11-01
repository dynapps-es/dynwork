# @dynwork/remote

The end-to-end-encrypted channel between DynWork Mobile and the DynWork desktop, through the relay. It is one
TypeScript package that runs unchanged on Bun, Electron and Hermes (React Native 0.88): Effect and Schema,
`@noble` primitives, no WebAssembly, no `node:` imports and no Bun APIs in `src`. It knows nothing of OpenCode or
systemprompt HTTP. What the relay sees is in [relay-protocol.md](./relay-protocol.md).

## Layers

| Module     | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Noise`    | The Noise framework (revision 34) for `Noise_XX_25519_ChaChaPoly_SHA256` and `Noise_IK_25519_ChaChaPoly_SHA256`: `CipherState` (nonces, rekey), the symmetric state and `HandshakeState`. Only the state machine is ours. X25519, ChaCha20-Poly1305, SHA-256 and HKDF come from `@noble/curves`, `@noble/ciphers` and `@noble/hashes`                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `Keys`     | Static key pairs, `fingerprint` (what a person compares on both screens), `peerId` (what the relay routes by), and the pairing payload `{v, instance, desktopKey, token, expires}`. `encodePairing` produces the QR text `dynwork://pair#<base64url JSON>`; `parsePairing` refuses an unknown version, an expired code, wrong key sizes and an instance that is not https (plain http only on loopback)                                                                                                                                                                                                                                                                                                                                                                      |
| `Frame`    | The versioned binary frame `{stream, kind, seq, ack, flags, payload}`. Frames are padded to five buckets (256 B to 64 KiB), which hides exact sizes but not traffic patterns (see "What the relay sees"). The decoder is strict: one frame has exactly one encoding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `Envelope` | The relay-facing `{to, from, seq, ciphertext}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `Session`  | Survives reconnects. It numbers sequenced frames, keeps the unacked ones in a bounded replay window (4096 frames or 16 MiB; writers wait when it is full) and resends what the peer reports missing. It rekeys every 10,000 messages or 10 minutes. Also the handshake drivers: `pair` (XX, phone), `reconnect` (IK, phone, optionally resuming) and `accept` (desktop), with version negotiation in the first payloads                                                                                                                                                                                                                                                                                                                                                      |
| `Mux`      | Logical streams: `fetch` (HTTP request and response; a streamed body covers fetch-SSE), `websocket` (text and binary messages up to 16 MiB), and `serve` for the side that answers. Per-stream, per-direction credit flow control (256 KiB window) for bodies and WebSocket fragments alike; empty frames cost one byte and grants past the window are refused. Cancellation is `Response.cancel` or interrupting the caller (a reset either way). A response that ends before its request body refuses the rest (`no-error` reset), so an early 413 stops the upload. Heads too large for a frame fail with `headers-too-large`                                                                                                                                             |
| `Remote`   | A `Peer` (a session plus its mux) on a relay `Link`: `pairPhone`, `reconnectPhone` (resumes a `Peer` in place, so its open streams carry on) and, for the desktop, `Desktop`. It is a long-lived registry of sessions and used pairing tokens, and its `listen(link)` answers every phone on one relay link. A new link after a relay reconnect finds the same sessions. A phone's new channel runs beside its live one until it authenticates, so a replayed first message cuts nothing off. Handshakes time out (30 s) and are capped (16 at once, 4 per phone). A detached session is closed after 10 minutes without a resume, or as soon as the phone starts a new session. `Peer.ended` reports why a connection ended; `Peer.close(reason)` ends the session for good |

Failures are tagged errors (`src/errors.ts`): `Handshake`, `Decrypt`, `KeyMismatch`, `Incompatible`,
`PairingRejected`, `Malformed`, `Replay`, `ResumeFailed`, `StreamReset` and `Closed`. None carries key material, a
token or plaintext.

A `Link` is the transport binding: `send(envelope)` and a queue of incoming envelopes that fails with `Closed` when
the socket drops. The apps give it a WebSocket to the relay (desktop in phase 09, React Native in phase 11).

## Usage

```ts
// Desktop: one registry for the app's lifetime, listening again on every relay link
const desktop = new Remote.Desktop({
  staticKey,
  pairing: () => shown,
  device: (key) => paired.has(key),
  events: { paired: (key) => save(key), connected: (peer) => peer.mux.serve(handler) },
})
const serving = desktop.listen(link)

// Phone: pair from the scanned QR, make requests, and resume the same peer after a dropped socket
const phone = Effect.gen(function* () {
  const pairing = yield* Keys.parsePairing(scanned, Date.now())
  const peer = yield* Remote.pairPhone({ link, staticKey, pairing })
  const response = yield* peer.mux.fetch({ method: "GET", path: "/api/session" })
  yield* peer.ended
  yield* Remote.reconnectPhone({ link: next, staticKey, desktopKey: pairing.desktopKey, peer })
})
```

## What the relay sees

The relay cannot read anything, but it is not blind. It sees:

- who talks to whom, by peer id;
- every envelope's time, and so how chatty a session is and when it is idle;
- each channel's `seq` counters, and so the number of frames each way;
- each frame's size bucket (5 classes), so a 64 KiB stream of data looks unlike a trickle of small requests;
- whether a channel is a pairing or a reconnect (the pattern byte), and when a phone resumes.

Padding hides exact sizes inside a bucket and nothing more. Timing and volume can hint at what a session is doing
(streaming a response, idle, a large upload).

## Requirements on the host

- `crypto.getRandomValues`. React Native needs it installed before this package loads: use
  `react-native-get-random-values` (imported first in the app's entry), which installs exactly that global.
  `expo-crypto` provides its own API and only some versions install the global.
- Metro's default `@react-native/babel-preset` transforms. Hermes gives `let` and `const` function scope unless block
  scoping is lowered, and Effect relies on per-iteration bindings. Never enable `unstable_preserveBlockScoping`.
  `test:hermes` applies the same lowering.

## Tests

- `bun test` runs everything:
  - the published Noise vectors for XX and IK from cacophony, snow and noise-c (`test/fixtures/noise-vectors.json`,
    regenerated and checked against pinned commits and SHA-256 by `bun script/vectors.ts`);
  - property tests that fuzz the frame and envelope decoders;
  - the handshake refusals;
  - session resume and rekey;
  - through an in-memory relay (`test/relay.ts`): HTTP, many concurrent streams, a WebSocket echo, SSE backpressure,
    cancellation, resume after a dropped socket, a 10 MB stream across rekeys, ciphertext-only and padded sizes on the
    relay, a hostile relay (tampering, replay, reordering, a wrong desktop), unknown devices, a QR raced by two phones,
    and revocation.
- `bun run test:hermes` runs the same test files under the Hermes engine of React Native 0.88 (macOS). npm ships no
  Hermes VM: `hermes-compiler` is only `hermesc`, which refuses to execute.
  1. `script/hermes.ts` downloads the `hermesvm` framework that RN's `hermes-engine` pod uses for that version, from
     Maven Central, and checks it against a pinned SHA-256.
  2. It builds the small JSI host in `script/hermes/host.cpp` against it.
  3. It bundles the tests with esbuild, lowers them as Metro does and compiles them with the npm `hermesc`.
  4. It runs the bytecode.

  The host provides only what an RN app has on top of the engine: timers, `console`, `queueMicrotask`,
  `performance.now` and `crypto.getRandomValues`.

  The harness is shared: `bun script/hermes.ts --package <dir>` runs another package's `test/hermes/entry.ts` with the same
  Hermes, host, hermesc and Babel transforms, and the `bun:test` shim in `test/hermes/bun-test.ts` (`.jsonl` files are
  bundled as text). `@dynwork/mobile-model` uses it.
