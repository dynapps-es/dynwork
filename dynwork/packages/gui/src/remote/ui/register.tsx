import { SettingsPage, TitlebarItem, type IpcClient, type Live, type SetupContext } from "@opencode/plugin/gui"
import { onIdle } from "@opencode/plugin/gui/builtin"
import { lazy, onCleanup, Suspense, type Accessor } from "solid-js"
import type { Remote } from "../contract"
import type definition from "../../accounts/index"
import { RemoteModel } from "./model"

export type Client = IpcClient<(typeof Remote)["spec"]>

// Settings -> Remote control, and the titlebar indicator while a phone is connected. Both read the tunnel's state
// from main; the window never holds a key, a JWT or a credential, only the QR it shows.
export function registerRemote(ctx: SetupContext<typeof definition>, live: Accessor<Live<Client>>) {
  const layout = ctx.layout
  const Page = lazy(() => import("./page"))
  onCleanup(onIdle(() => void Page.preload()))
  const state = () => {
    const current = live()
    return current.status === "active" ? current.value.state() : undefined
  }

  ctx.add(SettingsPage, {
    id: "remote",
    icon: "server",
    get title() {
      return ctx.t("remote.title")
    },
    get entries() {
      return [{ id: "remote", title: ctx.t("remote.title"), keywords: ctx.t("remote.keywords") }]
    },
    render: () => (
      <Suspense>
        <Page remote={live} />
      </Suspense>
    ),
  })

  ctx.add(TitlebarItem, () => {
    const value = state()
    const shown = value ? RemoteModel.indicator(value) : undefined
    if (!shown) return
    const label =
      shown.count === 1
        ? ctx.t("remote.indicator.one", { name: shown.name })
        : ctx.t("remote.indicator.other", { count: shown.count })
    return {
      id: "remote",
      label,
      title: `${ctx.t("remote.indicator.title")} · ${label}`,
      icon: "server" as const,
      run: () => layout.settings("remote"),
    }
  })
}
