import { Plugin } from "@opencode/plugin/gui"
import en from "./i18n/en"

// The `dynwork` built-in: DynWork's systemprompt accounts. Its main entry holds them; windows reach them through the
// `dynwork.accounts` Ipc (`./contract`), and its window entry adds the Accounts settings page and the titlebar pill.
export default Plugin.define({ i18n: { en } })
