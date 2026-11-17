import { Plugin } from "@opencode/plugin/gui"
import remote from "../remote/i18n/en"
import remoteEs from "../remote/i18n/es"
import remoteFr from "../remote/i18n/fr"
import remoteNl from "../remote/i18n/nl"
import en from "./i18n/en"
import es from "./i18n/es"
import fr from "./i18n/fr"
import nl from "./i18n/nl"

// The `dynwork` built-in: DynWork's systemprompt accounts. Its main entry holds them; windows reach them through the
// `dynwork.accounts` Ipc (`./contract`), and its window entry adds the Accounts settings page, the titlebar pill and the
// DynWork views (`../views`).
// Remote control (`../remote`) rides on the same built-in: its `dynwork.remote` Ipc, settings page and indicator.
export default Plugin.define({
  i18n: {
    en: { ...en, ...remote },
    es: { ...es, ...remoteEs },
    fr: { ...fr, ...remoteFr },
    nl: { ...nl, ...remoteNl },
  },
})
