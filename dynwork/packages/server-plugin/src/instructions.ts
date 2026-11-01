export * as DynWorkInstructions from "./instructions"

import { rename, rm } from "node:fs/promises"
import path from "node:path"

// The instance's rules as a managed block of the service's global `AGENTS.md`, the file the systemprompt bridge wrote:
// OpenCode loads it into every Session's instructions and watches it, so a change reaches each Session at its next
// step. Whatever the user wrote outside the block stays as it is.

export const begin = "<!-- systemprompt:begin (managed by DynWork; edits are replaced) -->"
export const end = "<!-- systemprompt:end -->"

// Any begin marker counts, so a block an older writer left behind is replaced too.
const block = /<!-- systemprompt:begin\b[^\n]*-->\n[\s\S]*?<!-- systemprompt:end -->\n?/

/** `existing` with the block holding `rules`, or without the block when `rules` is undefined; undefined when empty. */
export function merge(existing: string, rules: string | undefined) {
  const managed = rules === undefined ? "" : `${begin}\n\n${rules}\n${end}\n`
  if (block.test(existing)) {
    const next = existing.replace(block, () => managed)
    if (!next.trim()) return undefined
    // Removing an appended block leaves the separator it was appended with.
    return managed ? next : `${next.trimEnd()}\n`
  }
  if (!managed) return existing || undefined
  return existing.trim() ? `${existing.trimEnd()}\n\n${managed}` : managed
}

/** Writes `rules` into `<directory>/AGENTS.md` atomically, only when the file changes; removes it once it is empty. */
export async function write(directory: string, rules: string | undefined) {
  const file = path.join(directory, "AGENTS.md")
  const source = Bun.file(file)
  const existing = (await source.exists()) ? await source.text() : undefined
  const next = merge(existing ?? "", rules)
  if (next === existing) return
  if (next === undefined) return rm(file, { force: true })
  // The temporary file sits next to the target, so the rename stays on one file system.
  const temporary = path.join(directory, `.AGENTS.md.${crypto.randomUUID()}.tmp`)
  await Bun.write(temporary, next)
  await rename(temporary, file)
}
