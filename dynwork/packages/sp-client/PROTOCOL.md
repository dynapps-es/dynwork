# systemprompt sign-in: the contract DynWork relies on

How a systemprompt 0.76 instance signs a desktop client in through the browser device link, and how the one-time code
becomes a durable credential. Written from observation only (HTTP traffic and rendered pages of
`ghcr.io/systempromptio/systemprompt-dynapps:0.76.0` on the local harness), never from server or bridge code.

The evidence is `dynwork/test/sp-local/fixtures/device-link.json` (redacted: names, statuses and page text, never a
code, PAT or JWT). `bun dynwork/script/sp-local.ts capture` observes the instance again, rewrites the fixture and says
which entries changed, so a new server version can be checked against this page.

## 1. Where the device-link page is

| Step         | Request                                         | Answer                                                                                                                                                             |
| ------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Discovery    | `GET /.well-known/systemprompt-bridge`, no auth | `200` JSON with `contract` (`"1"`), `device_link_path` (`/bridge-auth/device-link` here), `identity_path`, `branding.display_name`, `enabled_hosts`                |
| No discovery |                                                 | Instances older than 0.76 answer `404`. Fall back to `/bridge-auth/device-link` (the Dynapps brand); the core default `/bridge/device-link` is `404` on this image |

Both paths are relative to the instance base URL. A path that would leave that origin is refused by the client.

## 2. Opening the page

The client opens the system browser on

```
<base><device_link_path>?redirect=<loopback URL>
```

`redirect` is the only query parameter the page reads. The rules it applies, observed on the page (`GET`) and on the
approval (`POST`), which reject the same set:

| `redirect`                                                                                                           | Result                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `http://127.0.0.1:<port>/<any path>`, with or without a path or its own query                                        | accepted                                                                                                      |
| `http://localhost:<port>/...`                                                                                        | accepted                                                                                                      |
| any port from 0 to 65535 (`:0` and `:1` included)                                                                    | accepted; 65536 is `400`                                                                                      |
| no port (`http://127.0.0.1/cb`)                                                                                      | `400`                                                                                                         |
| `https://` loopback, `http://[::1]:<port>`, `127.0.0.2`, `127.0.0.1.<other domain>`, any other host, a custom scheme | `400`, page "Invalid redirect": "Only http://127.0.0.1:PORT or http://localhost:PORT redirects are accepted." |
| missing                                                                                                              | the page switches to the paste flow (section 5)                                                               |

A browser without a session on the instance gets `307` to `/admin/login?redirect=<path and query of the page>`, signs
in with the instance's own IdP (Microsoft Entra on the Dynapps brand) and lands back on the page. The client never sees
the IdP.

## 3. The consent page

`200` HTML, title "Authorise a device". It shows the signed-in account, the helper (`127.0.0.1:<port>`, taken from
`redirect`), how long the code will live (600 seconds) and says that approving issues a personal access token that
stays valid until revoked. Two forms, each with a single hidden `redirect` field:

| Button | Form                                                                   | Answer                                                              |
| ------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Allow  | `POST <device_link_path>/approve`, `application/x-www-form-urlencoded` | `303` to `redirect` with `code=<code>` appended to its query        |
| Deny   | `POST <device_link_path>/deny`                                         | `303` to `redirect` with `error=denied` appended; nothing is issued |

A `POST` without a form body answers `415`; one without a session `307` to the login.

## 4. Coming back to the client

The browser follows the `303` with a plain `GET` to the loopback URL:

- query: `code` on Allow, `error=denied` on Deny, after whatever query the client put in `redirect`;
- the code is 64 lowercase hex characters, lives 600 seconds and works once;
- the request carries no credential; its `Referer` is the instance origin only.

**There is no `state` parameter.** A `state` next to `redirect` on the page URL, or as a field of the approval, is
dropped. A query inside `redirect` is kept verbatim. So the client binds the round trip itself: it puts its own random
`state` in the redirect URL (`http://127.0.0.1:<port>/cb?state=<random>`) and only accepts a callback that carries it
back unchanged.

## 5. Without a loopback: paste the code

Opened with no `redirect`, the page says a command-line helper on another machine is asking to sign in. Allow then
renders "Your device code" in the browser: the code (once as a `dynapps-bridge login --code <code> --gateway <url>`
command, once alone under "Just the code") and its remaining lifetime. The user copies it into the client. The code is
the same kind as the one of section 4 and is exchanged the same way. The `--gateway` URL the page prints is the
instance's internal address (`http://localhost:8080` locally), so the client keeps the base URL it already has.

An operator can also mint a code for a user with the instance CLI: `admin bridge issue-code --user-id <id or email>`
(same format, same lifetime, no TTL option).

## 6. Exchanging the code

| Request                                     | Body                                | Answer                                                                                                                |
| ------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/auth/bridge/session-pat`, no auth | JSON `code`, optional `device_name` | `200` JSON `pat`: a durable `sp-live-` personal access token. `device_name` becomes its name in the user's token list |
| same, code empty                            |                                     | `400` `bad_request` "missing exchange code"                                                                           |
| same, code unknown, expired or already used |                                     | `401` `unauthorized` "exchange code invalid, expired, or already consumed"                                            |
| `POST /v1/auth/bridge/session`, no auth     | JSON `code`                         | `200` with the same body as `/pat` below: a JWT and no durable credential                                             |

A code works once across both routes: the second exchange answers `401`.

Errors use the common envelope: `code`, `message`, `timestamp`.

## 7. From the PAT to a session

| Request                                                            | Answer                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/auth/bridge/pat`, `Authorization: Bearer <PAT>`, no body | `200` JSON `token` (RS256 JWT), `ttl` (3600 s), `headers` (identity headers the client may replay: `x-client-id` is `sp_bridge`, plus `x-user-id`, `x-session-id`, `x-trace-id`, `x-policy-version`, `x-call-source`) and `device_token` (a second JWT) |
| same, PAT revoked                                                  | `401` `unauthorized` "Invalid PAT"                                                                                                                                                                                                                      |

There is no refresh token: the client calls `/pat` again before `ttl` runs out.

## 8. What DynWork does with it

- Listen on `127.0.0.1` on a random port (bind the address, not `localhost`, which may resolve to `::1`; `[::1]` is
  refused as a redirect anyway).
- Open `<base><device_link_path>?redirect=http://127.0.0.1:<port>/cb?state=<random>` (the redirect URL-encoded).
- Accept one `GET /cb` whose `state` matches. `code` goes straight to `/v1/auth/bridge/session-pat` with a
  `device_name` that names this machine; `error=denied` ends the sign-in as declined. Anything else is ignored. Give up
  after 600 seconds.
- Keep the PAT in the OS secure store, mint JWTs from it with `/v1/auth/bridge/pat`, and treat `401` there as signed
  out.
- Offer "paste the code" as the fallback: same exchange, with the code typed in.
- Never log or persist a code, PAT or JWT.

## 9. After sign-in: what `@dynwork/sp-client` reads

Observed on both local instances; the redacted bodies are in `test/fixtures/alpha.json`. Every request carries
`x-systemprompt-client: opencode` (the declared client kind; the instance accepts only its closed list) and no
attestation header. Authenticated routes take the JWT from section 7 as `Authorization: Bearer`; a PAT is refused there
with `401` `invalid_credential`.

| Request                                                       | Auth        | Answer                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/auth/bridge/capabilities`                            | none        | `200` `modes`: `pat`, `session`, `oauth-client`                                                                                                                                                                                                                                                       |
| `GET /api/v1/health`                                          | none        | `200` `status`, `version` (`"0.76.0"`)                                                                                                                                                                                                                                                                |
| `GET /v1/bridge/pubkey`                                       | none        | `200` `pubkey`: base64 of the 32 raw bytes of an ed25519 key. Each instance has its own                                                                                                                                                                                                               |
| `GET /v1/bridge/manifest`                                     | JWT         | `200` `payload` (a JSON string) and `signature` (base64, 64 bytes), with `ETag` (a quoted 64-hex digest) and `Cache-Control: private, no-cache`. `If-None-Match` with that tag, strong or `W/` weak, answers `304` with no body. `Cache-Control: no-cache` on the request asks for a fresh resolution |
| `GET /v1/bridge/profile`                                      | JWT         | `200` `models` (ids admitted for the user), `default_model`, `providers` (name, display name, configured, models), `model_limits` (per model `context_window`, `max_output_tokens`), `auth_scheme` (`bearer`), `organization_uuid` (null), `inference_gateway_base_url`                               |
| `GET /v1/models`                                              | none needed | `200` `data`: the instance-wide catalog (`id`, `display_name`, `max_input_tokens`, `max_tokens`), Anthropic shape; `?format=openai` gives the OpenAI list                                                                                                                                             |
| `GET /v1/bridge/whoami`                                       | JWT         | `200` `user_id`, `email`, `display_name`, `roles`                                                                                                                                                                                                                                                     |
| `GET /api/public/bridge/whoami` (discovery's `identity_path`) |             | `401` with a bridge JWT; not used                                                                                                                                                                                                                                                                     |

`inference_gateway_base_url` is the instance's internal address (`http://localhost:8080/v1` locally), like the
`--gateway` of section 5, so the client keeps using its own base URL plus `/v1`.

### The manifest

The signature is ed25519 over the exact UTF-8 bytes of `payload`; the client verifies it before parsing anything.
`payload` is RFC 8785 (JCS) canonical JSON: re-canonicalizing the parsed value gives the same string on both instances
(a live test checks it). The fields DynWork reads: `min_schema_version` (1), `user_id`, `user`, `rules[]` (id, name,
`instructions`, sha256, plugins), `skills[]` (id, name, description, inline `instructions`, sha256, plugins),
`agents[]` (id, name, display name, provider, model, `system_prompt`, `mcp_servers.include`, `skills.include`),
`managed_mcp_servers[]` (id, name, url, transport, `oauth`, `tool_policy`), `plugins[]` (id, version, sha256,
`files[]` with path, sha256, size), `marketplaces[]`, `enabled_hosts`, `revocations` (ids of the user's revoked keys),
`branding`, `desktop_policy`. Unknown fields are ignored. A `min_schema_version` above 1 is incompatible.

The key is trusted on first use: the client pins it at sign-in and shows its fingerprint, `sha256:` plus the hex
SHA-256 of the 32 raw key bytes. When a manifest does not verify, the client fetches the served key again: a different
key is a key change, the same key a bad signature.

### Plugin bundle files (`SpPlugins`)

`GET /v1/bridge/plugins/{plugin}/{path}` with the JWT answers `200` with the raw bytes of one file of a plugin the user
is granted, the bytes the manifest's `plugins[].files[].sha256` covers: on the local 0.76 instance every file of alpha's
two plugins matched its digest and size. An unknown file or plugin is `404` (`File not found`, `Plugin not found`), a
bad JWT `401`. The route is the systemprompt bridge's (`gateway/fetch.rs`); `archive/<sha256>` under a plugin is the
whole plugin as a tar.gz, not used. `SpPlugins.file` encodes each path segment, refuses a plugin id or a path that is
not plain segments before sending anything, follows no redirect, and gives up past 8 MiB or 60 s; its errors map as
below. The caller checks the bytes against the manifest before using them.

### How answers map to the client's errors

The client refuses an `http:` base URL unless the host is `127.0.0.1`, `localhost` or `[::1]`, so a PAT or JWT never
travels in clear text to a remote instance. A health answer that fails or does not decode only leaves the version
unknown, and a `404` on `/v1/auth/bridge/capabilities` (instances before 0.76) means no modes.

| Answer                                                                                                                                                                      | Error                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `401` anywhere (PAT revoked, JWT refused, code invalid or used)                                                                                                             | `Unauthorized`, with the envelope's `message` and `error_key`. With a JWT, mint once more from the PAT before treating it as signed out |
| `429`                                                                                                                                                                       | `RateLimited`, with `Retry-After` (seconds or an HTTP date) in milliseconds                                                             |
| no answer, a timeout (30 s for the whole answer, body included), or a `5xx`                                                                                                 | `Unreachable`                                                                                                                           |
| manifest signature fails, served key unchanged                                                                                                                              | `SignatureInvalid`                                                                                                                      |
| manifest signature fails, served key changed                                                                                                                                | `KeyChanged`, with both fingerprints                                                                                                    |
| discovery `contract` other than `"1"`, manifest schema above 1                                                                                                              | `Incompatible`                                                                                                                          |
| any other status, a `3xx` (never followed, so a bearer never leaves the origin), a body that does not decode (with the field path), a discovery path that leaves the origin | `Protocol`                                                                                                                              |

## 10. Skill runtime files: the consumer API (`SpConsumer`)

A skill's runtime files (`config.yaml`, `references/*`, the `.systemprompt-source/<revision>/` copy) are not in the
manifest. A skill with a `publication` (`{publication_id, resource_id, revision_id, generation, bundle_digest}`) has a
bundle the systemprompt bridge fetches as an enrolled device. Unlike the sections above, the requests follow the
bridge's code (`bin/bridge/src/feedback/{enrol,transport,readback}.rs`, read for the bridge-parity plan); every answer
below was observed on the local 0.76 instance (`test/fixtures/consumer.json`):

| Call                                                                                         | Credential            | Answer                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/bridge/device` `{fingerprint, label}`                                              | the user's JWT        | `200 {device_id, consumer_id, credential}`, the credential `sp_device_` plus 72 characters. The same fingerprint is the same `device_id`; each call issues a new credential                                                                    |
| `GET /api/v1/consumer/resources/{resource}/publications/{publication}/bundle?host=open-code` | the device credential | `200` the installation plan: the publication's ids, `host`, `canonical_files` (`{revision_id, path, digest, bytes, executable, content_check, mode_check}`) and `runtime_files` (`{path, bytes, executable}`, `bytes` an array of byte values) |
| `POST /api/v1/consumer/receipts` (`ConsumerReceiptRequest`)                                  | the device credential | `200 {receipt_id, acknowledgement, acknowledged_at, fully_verified}`; `acknowledgement` is `accepted`, then `identical_retry` with the same `receipt_id` for the same receipt                                                                  |
| `POST /api/v1/consumer/session-bindings` `{receipt_id, host, session_id}` (`SessionBindingRequest`) | the device credential | `200 {id, bound_at}`; the same binding again answers the same. A receipt this device did not post, or an unknown device credential, is `403` "Consumer evidence is unavailable to this identity"; a JWT is `401`; `host: opencode` is `422` |

- The fingerprint is the bridge's: hex SHA-256 of `systemprompt-bridge-device/v1\n<install id>\n<user id>`.
  DynWork's install id is a random UUID kept with its accounts.
- `host` is the instance's `EvaluatorClient` in kebab-case: OpenCode is `open-code`. `opencode` answers `400` "Invalid
  request body, query or path parameters".
- The consumer routes answer problem documents (`{type, title, status, detail}`): a JWT or an unknown credential on
  them is `401` "Valid enrolled-device authentication is required". The client maps them like the rest (`401`
  `Unauthorized`, `429` `RateLimited`, `5xx` and no answer within 20 s `Unreachable`, anything else `Protocol` with its
  status). A plan whose ids, generation or digest differ from the manifest's publication is a `Protocol` error.
- Each plan's runtime files are the bundle's files at their own paths, a copy of each under
  `.systemprompt-source/<revision>/`, and a `SKILL.md` rendered for the host (`name: "alpha-notes"` quoted, unlike the
  bridge's projection).
- `SpConsumer.bind` posts a session binding: `session_id` is the session the governance events name (the v5 UUID the
  bridge derives from OpenCode's `ses_…` id; 0.76 also takes the raw id).
- The receipt reports every runtime file as read back from disk (`digest` SHA-256 hex, `bytes`, `executable`,
  `content_check`, `mode_check`), and each canonical file checked against its `.systemprompt-source` copy.
  `SpConsumer.receipt` builds it and refuses a readback that does not match the plan, as the bridge's `verify` does.

## Not observed

- What an expired code answers (expected the `401` above; the CLI cannot mint a short-lived code and waiting 600 s was
  not done).
- A real IdP login: the local instance has a dummy Entra secret. The capture signs in through the core OAuth page with
  a passkey instead (see the fixture's `development_login`); everything after the login is the same page.
- Other brands and production instances (0.74 has no discovery).
- A real `429` or `5xx` from an instance; their mapping is tested against a fake only.
- A manifest key rotation on a real instance (the local instances keep theirs; the live test pins one instance's key
  against the other's manifest instead).
