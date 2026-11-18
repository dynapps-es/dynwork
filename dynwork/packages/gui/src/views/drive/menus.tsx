import { lazy, Show, type ComponentProps } from "solid-js"
import { isServer } from "solid-js/web"

// The Drive's menus, loaded on the client only: Kobalte's menu runs browser-only code when it loads, and the tests
// render the views with Solid's server build.
const Row = lazy(() => import("./row-menu"))
const Doc = lazy(() => import("./doc-menu"))

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
