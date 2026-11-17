import { Plugin } from "@opencode/plugin/gui"
import remote from "../remote/i18n/en"
import remoteEs from "../remote/i18n/es"
import en from "./i18n/en"
import es from "./i18n/es"

// The `dynwork` built-in: DynWork's systemprompt accounts. Its main entry holds them; windows reach them through the
// `dynwork.accounts` Ipc (`./contract`), and its window entry adds the Accounts settings page, the titlebar pill and the
// DynWork views (`../views`).
// Remote control (`../remote`) rides on the same built-in: its `dynwork.remote` Ipc, settings page and indicator.
export default Plugin.define({ i18n: { en: { ...en, ...remote }, es: { ...es, ...remoteEs } } })
