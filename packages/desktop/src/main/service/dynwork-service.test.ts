import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DynWorkService } from "@dynwork/gui/service"
import { Service } from "@opencode/client/service"

const userData = "/profiles/es.dynapps.dynwork"

const resources = "/Applications/DynWork.app/Contents/Resources"

const app = (isPackaged: boolean) => ({
  isPackaged,
  getPath: () => userData,
  getAppPath: () => `${resources}/app.asar`,
})

// Where DynWork's service registers, listens and keeps its config and database. A change moves the service away from
// the profile, onto OpenCode's port, or back into the files OpenCode.app shares with every other client.
test.each([
  {
    build: "packaged prod",
    channel: "prod",
    packaged: true,
    expected: {
      file: "/profiles/es.dynapps.dynwork/service/state/opencode/service.json",
      args: ["--hostname", "127.0.0.1", "--port", "17495"],
      env: {
        XDG_STATE_HOME: "/profiles/es.dynapps.dynwork/service/state",
        XDG_DATA_HOME: "/profiles/es.dynapps.dynwork",
        OPENCODE_CONFIG_DIR: "/profiles/es.dynapps.dynwork/service/config",
        OPENCODE_DB: "/profiles/es.dynapps.dynwork/service/opencode.db",
        OPENCODE_CONFIG_CONTENT: `{"plugins":["${resources}/dynwork-server-plugin"]}`,
        DYNWORK_SHELL_ENV: '{"XDG_STATE_HOME":"/home/user/.local/state","XDG_DATA_HOME":null}',
      },
    },
  },
  { build: "unpackaged prod", channel: "prod", packaged: false, expected: undefined },
  { build: "packaged beta", channel: "beta", packaged: true, expected: undefined },
  { build: "packaged dev", channel: "dev", packaged: true, expected: undefined },
  { build: "local", channel: "local", packaged: false, expected: undefined },
])("the $build build runs the service layout of its channel", (row) => {
  process.env.XDG_STATE_HOME = "/home/user/.local/state"
  delete process.env.XDG_DATA_HOME
  expect(DynWorkService.layout(row.channel, app(row.packaged))).toEqual(row.expected)
})

test("the prod layout merges more server config, and a caller's plugins add to DynWork's", () => {
  const content = (config: Record<string, unknown>) =>
    JSON.parse(DynWorkService.layout("prod", app(true), config)?.env.OPENCODE_CONFIG_CONTENT ?? "{}")
  expect(content({ username: "dynwork" })).toEqual({
    username: "dynwork",
    plugins: [`${resources}/dynwork-server-plugin`],
  })
  expect(content({ plugins: ["/extra"] }).plugins).toEqual(["/extra", `${resources}/dynwork-server-plugin`])
})

// The prod electron-builder config ships the plugin directory under the name the layout loads it from.
test("the desktop build ships the server plugin where the layout looks for it", async () => {
  const { getConfig } = await import("../../../electron-builder.config")
  process.env.OPENCODE_CHANNEL = "prod"
  const shipped = getConfig().extraResources
  expect(shipped).toContainEqual({
    from: "../../dynwork/packages/server-plugin",
    to: DynWorkService.plugin,
    filter: ["package.json", "src/**/*"],
  })
})

const inherited = { ...process.env }

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in inherited)) delete process.env[key]
  Object.assign(process.env, inherited)
})

// The variables a login shell exported reach the service through main's environment. Spawns the service through the
// real client, with a stand-in for the CLI that registers where XDG_STATE_HOME says and records what it inherited.
test("the prod service never inherits the login shell's OpenCode setup", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dynwork-service-"))
  delete process.env.XDG_STATE_HOME
  delete process.env.XDG_DATA_HOME
  const own = DynWorkService.layout("prod", { isPackaged: true, getPath: () => root, getAppPath: () => "/r/app.asar" })
  if (!own) throw new Error("No prod layout")
  Object.assign(process.env, {
    OPENCODE_CONFIG: "/shell/opencode.json",
    OPENCODE_CONFIG_CONTENT: '{"username":"shell"}',
    OPENCODE_CONFIG_DIR: "/shell/config",
    OPENCODE_CLIENT: "desktop",
    ...Object.fromEntries(DynWorkService.inherited.map((key) => [key, "shell"])),
    OPENCODE_DISABLE_EMBEDDED_WEB_UI: "true",
    OPENCODE_DESKTOP_SERVER_CHANNEL: "prod",
  })

  DynWorkService.isolate(process.env)
  const endpoint = await Service.ensure({
    file: own.file,
    env: own.env,
    version: "fixture",
    command: [process.execPath, "-e", standIn],
  })
  const registered: { pid: number; env: Record<string, string | undefined> } = await Bun.file(own.file).json()
  process.kill(registered.pid, "SIGTERM")
  await rm(root, { recursive: true, force: true })

  expect(new URL(endpoint.url).hostname).toBe("127.0.0.1")
  expect(registered.env).toEqual({
    OPENCODE_CONFIG_DIR: path.join(root, "service/config"),
    OPENCODE_DB: path.join(root, "service/opencode.db"),
    XDG_STATE_HOME: path.join(root, "service/state"),
    XDG_DATA_HOME: root,
    OPENCODE_CONFIG_CONTENT: '{"plugins":["/r/dynwork-server-plugin"]}',
    OPENCODE_CLIENT: "desktop",
    OPENCODE_DISABLE_EMBEDDED_WEB_UI: "true",
    OPENCODE_DESKTOP_SERVER_CHANNEL: "prod",
    DYNWORK_SHELL_ENV: '{"XDG_STATE_HOME":null,"XDG_DATA_HOME":null}',
  })
})

// Answers the client's health check and registers like `opencode serve --service`, plus the environment it saw.
const standIn = `
const password = crypto.randomUUID()
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => Response.json({ version: "fixture", pid: process.pid }),
})
const env = Object.fromEntries(
  Object.entries(process.env).filter((entry) => /^(OPENCODE_|DYNWORK_|XDG_(STATE|DATA)_HOME)/.test(entry[0])),
)
await Bun.write(
  process.env.XDG_STATE_HOME + "/opencode/service.json",
  JSON.stringify({ id: "fixture", version: "fixture", url: server.url.origin, pid: process.pid, password, env }),
)
`
