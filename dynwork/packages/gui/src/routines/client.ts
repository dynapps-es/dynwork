export * as RoutinesClient from "./client"

import { createSignal, onCleanup, type Accessor } from "solid-js"
import type { IpcClient, Live } from "@opencode/plugin/gui"
import type { Chat, Routines } from "./contract"

export type Client = IpcClient<(typeof Routines)["spec"]>

// The views render outside the plugin host's setup, so they cannot `ctx.use` the Ipc themselves. The window entry hands
// over the live client: `connection()` is the Ipc's `Live` state while this window's entry runs, else undefined.
const [current, setCurrent] = createSignal<Accessor<Live<Client>>>()

export const connection = () => current()?.()

/** Makes `live` the connection until the current owner is disposed. */
export function attach(live: Accessor<Live<Client>>) {
  setCurrent(() => live)
  onCleanup(() => {
    if (current() === live) setCurrent(undefined)
  })
}

export type ChatClient = IpcClient<(typeof Chat)["spec"]>

// The chat's cards (`./chat`), handed over the same way.
const [chat, setChat] = createSignal<Accessor<Live<ChatClient>>>()

export const chatConnection = () => chat()?.()

/** Makes `live` the chat's connection until the current owner is disposed. */
export function attachChat(live: Accessor<Live<ChatClient>>) {
  setChat(() => live)
  onCleanup(() => {
    if (chat() === live) setChat(undefined)
  })
}
