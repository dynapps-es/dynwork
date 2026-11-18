import routines from "../routines/i18n/nl"
import agents from "./agents/nl"
import brain from "./brain/nl"
import chats from "./chats/nl"
import type en from "./en"
import runs from "./runs/nl"

// The views' strings in Dutch (`./en`), merged into the `dynwork` built-in's `nl` table.
export default {
  "views.nav.chats": "Chats",
  "views.nav.agents": "Gepland",
  "views.nav.brain": "Brain",
  "views.device.macos": "Deze Mac",
  "views.device.macos.inline": "deze Mac",
  "views.device.windows": "Deze pc",
  "views.device.windows.inline": "deze pc",
  "views.device.linux": "Deze computer",
  "views.device.linux.inline": "deze computer",
  "views.channel.canary": "Canary",
  "views.channel.dev": "Dev",
  "views.demo": "Testgegevens",
  "views.demo.title":
    "Voorbeeldgegevens inbegrepen. Niets hiervan wordt van een server gelezen of naar een server gestuurd.",
  "views.back": "Terug",
  "views.close": "Sluiten",
  "views.subnav": "Onderdelen",
  ...agents,
  ...brain,
  ...chats,
  ...runs,
  ...routines,
} satisfies Record<keyof typeof en, string>
