import type { Run } from "../../routines/contract"
import { runHref } from "./model"

// Main focuses a window and tells every window which run a notification opened: only the one in focus follows it.
// Following is a click on a link, as the Runs panel's rows are, so the app's router opens it in place.
const SETTLE = 100

export function openRun(run: Run) {
  const href = runHref(run)
  if (!href) return
  setTimeout(() => {
    if (!document.hasFocus()) return
    const link = document.createElement("a")
    link.href = href
    link.hidden = true
    document.body.append(link)
    link.click()
    link.remove()
  }, SETTLE)
}
