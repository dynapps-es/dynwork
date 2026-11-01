import { hostname } from "node:os"
import { safeStorage, shell } from "electron"
import type { Plugin } from "@opencode/plugin/gui/main"
import { DynWorkAccounts } from "./accounts"
import { Accounts } from "./contract"

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

  const ipc = ctx.provide(Accounts, {
    state: () => accounts.state(),
    list: () => accounts.list(),
    add: (url) => accounts.add(url),
    probe: (url) => accounts.probe(url),
    signInBrowser: (url, caller) => accounts.signInBrowser(url, caller.signal),
    signInToken: (input) => accounts.signInToken(input),
    cancel: () => accounts.cancel(),
    activate: (id) => accounts.activate(id),
    signOut: (id) => accounts.signOut(id),
    remove: (id) => accounts.remove(id),
    trust: (input) => accounts.trust(input),
  })
  provider.changed = () => ipc.changed()
}

export default setup
