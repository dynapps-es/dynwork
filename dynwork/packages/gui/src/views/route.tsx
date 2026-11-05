import { lazy, Suspense } from "solid-js"
import { Dynamic } from "solid-js/web"

/** The views by page id. Each loads as its own chunk the first time its page opens. */
export const views = new Map([
  ["agents", lazy(() => import("./agents"))],
  ["routines", lazy(() => import("./routines"))],
  ["brain", lazy(() => import("./brain"))],
])

/** The host's `page` slot: the view whose id the route names, or nothing for a page DynWork does not own. */
export function ViewRoute(props: { id: string }) {
  return (
    <Suspense>
      <Dynamic component={views.get(props.id)} />
    </Suspense>
  )
}
