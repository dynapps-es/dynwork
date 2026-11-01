export * as DynWorkSkills from "./skills"

import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
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

// A skill's runtime files (`references/*`, `config.yaml`, `.systemprompt-source/<revision>/...`) come from its
// publication bundle, which main reads with the device credential. They are written beside the projected `SKILL.md` as
// the bridge's `feedback/readback.rs` does: modes 0644 or 0755, a sidecar listing them, files a previous plan listed and
// this one does not removed, then every file read back for the receipt. The skill's directory stays the projection's:
// it goes with the skill, runtime files included.

const sidecarName = ".systemprompt-runtime.json"
const sidecarLimit = 1024 * 1024
const planLimit = 24 * 1024 * 1024

type Planned = { readonly path: string; readonly bytes: Buffer; readonly executable: boolean }

/**
 * Writes `files` into the directory of `skill`, when the projection wrote one for it, and reads them back. The plan's
 * own `SKILL.md` is written and read back like the bridge does, then the projected one is restored, as the bridge's next
 * sync does: the projection owns that file.
 */
export async function install(
  directory: string,
  projection: Projection | undefined,
  skill: string,
  files: ReadonlyArray<DynWorkSync.RuntimeFile>,
): Promise<DynWorkSync.Materialized> {
  const owned = projection?.files.find((file) => file.dir === kebab(skill))
  const root = owned && path.join(directory, "skills", owned.dir)
  if (!owned || !root || !(await Bun.file(path.join(root, "SKILL.md")).exists()))
    return { outcome: "missing", files: [] }
  const plan = files.map((file) => ({
    path: file.path,
    bytes: Buffer.from(file.content, "base64"),
    executable: file.executable,
  }))
  const previous = await listed(root)
  if (!validPlan(plan) || previous === undefined) return { outcome: "invalid", files: [] }
  const stale = previous.filter((entry) => !plan.some((file) => file.path === entry))
  const targets = await Promise.all([...plan.map((file) => file.path), ...stale].map((entry) => target(root, entry)))
  if (targets.some((entry) => entry === undefined)) return { outcome: "invalid", files: [] }
  await Promise.all(plan.map((file) => store(path.join(root, file.path), file.bytes, file.executable ? 0o755 : 0o644)))
  await Promise.all(stale.map((entry) => rm(path.join(root, entry), { force: true })))
  await store(path.join(root, sidecarName), Buffer.from(JSON.stringify(plan.map((file) => file.path))), 0o600)
  const readback = await Promise.all(plan.map((file) => readBack(path.join(root, file.path), file)))
  await replace(path.join(root, "SKILL.md"), owned.markdown)
  return { outcome: "written", files: readback }
}

/**
 * Whether the files a receipt recorded for `skill` are still on disk as written, so they need no new plan. `SKILL.md`
 * is not compared: the projection rewrote it.
 */
export async function inspect(
  directory: string,
  projection: Projection | undefined,
  skill: string,
  files: ReadonlyArray<DynWorkSync.Recorded>,
) {
  const owned = projection?.files.find((file) => file.dir === kebab(skill))
  if (!owned) return false
  const root = path.join(directory, "skills", owned.dir)
  const checks = await Promise.all(
    files
      .filter((file) => file.path !== "SKILL.md")
      .map(async (file) => {
        const found = validPath(file.path) ? await target(root, file.path) : undefined
        if (found === undefined) return false
        const read = await readBack(path.join(root, file.path), {
          path: file.path,
          bytes: Buffer.alloc(0),
          executable: file.executable,
        })
        return read.digest === file.digest && read.bytes === file.bytes && read.mode !== "mismatch"
      }),
  )
  return checks.every(Boolean)
}

// The bridge's `validate_plan`: some files and not too many, each path once and relative, at most 24 MiB, and SKILL.md.
function validPlan(plan: ReadonlyArray<Planned>) {
  const paths = new Set(plan.map((file) => file.path))
  return (
    plan.length > 0 &&
    plan.length <= 8192 &&
    paths.size === plan.length &&
    paths.has("SKILL.md") &&
    plan.every((file) => validPath(file.path)) &&
    plan.reduce((total, file) => total + file.bytes.length, 0) <= planLimit
  )
}

// The instance's `validate_relative_path`: no separator but `/`, no drive or NUL, no empty, `.` or `..` segment.
function validPath(relative: string) {
  return (
    relative.length > 0 &&
    relative.length <= 4096 &&
    !/[\\:\0]/.test(relative) &&
    relative.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  )
}

// The paths the previous plan wrote; undefined when the sidecar is not one the plugin could have written.
async function listed(root: string) {
  const source = Bun.file(path.join(root, sidecarName))
  if (!(await source.exists())) return []
  if (source.size > sidecarLimit) return undefined
  const paths = decodeSidecar(await source.text())
  if (paths._tag === "None" || !paths.value.every(validPath)) return undefined
  return paths.value
}

const decodeSidecar = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)))

// The bridge's `safe_target`: undefined when the directory or any segment below it is a symbolic link.
async function target(root: string, relative: string) {
  const segments = relative.split("/").map((_, index, parts) => path.join(root, ...parts.slice(0, index + 1)))
  const links = await Promise.all(
    [root, ...segments].map((entry) =>
      lstat(entry).then(
        (info) => info.isSymbolicLink(),
        () => false,
      ),
    ),
  )
  return links.some(Boolean) ? undefined : path.join(root, relative)
}

// Written through a hidden temporary file and a rename, with its mode set before it appears.
async function store(file: string, bytes: Buffer, mode: number) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`)
  await writeFile(temporary, bytes)
  await chmod(temporary, mode)
  await rename(temporary, file)
}

// What is on disk now: its digest and size, whether it holds the planned bytes, and whether its mode is the planned
// one (unavailable without POSIX modes).
async function readBack(file: string, planned: Planned): Promise<DynWorkSync.Readback> {
  const info = await lstat(file).catch(() => undefined)
  const bytes = info?.isFile() ? await readFile(file) : Buffer.alloc(0)
  const expected = planned.executable ? 0o755 : 0o644
  return {
    path: planned.path,
    digest: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    executable: planned.executable,
    content: info?.isFile() && bytes.equals(planned.bytes) ? "verified" : "mismatch",
    mode:
      process.platform === "win32"
        ? "unavailable"
        : info?.isFile() && (info.mode & 0o7777) === expected
          ? "verified"
          : "mismatch",
  }
}
