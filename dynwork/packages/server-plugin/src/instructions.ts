export * as DynWorkInstructions from "./instructions"

import { rename, rm } from "node:fs/promises"
import path from "node:path"
import type { DynWorkSync } from "./contract"

// The instance's rules as the managed block of the service's global `AGENTS.md`, byte for byte the block the
// systemprompt bridge writes into OpenCode's: OpenCode loads it into every Session's instructions and watches it, so a
// change reaches each Session at its next step. Whatever the user wrote outside the block stays.

export const begin = "<!-- systemprompt:begin (managed by the bridge; edits are replaced) -->"
export const end = "<!-- systemprompt:end -->"

/** OpenCode stops reading AGENTS.md instructions past this many characters: rules beyond it never reach the model. */
export const budget = 24_000

const hosts = ["opencode", "opencode-cli"]

/** The rules that name an OpenCode packaging, ordered by id. Unlike skills, a rule with no `hosts` targets no host. */
export function select(rules: ReadonlyArray<DynWorkSync.Manifest["rules"][number]>) {
  return rules
    .filter((rule) => rule.hosts?.some((host) => hosts.includes(host)))
    .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** The block for `select`ed rules, or undefined without any. Never cut: one over `budget` is reported by `overBudget`. */
export function block(selected: ReadonlyArray<DynWorkSync.Manifest["rules"][number]>) {
  if (selected.length === 0) return undefined
  return `${begin}\n${selected.map((rule) => `\n## ${rule.name}\n\n${rule.instructions?.trim() ?? ""}\n`).join("")}\n${end}\n`
}

/** The block's length in characters when it is over `budget`. */
export function overBudget(text: string | undefined) {
  const length = text === undefined ? 0 : [...text].length
  return length > budget ? length : undefined
}

/** `existing` with its block replaced by `managed` (appended at the end), or removed when `managed` is undefined. */
export function splice(existing: string, managed: string | undefined) {
  const start = existing.indexOf(begin)
  const stop = existing.indexOf(end)
  const outside = (
    start >= 0 && stop > start
      ? existing.slice(0, start).trimEnd() + existing.slice(stop + end.length).replace(/^\n+/, "")
      : existing
  ).trimEnd()
  if (!outside) return managed ?? ""
  return managed === undefined ? `${outside}\n` : `${outside}\n\n${managed}`
}

/** Writes `managed` into `<directory>/AGENTS.md` atomically, only when the file changes; removes the file once empty. */
export async function write(directory: string, managed: string | undefined) {
  const file = path.join(directory, "AGENTS.md")
  const source = Bun.file(file)
  const existing = (await source.exists()) ? await source.text() : ""
  const next = splice(existing, managed)
  if (next === existing) return
  if (!next) return rm(file, { force: true })
  // The temporary file sits next to the target, so the rename stays on one file system.
  const temporary = path.join(directory, `.AGENTS.md.${crypto.randomUUID()}.tmp`)
  await Bun.write(temporary, next)
  await rename(temporary, file)
}
