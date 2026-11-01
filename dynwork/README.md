# DynWork overlay

Everything DynWork adds on top of upstream OpenCode lives in this directory. The branch `main` is an upstream
release tag plus a short stack of `dynwork`-scoped commits, so syncing with upstream means rebasing that stack onto
the next tag.

## Layout

| Path                                  | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PATCHES.md`                          | Every upstream file we modify, why, and the risk on upstream updates                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `packages/branding`                   | `@dynwork/branding`: the prod app identity (`src/identity.ts`) that the desktop package reads                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `packages/branding/logo`              | `wordmark.svg`: "dynwork" outlined, in `currentColor`. `lockup.svg`: the Dynapps symbol in its gradient left of the wordmark                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `packages/build`                      | `@dynwork/build`: the build seam. `src/vite.ts` exports `DynWorkVite`, the aliases and plugins that swap the theme and the logos, which `packages/desktop/electron.vite.config.ts` spreads into its main and renderer plugins. `test/vite.test.ts` fails when an upstream specifier, module or export a swap relies on moves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `script/patches.ts`                   | The patch guard (`bun dynwork/script/patches.ts`, logic in `packages/build/src/patches.ts`). `UPSTREAM` holds the upstream tag the stack sits on                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `script/sync-upstream.ts`             | The upstream sync (logic in `packages/build/src/sync.ts`): rebases the stack onto a newer upstream ref in a throwaway worktree, checks it and writes a report. See "Syncing with upstream"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `script/sp-local.ts`, `test/sp-local` | The local systemprompt harness (see "Local systemprompt instances"). `script/e2e-sp.ts` runs the whole flow against it (see "End to end")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `packages/sp-client`                  | `@dynwork/sp-client`: the clean-room systemprompt 0.76 client, Effect and `fetch`, no OpenCode dependency. `SpClient` has `discover`, `deviceLinkUrl` and `parseCallback`, `exchangeCode`, `mintJwt` and `withJwt` (re-mints once on a refused JWT), `publicKey` and `fingerprint` (trust on first use), `manifest` (ed25519 over the JCS payload, ETag and 304), `profile`, `models` and `whoami`, and the errors `Unauthorized`, `RateLimited`, `Unreachable`, `SignatureInvalid`, `KeyChanged`, `Incompatible` and `Protocol`. It stores and logs no credential. `src/jcs.ts` is RFC 8785. `PROTOCOL.md` is the contract as observed (device link, code exchange, PAT to JWT, manifest, profile, models, error mapping). `bun test` runs the fake-instance tests; `SP_LOCAL_ENV=../../test/sp-local/.env.local bun test` adds the live ones against the local instances |
| `packages/gui`                        | `@dynwork/gui`: DynWork's own screens and main-process helpers. `src/signin`: the sign-in gate the desktop shows until the device is signed in. `src/service.ts`: the layout of DynWork's own background service (see "Background service"). `src/accounts`: the `dynwork` built-in GUI plugin that holds the systemprompt accounts in main (see "Accounts"). `src/sync`: the live sync engine (see "Live sync")                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `packages/server-plugin`              | `@dynwork/server-plugin`: the OpenCode server plugin DynWork's own service loads. It holds the active instance's content in memory (see "Server plugin"). `src/contract.ts` is the RPC contract and `src/client.ts` the caller main uses (only `effect`, so main can bundle them); `src/mapping.ts` turns a manifest into OpenCode items; `src/gateway.ts` builds the `systemprompt` provider and decides the JWT of each model call; `src/shell.ts` restores the user's XDG values in tool shells. `bun test` runs the mapping and contract tests and live tests against a real `opencode serve` (`test/gateway` drives real Session steps against a fake gateway)                                                                                                                                                                                                        |
| `packages/branding/src`               | `outline.ts`: the wordmark letters, the symbol and the lockup geometry. `logo.tsx`, `wordmark.tsx` and `new-session-wordmark.tsx`: the Solid components the desktop build uses in place of upstream's logos. `lockup.tsx`: the lockup, ink letters in light and white in dark                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `packages/branding/theme`             | `dynapps.json`: the Dynapps light and dark theme, bundled by the desktop build in place of `oc-2.json`. `dynapps-deep.json`: Dynapps Deep, the same light variant and a pure black dark variant, linked into the upstream theme folder as `oc-2-deep.json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## Architecture

DynWork is upstream OpenCode Desktop plus code under `dynwork/`, joined at a few seams so a rebase onto the next
upstream tag stays cheap:

- **Build seam:** `packages/desktop/electron.vite.config.ts` spreads `DynWorkVite.main()` and `DynWorkVite.renderer()`
  (`packages/build`); every theme, logo and module swap lives there.
- **GUI plugin seam:** the `dynwork` built-in GUI plugin (`packages/gui/src/accounts`) is one entry in each of
  `packages/gui-plugins/src/main.ts` and `renderer.ts`. It owns accounts, the sync engine, the Settings page and the
  titlebar pill. The sign-in gate is one line in `desktop-app.tsx`.
- **Service seam:** the packaged prod build runs its own OpenCode service (`DynWorkService.layout`, two touched spots in
  `background-service.ts` and `sidecar-probe.ts`), which loads the DynWork server plugin (`packages/server-plugin`)
  shipped as an extra resource (`electron-builder.config.ts`).
- **Patch guard:** every upstream file DynWork touches has a row in `PATCHES.md`; `script/patches.ts` and the `dynwork`
  workflow fail otherwise or when the line budget is passed.

Processes and data flow:

```
systemprompt instance ──HTTPS──▶ Electron main (dynwork GUI plugin)
  device link / PAT              accounts: PAT in safeStorage, JWT in memory, renewal
  manifest (ETag, ed25519)       sync engine: poll, verify, digest, push only changes
  /v1 gateway ◀─────────┐                 │ RPC dynwork.sync/apply|token|clear (service password, loopback)
                        │                 ▼
                        └──── DynWork's OpenCode service (own port, DB, config, state)
                              server plugin: skills, sub-agents, remote MCP, rules, provider `systemprompt`
                              model calls carry the JWT, pinned to the instance gateway
Windows (renderer) ◀── dynwork.accounts Ipc: accounts without secrets, sync status
```

To add a DynWork feature without new upstream patches: put UI and main-process code in the `dynwork` GUI plugin
(Settings pages, titlebar items, Ipc), content and hooks for sessions in the server plugin, and build-time swaps in
`DynWorkVite`. Touch an upstream file only when none of these reaches, with a `PATCHES.md` row.

### Known limitations

- Interactive terminals (PTY), MCP stdio servers and LSPs started by DynWork's service see DynWork's `XDG_STATE_HOME`
  and `XDG_DATA_HOME` (inside its userData). Only the bash tool's shells get the user's values back; OpenCode has no
  plugin hook for the PTY environment.
- The service drops a fixed list of the user's `OPENCODE_*` variables (`DynWorkService.inherited`); a new upstream
  variable that steers the service needs adding there.
- Only systemprompt 0.76 and later (production runs 0.74). macOS only: Linux would need to refuse the `basic_text`
  safeStorage backend first.
- The browser device link needs the instance's own login (Entra on Dynapps instances); the local harness signs in with a
  one-time code or a PAT instead.

## Sign-in

The desktop shows a full-window sign-in screen until a systemprompt instance is signed in and active
(`packages/gui/src/signin`, mounted by `desktop-app.tsx`, see `PATCHES.md`). It runs on the real accounts
(see "Accounts"): `SignInReal.create` implements `SignInAccounts.Interface` over the `dynwork.accounts` Ipc client that
`connection()` hands out, and `SignInAccounts.mock()` stays for tests and stories. No call of the interface rejects; a
failure is an answer the screen maps to its copy (`copy.ts`, `failure`).

- Step 1: the URL is checked as you type (`probe`: discovery plus health), with its own message for a malformed URL, an
  instance that does not answer and an address that is not a supported systemprompt. "Sign in with your browser" opens
  the instance's device-link page and waits on the loopback listener, with Cancel. "Use a personal access token
  instead" takes a PAT or a one-time code; "Get a one-time code from your instance" opens the instance's device-link
  page without a redirect, which shows the code to paste. Failures (declined, expired, refused token, unreachable, rate
  limited, unsupported instance, no OS secure storage) show under the control that started the sign-in.
- Step 2: the signed-in instances, the one just signed in first and preselected, with the skill, agent and MCP server
  counts of its first manifest (`summary`, verified against the manifest key the account holds). Finish activates the
  chosen instance. "Finishing setup" waits for the sync engine's first status for that instance (the `sync` event):
  `synced` shows its skill count, an error ends the step too, and it gives up after 20 s; the app opens either way.
- "Keep me signed in on this device" unchecked means the PAT is never stored: main keeps it sealed in memory for this
  run (so the JWT is still renewed) and the account is signed out on the next launch.
- Visibility follows main's state, not a renderer flag: the screen shows while no signed-in account is active, stays up
  until Finish has faded it out, and comes back when the active account signs out. Until main's first snapshot a plain
  cover keeps the shell from showing. The old `dynwork-signin` storage key is removed on startup.

The screen sits under the startup splash, so it appears when the splash fades and the shell keeps loading underneath.
While it shows, the gate keeps focus and every keydown to itself, so app shortcuts do not act on the hidden shell.
`bun dynwork/script/smoke.ts <png> oc-2 light signin-pat` signs in through it with alpha's PAT (see "Local systemprompt
instances"), reloads, and checks that the PAT is nowhere in the profile as plaintext.

## Accounts

DynWork's systemprompt accounts live in the main process, in the `dynwork` built-in GUI plugin
(`packages/gui/src/accounts`, registered with one line in each of `packages/gui-plugins/src/main.ts` and
`renderer.ts`). `DynWorkAccounts.make` (`accounts.ts`) keeps several instances, at most one active, and signs in with a
personal access token, a pasted one-time code, or the browser device link (`loopback.ts`: one listener on
`127.0.0.1`, a random port, one answer, the `state` checked, 10 minutes, the system browser opened with
`shell.openExternal`). Windows reach it through the `dynwork.accounts` Ipc (`contract.ts`); the window entry
(`renderer.ts`) hands its live client to the sign-in gate, which renders outside the plugin host. `ipc.ts` is the Ipc
over the service: a sign-in that fails answers with its kind (`unreachable`, `refused`, `rate-limited`, `incompatible`,
`insecure`, `failed`) instead of rejecting, since a rejection reaches a window as plain text; `summary(id)` counts the
account's first manifest.

Where secrets live:

- The PAT is stored only as `safeStorage.encryptString` ciphertext (base64) in the plugin's main storage, the desktop's
  own SQLite under `plugin.dynwork`, key `accounts`, with each instance's URL, label, user, organization, pinned
  manifest key and its fingerprint. Without OS encryption (`safeStorage.isEncryptionAvailable()` false) no sign-in
  starts. A ciphertext the OS cannot open right now (a locked keyring, a denied Keychain prompt) is kept and the call
  fails with `SecureStorageUnavailable`; only the instance refusing the PAT signs the account out.
- JWTs exist only in main memory. Each is renewed at 80 % of its lifetime; a failed renewal is tried again every 30 s
  while it holds. A refused JWT is minted again once; a refused PAT signs the account out. Main code (gateway, sync)
  gets one through `jwt(id)`, `session(id, fresh)` (with its expiry; `fresh` mints even while the held one is valid)
  or `withJwt(id, use)`, and hears of every JWT minted through the `renewed` option.
- Windows see `{id, label, url, user, org, status, active, fingerprint, trusted}` and never a PAT, JWT or code.
  Nothing goes into OpenCode's `credential` table or the service's database.
- Signing out forgets the PAT locally; the token stays in the user's list on the instance until revoked there.

### Managing instances

Settings -> systemprompt (`dynwork/packages/gui/src/accounts/ui/`) lists every instance this device knows: its label,
URL, user, status, when the active one last synced and what it holds, and the fingerprint of its manifest key. Per
instance: Make active, Sync now (active only), Sign out and Remove (both ask first), and Sign in again for a signed-out
one. Add instance opens the sign-in screen's connect form (browser link or personal access token) in a dialog; the
account joins the list and stays inactive until you make it active.

A manifest key waits for the user: the first key an instance offers ("New key") and a rotated one ("Key changed", shown
with the pinned and the offered fingerprints) stop at "Trust this key" / "Trust new key", which pins exactly the
fingerprint on screen. The sign-in screen never trusts a key. The active instance's section lists what it synced,
including its rules, which reach every session's system context through the service's global `AGENTS.md`.

The titlebar pill (a `TitlebarItem`) shows the active instance; its icon says how the sync stands (synced, syncing,
needs attention). It grows to its label on hover, and a click opens a small dialog to switch instance, Sync now, or go
to the page. `TitlebarItem` has no dot or menu, so the icon and the dialog stand in for the mockup's. Tailwind does not
scan `dynwork/`: the page, dialog and form style themselves in `accounts/ui/accounts.css` and `signin/connect.css`.
`bun dynwork/script/smoke.ts <png> oc-2 light accounts` (also `accounts-add` and `accounts-pill`) signs in to alpha,
adds beta through the dialog and shoots the page.

### Live sync

`DynWorkSyncEngine.make` (`packages/gui/src/sync/engine.ts`, one per process, started by the accounts main entry) runs
one loop, for the active signed-in account only (decision D4), and pushes its content to DynWork's service through
`accounts/sync.ts` (`dynwork.sync/apply`, `token`, `clear`):

- Cadence: the first poll at once; then every 30 s ± 20 % while a DynWork window has focus, every 5 min while none
  has; at once when a window gains focus, when an account is activated and on `syncNow`. Polls never overlap: one asked
  for while another runs follows it once.
- Each poll reads the manifest with the last ETag (`If-None-Match`). Only `syncNow` ("Sync now") adds `Cache-Control:
no-cache`; polls, focus and activation let the instance answer from its memo, like the bridge's scheduled sync. The
  signature is checked against the pinned key, else the one offered at sign-in. A 200 is then accepted under the
  bridge's rules, and refused (`invalid`, ETag not kept) when it is another user's than the one `whoami` named at
  sign-in, when its `manifest_version` (`<RFC3339>-<hex>`, ordered by timestamp then suffix) is not strictly newer than
  the last one fully applied for that account (`replay`; persisted with the account, so it survives restarts), when it
  does not parse (`version`), or when its `not_before` is more than 5 min from now (`skew`). A 304 skips both checks:
  its stored manifest is as old as its first acceptance. `issued_at` is not checked, as in the bridge.
- The content the plugin reads is digested entry by entry (kind, id, digest of the entry, sorted), with the profile and
  the models catalog. `apply` runs only when that changes: a 304 or a re-signed copy of the same content pushes nothing.
  The plugin replaces the instance's whole namespace on each `apply` (design point 3: whole-namespace replace).
- The profile and the `/v1/models` catalog are read when the loop starts and again every 30 min; a failed read keeps
  the previous ones.
- Failures are statuses, never exceptions. `unreachable` and `rate-limited` back off 30 s, 1, 2, 4 min, capped at 5
  (at least the instance's `Retry-After`); `service` (DynWork's service did not take the call) retries after 2 s,
  doubling up to the poll interval; the others wait one poll interval. `key-changed` records the served key with
  `offerKey` and stops the loop, keeping what the service holds, until the user `trust`s that key.
- Switching to another account stops the previous loop, clears the service and syncs the new one at once; signing out
  clears it. The same account with a newly trusted key keeps its content until the next apply.
- Every JWT the accounts mint for the active account is pushed with `token` once. The plugin's `refresh` event is
  answered with `session(id)`, or with a fresh mint when the reason is `rejected`; `rejected` signs the account out.
  When the event stream ends (the service stopped or restarted), the engine follows it again after 1 s and applies the
  instance again; a `token` the plugin refuses means the same. Event handlers never throw.

Statuses, in `State.sync` and as the Ipc's `sync` event: `{status: "idle"}`, `{status: "syncing", account}`,
`{status: "synced", account, at, counts: {skills, agents, mcp, rules}}` and `{status: "error", account, kind, at}`, with
`kind` one of `unreachable`, `rate-limited`, `refused`, `key-changed`, `invalid`, `insecure` and `service`.
`bun test test/sync` in `packages/gui` drives the engine on fake timers against the fake instance.

## Demo views

Agents (Agent Farm), Routines (this Mac) and Brain are demo screens of the November 2026 vision: they run on built-in
data ported from the mockup, show a "Demo data" marker and make no network call, Ipc or service request. They open from
rows under New session in the vertical sidebar (after Home in the tabs drawer of a window under 768px, and as icons
after Search in the horizontal titlebar), on the
`/page/:id` route; the systemprompt row opens the real Settings page.

- Code: `packages/gui/src/views/` (one folder per view, its `demo.ts` holds the data), contract in its `README.md`.
- Host seam: the built-in slots `sidebar.nav` and `page` and `BuiltinLayout.page(id)` (see `PATCHES.md`).
- Remove them: drop `registerViews(ctx)` from `packages/gui/src/accounts/renderer.ts`.

## Local systemprompt instances

`bun dynwork/script/sp-local.ts up|seed|check|status|code|capture|down` runs two disposable systemprompt 0.76 instances in
Docker (alpha and beta, loopback only, seeded with a user, a PAT, an exchange code and content) so DynWork can be tested
against real servers without touching a Dynapps environment. Setup, what the image needs and the seeded content are in
`test/sp-local/README.md`; the generated secrets stay in the gitignored `test/sp-local/.env.local`. `capture` observes
the browser device link and writes the redacted `test/sp-local/fixtures/device-link.json`; the sign-in contract drawn
from it is `packages/sp-client/PROTOCOL.md`.

## End to end

```bash
bun dynwork/script/desktop.ts && bun dynwork/script/e2e-sp.ts [screenshot dir]
```

`e2e-sp.ts` runs the installed `/Applications/DynWork.app` in an isolated profile (the smoke's, from
`dynwork/script/desktop-profile.ts`) against the two local instances: `sp-local up/seed/check`; sign in to alpha with
its PAT on the sign-in screen; add beta in Settings with a one-time code from `admin bridge issue-code` (the
device-link page's paste flow; the browser link itself needs the instance's Entra login); alpha's skills, agents, MCP
servers, rule and gateway provider in DynWork's service, read through the service's HTTP API with the credentials of
the profile's registration; a skill created on alpha with the instance CLI appears within 60 s and leaves within 60 s
once deleted; switching to beta swaps the content within 5 s; a copy of the app moved into the profile starts, loads the
server plugin from its own `Contents/Resources` and syncs; signing out of both leaves nothing in the service; and no
PAT, JWT or code is in plaintext anywhere in the profile, the OpenCode database included. Each step prints what it
waited for and how long it took; screenshots go to the screenshot dir (default: the plan's `docs/e2e`).

The live-sync steps need a focused DynWork window (the sync polls every 30 s with focus, every 5 min without). macOS
does not activate an app a background process starts, so the run asks the main process, through its inspector on
`127.0.0.1` (this run only), to focus the window; when macOS refuses, main gets the focus event a click would give it
(the window reports focus and the app emits `browser-window-focus`), and the run says which happened. At the end it revokes the PATs DynWork
minted on the instances, deletes the skill it created, stops only what it started, deletes the profile and runs
`sp-local check` again. Port 17495 must be free: a DynWork already running its service makes the run fail early.

## Background service

The packaged prod build runs its own OpenCode background service (`opencode serve --service` from the CLI it bundles),
never the one OpenCode.app uses. `DynWorkService.layout` (`packages/gui/src/service.ts`) gives the desktop's
`background-service.ts` and `sidecar-probe.ts` (see `PATCHES.md`) everything that service keeps, all under
`<userData>/service`:

| What                                                                               | Where                                                                                  |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Registration file (url, pid, version, private password)                            | `state/opencode/service.json`, through `XDG_STATE_HOME=<userData>/service/state`       |
| Config dir (`OPENCODE_CONFIG_DIR`), also the service's own `service.json` settings | `config`                                                                               |
| Database (`OPENCODE_DB`)                                                           | `opencode.db`                                                                          |
| Port                                                                               | `127.0.0.1:17495` (`DynWorkIdentity.servicePort`, `0x4457`), never OpenCode's `0xC0DE` |

DynWork only looks for its service at that registration file, so it never adopts, stops or replaces OpenCode.app's
service, whatever its version, and OpenCode.app never finds DynWork's. Before the service starts, main drops every
`OPENCODE_CONFIG*` variable the login shell exported (`DynWorkService.isolate`), so the user's own OpenCode config
(`~/.config/opencode`, `OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT`) never configures it. `layout` takes an optional
config object merged into the service's `OPENCODE_CONFIG_CONTENT`, which always loads DynWork's server plugin from the
app's resources (see "Server plugin"). The other variables of the user's OpenCode setup that would steer the service
are dropped too (`DynWorkService.inherited`): `OPENCODE_CLI_CONFIG_CONTENT`, the console key `OPENCODE_API_KEY`, the
models catalog (`OPENCODE_MODELS_URL`, `OPENCODE_MODELS_PATH`, `OPENCODE_DISABLE_MODELS_FETCH`,
`OPENCODE_DISABLE_FREE_MODELS`), `OPENCODE_DB`, the server passwords, `OPENCODE_SIMULATE`, and the switches that change
which skills and project config it reads (`OPENCODE_DISABLE_PROJECT_CONFIG`, `OPENCODE_DISABLE_CLAUDE_CODE*`). Desktop's
own variables (`OPENCODE_DESKTOP_*`, `OPENCODE_DISABLE_EMBEDDED_WEB_UI`, `OPENCODE_CLIENT`), native helper paths,
logging and performance switches stay. Dev, beta and local builds keep upstream's shared service and load no plugin.

The service's data dir (`XDG_DATA_HOME`: logs, snapshots, worktrees, tool output, artifacts) is userData itself, so
its logs land in `<userData>/opencode/log`, where the desktop's debug-log export already looks. Since the data dir is
DynWork's own, a new DynWork database never imports OpenCode.app's legacy `auth.json` provider
keys. Still shared with OpenCode.app: the cache dir; the service also still reads skills from `~/.claude` and
`~/.agents`, like any OpenCode service. Shells the service runs get the user's own `XDG_STATE_HOME` and `XDG_DATA_HOME`
back (unset when the user had not set them): main passes them as `DYNWORK_SHELL_ENV` and the server plugin restores
them in its `shell` `create.before` hook, unless a session environment set its own value.

## Server plugin

`@dynwork/server-plugin` (`packages/server-plugin`, plugin id `dynwork`) gives DynWork's service the active instance's
content without writing anything but the rules block of the service's own global `AGENTS.md`. The prod build ships its
`package.json` and `src` as the extra resource `dynwork-server-plugin` next to the app archive, and
`DynWorkService.layout` adds that directory to the service's `OPENCODE_CONFIG_CONTENT` `plugins`. It imports only
`effect` and `@opencode/plugin/effect`, which the service provides, so the directory needs no dependencies.

Data flow: main (the sync engine, through `accounts/sync.ts`) verifies the manifest with `@dynwork/sp-client`, then
calls `POST /api/rpc/dynwork.sync/apply` on the sidecar endpoint with `{instance: {key, url}, manifest, jwt,
expiresAt}`, or `dynwork.sync/clear` on sign-out. The plugin maps the manifest once, keeps the result and the JWT in
process memory only, writes the rules into `AGENTS.md` (below), and rebuilds the skills, agents, MCP servers and models
of every Location it runs in before it answers with the counts. The service activates the plugin per Location and
re-imports it for each, so that state lives in one process-wide slot; the RPC reaches whichever Location main calls.
Each `apply` replaces everything of the previous instance and `clear` removes it, because the transforms rebuild from
the current state every time. `key` is a slug of the account label (`DynWorkSyncMain.key`): the prefix of every id, so
instance content never replaces the user's own items. A failed call reports only the HTTP status and the RPC error
type, never the service's message, which may quote the input.

| Manifest                               | OpenCode                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skills[]` with inline body            | `ctx.skill.transform`: embedded `Skill.Info` with id `<key>-<id>` and the virtual path `dynwork://<key>/skills/<id>`                                                                                                                                                                                                                                                                                           |
| `agents[]` (not disabled)              | `ctx.agent.transform`: sub-agent `<key>-<id>` with the display name, description and `system_prompt`. An agent whose `model` the gateway serves runs on `systemprompt/<model>`; any other uses the Session's model                                                                                                                                                                                             |
| `managed_mcp_servers[]`                | `ctx.mcp.transform`: remote server named from its `name` with the bridge's slug (lowercase, `[a-z0-9_]`, other runs to `-`; `dynbrain`, not `<key>-<id>`), `oauth: false`. Only a server on the instance's own origin gets `Authorization: Bearer <jwt>`; any other keeps its declared headers only, and plain HTTP is accepted only on loopback. A user server of the same name is replaced by the instance's |
| `rules[]`                              | A managed block in the service's global `AGENTS.md` (`<OPENCODE_CONFIG_DIR>/AGENTS.md`), described below                                                                                                                                                                                                                                                                                                       |
| `marketplaces[].opencode.cli_defaults` | `default_agent` (an instance agent) becomes the default agent and selectable as primary; `model` (`provider/model`) becomes the default model when the service has it                                                                                                                                                                                                                                          |

Entries are kept only when they target OpenCode (`hosts` empty or with `opencode`/`opencode-cli`, and the same for the
manifest's `enabled_hosts`, where an absent list is an empty one and clears the host, like the bridge; rules need an OpenCode host, see below), and only when their id is plain (`[A-Za-z0-9][A-Za-z0-9._-]*`, 64 at most). The mapping is
pure and total, since a transform that throws disables the whole plugin. Manifest plugins, commands and hooks are not
applied.

### Rules in AGENTS.md

The rules become the managed block of the global `AGENTS.md` in the service's config dir, which OpenCode loads into
every Session's instructions. The block is byte for byte the one the systemprompt bridge writes into OpenCode's
(`src/instructions.ts`, checked against a file the bridge wrote), markers included, so a block the bridge left is
replaced too:

```
<!-- systemprompt:begin (managed by the bridge; edits are replaced) -->

## <rule name>

<rule instructions, trimmed>

## <next rule name>

<its instructions>

<!-- systemprompt:end -->
```

Only rules whose `hosts` name `opencode` or `opencode-cli` are written (unlike skills, a rule with no `hosts` reaches no
host), sorted by id; a rule with empty instructions keeps its heading. The block is never cut: one over 24,000
characters, past which OpenCode stops reading, is written in full and logged as a warning. `apply` cuts any block out of
the file and appends the new one after what the user wrote, a switch replaces it and `clear` removes it; a file left
empty is deleted. The plugin writes through a temporary file and a rename, and only when the content changes, and a
failed write fails the `apply`, so main tries again. OpenCode watches the file and reloads it by itself about 100 ms
after the change (`apply` does not wait for that): a new Session starts with the current rules, and an open one hears
of the change at its next step, like any edit of `AGENTS.md`. With the service's file watcher off
(`OPENCODE_DISABLE_FILEWATCHER`), the change waits for the next start of the service.

The plugin writes only when `OPENCODE_CONFIG_DIR` is set, as `DynWorkService.layout` does for the packaged prod build,
whose config dir is DynWork's alone. A service without it reads the user's own config dir, which the plugin never
touches: there the rules go into the system context of each model call through `ctx.session.hook("context")` instead.
The block outlives the service process: a sign-out while the service is down leaves it in place until the next `apply`
or `clear`.

### Model calls through the gateway

With the user's `profile` (and the `models` catalog for names and sizes), `apply` also carries `gateway: {label,
models: [{id, name, api, context, output}], default}`; `DynWorkSyncMain.gateway` builds it from the ids the profile
admits, skipping providers the instance has not configured and entries the contract refuses. The plugin adds provider
`systemprompt` (`ctx.provider.transform`, `activation: "enabled"`, named after the account) with the instance's own model
ids, so a user's model choice survives syncs and switches. A model whose provider serves the `claude` client uses
`@opencode/ai/providers/anthropic-compatible` (`/v1/messages`), one served only to `openai` clients
`@opencode/ai/providers/openai-compatible` (`/v1/chat/completions`). The base URL is the account's URL plus `/v1`,
never the profile's `inference_gateway_base_url` (the instance's internal address), and plain HTTP only on loopback.
The profile's `default_model` (without a `[1m]`-style suffix) becomes the default model only while no default is set.

Each model also carries the client families its provider is served to (`clients`), and the manifest's
`host_model_protocols` entry for DynWork's host (`opencode`, else `opencode-cli`) keeps only the models served to one of
its families, on `/v1/messages` when `claude` is among them, else on `/v1/chat/completions`. Without an entry, like the
bridge (`HostClients::for_host`), OpenCode's own family `openai` is the filter, so models served only to Claude clients
(Claude Desktop's aliases) are not listed. Every call carries the families as `x-inference-protocol`, as the bridge's
provider headers do. Like the bridge's `policies` (deny `provider.use *`, allow `systemprompt`), while an instance with a
gateway is applied the same transform removes every other provider first, OpenCode's free one included, and every
provider reload runs it again, so a provider connected meanwhile is not offered either; `clear` brings them all back. An
apply without gateway models (no profile, or a filter that selects none) locks nothing. Providers declared in a config
file's `providers` table are added by OpenCode's config plugin, which runs after external plugins, so they stay.

The JWT is never part of the provider, a credential row or the database (decision T6). `ctx.session.hook("model.request",
…, {providerID: "systemprompt"})` adds `authorization: Bearer <jwt>` and `x-systemprompt-client: opencode` to every
call, drops any other `authorization` or `x-api-key`, and pins the base URL to the gateway, so a provider base URL
changed by the user's config never receives the JWT. Freshness:

- Main pushes each renewed JWT with `dynwork.sync/token {instance, jwt, expiresAt}`; the plugin refuses one for any
  instance other than the one applied (`{accepted: false}`), uses it from the next call on, and reconnects the
  instance's MCP servers with it.
- A JWT within 60 s of its expiry makes the call publish the RPC event `rpc.dynwork.sync.refresh {instance, reason:
"expired"}` and wait up to 15 s for a `token`; an expired JWT is never sent, the call goes without one instead.
- A `401` from the gateway runs through the `retry` hook: the step's first refusal publishes `refresh` with reason
  `rejected`, waits for a new JWT and retries at once, so the step does not fail. A refusal of that new JWT in the same
  step surfaces the error, drops the JWT (later calls carry none) and publishes `rpc.dynwork.sync.rejected
{instance}`, on which main signs the instance out.
- Main follows both events with `DynWorkSyncMain.make(...).listen(handlers, signal)` (`GET /api/event?types=…` on the
  sidecar); events published while nobody listens are lost and the call just gives up after its wait. On `rejected`
  reasons main must mint a new JWT rather than hand out its cached one.

## Patch guard

```bash
bun dynwork/script/patches.ts
```

Compares `HEAD` against the tag in `dynwork/UPSTREAM` (so commit first; the working tree is not read) and prints one
row per upstream file that differs, outside `dynwork/` and `plans/`. It exits 1 when a changed file has no row in
`PATCHES.md`, when a row lists a file that no longer differs, or when the modified upstream files change more lines than
the `Budget:` line of `PATCHES.md` allows. The tag must be in the clone (`git fetch upstream tag v2.2.5`). The `dynwork`
workflow (`.github/workflows/dynwork.yml`) runs it on every push and pull request to `main` and `sp-auth-sync`, with the
tests and typechecks of every `dynwork/packages/*`; upstream's own workflows are disabled on the fork.

## Syncing with upstream

```bash
bun dynwork/script/sync-upstream.ts <target-ref> [--report <path>] [--from <ref>] [--no-build] [--quick] [--keep]
```

The sync script (logic in `packages/build/src/sync.ts`) runs `git fetch upstream --tags`, adds a detached worktree of
`--from` (default `main`) under the system temp dir and runs `git rebase --onto <target-ref> $(cat dynwork/UPSTREAM)`
there. It never pushes, never moves a branch (the rebase runs on a detached HEAD with `rebase.updateRefs` off) and never
touches this checkout. On a conflict it records the conflicted files and the DynWork commit that hit them, then aborts.
On a clean rebase it writes the target to the worktree's `dynwork/UPSTREAM` (committed when the target is a tag, the
target's commit hash and uncommitted otherwise, so the guard measures the stack against its new base), installs with
the npmjs.org registry, and runs the patch guard, `bun run test` and `bun run typecheck` in every `dynwork/packages/*`,
the desktop typecheck and the desktop bundle (`electron-vite build`, nothing packed, installed or launched).

It prints a Markdown report, or writes it to `--report`: target, base, source, the per-step results with timings, the
output of failed steps, the patch guard table, the stack and the `git range-diff` of the old stack against the rebased
one. Exit codes: 0 green, 2 conflicts, 1 a check failed. `--no-build` skips the desktop bundle, `--quick` runs only the
rebase and the patch guard, `--no-fetch` skips the fetch, and `--keep` keeps the worktree, whose path is in the report;
otherwise it is removed.

Production follows upstream tags; any ref works for a rehearsal (`bun dynwork/script/sync-upstream.ts upstream/dev`).
When the report is green on a tag, the kept worktree's `HEAD` is the new `main`: review the range-diff, then move `main`
there by hand.

## Icons

`packages/branding/icons/source.svg` is the only hand-edited icon file: the Dynapps symbol (the gradient path of the
brand skill's `Dynapps_Logo_Vertical_Color_White.svg`) centered on a Midnight squircle in the macOS Big Sur grid. Every
other file in that folder is generated and committed. Regenerate them after changing the source:

```bash
cd dynwork/packages/branding
bun run icons
```

This needs `rsvg-convert` (`brew install librsvg`) and `iconutil` (macOS). Each size is rendered straight from the SVG,
so the output is deterministic and never downsampled.

## Logo

The wordmark follows the Dyncloud one (`cloud_theme/static/description/dyncloud.svg`): the word in lowercase, Readex Pro
SemiBold (600), no tracking and no kerning, one solid color, no symbol. Outlining "dyncloud" in each static Readex Pro
weight and fitting it to that SVG gives SemiBold at about 31.85 px with zero extra spacing between letters (glyph
positions within 0.01 px without kerning, 0.16 px off with it; `l` stem 4.52 px against 4.51 px).

`logo/wordmark.svg`, `logo/lockup.svg` and the letters in `src/outline.ts` were outlined once, outside the repo, from
`ReadexPro-SemiBold.ttf` (Readex Pro 1.204, OFL, from the `dynapps-brand` skill's fonts) with opentype.js 1.3.4 at
200 px, no kerning, one path per letter, moved to a tight `0 0 867 194` box (baseline at 148). The static font keeps
overlapping contours, which a stroked outline would show, so each letter went through Skia PathOps `simplify`
(pathkit-wasm 1.0.0) and was rounded to two decimals. Nothing reads the font at runtime. The lockup reuses the symbol
path and gradient of `icons/source.svg` at the proportions of `cloud_theme/static/img/login/dyncloud-logo.png`, whose
ascender is also 148 px: a 243.5 px symbol centred 190 px left of the "d" and 91.5 px below the ascender line.

The desktop build (`packages/build`) swaps three upstream modules for the components in `src/` (see `PATCHES.md`):

| Upstream                                        | DynWork                                                                                                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@opencode/ui/logo` `Mark`, `Splash`            | `src/logo.tsx`: the Dynapps symbol in its brand gradient (the pulsing startup splash, the side panel placeholder)                                       |
| `@opencode/ui/logo` `Logo`                      | `src/logo.tsx`: the wordmark in `--icon-base` (the error page)                                                                                          |
| `@opencode/ui/wordmark` `Wordmark`              | `src/wordmark.tsx`: the wordmark with upstream's outline, fade and muted modes (the first-launch splash draws it, the server connect screen)            |
| `new-session/wordmark.tsx` `NewSessionWordmark` | `src/new-session-wordmark.tsx`: the wordmark at rest, in the place and opacity of upstream's; the lodger, pin board and brick breaker easter egg is off |

Tailwind only scans upstream folders, so these components style themselves with SVG attributes, inline styles and
`src/wordmark.css`, never with utility classes of their own. The settings About page keeps upstream's animated OpenCode
wordmark.

## Build and install on macOS

Builds DynWork for Apple Silicon from this checkout and installs it as `/Applications/DynWork.app`. It needs the
workspace installed (`BUN_CONFIG_REGISTRY=https://registry.npmjs.org/ bun install`), Bun 1.4.4 and the Xcode command
line tools. The result is unsigned apart from an ad-hoc signature, so it only runs on the Mac that built it.

```bash
bun dynwork/script/desktop.ts
```

The script builds the CLI for this machine from `packages/cli` (release channel, version taken from
`packages/desktop/package.json`), builds the desktop app on the prod channel, swaps in
`dynwork/packages/branding/icons` before packing, signs ad hoc, clears quarantine and replaces
`/Applications/DynWork.app`. It never touches `/Applications/OpenCode.app`. A run takes about a minute.

To check the installed app, launch it in a throwaway profile:

```bash
bun dynwork/script/smoke.ts [screenshot] [theme-id] [light|dark] [view] [width] [--with-foreign-service]
```

The smoke test starts `/Applications/DynWork.app` with its own home, user data, XDG directories, database and config,
and none of your `OPENCODE_*` variables, so it never attaches to or restarts a running OpenCode service. DynWork's own
service runs inside that profile on its fixed port, so the smoke fails at once when a DynWork is already running. It
also exports an `OPENCODE_CONFIG_CONTENT` the way a login shell would and fails if DynWork's service loaded it.
`--with-foreign-service` first starts an `opencode serve --service` from this checkout, with another version string, at
the profile's default registration, as OpenCode.app's service would be; once DynWork is ready the smoke fails unless
that service still runs with the same pid and DynWork registered its own service under its userData. The output's
`service` key reports both. It waits for the window, optionally stores a theme id and color scheme
and reloads (for example `oc-2-deep dark`), saves a screenshot (by default to
`plans/done/2026-10-dynwork-pilot/docs/smoke.png`), prints the theme colors read from the page, then stops only the
processes it started and deletes the profile. It exits non-zero if the window never appears.

The view defaults to home, which stores the sign-in flag and reloads. `signin` shoots the sign-in screen at step 1,
`signin-choose` at step 2, `signin-finalizing` while it syncs and `signin-done` the app after it fades; each drives the
screen with the keyboard over CDP. A width in CSS pixels (for example `800`) shoots the window at that width.
`new-session` starts as a fresh install, which opens on the new session screen, signs in through the sign-in screen
and applies the theme live instead of reloading, since a reload would land on home. `first-launch` shoots the first-launch splash
once its wordmark has drawn, before any theme can be stored. A fresh install runs the first-launch onboarding, which
may create `Default Project` in your real `~/Documents` (Electron reads it from macOS, not from `HOME`).

Run the app normally from Finder. Its data lives in `~/Library/Application Support/es.dynapps.dynwork`, its background
service's in the `service` folder inside it (see "Background service"), so DynWork and OpenCode run side by side.
