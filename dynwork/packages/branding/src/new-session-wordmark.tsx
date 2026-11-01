import { For } from "solid-js"
import { DynWorkOutline } from "./outline"

// Upstream's ball handle for the brick breaker, kept so the props read like upstream's. Nothing creates one here.
export type LodgerBall = {
  radius: () => number
  at: () => { x: number; y: number }
  place: (
    x: number,
    y: number,
    pose: { look: number; lookAngle: number; stretch: number; angle: number; squint: number; curl: number },
  ) => void
  blink: () => void
  done: () => void
}

/**
 * Replaces `./wordmark` for packages/app/src/new-session/view.tsx in the desktop build (see dynwork/PATCHES.md). It
 * shows the "dynwork" wordmark flat, the way upstream rests, and never opens: no lodger, pin board or brick breaker,
 * so the callbacks are never called. The box keeps upstream's width and top edge, so the first-launch splash, which
 * draws the same letters at the same size and position, hands over to it in place.
 */
export function NewSessionWordmark(props: {
  ref: (element: HTMLDivElement) => void
  pins?: boolean
  sound?: () => boolean
  onOpen?: () => void
  onClose?: () => void
  onFlat?: () => void
  onPlay?: (ball: LodgerBall) => void
}) {
  return (
    <div
      data-component="new-session-wordmark"
      aria-hidden="true"
      style={{ "pointer-events": "none", "margin-inline": "auto", width: "100%", "max-width": "720px" }}
    >
      <div
        ref={props.ref}
        data-slot="wordmark-box"
        style={{
          position: "relative",
          "margin-inline": "auto",
          width: "80%",
          "aspect-ratio": `${DynWorkOutline.wordmark.width} / ${DynWorkOutline.wordmark.height}`,
        }}
      >
        <svg
          viewBox={`0 0 ${DynWorkOutline.wordmark.width} ${DynWorkOutline.wordmark.height}`}
          fill="none"
          style={{ display: "block", width: "100%", height: "100%" }}
        >
          {/* Upstream's resting letters: the icon color at 0.16. */}
          <g opacity="0.16" fill="var(--icon-base)">
            <For each={DynWorkOutline.wordmark.letters}>{(letter) => <path d={letter} />}</For>
          </g>
        </svg>
      </div>
    </div>
  )
}
