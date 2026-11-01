import { SettingsPage, TitlebarItem, type Live, type SetupContext } from "@opencode/plugin/gui"
import { onIdle } from "@opencode/plugin/gui/builtin"
import { createSignal, lazy, onCleanup, Suspense, type Accessor } from "solid-js"
import type definition from "../index"
import type { Client } from "../renderer"
import { AccountsController } from "./controller"
import { AccountsModel } from "./model"
import { AccountsText } from "./text"

// How often the relative times ("Synced 2 minutes ago") read the clock again.
const tick = 30_000

// DynWork's window entry: the systemprompt settings page and the titlebar pill, both over the live accounts Ipc.
export function register(ctx: SetupContext<typeof definition>, live: Accessor<Live<Client>>) {
  const layout = ctx.layout
  const Page = lazy(() => import("./page"))
  const Menu = lazy(() => import("./pill"))
  // Settings rows are small; load them while idle so settings opens without a blank page.
  onCleanup(onIdle(() => void Page.preload()))

  const client = () => {
    const current = live()

    return current.status === "active" ? current.value : undefined
  }
  const state = () => client()?.state()

  const [now, setNow] = createSignal(Date.now())
  const clock = setInterval(() => setNow(Date.now()), tick)
  onCleanup(() => clearInterval(clock))

  const failed = async () => {
    const { showToast } = await import("@opencode/ui/toast")

    showToast({ title: ctx.t("action.error") })
  }

  ctx.add(SettingsPage, {
    id: "accounts",
    icon: "lock",
    get title() {
      return ctx.t("title")
    },
    get entries() {
      return [{ id: "accounts", title: ctx.t("title"), keywords: ctx.t("keywords") }]
    },
    render: () => (
      <Suspense>
        <Page accounts={live} now={now} />
      </Suspense>
    ),
  })

  ctx.add(TitlebarItem, () => {
    const value = state()
    const pill = value ? AccountsModel.pill(value) : undefined

    if (!pill) return
    const status = AccountsText.sync(ctx, pill.sync, now())

    return {
      id: "systemprompt",
      label: `${pill.name} · ${status}`,
      title: `${ctx.t("pill.title", { label: pill.name })} · ${status}`,
      icon: pill.icon,
      run: () => {
        ctx.dialogs.open((dialog) => (
          <Menu
            state={state}
            now={now}
            {...AccountsController.menu({
              client,
              settings: (page) => layout.settings(page),
              failed,
              close: dialog.close,
            })}
          />
        ))
      },
    }
  })
}
