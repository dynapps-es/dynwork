import { createSignal } from "solid-js"
import type { Ref } from "../../routines/contract"

// A routine another place asked the Agents view to show, such as Edit in the Runs panel. The view selects it when it is
// on screen, at once or once it mounts, and clears it.
const [pending, setPending] = createSignal<Ref>()

export const focused = pending

/** Shows `ref`'s detail the next time the Agents view is on screen. */
export function focus(ref: Ref) {
  setPending({ backend: ref.backend, id: ref.id })
}

export function clearFocus() {
  setPending(undefined)
}
