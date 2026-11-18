export * as ChatsMain from "./main"

import type { MainContext } from "@opencode/plugin/gui/main"
import { ChatsClient } from "./client"
import { Chats } from "./contract"
import { ChatsIpc } from "./ipc"
import { ChatsSync } from "./sync"

/** What the chats need of the accounts: the active one and its session, renewed as needed. */
export interface Accounts {
  list: () => readonly { id: string; url: string; status: "signedIn" | "signedOut"; active: boolean }[]
  session: (id: string, fresh?: boolean) => Promise<{ token: string }>
}

export interface Options {
  accounts: Accounts
  /** Whether a DynWork window has focus now. */
  focused: boolean
  fetch?: ChatsClient.Fetch
}

// The chats' main side, set up by the `dynwork` built-in's main entry next to the accounts: the instance's client, the
// list kept in step with it and the `dynwork.chats` Ipc over both. Main calls `update` when the accounts change,
// `focus` when focus moves between windows, and `pull` on the relay's `chats.changed` hint.
export function setup(ctx: MainContext, options: Options) {
  const active = () => options.accounts.list().find((account) => account.active && account.status === "signedIn")
  const client = ChatsClient.make({
    fetch: options.fetch,
    account: () => {
      const account = active()
      if (!account) return undefined
      return {
        id: account.id,
        url: account.url,
        token: async (fresh) => (await options.accounts.session(account.id, fresh)).token,
      }
    },
  })
  const provider = { changed: () => {}, event: (_: Parameters<ChatsIpc.Notify["event"]>[0]) => {} }
  const sync = ChatsSync.make({
    client,
    account: () => active()?.id,
    changed: () => provider.changed(),
    focused: options.focused,
  })
  ctx.onCleanup(sync.dispose)
  const ipc = ctx.provide(Chats, ChatsIpc.implementation(client, sync, { event: (event) => provider.event(event) }))
  provider.changed = () => ipc.changed()
  provider.event = (event) => ipc.emit("event", event)
  void sync.pull()
  return { update: () => void sync.pull(), pull: () => void sync.pull(), focus: sync.focus }
}
