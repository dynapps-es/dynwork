import routines from "../routines/i18n/es"
import agents from "./agents/es"
import brain from "./brain/es"
import drive from "./drive/es"
import type en from "./en"
import runs from "./runs/es"

// The views' strings in Spanish (`./en`), merged into the `dynwork` built-in's `es` table.
export default {
  "views.nav.agents": "Programadas",
  "views.nav.drive": "Drive",
  "views.nav.brain": "Brain",
  "views.device.macos": "Este Mac",
  "views.device.macos.inline": "este Mac",
  "views.device.windows": "Este PC",
  "views.device.windows.inline": "este PC",
  "views.device.linux": "Este equipo",
  "views.device.linux.inline": "este equipo",
  "views.channel.canary": "Canary",
  "views.channel.dev": "Dev",
  "views.demo": "Datos de prueba",
  "views.demo.title": "Datos de ejemplo incluidos. Nada de esto se lee de un servidor ni se envía a ninguno.",
  "views.back": "Atrás",
  "views.close": "Cerrar",
  "views.subnav": "Secciones",
  ...agents,
  ...brain,
  ...drive,
  ...runs,
  ...routines,
} satisfies Record<keyof typeof en, string>
