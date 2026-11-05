import { createSignal, onCleanup, type Accessor } from "solid-js"
import type { IpcClient, Live, Plugin } from "@opencode/plugin/gui"
import { Accounts } from "./contract"
import type definition from "./index"
import { Remote } from "../remote/contract"
import { registerRemote } from "../remote/ui/register"
import { register } from "./ui/register"
import { registerViews } from "../views/register"

export type Client = IpcClient<(typeof Accounts)["spec"]>

// The sign-in gate renders outside the plugin host, so it cannot `ctx.use` the Ipc itself. The window entry hands it
// the live client: `connection()` is the Ipc's `Live` state while this window's entry runs, else undefined.
const [current, setCurrent] = createSignal<Accessor<Live<Client>>>()

export const connection = () => current()?.()

const setup: Plugin.Setup<typeof definition> = (ctx) => {
  if (!ctx.desktop) return
  const live = ctx.use(Accounts)
  setCurrent(() => live)
  onCleanup(() => {
    if (current() === live) setCurrent(undefined)
  })
  register(ctx, live)
  registerViews(ctx)
  registerRemote(ctx, ctx.use(Remote))
}

export default setup
