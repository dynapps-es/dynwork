import agents from "./agents/en"
import brain from "./brain/en"
import chats from "./chats/en"
import runs from "./runs/en"
import routines from "../routines/i18n/en"

// The views' strings, merged into the `dynwork` built-in's table. Each view owns the table in its folder.
export default {
  "views.nav.chats": "Chats",
  "views.nav.agents": "Scheduled",
  "views.nav.brain": "Brain",
  "views.device.macos": "This Mac",
  "views.device.macos.inline": "this Mac",
  "views.device.windows": "This PC",
  "views.device.windows.inline": "this PC",
  "views.device.linux": "This computer",
  "views.device.linux.inline": "this computer",
  "views.channel.canary": "Canary",
  "views.channel.dev": "Dev",
  "views.demo": "Demo data",
  "views.demo.title": "Built-in sample data. Nothing here is read from or sent to a server.",
  "views.back": "Back",
  "views.close": "Close",
  "views.subnav": "Sections",
  ...agents,
  ...brain,
  ...chats,
  ...runs,
  ...routines,
}
