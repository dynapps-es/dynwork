export * as DynWorkConfig from "./config"

import { existsSync } from "node:fs"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { Option, Schema } from "effect"
import type { DynWorkSync } from "./contract"

// What the systemprompt bridge merges into OpenCode's own `opencode.json` and `cli.json` (`install/merge.rs`,
// `managed_resources/config_json.rs`), here in the service's config dir: the `policies` that leave the instance's
// provider the only one while it is applied, each marketplace's `cli_defaults` where the user has not set the key, and
// its default theme in `cli.json` where none is chosen. Every other key is the user's and is carried through. Node's
// APIs rather than Bun's, like `bundles.ts`, which main imports with this module.

const Theme = Schema.Struct({ name: Schema.String, sha: Schema.String })

const OpenCode = Schema.Struct({
  themes: Schema.optional(Schema.Array(Theme)),
  /** A 0.73 gateway's only theme, which is also the default. */
  theme: Schema.optional(Theme),
  default_theme: Schema.optional(Schema.String),
  theme_mode: Schema.optional(Schema.Literals(["system", "dark", "light"])),
  cli_defaults: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})
const decodeOpenCode = Schema.decodeUnknownOption(OpenCode)

/** Each marketplace's `opencode` block as the bridge reads it (`ManifestOpenCode`); one it cannot read is left out. */
export function opencode(manifest: DynWorkSync.Manifest) {
  return (manifest.marketplaces ?? []).flatMap((marketplace) =>
    Option.toArray(decodeOpenCode(marketplace.opencode)).map((block) => {
      const themes = block.themes ?? []
      const single = block.theme
      return {
        themes: single && !themes.some((theme) => theme.name === single.name) ? [...themes, single] : themes,
        default: block.default_theme ?? single?.name,
        mode: block.theme_mode,
        defaults: block.cli_defaults ?? {},
      }
    }),
  )
}

export interface Settings {
  /** Top-level `opencode.json` keys, the first marketplace winning a key. */
  readonly defaults: ReadonlyArray<readonly [string, unknown]>
  /** Every marketplace theme: a V1 top-level `theme` naming one was written by a bridge up to 0.73, and goes. */
  readonly themes: ReadonlyArray<string>
  /** The `cli.json` theme selected where the user has chosen none. */
  readonly theme?: { readonly name: string; readonly mode?: string }
}

/** What `write` merges for `manifest`, given the theme names whose files were projected. */
export function settings(manifest: DynWorkSync.Manifest, projected: ReadonlyArray<string>): Settings {
  const blocks = opencode(manifest)
  const defaults = blocks
    .flatMap((block) => Object.entries(block.defaults))
    .filter((entry, index, all) => all.findIndex((other) => other[0] === entry[0]) === index)
  const chosen = blocks.find((block) => block.themes.some((theme) => theme.name === block.default))
  const name = chosen?.default
  return {
    defaults,
    themes: blocks.flatMap((block) => block.themes.map((theme) => theme.name)),
    ...(chosen && name && projected.includes(name)
      ? { theme: { name, ...(chosen.mode ? { mode: chosen.mode } : {}) } }
      : {}),
  }
}

/** The bridge's own statements (`provider_policies`): deny every provider, allow `systemprompt`. */
export const policies = [
  { effect: "deny", action: "provider.use", resource: "*" },
  { effect: "allow", action: "provider.use", resource: "systemprompt" },
]

/**
 * Merges into `<directory>/opencode.json` the `policies` while `locked` (ahead of the user's own; taken out again
 * otherwise, and the file removed once nothing else is left in it) and `settings`' keys where absent, then selects
 * `settings`' theme in `cli.json`. A file that is not a JSON object is refused rather than rewritten.
 */
export async function write(directory: string, input: { readonly locked: boolean; readonly settings?: Settings }) {
  const file = path.join(directory, "opencode.json")
  const original = await read(file)
  const settings = input.settings
  const kept = Object.entries(original ?? {}).filter(
    (entry) =>
      !(settings && entry[0] === "theme" && typeof entry[1] === "string" && settings.themes.includes(entry[1])),
  )
  const filled = [...kept, ...(settings?.defaults ?? []).filter((entry) => !kept.some((key) => key[0] === entry[0]))]
  const foreign = filled.flatMap((entry) =>
    entry[0] === "policies" && Array.isArray(entry[1]) ? entry[1].filter((policy) => !ours(policy)) : [],
  )
  const next = Object.fromEntries(
    input.locked
      ? [...filled.filter((entry) => entry[0] !== "policies"), ["policies", [...policies, ...foreign]]]
      : filled.flatMap((entry) => {
          if (entry[0] !== "policies" || !Array.isArray(entry[1])) return [entry]
          return foreign.length === 0 ? [] : [["policies", foreign]]
        }),
  )
  if (JSON.stringify(next) !== JSON.stringify(original ?? {})) {
    // Taking the lock away from a file that held nothing else removes it, like the bridge's uninstall
    if (Object.keys(next).length === 0 && !settings && original !== undefined) await rm(file, { force: true })
    else await save(file, `${JSON.stringify(next, null, 2)}\n`)
  }
  if (settings?.theme) await select(directory, settings.theme)
}

// `cli.json`'s theme, only where the user has none; never removed. serde_json's pretty print, without a final newline.
async function select(directory: string, theme: NonNullable<Settings["theme"]>) {
  const file = path.join(directory, "cli.json")
  const current = (await read(file)) ?? {}
  if (Object.hasOwn(current, "theme")) return
  await save(file, JSON.stringify({ ...current, theme }, null, 2))
}

function ours(policy: unknown) {
  return policies.some(
    (own) =>
      isObject(policy) &&
      Object.keys(policy).length === 3 &&
      policy.effect === own.effect &&
      policy.action === own.action &&
      policy.resource === own.resource,
  )
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

// The file as an object, undefined when it does not exist; empty text is an empty object, a byte-order mark is skipped.
async function read(file: string) {
  if (!existsSync(file)) return undefined
  const text = (await readFile(file, "utf8")).replace(/^\uFEFF/, "")
  if (text.trim() === "") return {}
  const value = decodeJson(text)
  if (Option.isNone(value) || !isObject(value.value))
    throw new Error(`${file} is not a JSON object; refusing to overwrite`)
  return value.value
}

// Owner-only like the bridge's `atomic_write_0600`: the user's config may hold keys. The temporary file sits next to
// the target, so the rename stays on one file system.
async function save(file: string, text: string) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`)
  await writeFile(temporary, text, { mode: 0o600 })
  await rename(temporary, file)
}
