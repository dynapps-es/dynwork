import { lazy, Show, type ComponentProps } from "solid-js"
import { isServer } from "solid-js/web"

// The Drive's menus and the Share popover, loaded on the client only: Kobalte's menu and popover run browser-only code
// when they load, and the tests render the views with Solid's server build.
const Row = lazy(() => import("./row-menu"))
const Doc = lazy(() => import("./doc-menu"))
const Share = lazy(() => import("./share-popover"))

export function RowMenu(props: ComponentProps<typeof Row>) {
  return (
    <Show when={!isServer}>
      <Row {...props} />
    </Show>
  )
}

export function DocMenu(props: ComponentProps<typeof Doc>) {
  return (
    <Show when={!isServer}>
      <Doc {...props} />
    </Show>
  )
}

export function SharePopover(props: ComponentProps<typeof Share>) {
  return (
    <Show when={!isServer}>
      <Share {...props} />
    </Show>
  )
}
