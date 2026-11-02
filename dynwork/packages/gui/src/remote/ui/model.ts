export * as RemoteModel from "./model"

import type { State } from "../contract"

/** The titlebar indicator: shown only while a paired phone is connected. */
export function indicator(state: State) {
  const online = state.phones.filter((phone) => phone.online)
  if (!state.enabled || state.status !== "connected" || online.length === 0) return undefined
  return { count: online.length, name: online[0]!.name }
}

/** The status line's copy key. */
export function statusKey(state: State) {
  if (state.status === "error") return `remote.status.error.${state.failure ?? "offline"}`
  return `remote.status.${state.status}`
}

/** Whether the toggle must ask first: turning it on before the user ever confirmed. */
export function asks(state: State, enabled: boolean) {
  return enabled && !state.confirmed
}
