# Relay protocol

What the DynWork relay (the `dynwork-relay` systemprompt extension) sees and must do. The phone and the desktop each
hold one WebSocket to the relay; everything they say to each other is end-to-end encrypted with Noise
(`@dynwork/remote`), and the relay routes opaque bytes. It never holds a key that opens them.

## Envelope

Each WebSocket binary message is one envelope (`src/envelope.ts`). All integers are big-endian.

| Offset | Size | Field        | Meaning                                                                    |
| ------ | ---- | ------------ | -------------------------------------------------------------------------- |
| 0      | 1    | `version`    | `1`. The relay drops any other value                                       |
| 1      | 16   | `to`         | The recipient's peer id                                                    |
| 17     | 16   | `from`       | The sender's peer id. The relay overwrites it with the authenticated one   |
| 33     | 4    | `seq`        | The message's index on its channel, per direction. `0` opens a new channel |
| 37     | rest | `ciphertext` | A Noise message: 1 to 65535 bytes                                          |

An envelope is at most 37 + 65535 = 65572 bytes. That is the whole of what the relay learns:

- who talks to whom, when and how often;
- the `seq` counters, so the number of frames each way;
- the ciphertext sizes. Transport ciphertexts come in five sizes only (272, 1040, 4112, 16400 and 65535 bytes), because
  every frame inside is padded to a bucket. That hides exact sizes, not volume or timing;
- whether a channel is a pairing or a reconnect.

A **peer id** is the first 16 bytes of SHA-256 of the peer's static X25519 public key (`Keys.peerId`). The phone learns
the desktop's key, and so its id, from the pairing QR. The relay never sees a key, only ids.

## What the relay must do

1. **Authenticate each socket** with the instance's own credentials (the DynWork JWT of the desktop, the device
   credential of the phone; phase 05) and bind it to a peer id. A socket may only send as its own id: the relay writes
   that id into `from` on every envelope it forwards.
2. **Route by `to`.** It delivers the envelope unchanged except for `from`. Envelopes to an id with no socket are
   dropped, or held in the encrypted ring buffer (phase 05). Delivery is best effort: the ends resume over a new channel
   and resend what was lost.
3. **Keep order per `(from, to)` pair.** Envelopes from one sender to one recipient arrive in the order sent. The ends
   treat a gap or a reordering inside a channel as an attack and drop the connection (`Replay`).
4. **Never decrypt, never parse `ciphertext`, never log it.** The relay has no key. Logs carry ids, sizes and
   timestamps at most.
5. **Allow one desktop socket to carry many phones.** The desktop tells phones apart by `from`.

The relay does **not** see or check the end-to-end pairing token. That token in the QR is a secret between the two
ends: the phone proves it inside the encrypted third handshake message, and the desktop checks it. The relay
authorizes sockets with the instance's credentials, never with that token.

## Routes and pairing

The relay lives under `/api/dynwork/relay/v1` on the instance (under `/api/`, where core neither tracks a session nor
records the URI). Every credential travels in the `Authorization` header or the JSON body, never in a URL.

| Route                                  | Caller  | Credential                                                                         |
| -------------------------------------- | ------- | ---------------------------------------------------------------------------------- |
| `GET /desktop` (WebSocket)             | desktop | the account's DynWork JWT, plus `X-Dynwork-Peer: <peer id, 32 hex>`                |
| `GET /device` (WebSocket)              | phone   | its `dwr1_` device credential                                                      |
| `POST /pairings`                       | desktop | JWT; answers `{pairing_id, token, expires_at}`                                     |
| `POST /pairings/claim`                 | phone   | none: the body `{token, peer_id, name}` answers `{device_id, peer_id, credential}` |
| `GET /devices`, `DELETE /devices/{id}` | desktop | JWT; only phones are revocable (desktops: `409`)                                   |

The QR therefore carries **two** secrets (`Keys.encodePairing`, field `relay`):

- `relay`: the relay's pairing token, `dwp1_` and 32 random bytes in base64url (48 characters), single use, 5 minutes.
  The relay keeps only its SHA-256. The phone claims its device credential with it, sending its peer id, never its key.
- `token`: the end-to-end secret above, which the relay never sees.

A relay that is not honest can therefore at most refuse a pairing: claiming the relay token gives a device credential,
but without the end-to-end token no handshake completes. The desktop keeps used end-to-end tokens (as SHA-256) until
their pairing expires, so a token stays single use across restarts.

## Presence

The relay itself writes one 34-byte binary message to every live desktop of the user when a phone of that user
attaches (`1`) or goes away (`2`), on the same queue as the envelopes, so it arrives after that phone's last envelope:

| Offset | Size | Field     | Meaning                                                                                                 |
| ------ | ---- | --------- | ------------------------------------------------------------------------------------------------------- |
| 0      | 1    | `version` | `0xFF`: relay control. A client cannot send it: the relay drops every envelope whose version is not `1` |
| 1      | 16   | `to`      | the desktop's peer id                                                                                   |
| 17     | 16   | `phone`   | the phone's peer id                                                                                     |
| 33     | 1    | `event`   | `1` connected, `2` disconnected                                                                         |

A desktop reads byte 0 before decoding: `0x01` is an envelope, `0xFF` presence (`Presence.decode`), anything else is
ignored. A desktop that attaches hears one `connected` for each phone already online. A phone socket replaced by a newer
one is not reported gone.

## Limits a client respects

The relay closes a socket that sends more than 500 envelopes a second (burst 1000) or 8 MiB a second (burst 16 MiB)
with `1008`. `Socket.link` paces what it sends below that (400 a second, burst 800; 6 MiB a second, burst 12 MiB), in
order. `4000` (the 50-minute lifetime) and `1012` (shutdown) mean "dial again now"; `4003` is a revoked device.

## Channels

A channel is one Noise handshake and the transport messages after it. The initiator (always the phone) opens it with
`seq = 0`. Each direction counts its own `seq` from 0 upwards.

- **Pairing** (`Noise_XX_25519_ChaChaPoly_SHA256`). The first message carries the byte `0x01` before the Noise message.
  1. The phone sends `e` and a cleartext `{versions}`.
  2. The desktop answers with `e, ee, s, es` and an encrypted `{version, session, received}`.
  3. The phone refuses any desktop static key other than the one in the QR (`KeyMismatch`), then sends `s, se` with the
     encrypted `{token}`.
  4. The desktop checks the token (constant time, expiry, single use) and sends one transport frame: an ack to accept,
     or a close `pairing:<reason>` to refuse (`PairingRejected`).
- **Reconnect** (`Noise_IK_25519_ChaChaPoly_SHA256`). The first byte is `0x02`.
  1. The phone sends `e, es, s, ss` and an encrypted `{versions, resume: {session, received}}`.
  2. The desktop refuses a static key it never paired. Otherwise it answers `e, ee, se` with
     `{version, session, received}`.
  3. The phone's first transport frame on the new channel is an ack. An IK first message can be replayed, so only that
     frame, which needs the new keys, proves the phone is live; the desktop switches to the channel only then.
  4. When the session is the one asked for, both ends resend the frames the other has not received.

The protocol version is negotiated in those payloads. With no common major version, the responder answers
`{refused: "version", versions}` and both ends fail with `Incompatible`. The prologue is `dynwork-remote`.

A new `seq = 0` from a phone opens a channel beside its live one, which carries on until the new one authenticates
(the XX third message, or the IK confirmation). So a first message the relay replays cuts nothing off: the desktop
answers it, waits, and drops it after the handshake timeout (30 s).

Until a message authenticates on a channel, envelopes the channel cannot use are passed on rather than fatal:

- another `seq`, or a message that fails to decrypt, goes to the live channel (desktop) or is skipped (phone);
- on the phone, a later message right after a skipped one fails the channel, so tampering cannot stall it.

After that first message, a gap or a failed decryption ends the connection.

## Inside the channel

These details are invisible to the relay and listed here for completeness. Every transport message holds one frame
(`src/frame.ts`):

- a 20-byte header: version, kind, flags, stream, `seq`, `ack` and length;
- then the payload and zero padding up to the bucket.

Sequenced frames are numbered, kept until acked (the replay window) and resent after a reconnect. Within one connection,
Noise's nonces already refuse tampered, replayed and reordered messages. A sender rekeys
(`REKEY` of the Noise specification, section 11.3) after a flagged frame, every 10,000 messages or 10 minutes.
