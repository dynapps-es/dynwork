import { DynWorkOutline } from "@dynwork/branding/outline"
import { For } from "solid-js"
import "./brand.css"

/**
 * The foot of the vertical sidebar: the Dynapps aperture and the "dynwork" wordmark, as DynWork Mobile's sidebar draws
 * them. Both take the sidebar's text color, so the mark is dark on a light theme and light on a dark one.
 */
export function SidebarBrand() {
  return (
    <div data-component="dynwork-sidebar-brand" role="img" aria-label="Dynwork">
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
    </div>
  )
}
