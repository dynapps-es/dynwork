import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

// An OpenCode service of its own for the recorder: `opencode serve` from this checkout on a port the OS picks, with HOME,
// the XDG directories, the config directory and the database in a temp root, and none of the caller's OPENCODE_*
// variables. Its only provider is the fake one, so no call can leave the machine. It never sees the user's profile, the
// installed DynWork or its port.

const cli = path.join(import.meta.dir, "../../../packages/cli")

export type Service = Awaited<ReturnType<typeof boot>>

export async function boot(input: { provider: string; config?: Record<string, unknown> }) {
  const root = await mkdtemp(path.join(tmpdir(), "dynwork-record-"))
  const password = crypto.randomUUID()
  // Git, which snapshots the project for diffs, needs an identity and must not read the user's own config
  await Bun.write(path.join(root, ".gitconfig"), "[user]\n\tname = recorder\n\temail = recorder@invalid\n")
  const child = Bun.spawn(
    [process.execPath, "run", "src/index.ts", "serve", "--hostname", "127.0.0.1", "--port", "0"],
    {
      cwd: cli,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter((entry) => !entry[0].startsWith("OPENCODE_"))),
        HOME: root,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          ...input.config,
          enabled_providers: ["fake"],
          provider: {
            fake: {
              npm: "@ai-sdk/anthropic",
              name: "Fake",
              options: { baseURL: input.provider, apiKey: "fake" },
              models: {
                "fake-1": {
                  name: "Fake 1",
                  tool_call: true,
                  reasoning: true,
                  limit: { context: 200_000, output: 8_000 },
                },
              },
            },
          },
          model: "fake/fake-1",
        }),
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
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const stderr = new Response(child.stderr).text()
  const url = await listening(child.stdout).catch(async (error) => {
    child.kill()
    await rm(root, { recursive: true, force: true })
    throw new Error(`opencode serve did not start: ${error}\n${await stderr}`)
  })
  const headers = { authorization: `Basic ${btoa(`opencode:${password}`)}` }
  const where = (route: string, directory?: string) =>
    directory ? `${route}${route.includes("?") ? "&" : "?"}location[directory]=${encodeURIComponent(directory)}` : route
  const call = async (method: string, route: string, body: unknown, directory?: string) => {
    const response = await fetch(`${url}${where(route, directory)}`, {
      method,
      headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`${method} ${route}: ${response.status} ${await response.text()}`)
    return response.status === 204 ? undefined : response.json()
  }
  return {
    root,
    url,
    headers,
    /** A fresh directory under the root, as a git repository, so each scenario has a project of its own. */
    project: async (name: string) => {
      const directory = path.join(root, name)
      await mkdir(directory)
      // A repository with one commit is a project of its own, and gives the edit tool's snapshots something to diff
      const git = (...argv: string[]) =>
        Bun.spawn(["git", "-c", "user.name=recorder", "-c", "user.email=recorder@invalid", ...argv], {
          cwd: directory,
          stdout: "ignore",
          stderr: "ignore",
        }).exited
      await git("init", "-q")
      await git("commit", "-q", "--allow-empty", "-m", "start")
      return directory
    },
    get: (route: string, directory?: string) => call("GET", route, undefined, directory),
    post: (route: string, body: unknown, directory?: string) => call("POST", route, body, directory),
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
  const deadline = AbortSignal.timeout(60_000)
  const seen = { text: "" }
  while (!deadline.aborted) {
    const chunk = await reader.read()
    if (chunk.done) break
    seen.text += decoder.decode(chunk.value, { stream: true })
    const match = seen.text.match(/server listening on (http:\/\/\S+)/)
    if (match?.[1]) {
      // Keep reading, so a full pipe never stalls the service
      void (async () => {
        while (!(await reader.read()).done);
      })()
      return match[1].replace(/\/$/, "")
    }
  }
  throw new Error(`no listening line in ${JSON.stringify(seen.text)}`)
}
