import routines from "../routines/i18n/fr"
import agents from "./agents/fr"
import brain from "./brain/fr"
import drive from "./drive/fr"
import type en from "./en"
import runs from "./runs/fr"

// The views' strings in French (`./en`), merged into the `dynwork` built-in's `fr` table.
export default {
  "views.nav.agents": "Planifiées",
  "views.nav.drive": "Drive",
  "views.nav.brain": "Brain",
  "views.device.macos": "Ce Mac",
  "views.device.macos.inline": "ce Mac",
  "views.device.windows": "Ce PC",
  "views.device.windows.inline": "ce PC",
  "views.device.linux": "Cet ordinateur",
  "views.device.linux.inline": "cet ordinateur",
  "views.channel.canary": "Canary",
  "views.channel.dev": "Dev",
  "views.demo": "Données de test",
  "views.demo.title":
    "Données d'exemple incluses. Rien de tout cela n'est lu depuis un serveur ni envoyé à un serveur.",
  "views.back": "Retour",
  "views.close": "Fermer",
  "views.subnav": "Sections",
  ...agents,
  ...brain,
  ...drive,
  ...runs,
  ...routines,
} satisfies Record<keyof typeof en, string>
