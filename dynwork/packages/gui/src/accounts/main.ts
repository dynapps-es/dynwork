import { DynWorkIdentity } from "@dynwork/branding/identity"
import { homedir, hostname } from "node:os"
import { app, Notification, powerMonitor, powerSaveBlocker, safeStorage, shell } from "electron"
import type { Plugin } from "@opencode/plugin/gui/main"
import { ChatsMain } from "../chats/main"
import { RemoteMain } from "../remote/main"
import { RoutinesChat } from "../routines/chat"
import { RoutinesFarm } from "../routines/farm/backend"
import { RoutinesMain } from "../routines/main"
import { DynWorkSyncEngine } from "../sync/engine"
import { DynWorkHeartbeat } from "../sync/heartbeat"
import { DynWorkRuntime } from "../sync/runtime"
import { SidebarGlass } from "../views/glass/glass"
import { DynWorkAccounts } from "./accounts"
import { Accounts, type SyncStatus } from "./contract"
import { AccountsIpc } from "./ipc"
import { DynWorkSyncMain } from "./sync"

const setup: Plugin.MainSetup = (ctx) => {
  // macOS 26 and later: AppKit's sidebar glass behind the windows, as Claude desktop has it.
  SidebarGlass.setup(ctx)

  const provider: { changed: () => void; emit: (status: SyncStatus) => void } = {
    changed: () => {},
    emit: () => {},
  }
  const engine: { current?: DynWorkSyncEngine.Engine } = {}
  const remote: { update: () => void } = { update: () => {} }
  const chats: { update: () => void } = { update: () => {} }
  // The routines' clock looks again whenever the sync changes: it fires nothing until the provider is applied.
  // `applied` holds once a sync went through, until the account goes: a failed poll later keeps the provider applied.
  const routines: { check: () => void; pull: () => void; applied: boolean } = {
    check: () => {},
    pull: () => {},
    applied: false,
  }
  const accounts = DynWorkAccounts.make({
    store: ctx.storage.store("accounts", { schema: DynWorkAccounts.Store, initial: DynWorkAccounts.initial }),
    secure: safeStorage,
    open: (url) => shell.openExternal(url),
    deviceName: `${DynWorkIdentity.name} on ${hostname()}`,
    changed: () => {
      provider.changed()
      engine.current?.update()
      remote.update()
      routines.pull()
      chats.update()
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
  const follow = () =>
    setImmediate(() => {
      sync.focus(focused())
      cloud.focus(focused())
    })
  app.on("browser-window-focus", follow)
  app.on("browser-window-blur", follow)
  ctx.onCleanup(() => {
    app.off("browser-window-focus", follow)
    app.off("browser-window-blur", follow)
  })

  // Remote control follows the active account: switching it moves the tunnel, signing out stops it
  const tunnel = RemoteMain.setup(ctx, accounts)
  remote.update = tunnel.update

  // Cloud chats: threads stored and answered on the active instance. Another device changed one: the instance's hint
  // arrives over the relay while remote control is connected; without it the list is read every 30 s with focus.
  const cloud = ChatsMain.setup(ctx, { accounts, focused: focused() })
  chats.update = cloud.update
  ctx.onCleanup(
    tunnel.onControl((message) => {
      if (message.t === "chats.changed") cloud.pull()
    }),
  )

  // Routines: the registry of backends, local and remote, and the `dynwork.routines` Ipc over it. A local run that
  // finishes, fails or waits for a permission is told with a system notification, as its routine says; it shows with
  // no window open, and clicking it opens the run. The computer stays awake while a run is going.
  const notices = new Set<Notification>()
  const awake: { blocker?: number } = {}
  // Scheduled runs wait for the Governance provider; without an account there is nothing to wait for. Waking the
  // computer has the clock catch up at once.
  const label = hostname().replace(/\.local$/, "")
  const routinesMain = RoutinesMain.setup(ctx, {
    label,
    farm: RoutinesFarm.enabled(process.env),
    demo: DynWorkIdentity.channel === "dev",
    notify: (notice) => {
      if (!Notification.isSupported()) return
      const shown = new Notification(RoutinesMain.words(notice, ctx.t))
      // Held until it is clicked or closed: a notification nobody refers to may be collected before the click.
      notices.add(shown)
      shown.on("click", notice.open)
      shown.on("close", () => void notices.delete(shown))
      shown.show()
    },
    busy: (going) => {
      if (going && awake.blocker === undefined) awake.blocker = powerSaveBlocker.start("prevent-app-suspension")
      if (going || awake.blocker === undefined) return
      powerSaveBlocker.stop(awake.blocker)
      awake.blocker = undefined
    },
    ready: () => routines.applied || sync.status().status === "idle",
    // Definitions sync with the active account's Governance. This computer is its relay peer id, kept whether or not
    // remote control is on, and its name.
    sync: {
      account: () => {
        const active = accounts.list().find((account) => account.active && account.status === "signedIn")
        if (!active) return undefined
        return { id: active.id, url: active.url, token: async () => (await accounts.session(active.id)).token }
      },
      device: () => {
        const peer = tunnel.peer()
        return peer ? { id: peer, name: label } : undefined
      },
    },
  })
  // Routines from a chat: the routines tools' proposals, their cards and Schedule, over the same registry.
  RoutinesChat.setup(ctx, {
    registry: routinesMain.registry,
    farm: RoutinesFarm.enabled(process.env),
    client: routinesMain.client,
    act: routinesMain.act,
    server: RoutinesMain.SERVER,
    home: homedir(),
  })
  routines.check = routinesMain.check
  routines.pull = routinesMain.pull
  // Another computer changed a routine: Governance's hint arrives over the relay while remote control is connected.
  // Without it the sync still reads the feed every few minutes.
  ctx.onCleanup(
    tunnel.onControl((message) => {
      if (message.t === "routines.changed") routines.pull()
    }),
  )
  ctx.onCleanup(() => {
    if (awake.blocker !== undefined) powerSaveBlocker.stop(awake.blocker)
  })
  const wake = () => {
    routines.check()
    routines.pull()
  }
  powerMonitor.on("resume", wake)
  ctx.onCleanup(() => void powerMonitor.off("resume", wake))

  const ipc = ctx.provide(Accounts, AccountsIpc.implementation(accounts, sync))
  provider.changed = () => ipc.changed()
  provider.emit = (status) => ipc.emit("sync", status)
}

export default setup
