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

| Call                                                                                                | Credential            | Answer                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/bridge/device` `{fingerprint, label}`                                                     | the user's JWT        | `200 {device_id, consumer_id, credential}`, the credential `sp_device_` plus 72 characters. The same fingerprint is the same `device_id`; each call issues a new credential                                                                    |
| `GET /api/v1/consumer/resources/{resource}/publications/{publication}/bundle?host=open-code`        | the device credential | `200` the installation plan: the publication's ids, `host`, `canonical_files` (`{revision_id, path, digest, bytes, executable, content_check, mode_check}`) and `runtime_files` (`{path, bytes, executable}`, `bytes` an array of byte values) |
| `POST /api/v1/consumer/receipts` (`ConsumerReceiptRequest`)                                         | the device credential | `200 {receipt_id, acknowledgement, acknowledged_at, fully_verified}`; `acknowledgement` is `accepted`, then `identical_retry` with the same `receipt_id` for the same receipt                                                                  |
| `POST /api/v1/consumer/session-bindings` `{receipt_id, host, session_id}` (`SessionBindingRequest`) | the device credential | `200 {id, bound_at}`; the same binding again answers the same. A receipt this device did not post, or an unknown device credential, is `403` "Consumer evidence is unavailable to this identity"; a JWT is `401`; `host: opencode` is `422`    |

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

## 11. Mobile sign-in

How a phone signs in to a 0.76 instance, observed on both local instances with `bun dynwork/script/sp-local.ts mobile-auth-probe`
(evidence: `dynwork/test/sp-local/fixtures/mobile-auth.json`, redacted like the device-link fixture). The device link of
sections 1 to 8 cannot serve a phone: it accepts only `http://127.0.0.1:<port>` and `http://localhost:<port>` redirects
(section 2) and a phone has no loopback listener the system browser can reach. What the probe asked is whether the
instance's own OAuth server, the `oauth-client` mode the capabilities list, takes a native app redirect.

**Verdict: core OAuth usable.** Every step the app needs worked on both instances: a native client registers
`dynwork://auth/callback`, authorize accepts it with PKCE `S256`, the callback carries `code` and the same `state`, the
code becomes an access token and a refresh token, the refresh token mints another one, and the access token is accepted
by the bridge routes. No extension endpoint is needed for the protocol. One product limit decides how it is offered
(the sign-in is a passkey, see "What it signs in with").

### Discovery

| Request                                       | Answer                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/auth/bridge/capabilities`            | `200` `modes`: `pat`, `session`, `oauth-client`                                                                                                                                                                                                                                                                                           |
| `GET /.well-known/oauth-authorization-server` | `200` RFC 8414 metadata, the same body at `/.well-known/openid-configuration`. `issuer` is the instance base URL. Endpoints under `/api/v1/core/oauth/`: `authorize`, `token`, `userinfo`, `introspect`, `revoke`, `register`                                                                                                             |
| same, what it says                            | `response_types` `code`, `response_modes` `query`, `scopes` `user` and `admin`, `code_challenge_methods` **`S256` only**, token endpoint auth `none`, `client_secret_post`, `client_secret_basic`, `authorization_response_iss_parameter_supported` `true`; grants `authorization_code`, `refresh_token`, token exchange and `jwt-bearer` |
| `GET /.well-known/oauth-protected-resource`   | `200` `resource` and `authorization_servers` are the base URL                                                                                                                                                                                                                                                                             |

The `registration_client_uri` a registration returns names the container's own address (`http://localhost:8080/...`):
use its path on the base URL the user typed, as with `--gateway` in section 5.

### Registering a client

`POST /api/v1/core/oauth/register`, JSON, **no credentials** (RFC 7591). A public client sends `client_name`,
`redirect_uris`, `token_endpoint_auth_method: "none"`, `grant_types` (`authorization_code`, `refresh_token`),
`response_types: ["code"]` and `application_type: "native"`. Answer `201` with `client_id` (`client_` and 32 hex
characters), `registration_access_token` and `registration_client_uri`. `DELETE` on that URI with the token answers `204`.

| `redirect_uris` entry                                                                     | `application_type: native`    | default (`web`)                                                                          |
| ----------------------------------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------- |
| `dynwork://auth/callback`, `dynwork:/auth/callback`, `com.dynapps.dynwork:/auth/callback` | `201`                         | `400` `invalid_client_metadata`: a private-use scheme "requires application_type native" |
| `http://127.0.0.1/cb`, `http://127.0.0.1:<port>/cb`                                       | `201`                         | `201`                                                                                    |
| `https://<any host>/...`, including a host that is not the instance                       | `201`                         | `201`                                                                                    |
| `javascript:...`                                                                          | `400` "uses a refused scheme" | `400`                                                                                    |

The app therefore registers once per instance at first sign-in (name "DynWork Mobile") and keeps the `client_id`; it
does not need the registration token afterwards unless it deletes the client.

### Authorize

`GET /api/v1/core/oauth/authorize?response_type=code&client_id&redirect_uri&scope=user&state&code_challenge&code_challenge_method=S256`
in the system browser (ASWebAuthenticationSession, Custom Tabs). Observed rules, with the instance not signed in:

| Request                                                                           | Answer                                                                                                                  |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| registered `redirect_uri` (`dynwork://auth/callback`), PKCE `S256`, valid `state` | `200` sign-in page (section "What it signs in with")                                                                    |
| another path, another host, a trailing slash or another scheme than registered    | `400` JSON `invalid_request`, "redirect_uri ... not registered for client": **exact match**, no redirect to the bad URI |
| a loopback client registered as `http://127.0.0.1/cb`, asked with `:<port>/cb`    | `200`: the port may differ (RFC 8252 7.3). A different path, `localhost` instead of `127.0.0.1`: `400`                  |
| unknown `client_id`                                                               | `400` "Invalid client_id"                                                                                               |
| no `code_challenge`, `code_challenge_method=plain`                                | `303` to the redirect URI with `error=invalid_request` and `state`: PKCE with `S256` is required                        |
| `state` shorter than 32 characters (16 and 30 refused), or missing                | `400` "CSRF token (state parameter) is invalid" / "is required". 32 hex, 43 base64url, 200 characters: accepted         |
| `scope=admin` for a user without the role                                         | `303` to the redirect URI with an `error`                                                                               |

The `state` is mandatory and at least 32 characters, so the app generates 32 random bytes as base64url (43 characters)
and compares it on return.

### The round trip

After the sign-in the page shows a consent step ("DynWork mobile probe wants to access your account", the scope and
where the browser will be sent) with Authorize and Cancel.

| Step                                                                                                                                                                      | Observed                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Authorize                                                                                                                                                                 | `303` to `dynwork://auth/callback?code=<42 characters>&client_id=<id>&state=<same>&iss=<issuer>` (RFC 9207; its value was not recorded). The loopback client is sent to `http://127.0.0.1:<port>/cb?` the same way |
| Cancel                                                                                                                                                                    | `303` to `dynwork://auth/callback?error=access_denied&error_description=...&state=<same>`                                                                                                                          |
| `POST /api/v1/core/oauth/token` (`application/x-www-form-urlencoded`, no auth) with `grant_type=authorization_code`, `client_id`, `code`, `redirect_uri`, `code_verifier` | `200` `access_token` (RS256 JWT), `expires_in` **2592000** (30 days), `refresh_token`, `token_type` `Bearer`, `scope` `user`                                                                                       |
| `grant_type=refresh_token`, `client_id`, `refresh_token`                                                                                                                  | `200` the same body with **a new refresh token**: it rotates, and the old one answers `400` `invalid_grant`                                                                                                        |
| a code used twice                                                                                                                                                         | the second use is `400` `invalid_grant` "Invalid authorization code", **and the refresh token of the first use stops working** (RFC 6749 4.1.2)                                                                    |
| wrong `code_verifier`, or a `redirect_uri` that differs at the token endpoint                                                                                             | `400` `invalid_grant` "Invalid authorization code"                                                                                                                                                                 |
| `POST /api/v1/core/oauth/revoke` with `client_id` and `token`                                                                                                             | `401` with the client id alone; `200` when the request also carries `Authorization: Bearer <access token>`, and the refresh token is then dead                                                                     |
| `GET /api/v1/core/oauth/userinfo`, bearer                                                                                                                                 | `200`                                                                                                                                                                                                              |

The access token's claims: `aud` (`web`, `api`, `a2a`, `mcp`), `auth_time`, `client_id`, `email`, `exp`, `iat`, `iss`,
`jti`, `nbf`, `rate_limit_tier`, `roles`, `scope`, `session_id`, `sub`, `token_type`, `user_type`, `username`.

### The OAuth token on the bridge routes

With `x-systemprompt-client: opencode` and the access token as bearer, `GET /v1/bridge/whoami`, `/v1/bridge/profile` and
`/v1/bridge/manifest` answer `200` with the shapes of section 9. The token is not a PAT: `POST /v1/auth/bridge/pat`
with it answers `401`. The phone's durable credential is therefore the **rotating refresh token** (keep it in the OS
secure store, replace it on every refresh, and treat `invalid_grant` as signed out), not a `sp-live-` PAT.

### What it signs in with

The authorize page signs in with a **passkey** (WebAuthn) and nothing else: Microsoft Entra, the admin login of
sections 2 and 3, is not offered on it. A user who has no passkey gets `401` "Authentication failed. Check the email
address or register a passkey." The page's own "Create New Passkey" reaches `POST .../webauthn/register/start`, which
answered `200` without credentials, even for an existing account; whether `finish` enrols one was not exercised. An
instance whose users sign in with Entra only needs them to link a passkey first (the operator's
`admin users webauthn generate-setup-token`, which the local probe uses). This is the one place where the phone differs
from the desktop, whose device link rides the Entra login.

### What phases 07 and 10 build on

- The app registers `dynwork://auth/callback` as a native public client per instance, then runs authorize with PKCE
  `S256` and a 43-character `state`. Phase 07 shrinks to the client registration, the passkey prerequisite and tests;
  it adds no sign-in endpoint.
- The app must not log or persist `code`, the access token or the refresh token outside the secure store.
- Registration is open to anyone who can reach the instance, including `https://` redirects on any host. The consent page
  shows the client's own `client_name`, so a look-alike client can ask for consent in the app's name. The app cannot
  prevent that; the redirect it registers is the only one that reaches it.
- On Android the custom scheme can be claimed by another installed app (RFC 8252 7.1); `S256` makes a stolen code
  useless without the verifier, so the app never uses a challenge it did not generate.

## 11. Mobile sign-in, path 1: the DynWork extension

Path 1 is the default (decision A6, "Ambos"): the phone signs in like the desktop, through the system browser and the
instance login (Entra on the Dynapps brand), and needs no passkey. It is the `dynwork-relay` extension of
systemprompt-dynapps, not core, so it is written from its source and its tests, and observed on the mobile project's
alpha (`sp-local.ts up --image local`). Core OAuth (section 10) is path 2, postponed to phase 19 (decision M9).
`@dynwork/sp-client/mobile` (`SpMobile`) is the client; it runs on Hermes.

Every route is under `/api/dynwork/mobile/v1` (under `/api/`, so core's session middleware tracks none of them):

| Request                                                                              | Auth                                                   | Answer                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /discovery`                                                                     | none                                                   | `version` 1, `display_name`, `redirect_uri`, the route paths, `device_socket_path`, `code_challenge_methods` `["S256"]`. `404` on an instance without the extension: the app falls back to path 2                         |
| `GET /authorize?redirect_uri&code_challenge&code_challenge_method&state&device_name` | the instance's browser session cookie (`access_token`) | `200` consent page; `307` to `/admin/login?redirect=<this path and query>` without a session; `400` page for any malformed parameter, before the session is looked at                                                     |
| `POST /authorize/decision`, form `request`, `decision` (`allow` or `deny`)           | the same cookie                                        | `303` to `dynwork://auth/callback?code=<code>&state=<state>` or `?error=access_denied&state=<state>`; `400` page when the request is unknown, already answered, expired or another person's; `401` page without a session |
| `POST /token`, JSON `code`, `code_verifier`, `peer_id`                               | none                                                   | `200` JSON `credential` (`dwm1_`), `peer_id`, `token` (JWT), `token_type` `Bearer`, `expires_in` 3600, `device_id`, `account` (`id`, `email`, `name`); `cache-control: no-store`                                          |
| `POST /refresh`                                                                      | `Bearer <credential>`                                  | `200` the same without `credential` and `peer_id`                                                                                                                                                                         |
| `GET /session`                                                                       | `Bearer <JWT>`                                         | `200` `user_id`, `email`, `name`, `device_id`, `expires_at` while the device is live                                                                                                                                      |
| `POST /revoke`                                                                       | `Bearer <credential>`                                  | `204`: the device is revoked (sign-out)                                                                                                                                                                                   |

Rules:

- `redirect_uri` must be exactly `dynwork://auth/callback`; the relay never redirects anywhere a request names.
- PKCE is `S256` only: `code_challenge` is 43 base64url characters, `code_challenge_method` may be omitted or `S256`.
  `code_verifier` is 43 to 128 unreserved characters.
- `state` is mandatory, 32 to 256 unreserved characters, returned verbatim on Allow and on Deny. The client accepts a
  callback only with its own `state` (constant-time compare).
- `device_name` is at most 64 printable characters (default `Phone`); it is shown on the consent page and names the
  device in the devices list.
- Only a browser session of a person opens the consent page: an `Authorization` header is never read there, and an
  anonymous, delegated, plugin-scoped or purpose-bound token is a signed-out browser.
- At most 10 consents per person are open at once (`429` page after that).
- The code (`dwa1_` + 43 characters) lives 10 minutes from Allow and works once. Unknown, used, expired and
  wrong-verifier all answer the same `400` `invalid_grant`, and a wrong verifier burns the code. A code presented
  again revokes the device its first use created.
- The credential is a phone row of the relay (`kind` `phone`, SHA-256 only): it opens the device socket
  (`/api/dynwork/relay/v1/device`), shows up in the desktop's `GET /devices` and is removed by `DELETE /devices/{id}`.
  Signing in again with the same peer id replaces the previous device of that peer.
- The JWT lives one hour. Its only audience is `dynwork-mobile` and its purpose `dynwork-mobile`, so the bridge, MCP,
  core session and the relay's desktop routes refuse it. `/refresh` re-reads the account: a suspended or deleted
  account cannot refresh.
- Errors are the relay's `{error, message}`: `invalid_grant` and `bad_request` (`400`), `unauthorized` (`401`),
  `device_limit` and `peer_taken` (`409`).

Locally there is no IdP. `sp-local.ts dev-login [alpha|beta]` prints a single-use, ten-minute link to the instance's
own development login (`/admin/auth/dev/login`, mounted only on development, non-cloud profiles, which the image's
generated profile is). Opening it sets the instance session cookie in that browser; the consent then shows with no
IdP. `test/mobile/live.test.ts` does this with `fetch`; the app's end-to-end flows (phase 12) open the link in the
device browser first, which shares its cookies with ASWebAuthenticationSession and Custom Tabs.

Not observed: the Entra login in front of `/authorize` (no local IdP), and whether core's login honours a `redirect`
under `/api/` after Entra the way it does for the device link.

## Not observed

- Mobile sign-in: the Entra login on the authorize page (the local instance has none to offer), how long a refresh token
  lives and whether an OAuth session shows in an administrator's token list, `register/finish`, and a rate limit on
  client registration.
- What an expired code answers (expected the `401` above; the CLI cannot mint a short-lived code and waiting 600 s was
  not done).
- A real IdP login: the local instance has a dummy Entra secret. The capture signs in through the core OAuth page with
  a passkey instead (see the fixture's `development_login`); everything after the login is the same page.
- Other brands and production instances (0.74 has no discovery).
- A real `429` or `5xx` from an instance; their mapping is tested against a fake only.
- A manifest key rotation on a real instance (the local instances keep theirs; the live test pins one instance's key
  against the other's manifest instead).
