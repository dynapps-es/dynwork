# @dynwork/gui

DynWork's desktop features as GUI plugin code, composed into the `dynwork` built-in of `packages/gui-plugins` (the only
two upstream lines that name it). Main entry: `src/accounts/main.ts`; window entry: `src/accounts/renderer.ts`.

| Directory        | What it is                                                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/accounts`   | systemprompt accounts in main (PATs sealed, JWTs in memory), the `dynwork.accounts` Ipc, the Accounts settings page and the titlebar pill    |
| `src/sync`       | the sync engine that pulls the active instance's manifest into DynWork's service                                                             |
| `src/signin`     | the sign-in gate shown until an instance is active                                                                                           |
| `src/remote`     | Remote control: the tunnel to the relay, the proxy and its allowlist, the `dynwork.remote` Ipc, the settings page and the titlebar indicator |
| `src/service.ts` | DynWork's own OpenCode service layout (prod), and its port (`DYNWORK_SERVICE_PORT` for isolated runs)                                        |

## Remote control (`src/remote`)

| File           | Role                                                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `allowlist.ts` | The data: one rule per allowed request family, with examples; the headers passed each way                                               |
| `proxy.ts`     | The `Mux.Handler` for a phone: allowlist, then DynWork's service with the tunnel's OpenCode session token; 403/413/502/503 otherwise    |
| `tunnel.ts`    | The controller: toggle, active account, relay socket and reconnects, `Remote.Desktop`, pairing, presence, revoke, the state windows see |
| `relay.ts`     | The relay's desktop routes: `POST /pairings`, `GET /devices`, `DELETE /devices/{id}`                                                    |
| `store.ts`     | What persists, the used-token ledger and the connection log                                                                             |
| `contract.ts`  | The `dynwork.remote` Ipc                                                                                                                |
| `main.ts`      | Electron wiring: storage, `safeStorage`, `ServerEndpoints`, Node's WebSocket                                                            |
| `ui/`          | The settings page, the pairing dialog and the titlebar indicator                                                                        |

Windows never receive a key, a JWT, a credential, the service password or the session token; only the QR while it is
shown. `test/remote` runs the tunnel against a fake relay and a fake OpenCode service, and checks no secret reaches the
log or a window.

## Tests

`bun test` from this directory (`test/remote` for Remote control); `bun typecheck`.
