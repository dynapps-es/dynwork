import { DynWorkIdentity } from "@dynwork/branding/identity"
import { hostname } from "node:os"
import { app, Notification, powerMonitor, safeStorage, shell } from "electron"
import type { Plugin } from "@opencode/plugin/gui/main"
import { RemoteMain } from "../remote/main"
import { RoutinesFarm } from "../routines/farm/backend"
import { RoutinesMain } from "../routines/main"
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
  // The routines' clock looks again whenever the sync changes: it fires nothing until the provider is applied.
  // `applied` holds once a sync went through, until the account goes: a failed poll later keeps the provider applied.
  const routines: { check: () => void; applied: boolean } = { check: () => {}, applied: false }
  const accounts = DynWorkAccounts.make({
    store: ctx.storage.store("accounts", { schema: DynWorkAccounts.Store, initial: DynWorkAccounts.initial }),
    secure: safeStorage,
    open: (url) => shell.openExternal(url),
    deviceName: `${DynWorkIdentity.name} on ${hostname()}`,
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
      if (status.status === "synced") routines.applied = true
      if (status.status === "idle") routines.applied = false
      routines.check()
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

  // Routines: the registry of backends, local and remote, and the `dynwork.routines` Ipc over it. A local run that
  // fails is told with a system notification, which shows with no window open; nothing else notifies.
  // Scheduled runs wait for the Governance provider; without an account there is nothing to wait for. Waking the
  // computer has the clock catch up at once.
  routines.check = RoutinesMain.setup(ctx, {
    label: hostname().replace(/\.local$/, ""),
    farm: RoutinesFarm.enabled(process.env),
    failed: (run, routine) => {
      if (!Notification.isSupported()) return
      new Notification({ title: `${routine.name} failed`, body: run.title }).show()
    },
    ready: () => routines.applied || sync.status().status === "idle",
  }).check
  const wake = () => routines.check()
  powerMonitor.on("resume", wake)
  ctx.onCleanup(() => void powerMonitor.off("resume", wake))

  const ipc = ctx.provide(Accounts, AccountsIpc.implementation(accounts, sync))
  provider.changed = () => ipc.changed()
  provider.emit = (status) => ipc.emit("sync", status)
}

export default setup
