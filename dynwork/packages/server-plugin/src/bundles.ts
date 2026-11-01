export * as DynWorkBundles from "./bundles"

import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { Option, Schema } from "effect"
import { DynWorkConfig } from "./config"
import type { DynWorkSync } from "./contract"

// The files the systemprompt bridge projects for OpenCode out of the manifest's plugin bundles
// (`managed_resources/content.rs`, `owned.rs`), here into the service's config dir: a bundle's `agents/<name>.md` as a
// sub-agent, its `hosts/opencode/plugins/<file>.{js,ts}` as `plugins/<plugin>-<file>`, and each theme a marketplace pins.
// The instance's code runs in DynWork's service, so a file is written only when its bytes have the SHA-256 the signed
// manifest gives it, and only to the paths above. A ledger beside them records what is ours, so every other file there
// stays, and what the manifest stops projecting is removed. Node's APIs rather than Bun's: main imports `wanted`, and
// Electron's main process has no `Bun`.

type Plugin = NonNullable<DynWorkSync.Manifest["plugins"]>[number]
type File = NonNullable<Plugin["files"]>[number]

const ledgerName = ".systemprompt-owned.json"

const bundlePlugins = "hosts/opencode/plugins/"
const bundleThemes = "hosts/opencode/themes/"
// OpenCode Desktop does not load external themes yet; the bridge projects them so a kit need not change once it does.
const bundleDesktopThemes = "hosts/opencode/desktop-themes/"

/** Every path the projection may write or the ledger may name, relative to the config dir: one file, no directory. */
const owned =
  /^(?:agents\/[^/\\]+\.[Mm][Dd]|plugins\/[^/\\]+\.(?:[Jj][Ss]|[Tt][Ss])|(?:desktop-)?themes\/[^/\\]+\.json)$/

export interface Projection {
  /** Relative to the config dir, ordered by path. */
  readonly files: ReadonlyArray<{ readonly path: string; readonly bytes: Uint8Array }>
  /** Files left out: not delivered, or not the bytes the manifest signed. */
  readonly warnings: ReadonlyArray<string>
}

/** The bundle files `project` reads, for main to fetch: plugins in id order, files in manifest order. */
export function wanted(manifest: DynWorkSync.Manifest) {
  const themes = pinned(manifest)
  return plugins(manifest).flatMap((plugin) =>
    (plugin.files ?? [])
      .filter((file) => target(plugin.id, file, themes) !== undefined)
      .map((file) => ({ plugin: plugin.id, path: file.path, sha256: file.sha256 })),
  )
}

/**
 * What the manifest's bundles project, from the bytes main `delivered`. Like the bridge, the first plugin by id that
 * ships a path verified takes it; a file missing or not matching its digest is skipped with a warning.
 */
export function project(manifest: DynWorkSync.Manifest, delivered: ReadonlyArray<DynWorkSync.BundleFile>): Projection {
  const themes = pinned(manifest)
  const contents = new Map(delivered.map((file) => [`${file.plugin}\0${file.path}`, file.content]))
  const files = new Map<string, Uint8Array>()
  const warnings: string[] = []
  plugins(manifest).forEach((plugin) =>
    (plugin.files ?? []).forEach((file) => {
      const to = target(plugin.id, file, themes)
      if (to === undefined || files.has(to)) return
      const content = contents.get(`${plugin.id}\0${file.path}`)
      const bytes = content === undefined ? undefined : Buffer.from(content, "base64")
      const actual = bytes && createHash("sha256").update(bytes).digest("hex")
      if (!bytes || actual !== file.sha256)
        return void warnings.push(
          `${file.path} of plugin ${plugin.id} not projected: ${bytes ? `its SHA-256 ${actual} is not the manifest's ${file.sha256}` : "not delivered"}`,
        )
      files.set(to, to.startsWith("agents/") ? new TextEncoder().encode(subagent(lossy.decode(bytes))) : bytes)
    }),
  )
  return {
    files: [...files]
      .toSorted((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map((entry) => ({ path: entry[0], bytes: entry[1] })),
    warnings,
  }
}

// `String::from_utf8_lossy`, which keeps a byte-order mark for `subagent` to drop.
const lossy = new TextDecoder("utf-8", { ignoreBOM: true })

/** The bridge's `as_subagent`: `mode: subagent` first in the front matter, replacing any mode; front matter if none. */
export function subagent(markdown: string) {
  const body = markdown.startsWith("\uFEFF") ? markdown.slice(1) : markdown
  const rest = body.startsWith("---\n") ? body.slice(4) : undefined
  const end = rest?.indexOf("\n---") ?? -1
  if (rest === undefined || end < 0) return `---\nmode: subagent\n---\n\n${body}`
  const front = lines(rest.slice(0, end)).filter((line) => !line.trimStart().startsWith("mode:"))
  return `---\nmode: subagent\n${front.join("\n")}\n---${rest.slice(end + 4)}`
}

// Rust's `str::lines`: split at `\n`, without a final empty piece, each without a trailing `\r`.
function lines(text: string) {
  const parts = text.split("\n")
  return (parts.at(-1) === "" ? parts.slice(0, -1) : parts).map((line) => line.replace(/\r$/, ""))
}

/** The bridge's `safe_plugin_id`: a plugin id names a path segment and a URL segment. */
function plugins(manifest: DynWorkSync.Manifest) {
  return (manifest.plugins ?? [])
    .filter((plugin) => plugin.id !== "" && !/\.\.|[/\\]|^\./.test(plugin.id))
    .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

// Theme name to the digest a marketplace pins it at; a later marketplace's pin of the same name wins, as in the bridge.
function pinned(manifest: DynWorkSync.Manifest) {
  return new Map(
    DynWorkConfig.opencode(manifest).flatMap((block) => block.themes.map((theme) => [theme.name, theme.sha] as const)),
  )
}

// The bridge's `target_for`, limited to paths that stay one file deep in their directory.
function target(plugin: string, file: File, themes: ReadonlyMap<string, string>) {
  const to = (() => {
    const name = file.path
    if (name.startsWith("agents/") && extension(name.slice(7), ["md"])) return name
    if (name.startsWith(bundlePlugins) && extension(name.slice(bundlePlugins.length), ["js", "ts"]))
      return `plugins/${plugin}-${name.slice(bundlePlugins.length)}`
    if (name.startsWith(bundleDesktopThemes) && name.endsWith(".json")) {
      const theme = name.slice(bundleDesktopThemes.length, -5)
      return themes.has(theme) ? `desktop-themes/${theme}.json` : undefined
    }
    if (!name.startsWith(bundleThemes) || !name.endsWith(".json")) return undefined
    const theme = name.slice(bundleThemes.length, -5)
    return themes.get(theme) === file.sha256 ? `themes/${theme}.json` : undefined
  })()
  return to !== undefined && owned.test(to) ? to : undefined
}

// A file name directly in its directory with one of `extensions`, case-insensitive; a dot file has no extension.
function extension(name: string, extensions: ReadonlyArray<string>) {
  return !name.includes("/") && extensions.includes(path.extname(name).slice(1).toLowerCase())
}

const Ledger = Schema.Struct({
  // Paths in the ledger are removed from disk, so only what the projection could have written is accepted
  files: Schema.optional(Schema.Array(Schema.String.check(Schema.isPattern(owned)))),
})
const decodeLedger = Schema.decodeUnknownOption(Schema.fromJsonString(Ledger))

/**
 * Writes `projection` into `directory`, removing what the ledger lists and the projection no longer has, or
 * everything listed when it is undefined. Files are replaced atomically and only when their bytes change. A corrupt
 * ledger fails rather than reading as empty, since it is what keeps the user's own files from being taken for ours.
 */
export async function write(directory: string, projection: Projection | undefined) {
  const files = projection?.files ?? []
  const outside = files.find((file) => !owned.test(file.path))
  if (outside) throw new Error(`${outside.path} is not a path the bridge projects; refusing to write it`)
  const ledger = path.join(directory, ledgerName)
  const previous = await read(ledger)
  const kept = files.map((file) => file.path).toSorted()
  await Promise.all(
    previous.filter((file) => !kept.includes(file)).map((file) => rm(path.join(directory, file), { force: true })),
  )
  await Promise.all(files.map((file) => replace(path.join(directory, file.path), file.bytes)))
  if (kept.length === 0) return rm(ledger, { force: true })
  // serde_json's pretty print: two spaces, no final newline
  await replace(ledger, new TextEncoder().encode(JSON.stringify({ files: kept }, null, 2)))
}

async function read(file: string) {
  if (!existsSync(file)) return []
  const ledger = decodeLedger(await readFile(file, "utf8"))
  if (Option.isNone(ledger)) throw new Error(`${file} is corrupt; refusing to treat a corrupt ledger as empty`)
  return ledger.value.files ?? []
}

async function replace(file: string, bytes: Uint8Array) {
  if (existsSync(file) && (await readFile(file)).equals(bytes)) return
  await mkdir(path.dirname(file), { recursive: true })
  // Hidden and ending in `.tmp`, so OpenCode never loads it as a plugin or an agent, and beside the target for an
  // atomic rename.
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`)
  await writeFile(temporary, bytes)
  await rename(temporary, file)
}
