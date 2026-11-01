import { createUniqueId, For, type ComponentProps } from "solid-js"
import { DynWorkOutline } from "./outline"
import "./wordmark.css"

// Replaces @opencode/ui/wordmark in the desktop build (see dynwork/PATCHES.md) with the same props and layers. The
// first-launch splash draws the outline through CSS on every `path` (pathLength 1), so the letters stay the only paths.
// With a non-scaling stroke Chromium lays that one-unit dash out in CSS pixels, so a wordmark drawn larger than its
// viewBox units stops short of closing each letter; the 867-unit box keeps the splash (576 px at most) below that.
// Tailwind does not scan dynwork/, so styling uses SVG attributes and wordmark.css instead of utility classes.
export function Wordmark(
  props: Pick<ComponentProps<"svg">, "class"> & { fade?: boolean; muted?: boolean; outline?: boolean },
) {
  const mask = createUniqueId()
  const maskGradient = createUniqueId()

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${DynWorkOutline.wordmark.width} ${DynWorkOutline.wordmark.height}`}
      fill="none"
      overflow={props.outline ? "visible" : undefined}
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g data-slot="dynwork-wordmark-muted" opacity={props.muted === false ? 1 : 0.6}>
        <g mask={props.fade === false ? undefined : `url(#${mask})`}>
          <g
            opacity={props.muted === false ? 1 : 0.16 * 0.7}
            fill={props.outline ? "none" : "currentColor"}
            stroke={props.outline ? "currentColor" : undefined}
            stroke-width={props.outline ? 1 : undefined}
          >
            <For each={DynWorkOutline.wordmark.letters}>
              {(letter) => (
                <path
                  pathLength={props.outline ? 1 : undefined}
                  vector-effect={props.outline ? "non-scaling-stroke" : undefined}
                  d={letter}
                />
              )}
            </For>
          </g>
        </g>
      </g>
      <defs>
        <mask
          id={mask}
          style="mask-type:alpha"
          maskUnits="userSpaceOnUse"
          x="0"
          y="0"
          width={DynWorkOutline.wordmark.width}
          height={DynWorkOutline.wordmark.height}
        >
          <rect
            width={DynWorkOutline.wordmark.width}
            height={DynWorkOutline.wordmark.height}
            fill={`url(#${maskGradient})`}
          />
        </mask>
        {/* Upstream fades from 68 of its 129 units to the bottom edge; this keeps the same share of the height. */}
        <linearGradient
          id={maskGradient}
          x1={DynWorkOutline.wordmark.width / 2}
          y1={(DynWorkOutline.wordmark.height * 68) / 129}
          x2={DynWorkOutline.wordmark.width / 2}
          y2={DynWorkOutline.wordmark.height}
          gradientUnits="userSpaceOnUse"
        >
          <stop stop-color="white" stop-opacity="0.7" />
          <stop offset="1" stop-color="white" stop-opacity="0" />
        </linearGradient>
      </defs>
    </svg>
  )
}
