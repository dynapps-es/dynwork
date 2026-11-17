export * as ChatsBackend from "./backend"

import { createSignal, onCleanup, type Accessor } from "solid-js"
import type { IpcClient, Live } from "@opencode/plugin/gui"
import type { Chats } from "./contract"

// The window's side of the chats: the live `dynwork.chats` Ipc client. The views render outside the plugin host's
// setup, so they cannot `ctx.use` the Ipc themselves; the window entry hands it over (`attach`) and the views read
// `connection()`. Everything a view does goes through it: the window never reaches the instance, holds no credential
// and never reaches OpenCode.

export type Client = IpcClient<(typeof Chats)["spec"]>

const [current, setCurrent] = createSignal<Accessor<Live<Client>>>()

/** The Ipc's `Live` state while this window's entry runs, else undefined. */
export const connection = () => current()?.()

/** The client while the Ipc is up. */
export const client = () => {
  const live = connection()
  return live?.status === "active" ? live.value : undefined
}

/** Makes `live` the connection until the current owner is disposed. */
export function attach(live: Accessor<Live<Client>>) {
  setCurrent(() => live)
  onCleanup(() => {
    if (current() === live) setCurrent(undefined)
  })
}
