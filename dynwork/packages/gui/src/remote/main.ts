export * as RemoteMain from "./main"

import { safeStorage } from "electron"
import type { MainContext } from "@opencode/plugin/gui/main"
import { Remote } from "./contract"
import { RemoteStore } from "./store"
import { RemoteTunnel } from "./tunnel"

// SAFETY: Node's WebSocket (undici) in Electron's main process takes request headers in its second argument, as Bun's
// does; the DOM type in this package's lib only knows subprotocols there.
const HeaderWebSocket = WebSocket as unknown as new (
  url: string,
  init: { headers: Record<string, string> },
) => WebSocket

// Remote control's main side, set up by the `dynwork` built-in's main entry next to the accounts: the tunnel, its
// store, and the `dynwork.remote` Ipc. The tunnel targets whatever `ServerEndpoints` resolves as the app's own server.
export function setup(ctx: MainContext, accounts: RemoteTunnel.Accounts) {
  const provider = { changed: () => {} }
  const tunnel = RemoteTunnel.make({
    store: ctx.storage.store("remote", { schema: RemoteStore.Store, initial: RemoteStore.initial }),
    accounts,
    secure: safeStorage,
    endpoint: () => ctx.serverEndpoints.get("sidecar"),
    socket: (url, headers) => new HeaderWebSocket(url, { headers }),
    log: (level, message, data) => ctx.log.write(level, message, data),
    changed: () => provider.changed(),
  })
  ctx.onCleanup(tunnel.dispose)
  const ipc = ctx.provide(Remote, {
    state: () => tunnel.state(),
    setEnabled: (enabled) => tunnel.setEnabled(enabled),
    pair: () => tunnel.pair(),
    cancelPairing: () => tunnel.cancelPairing(),
    revoke: (id) => tunnel.revoke(id),
  })
  provider.changed = () => ipc.changed()
  tunnel.update()
  return tunnel
}
