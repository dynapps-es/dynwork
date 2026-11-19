export * as DriveMain from "./main"

import type { OpenCodeClient } from "@opencode/client/promise"
import type { MainContext } from "@opencode/plugin/gui/main"
import type { DynWorkAccounts } from "../accounts/accounts"
import { DriveAgent } from "./agent"
import { DriveBackend } from "./backend"
import { Drive } from "./contract"
import { DriveFrames } from "./frames"
import { DriveIpc } from "./ipc"
import { DriveMentions } from "./mentions"
import { DriveShare } from "./share"

export interface Options {
  /** What each account's instance has delivered; absent, nothing (`DriveCapabilities.none`). */
  capabilities?: DriveIpc.Options["capabilities"]
  timers?: DriveIpc.Timers
  /** Electron's app and windows, to keep the viewer's HTML frame on its page (`frames.ts`); the main entry passes them. */
  frames?: DriveFrames.Host
  /** DynWork's service, where the agent's `documents` tools run: its writes are followed (`DriveAgent`). Absent, none is. */
  client?: () => OpenCodeClient | undefined
  /** Whether a window is open to show a share's card (`DriveShare`); absent, none is, and the agent's shares are refused. */
  attended?: () => boolean
}

// The Drive's main side, set up by the `dynwork` built-in's main entry next to the routines: the `dynwork.drive` Ipc
// over the active account's Drive in Governance, with the account's JWT, which never reaches a window. Answers
// `account`, which main calls on every change of the accounts, and the service, for main code that writes to the
// Drive for a conversation. With the service's `client`, the agent's writes through the `documents` tools are followed:
// they enter the conversation's index and land in its folder (`DriveAgent`), a comment that asks for the agent
// (`@Agent`) wakes the conversation its document is linked to (`DriveMentions`), and each share waits on a card for the
// user's decision (`DriveShare`, the `dynwork.drive.shares` Ipc).
export function setup(ctx: MainContext, accounts: DynWorkAccounts.Accounts, options: Options = {}) {
  const provider = { changed: () => {} }
  const service = DriveIpc.make({
    account: () => {
      const active = accounts.list().find((account) => account.active && account.status === "signedIn")
      if (!active) return undefined
      return {
        id: active.id,
        user: active.user ?? active.label,
        url: active.url,
        userId: accounts.stored(active.id)?.userId,
      }
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
  if (options.frames) ctx.onCleanup(DriveFrames.guard(options.frames))
  if (options.client) {
    DriveAgent.setup(ctx, { service, client: options.client, untitled: ctx.t("drive.chat.untitled") })
    DriveMentions.setup(ctx, { service, client: options.client })
    DriveShare.setup(ctx, { service, client: options.client, attended: options.attended ?? (() => false) })
  }
  const ipc = ctx.provide(Drive, service.ipc)
  provider.changed = () => ipc.changed()
  return service
}
