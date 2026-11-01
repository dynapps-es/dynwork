import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DynWorkService } from "@dynwork/gui/service"
import { Service } from "@opencode/client/service"

const userData = "/profiles/es.dynapps.dynwork"

const app = (isPackaged: boolean) => ({ isPackaged, getPath: () => userData })

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
      },
    },
  },
  { build: "unpackaged prod", channel: "prod", packaged: false, expected: undefined },
  { build: "packaged beta", channel: "beta", packaged: true, expected: undefined },
  { build: "packaged dev", channel: "dev", packaged: true, expected: undefined },
  { build: "local", channel: "local", packaged: false, expected: undefined },
])("the $build build runs the service layout of its channel", (row) => {
  expect(DynWorkService.layout(row.channel, app(row.packaged))).toEqual(row.expected)
})

test("the prod layout hands DynWork's own server config to the service", () => {
  expect(
    DynWorkService.layout("prod", app(true), { plugins: ["/dynwork/server-plugin"] })?.env.OPENCODE_CONFIG_CONTENT,
  ).toBe('{"plugins":["/dynwork/server-plugin"]}')
})

const inherited = { ...process.env }

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in inherited)) delete process.env[key]
  Object.assign(process.env, inherited)
})

// The variables a login shell exported reach the service through main's environment. Spawns the service through the
// real client, with a stand-in for the CLI that registers where XDG_STATE_HOME says and records what it inherited.
test("the prod service never inherits the login shell's OpenCode config", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dynwork-service-"))
  const own = DynWorkService.layout("prod", { isPackaged: true, getPath: () => root })
  if (!own) throw new Error("No prod layout")
  Object.assign(process.env, {
    OPENCODE_CONFIG: "/shell/opencode.json",
    OPENCODE_CONFIG_CONTENT: '{"username":"shell"}',
    OPENCODE_CONFIG_DIR: "/shell/config",
    OPENCODE_CLIENT: "desktop",
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
    OPENCODE_CLIENT: "desktop",
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
  Object.entries(process.env).filter((entry) => /^(OPENCODE_(CONFIG|DB|CLIENT)|XDG_(STATE|DATA)_HOME)/.test(entry[0])),
)
await Bun.write(
  process.env.XDG_STATE_HOME + "/opencode/service.json",
  JSON.stringify({ id: "fixture", version: "fixture", url: server.url.origin, pid: process.pid, password, env }),
)
`
