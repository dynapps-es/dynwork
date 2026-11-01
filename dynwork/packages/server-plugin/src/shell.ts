export * as DynWorkShell from "./shell"

import { Option, Schema } from "effect"

// DynWork's service runs with XDG_STATE_HOME and XDG_DATA_HOME inside DynWork's profile, and the shells its tools
// start would inherit them, so a `gh`, `git` or `npm` run from a session would read and write its state there.
// Main passes the user's own values in this variable (null for a variable the user had not set), and the plugin
// puts them back in every shell the service starts.
export const variable = "DYNWORK_SHELL_ENV"

const Saved = Schema.Struct({
  XDG_STATE_HOME: Schema.optional(Schema.NullOr(Schema.String)),
  XDG_DATA_HOME: Schema.optional(Schema.NullOr(Schema.String)),
})
export type Saved = typeof Saved.Type

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Saved))

/** The user's values, or undefined when main passed none or something unreadable. */
export function saved(env: Readonly<Record<string, string | undefined>>) {
  const value = env[variable]
  return value === undefined ? undefined : Option.getOrUndefined(decode(value))
}

/**
 * Restores the user's values in a shell's environment. A value that differs from the service's own was set for the
 * shell on purpose (a session environment) and stays.
 */
export function restore(
  env: Record<string, string | undefined>,
  user: Saved,
  service: Readonly<Record<string, string | undefined>>,
) {
  delete env[variable]
  for (const [key, value] of Object.entries(user)) {
    if (value === undefined || env[key] !== service[key]) continue
    if (value === null) {
      delete env[key]
      continue
    }
    env[key] = value
  }
}
