import { cp, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

// Boots a real `opencode serve` from the workspace CLI in a temp root, with the plugin loaded from a copy of what the
// desktop build ships (package.json and src, no node_modules) through OPENCODE_CONFIG_CONTENT, like DynWork's own
// service. HOME, XDG dirs, config dir and database all live in the root; the port is chosen by the OS.

const cli = path.join(import.meta.dir, "../../../../packages/cli")
const transpilerCache = path.join(tmpdir(), "opencode-test-transpiler-cache")

export async function boot(extra: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "dynwork-server-plugin-"))
  const plugin = path.join(root, "dynwork-server-plugin")
  await mkdir(plugin)
  await cp(path.join(import.meta.dir, "../package.json"), path.join(plugin, "package.json"))
  await cp(path.join(import.meta.dir, "../src"), path.join(plugin, "src"), { recursive: true })
  const projects = [path.join(root, "project-a"), path.join(root, "project-b")]
  await Promise.all(projects.map((project) => mkdir(project)))
  const password = crypto.randomUUID()
  const child = Bun.spawn(
    [process.execPath, "run", "src/index.ts", "serve", "--hostname", "127.0.0.1", "--port", "0"],
    {
      cwd: cli,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter((entry) => !entry[0].startsWith("OPENCODE_"))),
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: transpilerCache,
        HOME: root,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugins: [plugin] }),
        OPENCODE_CONFIG_DIR: path.join(root, "config"),
        OPENCODE_DB: path.join(root, "opencode.db"),
        OPENCODE_DISABLE_FILEWATCHER: "true",
        OPENCODE_DISABLE_MODELS_FETCH: "true",
        OPENCODE_PASSWORD: password,
        OPENCODE_TEST_HOME: root,
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_CONFIG_HOME: path.join(root, "xdg-config"),
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_STATE_HOME: path.join(root, "state"),
        ...extra,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const stderr = new Response(child.stderr).text()
  const url = await listening(child.stdout).catch(async (error) => {
    child.kill()
    throw new Error(`opencode serve did not start: ${error}\n${await stderr}`)
  })
  const headers = { authorization: `Basic ${btoa(`opencode:${password}`)}` }
  return {
    root,
    projects,
    url,
    headers,
    database: path.join(root, "opencode.db"),
    get: async (route: string, directory: string) => {
      const response = await fetch(`${url}${route}?location[directory]=${encodeURIComponent(directory)}`, { headers })
      if (!response.ok) throw new Error(`GET ${route}: ${response.status} ${await response.text()}`)
      return response.json()
    },
    post: async (route: string, body: unknown, directory?: string) => {
      const query = directory ? `?location[directory]=${encodeURIComponent(directory)}` : ""
      const response = await fetch(`${url}${route}${query}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      return { status: response.status, body: await response.json() }
    },
    stop: async () => {
      child.kill()
      await child.exited
      await rm(root, { recursive: true, force: true })
    },
  }
}

async function listening(stdout: ReadableStream<Uint8Array>) {
  const reader = stdout.getReader()
  const decoder = new TextDecoder()
  const deadline = AbortSignal.timeout(25_000)
  const text = { value: "" }
  while (!deadline.aborted) {
    const chunk = await reader.read()
    if (chunk.done) break
    text.value += decoder.decode(chunk.value, { stream: true })
    const match = text.value.match(/server listening on (http:\/\/\S+)/)
    if (match?.[1]) {
      reader.releaseLock()
      return match[1].replace(/\/$/, "")
    }
  }
  throw new Error(`no listening line in ${JSON.stringify(text.value)}`)
}

/** Polls until `check` holds, for up to `ms` of real time. */
export async function until<T>(read: () => Promise<T>, check: (value: T) => boolean, ms = 15_000) {
  const deadline = Date.now() + ms
  const last = { value: await read() }
  while (!check(last.value) && Date.now() < deadline) {
    await Bun.sleep(100)
    last.value = await read()
  }
  return last.value
}
