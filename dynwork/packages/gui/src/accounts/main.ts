import { hostname } from "node:os"
import { safeStorage, shell } from "electron"
import type { Plugin } from "@opencode/plugin/gui/main"
import { DynWorkAccounts } from "./accounts"
import { Accounts } from "./contract"
import { AccountsIpc } from "./ipc"

const setup: Plugin.MainSetup = (ctx) => {
  const provider: { changed: () => void } = { changed: () => {} }
  const accounts = DynWorkAccounts.make({
    store: ctx.storage.store("accounts", { schema: DynWorkAccounts.Store, initial: DynWorkAccounts.initial }),
    secure: safeStorage,
    open: (url) => shell.openExternal(url),
    deviceName: `DynWork on ${hostname()}`,
    changed: () => provider.changed(),
  })
  ctx.onCleanup(accounts.dispose)

  const ipc = ctx.provide(Accounts, AccountsIpc.implementation(accounts))
  provider.changed = () => ipc.changed()
}

export default setup
