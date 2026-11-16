import type { DynWorkIdentity } from "@dynwork/branding/identity"

/** The pill that names a channel other than internal, which is DynWork as it ships and shows none. */
export function channelPill(channel: DynWorkIdentity.Channel, t: (key: string) => string) {
  if (channel === "internal") return undefined
  return t(`views.channel.${channel}`)
}
