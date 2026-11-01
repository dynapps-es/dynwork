export * as SignInVisibility from "./visibility"

import { createSignal } from "solid-js"
import type { State } from "../accounts/contract"

// Whether the sign-in screen shows. `state` is the accounts' state as main last pushed it, undefined until the first
// snapshot. The screen shows when no signed-in account is active, and stays until `dismiss` (its fade-out ended), so
// signing in, which makes an account active, does not close it before the user finishes. It stays hidden until the
// first snapshot: the caller covers the window meanwhile.
export function create(state: () => State | undefined) {
  // `holding` is read where `open` is, so a screen that is already up stays up after the account turns active. A
  // signal in `dismiss` makes `open` read again.
  const [dismissals, setDismissals] = createSignal(0)
  const holding = { current: false }
  const active = () => state()?.accounts.some((account) => account.active && account.status === "signedIn")

  return {
    known: () => state() !== undefined,
    open() {
      dismissals()

      if (active() === false) holding.current = true

      return active() === false || holding.current
    },
    dismiss() {
      holding.current = false
      setDismissals((count) => count + 1)
    },
  }
}

// How long the plain cover waits for main's accounts to answer before it gives up.
export const stall = 15_000

// What the window shows before the first snapshot: the plain cover while the accounts may still answer, an error with
// a retry once they never will, either because their provider is gone or because they took longer than `stall`.
export function cover(input: { known: boolean; link: "pending" | "active" | "inactive" | undefined; waited: boolean }) {
  if (input.known) return "ready"

  if (input.link === "inactive" || input.waited) return "failed"

  return "waiting"
}
