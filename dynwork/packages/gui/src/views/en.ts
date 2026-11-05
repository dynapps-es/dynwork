import agents from "./agents/en"
import brain from "./brain/en"
import routines from "./routines/en"

// The views' strings, merged into the `dynwork` built-in's table. Each view owns the table in its folder.
export default {
  "views.nav.agents": "Agents",
  "views.nav.brain": "Brain",
  "views.work.cloud": "Cloud",
  "views.work.agents": "Agents",
  "views.work.routines": "Routines",
  "views.device.macos": "This Mac",
  "views.device.macos.inline": "this Mac",
  "views.device.windows": "This PC",
  "views.device.windows.inline": "this PC",
  "views.device.linux": "This computer",
  "views.device.linux.inline": "this computer",
  "views.demo": "Demo data",
  "views.demo.title": "Built-in sample data. Nothing here is read from or sent to a server.",
  "views.back": "Back",
  "views.close": "Close",
  "views.subnav": "Sections",
  ...agents,
  ...routines,
  ...brain,
}
