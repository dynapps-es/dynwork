import { createUniqueId, For, type ComponentProps } from "solid-js"
import { DynWorkOutline } from "./outline"
import "./lockup.css"

// The DynWork lockup: the Dynapps symbol in its brand gradient left of the "dynwork" wordmark, drawn like
// logo/lockup.svg. The letters are Dynapps ink in light and white in dark (lockup.css), whatever the theme.
export function Lockup(props: Pick<ComponentProps<"svg">, "class">) {
  const gradient = createUniqueId()

  return (
    <svg
      data-component="dynwork-lockup"
      role="img"
      aria-label="Dynwork"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox={`0 0 ${DynWorkOutline.lockup.width} ${DynWorkOutline.lockup.height}`}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g transform={DynWorkOutline.lockup.symbol}>
        <path d={DynWorkOutline.symbol.path} fill={`url(#${gradient})`} />
      </g>
      <g data-slot="dynwork-lockup-letters" transform={DynWorkOutline.lockup.wordmark}>
        <For each={DynWorkOutline.wordmark.letters}>{(letter) => <path d={letter} />}</For>
      </g>
      <defs>
        <linearGradient
          id={gradient}
          x1={DynWorkOutline.symbol.gradient.x1}
          y1={DynWorkOutline.symbol.gradient.y1}
          x2={DynWorkOutline.symbol.gradient.x2}
          y2={DynWorkOutline.symbol.gradient.y2}
          gradientUnits="userSpaceOnUse"
        >
          <For each={DynWorkOutline.symbol.stops}>
            {(stop) => <stop offset={stop.offset} stop-color={stop.color} />}
          </For>
        </linearGradient>
      </defs>
    </svg>
  )
}
