import { DynWorkIdentity } from "@dynwork/branding/identity"
import { DynWorkOutline } from "@dynwork/branding/outline"
import { usePlugin } from "@opencode/plugin/gui"
import { For, Show } from "solid-js"
import { channelPill } from "./channel"
import "./brand.css"

/**
 * The foot of the vertical sidebar: the Dynapps aperture and the "dynwork" wordmark, as DynWork Mobile's sidebar draws
 * them. Both take the sidebar's text color, so the mark is dark on a light theme and light on a dark one. A channel
 * other than internal adds a pill that names it, so two installs side by side are told apart.
 */
export function SidebarBrand() {
  const ctx = usePlugin()
  const pill = () => channelPill(DynWorkIdentity.channel, (key) => ctx.t(key))

  return (
    <div data-component="dynwork-sidebar-brand" role="img" aria-label={DynWorkIdentity.name}>
      <svg data-slot="dynwork-brand-symbol" viewBox={DynWorkOutline.symbol.viewBox} aria-hidden="true">
        <path d={DynWorkOutline.symbol.path} />
      </svg>
      <svg
        data-slot="dynwork-brand-wordmark"
        viewBox={`0 0 ${DynWorkOutline.wordmark.width} ${DynWorkOutline.wordmark.height}`}
        aria-hidden="true"
      >
        <For each={DynWorkOutline.wordmark.letters}>{(letter) => <path d={letter} />}</For>
      </svg>
      <Show when={pill()}>
        <span data-slot="dynwork-brand-channel">{pill()}</span>
      </Show>
    </div>
  )
}
