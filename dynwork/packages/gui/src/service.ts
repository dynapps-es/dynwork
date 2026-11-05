export * as DynWorkService from "./service"

import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { DynWorkIdentity } from "@dynwork/branding/identity"
import { DynWorkShell } from "@dynwork/server-plugin/shell"
import { Option, Schema } from "effect"

// The packaged prod build runs its own OpenCode background service, so it never adopts, stops or replaces the one
// OpenCode.app registered, and its credentials and synced content stay in DynWork's profile. Everything the service
// keeps lives under `<userData>/service`: the registration file (under XDG_STATE_HOME, where the CLI writes it), the
// config dir (also the home of the service's own `service.json` settings) and the database. The data dir (logs,
// snapshots, tool output, and the legacy `auth.json` a new database would otherwise import from OpenCode.app) is
// userData itself, so its logs land in `<userData>/opencode/log`, which the desktop's debug-log export already reads. Dev and beta builds keep
// upstream's shared service.
export function layout(
  channel: string,
  app: { readonly isPackaged: boolean; getPath(name: "userData"): string; getAppPath(): string },
  // Merged into OPENCODE_CONFIG_CONTENT, which always loads DynWork's server plugin.
  config?: Readonly<Record<string, unknown>>,
) {
  if (channel !== "prod" || !app.isPackaged) return undefined
  const root = path.join(app.getPath("userData"), "service")
  const state = path.join(root, "state")

  return {
    file: path.join(state, "opencode", "service.json"),
    // Loopback only, on a fixed port: a second contender for the same profile fails to bind and backs off.
    args: ["--hostname", hostname, "--port", String(DynWorkIdentity.servicePort)],
    env: {
      XDG_STATE_HOME: state,
      XDG_DATA_HOME: app.getPath("userData"),
      OPENCODE_CONFIG_DIR: path.join(root, "config"),
      OPENCODE_DB: path.join(root, "opencode.db"),
      // The desktop build ships the plugin as an extra resource, next to the app archive (see PATCHES.md).
      // A caller's own `plugins` add to DynWork's, never replace it.
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        ...config,
        plugins: [
          ...(Array.isArray(config?.plugins) ? config.plugins : []),
          path.join(path.dirname(app.getAppPath()), plugin),
        ],
      }),
      // The user's own XDG values, which the plugin restores in the shells the service starts (null: unset).
      [DynWorkShell.variable]: JSON.stringify({
        XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? null,
        XDG_DATA_HOME: process.env.XDG_DATA_HOME ?? null,
      }),
    },
  }
}

const hostname = "127.0.0.1"

/**
 * Writes the service's host and port into its own settings (`<config>/service.json`, what `opencode service set` edits),
 * keeping every other setting. `opencode service start`, which the pairing settings run to bring the service back with
 * remote access, starts it from these settings and not from the desktop's arguments: without them it would come up on
 * OpenCode's port.
 */
export async function pin(own: NonNullable<ReturnType<typeof layout>>) {
  const file = path.join(own.env.OPENCODE_CONFIG_DIR, "service.json")
  const current = await readFile(file, "utf8").then(settings, () => settings(""))
  if (current.hostname === hostname && current.port === DynWorkIdentity.servicePort) return
  await mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify({ ...current, hostname, port: DynWorkIdentity.servicePort }, null, 2) + "\n", {
    mode: 0o600,
  })
  await rename(temp, file)
}

// The settings as an object, or none when the file is not one: the CLI reads such a file as empty too.
const settings = (text: string) => Option.getOrElse(decodeSettings(text), (): Readonly<Record<string, unknown>> => ({}))

const decodeSettings = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))

/** The directory name of the server plugin among the app's resources. */
export const plugin = "dynwork-server-plugin"

// Main merges the login shell's environment into its own, and the service inherits it. The service options can only
// add variables, never remove inherited ones, so the variables of the user's own OpenCode setup that would steer
// DynWork's service are removed before it starts: their config (OPENCODE_CONFIG*, OPENCODE_CLI_CONFIG_CONTENT), their
// console key, models catalog and database, a server password, simulation, and the switches that change which
// content and models the service serves. Desktop's own variables (OPENCODE_DESKTOP_*, OPENCODE_DISABLE_EMBEDDED_WEB_UI,
// OPENCODE_CLIENT), paths to native helpers, logging and performance switches stay.
export const inherited = [
  "OPENCODE_CLI_CONFIG_CONTENT",
  "OPENCODE_API_KEY",
  "OPENCODE_MODELS_URL",
  "OPENCODE_MODELS_PATH",
  "OPENCODE_DB",
  "OPENCODE_PASSWORD",
  "OPENCODE_SERVER_PASSWORD",
  "OPENCODE_SIMULATE",
  "OPENCODE_DISABLE_MODELS_FETCH",
  "OPENCODE_DISABLE_FREE_MODELS",
  "OPENCODE_DISABLE_PROJECT_CONFIG",
  "OPENCODE_DISABLE_CLAUDE_CODE",
  "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS",
]

export function isolate(env: Record<string, string | undefined>) {
  for (const key of Object.keys(env)) if (key.startsWith("OPENCODE_CONFIG") || inherited.includes(key)) delete env[key]
}
