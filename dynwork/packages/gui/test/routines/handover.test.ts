import { describe, expect, test } from "bun:test"
import path from "node:path"

// Every place the Agent Farm plugs in carries a `JESÚS:` comment that names the contract piece it implements, so that
// the person who writes the backend finds each hook by searching for the marker. These tests read the sources.
const src = path.join(import.meta.dir, "../../src")

// A backtick span with a piece of the contract in it: a `Backend` method or interface, or one of the data types.
const piece =
  /`[^`]*\b(Backend|capabilities|options|validate|list|get|create|update|remove|pause|resume|start|cancel|runs|transcript|viewed|watch|Capabilities|Failure|Field|fields|Run|Routine|Definition|Transcript|Change|Routines|Registry|registry|status|quota|actions)\b[^`]*`/

async function comments() {
  const files = await Array.fromAsync(new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: src }))
  return (
    await Promise.all(
      files.map(async (file) => {
        const lines = (await Bun.file(path.join(src, file)).text()).split("\n")
        return lines.flatMap((line, index) =>
          line.includes("JESÚS:") ? [{ file, line: index + 1, text: comment(lines, index) }] : [],
        )
      }),
    )
  ).flat()
}

// The marker's line and what goes on with the same comment: up to the end of a block comment, or the `//` lines after it.
function comment(lines: readonly string[], start: number) {
  const first = lines[start] ?? ""
  const block = first.trim().startsWith("*") || first.includes("/*")
  const rest = lines.slice(start + 1)
  const length = rest.findIndex((line) => (block ? line.includes("*/") : !line.trim().startsWith("//")))
  const more = block ? rest.slice(0, length < 0 ? 0 : length + 1) : rest.slice(0, length < 0 ? rest.length : length)
  return [first, ...(block && first.includes("*/") ? [] : more)].join("\n")
}

describe("the farm handover markers", () => {
  test("there are enough of them, spread over the contract, the backend, the views and the farm folder", async () => {
    const found = await comments()
    expect(found.length).toBeGreaterThanOrEqual(8)
    const files = new Set(found.map((marker) => marker.file))
    expect(files).toContain("routines/contract.ts")
    expect(files).toContain("routines/backend.ts")
    expect(files).toContain("routines/main.ts")
    expect(files).toContain("routines/farm/backend.ts")
    expect([...files].some((file) => file.startsWith("views/agents/"))).toBe(true)
  })

  test("every marker names the contract piece it implements", async () => {
    const without = (await comments()).filter((marker) => !piece.test(marker.text))
    expect(without.map((marker) => `${marker.file}:${marker.line}`)).toEqual([])
  })

  test("the skeleton marks every method of Backend", async () => {
    const text = await Bun.file(path.join(src, "routines/farm/backend.ts")).text()
    const methods = [
      "capabilities",
      "options",
      "validate",
      "list",
      "get",
      "create",
      "update",
      "remove",
      "pause",
      "resume",
      "start",
      "cancel",
      "runs",
      "transcript",
      "viewed",
      "watch",
    ]
    const missing = methods.filter((method) => !new RegExp(`// JESÚS: \`${method}\\(`).test(text))
    expect(missing).toEqual([])
  })
})
