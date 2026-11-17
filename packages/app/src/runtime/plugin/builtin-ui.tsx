import { lazy } from "solid-js"
import type { BuiltinContext } from "@opencode/plugin/gui/builtin"
import { ui } from "./ui"

/** `BuiltinUi`: the app's components, and the chat composer, loaded the first time a built-in shows it. */
export const builtinUi: BuiltinContext["ui"] = {
  ...ui,
  ChatComposer: lazy(() => import("./chat-composer")),
}
