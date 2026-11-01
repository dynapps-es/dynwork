export * as DynWorkService from "./service"

import path from "node:path"
import { DynWorkIdentity } from "@dynwork/branding/identity"

// The packaged prod build runs its own OpenCode background service, so it never adopts, stops or replaces the one
// OpenCode.app registered, and its credentials and synced content stay in DynWork's profile. Everything the service
// keeps lives under `<userData>/service`: the registration file (under XDG_STATE_HOME, where the CLI writes it), the
// config dir (also the home of the service's own `service.json` settings) and the database. The data dir (logs,
// snapshots, tool output, and the legacy `auth.json` a new database would otherwise import from OpenCode.app) is
// userData itself, so its logs land in `<userData>/opencode/log`, which the desktop's debug-log export already reads. Dev and beta builds keep
// upstream's shared service.
export function layout(
  channel: string,
  app: { readonly isPackaged: boolean; getPath(name: "userData"): string },
  // Reaches the service as OPENCODE_CONFIG_CONTENT: the extension point for DynWork's own server config.
  config?: Readonly<Record<string, unknown>>,
) {
  if (channel !== "prod" || !app.isPackaged) return undefined
  const root = path.join(app.getPath("userData"), "service")
  const state = path.join(root, "state")

  return {
    file: path.join(state, "opencode", "service.json"),
    // Loopback only, on a fixed port: a second contender for the same profile fails to bind and backs off.
    args: ["--hostname", "127.0.0.1", "--port", String(DynWorkIdentity.servicePort)],
    env: {
      XDG_STATE_HOME: state,
      XDG_DATA_HOME: app.getPath("userData"),
      OPENCODE_CONFIG_DIR: path.join(root, "config"),
      OPENCODE_DB: path.join(root, "opencode.db"),
      ...(config ? { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) } : {}),
    },
  }
}

// Main merges the login shell's environment into its own, and the service inherits it. The user's OPENCODE_CONFIG*
// would point DynWork's service at their OpenCode setup, so they are removed before it starts. The service options
// can only add variables, never remove inherited ones.
export function isolate(env: Record<string, string | undefined>) {
  for (const key of Object.keys(env)) if (key.startsWith("OPENCODE_CONFIG")) delete env[key]
}
