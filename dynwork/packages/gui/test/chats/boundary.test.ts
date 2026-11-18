import { describe, expect, test } from "bun:test"
import path from "node:path"

// Design 0 of the phase: a cloud chat is the same chat UI with no OpenCode backend behind it. Nothing under the chats'
// code may reach OpenCode's runtime: no client or SDK call, no core, server or schema module, no service endpoint. Only
// the type shapes of messages and events (`import type`) and the session UI's components are used.
const roots = ["src/chats", "src/views/chats"]
const runtime = /^@opencode\/(?:client|sdk|core|server|schema)(?:\/|$)/
const service = /serverEndpoints|"sidecar"|OpenCode\.make|\bopencode serve\b/

async function sources() {
  const root = path.join(import.meta.dir, "../..")
  const found = await Promise.all(
    roots.map((dir) =>
      Array.fromAsync(new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: path.join(root, dir) })).then((files) =>
        files.map((file) => path.join(dir, file)),
      ),
    ),
  )
  return Promise.all(found.flat().map(async (file) => ({ file, text: await Bun.file(path.join(root, file)).text() })))
}

// Every module a file reads, and whether only its types are read.
function imports(text: string) {
  const statements = [...text.matchAll(/^\s*(import|export)\s+(type\s+)?[^"']*?from\s+["']([^"']+)["']/gm)].map(
    (match) => ({
      module: match[3]!,
      types: match[2] !== undefined,
    }),
  )
  const bare = [...text.matchAll(/^\s*import\s+["']([^"']+)["']/gm)].map((match) => ({
    module: match[1]!,
    types: false,
  }))
  const dynamic = [...text.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)].map((match) => ({
    module: match[1]!,
    types: false,
  }))
  return [...statements, ...bare, ...dynamic]
}

describe("the chats' import boundary", () => {
  test("it scans the chats' code", async () => {
    const files = (await sources()).map((source) => source.file)
    expect(files).toContain("src/chats/client.ts")
    expect(files).toContain("src/chats/document.ts")
    expect(files).toContain("src/views/chats/index.tsx")
  })

  test("imports nothing of OpenCode's runtime, only the types of its message and event shapes", async () => {
    const violations = (await sources()).flatMap((source) =>
      imports(source.text)
        .filter((item) => runtime.test(item.module) && !item.types)
        .map((item) => `${source.file}: ${item.module}`),
    )
    expect(violations).toEqual([])
  })

  test("never reaches OpenCode's service", async () => {
    const violations = (await sources()).filter((source) => service.test(source.text)).map((source) => source.file)
    expect(violations).toEqual([])
  })

  test("the scan catches a runtime import", () => {
    const found = imports(
      'import { OpenCode } from "@opencode/client/promise"\nimport type { X } from "@opencode/client"',
    )
    expect(found.filter((item) => runtime.test(item.module) && !item.types)).toEqual([
      { module: "@opencode/client/promise", types: false },
    ])
  })
})
