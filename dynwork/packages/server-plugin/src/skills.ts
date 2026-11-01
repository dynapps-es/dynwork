export * as DynWorkSkills from "./skills"

import { mkdir, rename, rm } from "node:fs/promises"
import path from "node:path"
import { Option, Schema } from "effect"
import type { DynWorkSync } from "./contract"

// The instance's skills as `<config>/skills/<dir>/SKILL.md`, the files the systemprompt bridge writes into OpenCode's
// (`integration/managed_skills.rs`, `KebabNamed` policy). OpenCode scans and watches that directory, so a change shows
// in every Location by itself. A ledger beside them records what is ours, so a skill the user wrote there stays.

type Entry = DynWorkSync.Manifest["skills"][number]

const ledgerName = ".systemprompt-managed.json"

export interface Projection {
  /** One `SKILL.md` per skill, ordered by directory name. */
  readonly files: ReadonlyArray<{ readonly dir: string; readonly markdown: string }>
  /** The manifest's marketplace ids, recorded in the ledger like the bridge does. */
  readonly marketplaces: ReadonlyArray<string>
  /** Ids of selected skills that cannot have a directory: an unsafe id, or the same directory as an earlier skill. */
  readonly skipped: ReadonlyArray<string>
}

/** Ids reach the file system, so only the bridge's `safe_id_segment` characters (no dot) become directories. */
const safeID = /^[A-Za-z0-9_-]+$/

/**
 * The files for `selected` skills, or undefined when the manifest has no skills at all (then everything managed is
 * removed). Like the bridge, a manifest with skills none of which is selected still writes an empty ledger.
 */
export function project(manifest: DynWorkSync.Manifest, selected: ReadonlyArray<Entry>): Projection | undefined {
  if (manifest.skills.length === 0) return undefined
  const taken = new Set<string>()
  const files = selected.flatMap((skill) => {
    const dir = kebab(skill.id)
    if (!safeID.test(skill.id) || !dir || taken.has(dir)) return []
    taken.add(dir)
    return [{ dir, markdown: markdown(skill, dir), id: skill.id }]
  })
  return {
    files: files
      .toSorted((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0))
      .map(({ dir, markdown }) => ({ dir, markdown })),
    marketplaces: (manifest.marketplaces ?? []).map((marketplace) => marketplace.id),
    skipped: selected.filter((skill) => !files.some((file) => file.id === skill.id)).map((skill) => skill.id),
  }
}

/** The bridge's `kebab_dir`: lowercase alphanumerics, any run of other characters one `-`, no edge `-`, at most 64. */
export function kebab(id: string) {
  return id
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .toLowerCase()
    .slice(0, 64)
    .replace(/-+$/, "")
}

/** The bridge's `skill_markdown_named`: the front matter's `name` is forced to the directory, which OpenCode requires. */
export function markdown(skill: Entry, dir: string) {
  const body = skill.instructions ?? ""
  const trimmed = body.trimStart()
  const rest = trimmed.startsWith("---") ? trimmed.slice(3) : undefined
  const end = rest?.indexOf("\n---") ?? -1
  if (rest === undefined || end < 0)
    return newline(
      `---\nname: ${dir}\ndescription: ${scalar(skill.description ?? "")}\n${passthrough(skill.frontmatter)}---\n\n${body}`,
    )
  const lines = rest
    .slice(0, end)
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("name:") && line.trim() !== "")
  return newline(`---\n${[`name: ${dir}`, ...lines].join("\n")}\n---${rest.slice(end + 4)}`)
}

function newline(text: string) {
  return text.endsWith("\n") ? text : `${text}\n`
}

/**
 * The bridge's `yaml_scalar`: quoted when a plain scalar would be read as something else. Only `"` is escaped. Unlike the
 * bridge, an empty description is written as `""`: left bare it reads as null, which makes OpenCode skip the whole skill.
 */
function scalar(text: string) {
  if (text === "") return '""'
  if (!text.includes(":") && !text.includes("#") && !/^[-?!&*|>'"%@`]/.test(text)) return text
  return `"${text.replaceAll('"', '\\"')}"`
}

/** Keys the platform re-emits itself (or keeps as catalogue metadata) never pass through. */
const owned = ["name", "title", "description", "tags", "category", "display_category", "hosts"]

// The bridge renders the author's other keys with `serde_yaml`, keys sorted at every depth.
function passthrough(frontmatter: Entry["frontmatter"]) {
  const kept = Object.entries(frontmatter ?? {}).filter((entry) => !owned.includes(entry[0]))
  if (kept.length === 0) return ""
  return `${mapping(Object.fromEntries(kept), 0).join("\n")}\n`
}

// serde_yaml's block layout: two spaces per level, a sequence under a key at the key's own indent, strings plain unless
// that would change their meaning (then single-quoted). A string with a line break is double-quoted here, where
// serde_yaml writes a literal block: both read back as the same string.
function mapping(value: object, depth: number): string[] {
  const pad = "  ".repeat(depth)
  return Object.entries(value)
    .toSorted((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .flatMap(([key, item]) => {
      if (Array.isArray(item) && item.length > 0) return [`${pad}${text(key)}:`, ...sequence(item, depth)]
      if (isObject(item) && !Array.isArray(item) && Object.keys(item).length > 0)
        return [`${pad}${text(key)}:`, ...mapping(item, depth + 1)]
      return [`${pad}${text(key)}: ${flat(item)}`]
    })
}

function sequence(items: ReadonlyArray<unknown>, depth: number): string[] {
  const pad = "  ".repeat(depth)
  return items.flatMap((item) => {
    const nested =
      Array.isArray(item) && item.length > 0
        ? sequence(item, depth + 1)
        : isObject(item) && !Array.isArray(item) && Object.keys(item).length > 0
          ? mapping(item, depth + 1)
          : undefined
    // The dash takes the place of the first line's indent.
    if (nested) return [`${pad}- ${(nested[0] ?? "").slice(pad.length + 2)}`, ...nested.slice(1)]
    return [`${pad}- ${flat(item)}`]
  })
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null
}

function flat(value: unknown) {
  if (Array.isArray(value)) return "[]"
  if (isObject(value)) return "{}"
  if (typeof value === "string") return text(value)
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return "null"
}

function text(value: string) {
  if (/[\n\r\t]/.test(value)) return JSON.stringify(value)
  const plain =
    value !== "" &&
    value === value.trim() &&
    !/^[-?:,[\]{}#&*!|>'"%@`]/.test(value) &&
    !value.includes(": ") &&
    !value.includes(" #") &&
    !value.endsWith(":") &&
    !/^(~|null|true|false|y|n|yes|no|on|off)$/i.test(value) &&
    Number.isNaN(Number(value)) &&
    !/^[-+.]?\d/.test(value)
  return plain ? value : `'${value.replaceAll("'", "''")}'`
}

/** The bridge's bundle version: the first 16 hex digits of the SHA-256 of every directory and its file. */
export function version(files: Projection["files"]) {
  const hasher = new Bun.CryptoHasher("sha256")
  files.forEach((file) => hasher.update(`${file.dir}\0${file.markdown}\0`))
  return hasher.digest("hex").slice(0, 16)
}

const Ledger = Schema.Struct({
  version: Schema.String,
  // Ids are removed from disk, so only what the bridge could have written is accepted
  ids: Schema.Array(Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/))),
  marketplaces: Schema.optional(Schema.Array(Schema.String)),
})
const decodeLedger = Schema.decodeUnknownOption(Schema.fromJsonString(Ledger))

/**
 * Writes `projection` into `<directory>/skills`, or removes everything the ledger lists when it is undefined. Files are
 * replaced atomically and only when their content changes. A corrupt ledger fails rather than reading as empty, since
 * it is what keeps the user's own skills from being taken for ours.
 */
export async function write(directory: string, projection: Projection | undefined) {
  const root = path.join(directory, "skills")
  const previous = await read(path.join(root, ledgerName))
  const kept = projection?.files.map((file) => file.dir) ?? []
  await Promise.all(
    (projection?.files ?? []).map((file) => replace(path.join(root, file.dir, "SKILL.md"), file.markdown)),
  )
  await Promise.all(
    previous.filter((id) => !kept.includes(id)).map((id) => rm(path.join(root, id), { recursive: true, force: true })),
  )
  if (!projection) return rm(path.join(root, ledgerName), { force: true })
  await replace(
    path.join(root, ledgerName),
    JSON.stringify({ version: version(projection.files), ids: kept, marketplaces: projection.marketplaces }, null, 2),
  )
}

async function read(file: string) {
  const source = Bun.file(file)
  if (!(await source.exists())) return []
  const ledger = decodeLedger(await source.text())
  if (Option.isNone(ledger)) throw new Error(`${file} is corrupt; refusing to treat a corrupt ledger as empty`)
  return ledger.value.ids
}

async function replace(file: string, content: string) {
  const source = Bun.file(file)
  if ((await source.exists()) && (await source.text()) === content) return
  await mkdir(path.dirname(file), { recursive: true })
  // The temporary file is hidden, so OpenCode's scan never reads it, and sits next to the target for an atomic rename.
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`)
  await Bun.write(temporary, content)
  await rename(temporary, file)
}
