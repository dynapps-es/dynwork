import { hostname } from "node:os"
import { app, safeStorage, shell } from "electron"
import type { Plugin } from "@opencode/plugin/gui/main"
import { RemoteMain } from "../remote/main"
import { DynWorkSyncEngine } from "../sync/engine"
import { DynWorkHeartbeat } from "../sync/heartbeat"
import { DynWorkRuntime } from "../sync/runtime"
import { DynWorkAccounts } from "./accounts"
import { Accounts, type SyncStatus } from "./contract"
import { AccountsIpc } from "./ipc"
import { DynWorkSyncMain } from "./sync"

const setup: Plugin.MainSetup = (ctx) => {
  const provider: { changed: () => void; emit: (status: SyncStatus) => void } = {
    changed: () => {},
    emit: () => {},
  }
  const engine: { current?: DynWorkSyncEngine.Engine } = {}
  const remote: { update: () => void } = { update: () => {} }
  const accounts = DynWorkAccounts.make({
    store: ctx.storage.store("accounts", { schema: DynWorkAccounts.Store, initial: DynWorkAccounts.initial }),
    secure: safeStorage,
    open: (url) => shell.openExternal(url),
    deviceName: `DynWork on ${hostname()}`,
    changed: () => {
      provider.changed()
      engine.current?.update()
      remote.update()
    },
    renewed: (id, session) => engine.current?.renewed(id, session),
  })
  ctx.onCleanup(accounts.dispose)

  const focused = () => ctx.windows.list().some((window) => window.isFocused())
  const plugin = DynWorkSyncMain.make(ctx.serverEndpoints)
  const sync = DynWorkSyncEngine.make({
    accounts,
    plugin,
    runtime: DynWorkRuntime.make({ accounts, plugin }),
    focused: focused(),
    changed: (status) => {
      provider.changed()
      provider.emit(status)
    },
  })
  engine.current = sync
  ctx.onCleanup(sync.dispose)

  const heartbeat = DynWorkHeartbeat.make({
    accounts,
    plugin,
    version: app.getVersion(),
    hostname: hostname(),
    platform: process.platform,
    log: (level, message, data) => ctx.log.write(level, message, data),
  })
  ctx.onCleanup(heartbeat.dispose)

  // Moving focus between two DynWork windows blurs one before it focuses the other: read it once both have run.
  const follow = () => setImmediate(() => sync.focus(focused()))
  app.on("browser-window-focus", follow)
  app.on("browser-window-blur", follow)
  ctx.onCleanup(() => {
    app.off("browser-window-focus", follow)
    app.off("browser-window-blur", follow)
  })

  // Remote control follows the active account: switching it moves the tunnel, signing out stops it
  remote.update = RemoteMain.setup(ctx, accounts).update

  const ipc = ctx.provide(Accounts, AccountsIpc.implementation(accounts, sync))
  provider.changed = () => ipc.changed()
  provider.emit = (status) => ipc.emit("sync", status)
}

export default setup
