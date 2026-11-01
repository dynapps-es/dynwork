import { createUniqueId, For, type ComponentProps } from "solid-js"
import { DynWorkOutline } from "./outline"

// Replaces @opencode/ui/logo in the desktop build (see dynwork/PATCHES.md), so every export keeps upstream's name and
// props. The marks show the Dynapps symbol in its brand gradient; the logo is the "dynwork" wordmark in the icon color.

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox={DynWorkOutline.symbol.viewBox}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <Aperture />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox={DynWorkOutline.symbol.viewBox}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <Aperture />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${DynWorkOutline.wordmark.width} ${DynWorkOutline.wordmark.height}`}
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g fill="var(--icon-base)">
        <For each={DynWorkOutline.wordmark.letters}>{(letter) => <path d={letter} />}</For>
      </g>
    </svg>
  )
}

// Gradient ids are document-wide, so each mark on the page needs its own.
function Aperture() {
  const gradient = createUniqueId()

  return (
    <>
      <path d={DynWorkOutline.symbol.path} fill={`url(#${gradient})`} />
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
    </>
  )
}
