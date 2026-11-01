# systemprompt sign-in: the contract DynWork relies on

How a systemprompt 0.76 instance signs a desktop client in through the browser device link, and how the one-time code
becomes a durable credential. Written from observation only (HTTP traffic and rendered pages of
`ghcr.io/systempromptio/systemprompt-dynapps:0.76.0` on the local harness), never from server or bridge code.

The evidence is `dynwork/test/sp-local/fixtures/device-link.json` (redacted: names, statuses and page text, never a
code, PAT or JWT). `bun dynwork/script/sp-local.ts capture` observes the instance again, rewrites the fixture and says
which entries changed, so a new server version can be checked against this page.

## 1. Where the device-link page is

| Step | Request | Answer |
| --- | --- | --- |
| Discovery | `GET /.well-known/systemprompt-bridge`, no auth | `200` JSON with `contract` (`"1"`), `device_link_path` (`/bridge-auth/device-link` here), `identity_path`, `branding.display_name`, `enabled_hosts` |
| No discovery | | Instances older than 0.76 answer `404`. Fall back to `/bridge-auth/device-link` (the Dynapps brand); the core default `/bridge/device-link` is `404` on this image |

Both paths are relative to the instance base URL. A path that would leave that origin is refused by the client.

## 2. Opening the page

The client opens the system browser on

```
<base><device_link_path>?redirect=<loopback URL>
```

`redirect` is the only query parameter the page reads. The rules it applies, observed on the page (`GET`) and on the
approval (`POST`), which reject the same set:

| `redirect` | Result |
| --- | --- |
| `http://127.0.0.1:<port>/<any path>`, with or without a path or its own query | accepted |
| `http://localhost:<port>/...` | accepted |
| any port from 0 to 65535 (`:0` and `:1` included) | accepted; 65536 is `400` |
| no port (`http://127.0.0.1/cb`) | `400` |
| `https://` loopback, `http://[::1]:<port>`, `127.0.0.2`, `127.0.0.1.<other domain>`, any other host, a custom scheme | `400`, page "Invalid redirect": "Only http://127.0.0.1:PORT or http://localhost:PORT redirects are accepted." |
| missing | the page switches to the paste flow (section 5) |

A browser without a session on the instance gets `307` to `/admin/login?redirect=<path and query of the page>`, signs
in with the instance's own IdP (Microsoft Entra on the Dynapps brand) and lands back on the page. The client never sees
the IdP.

## 3. The consent page

`200` HTML, title "Authorise a device". It shows the signed-in account, the helper (`127.0.0.1:<port>`, taken from
`redirect`), how long the code will live (600 seconds) and says that approving issues a personal access token that
stays valid until revoked. Two forms, each with a single hidden `redirect` field:

| Button | Form | Answer |
| --- | --- | --- |
| Allow | `POST <device_link_path>/approve`, `application/x-www-form-urlencoded` | `303` to `redirect` with `code=<code>` appended to its query |
| Deny | `POST <device_link_path>/deny` | `303` to `redirect` with `error=denied` appended; nothing is issued |

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

| Request | Body | Answer |
| --- | --- | --- |
| `POST /v1/auth/bridge/session-pat`, no auth | JSON `code`, optional `device_name` | `200` JSON `pat`: a durable `sp-live-` personal access token. `device_name` becomes its name in the user's token list |
| same, code empty | | `400` `bad_request` "missing exchange code" |
| same, code unknown, expired or already used | | `401` `unauthorized` "exchange code invalid, expired, or already consumed" |
| `POST /v1/auth/bridge/session`, no auth | JSON `code` | `200` with the same body as `/pat` below: a JWT and no durable credential |

A code works once across both routes: the second exchange answers `401`.

Errors use the common envelope: `code`, `message`, `timestamp`.

## 7. From the PAT to a session

| Request | Answer |
| --- | --- |
| `POST /v1/auth/bridge/pat`, `Authorization: Bearer <PAT>`, no body | `200` JSON `token` (RS256 JWT), `ttl` (3600 s), `headers` (identity headers the client may replay: `x-client-id` is `sp_bridge`, plus `x-user-id`, `x-session-id`, `x-trace-id`, `x-policy-version`, `x-call-source`) and `device_token` (a second JWT) |
| same, PAT revoked | `401` `unauthorized` "Invalid PAT" |

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

## Not observed

- What an expired code answers (expected the `401` above; the CLI cannot mint a short-lived code and waiting 600 s was
  not done).
- A real IdP login: the local instance has a dummy Entra secret. The capture signs in through the core OAuth page with
  a passkey instead (see the fixture's `development_login`); everything after the login is the same page.
- Other brands and production instances (0.74 has no discovery).
