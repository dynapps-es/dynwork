export * as DriveMain from "./main"

import type { MainContext } from "@opencode/plugin/gui/main"
import type { DynWorkAccounts } from "../accounts/accounts"
import { DriveBackend } from "./backend"
import { Drive } from "./contract"
import { DriveIpc } from "./ipc"

export interface Options {
  /** What each account's instance has delivered; absent, nothing (`DriveCapabilities.none`). */
  capabilities?: DriveIpc.Options["capabilities"]
  timers?: DriveIpc.Timers
}

// The Drive's main side, set up by the `dynwork` built-in's main entry next to the routines: the `dynwork.drive` Ipc
// over the active account's Drive in Governance, with the account's JWT, which never reaches a window. Answers
// `account`, which main calls on every change of the accounts, and the service, for main code that writes to the
// Drive for a conversation (the agent's files, phase 07).
export function setup(ctx: MainContext, accounts: DynWorkAccounts.Accounts, options: Options = {}) {
  const provider = { changed: () => {} }
  const service = DriveIpc.make({
    account: () => {
      const active = accounts.list().find((account) => account.active && account.status === "signedIn")
      if (!active) return undefined
      return { id: active.id, user: active.user ?? active.label, url: active.url }
    },
    backend: (account) =>
      DriveBackend.remote({
        url: account.url,
        user: accounts.stored(account.id)?.userId,
        withJwt: (use) => accounts.withJwt(account.id, use),
      }),
    store: ctx.storage.store("drive", { schema: DriveIpc.Saved, initial: DriveIpc.initial }),
    changed: () => provider.changed(),
    capabilities: options.capabilities,
    timers: options.timers,
  })
  ctx.onCleanup(service.dispose)
  const ipc = ctx.provide(Drive, service.ipc)
  provider.changed = () => ipc.changed()
  return service
}
