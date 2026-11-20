// The side panel's tab strip is the app's: tabs keep a natural width while they fit and shrink to a minimum before it
// scrolls. What DynWork adds for its document tabs is a readable label (`tab-label.tsx`) and keeping the selected one in
// view, which the strip does for a new tab only, and which has to leave the room the strip fades and its sticky "+" take.

/** The strip's fade at each edge (`EDGE_FADE` of the app's `tab-strip-scroll.ts`). */
export const fade = 24

interface Span {
  readonly left: number
  readonly right: number
}

/**
 * How far to scroll the strip, in pixels (negative: back) for `tab` to sit fully inside it, past the `inset` each edge
 * loses to its fade and, at the end, the sticky "+". Zero when it already does, or when it is wider than what is left.
 */
export function shiftToShow(strip: Span, tab: Span, inset: Span) {
  const from = strip.left + inset.left
  const to = strip.right - inset.right
  if (tab.right - tab.left >= to - from) return 0
  if (tab.left < from) return tab.left - from
  if (tab.right > to) return tab.right - to
  return 0
}

/** Scrolls the strip that holds `label` so the tab around it is in view. Nothing when it is not in a strip. */
export function reveal(label: HTMLElement | undefined) {
  const tab = label?.closest<HTMLElement>("[data-pane-tab]")
  const strip = label?.closest<HTMLElement>("[data-pane-strip]")
  if (!tab || !strip) return
  const style = getComputedStyle(strip)
  // The strip's script keeps the "+"'s width in `--tab-strip-add`; its fades are there only where there is more to scroll.
  const add = Number.parseFloat(style.getPropertyValue("--tab-strip-add")) || 0
  const rtl = style.direction === "rtl"
  const shift = shiftToShow(
    strip.getBoundingClientRect(),
    tab.getBoundingClientRect(),
    rtl ? { left: add + fade, right: fade } : { left: fade, right: add + fade },
  )
  if (shift !== 0) strip.scrollBy({ left: shift, behavior: "smooth" })
}
