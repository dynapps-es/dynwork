// What the smoke (`smoke.ts`) and the end-to-end run (`e2e-sp.ts`) share: an isolated DynWork profile, the installed
// app launched in it with a CDP port, a small CDP client, the sign-in form driven like a keyboard user, and stopping
// only the processes the run started.
//
// The profile follows packages/desktop/script/bench-startup.ts: its own home, userData, XDG directories, database,
// config and service registration, and none of the developer's OPENCODE_* variables. It never attaches to or restarts
// the developer's running OpenCode service.
import { mkdir, mkdtemp } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"

export const repo = path.resolve(import.meta.dir, "../..")

export const installed = "/Applications/DynWork.app"

export type Cdp = Awaited<ReturnType<typeof connect>>

export type Profile = Awaited<ReturnType<typeof profile>>

/**
 * A fresh profile under the temp dir. `onboarded` false starts as a first install; `extra` adds to the environment the
 * app runs with.
 */
export async function profile(input: { prefix: string; onboarded: boolean; extra?: Record<string, string> }) {
  const root = await mkdtemp(path.join(tmpdir(), input.prefix))
  const config = path.join(root, "config/opencode")

  for (const dir of ["home", "data", "desktop", "state/opencode"])
    await mkdir(path.join(root, dir), { recursive: true })
  await mkdir(config, { recursive: true })

  // A service using this config dir would otherwise listen on the channel's default port, which the developer's own
  // service holds. DynWork's own service ignores it; a foreign one and a DynWork without its own service use it.
  await Bun.write(path.join(config, "service.json"), JSON.stringify({ port: await freePort() }))
  await Bun.write(
    path.join(root, "desktop/opencode.settings"),
    JSON.stringify({ firstLaunchOnboardingComplete: input.onboarded }),
  )

  return {
    root,
    config,
    // The default registration of the profile, where OpenCode.app's service would register.
    registration: path.join(root, "state/opencode/service.json"),
    // DynWork's own registration, under its userData (`<root>/desktop`, see OPENCODE_DESKTOP_TEST_ROOT).
    ownRegistration: path.join(root, "desktop/service/state/opencode/service.json"),
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter((entry) => !/^(OPENCODE_|OTEL_|SENTRY_)/.test(entry[0])),
      ),
      HOME: path.join(root, "home"),
      OPENCODE_DESKTOP_TEST_ROOT: root,
      OPENCODE_DB: path.join(root, "data/opencode.db"),
      OPENCODE_CONFIG_DIR: config,
      // A closed proxy port makes the update check fail at once and offline.
      HTTPS_PROXY: "http://127.0.0.1:9",
      ...input.extra,
    },
  }
}

/**
 * Starts the app of `bundle` in the profile with a CDP port. The mock keychain keeps safeStorage off the developer's
 * login Keychain: the profile seals its PATs with a throwaway key, the same on every launch.
 */
export function launch(target: Profile, cdpPort: number, bundle = installed, extra: string[] = []) {
  return Bun.spawn(
    [
      path.join(bundle, "Contents/MacOS/DynWork"),
      `--remote-debugging-port=${cdpPort}`,
      "--use-mock-keychain",
      ...extra,
    ],
    { env: target.env, stdio: ["ignore", "ignore", "ignore"] },
  )
}

/** The main window's CDP connection, once it has loaded the app. */
export async function mainWindow(cdpPort: number, timeout = 90_000) {
  const page = await waitFor(
    "the main window",
    async () =>
      (await targets(cdpPort)).find((target) => target.type === "page" && target.url.startsWith("oc://"))
        ?.webSocketDebuggerUrl,
    timeout,
  )

  return connect(page)
}

/** Waits for the app shell under the sign-in screen and says what the window shows when it does not come. */
export function shell(cdp: Cdp, timeout = 60_000) {
  return waitFor(
    "the app shell",
    async () =>
      cdp.value<boolean>(
        `!!document.querySelector('#root [data-titlebar-tab-link], #root [data-action="vertical-tabs-home"], #root [data-action="home-new-session"], #root [data-action="home-add-project-row"]')`,
      ),
    timeout,
  ).catch(async (error: Error) => {
    const seen = await cdp.value<string>(`location.href + " | " + document.body.innerText.slice(0, 300)`)
    throw new Error(`${error.message}; the window shows: ${seen}`)
  })
}

/**
 * Fills the connect form, the sign-in screen's and the Add instance dialog's: types the instance URL, waits for the
 * green status, opens the token field and types the token (a PAT or a one-time code).
 */
export async function fillConnect(cdp: Cdp, target: { url: string; token: string }) {
  const seen = (selector: string) => cdp.value<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`)

  await waitFor("the instance URL field", async () => seen("#dynwork-signin-url"), 60_000)
  await cdp.value(`document.querySelector("#dynwork-signin-url").focus()`)
  await cdp.send("Input.insertText", { text: target.url })
  await waitFor("a reachable instance URL", async () => seen('[data-slot="signin-status"][data-tone="valid"]'), 10_000)
  await cdp.value(`document.querySelector('[data-slot="signin-token-toggle"]').click()`)
  await waitFor("the token field", async () => seen("#dynwork-signin-token"), 5_000)
  await cdp.value(`document.querySelector("#dynwork-signin-token").focus()`)
  await cdp.send("Input.insertText", { text: target.token })
}

export async function pressEnter(cdp: Cdp) {
  for (const type of ["keyDown", "keyUp"])
    await cdp.send("Input.dispatchKeyEvent", {
      type,
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      ...(type === "keyDown" ? { text: "\r" } : {}),
    })
}

export async function screenshot(cdp: Cdp, file: string) {
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" })

  await Bun.write(file, Buffer.from(shot.result.data, "base64"))
  return file
}

/** A service registration file, or undefined while there is none. */
export async function read(file: string) {
  return Bun.file(file)
    .json()
    .then((value: { pid: number; url: string; version?: string; password?: string }) => value)
    .catch(() => undefined)
}

export function authorization(info: { password?: string }) {
  if (!info.password) return undefined

  return { authorization: `Basic ${Buffer.from(`opencode:${info.password}`).toString("base64")}` }
}

export async function health(info: { url: string; password?: string }) {
  return fetch(new URL("/api/info", info.url), {
    headers: authorization(info),
    signal: AbortSignal.timeout(2000),
  })
    .then((response) => response.json() as Promise<{ version?: string; pid?: number }>)
    .catch(() => undefined)
}

/**
 * Stops only what the run started: the processes in `started` and their children, and the background services
 * registered in the profile's `registrations` whose command line runs from the profile.
 */
export async function stop(root: string, started: number[], registrations: string[]) {
  const registered = (await Promise.all(registrations.map(async (file) => (await read(file))?.pid))).filter(
    (pid): pid is number => pid !== undefined,
  )
  const service = (
    await Promise.all(
      registered.map(async (pid) =>
        (await Bun.$`ps -p ${pid} -o command=`.nothrow().text()).includes(root) ? [pid] : [],
      ),
    )
  ).flat()
  const rows = (await Bun.$`ps -eo pid=,ppid=`.text())
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
  const tree = new Set(started)

  for (const _ of rows) for (const row of rows) if (tree.has(row[1])) tree.add(row[0])

  const pids = new Set([...tree, ...service])

  for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGTERM")
  await Bun.sleep(3000)
  for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL")
  await Bun.sleep(500)
}

export function alive(pid: number) {
  return Bun.spawnSync(["kill", "-0", String(pid)]).exitCode === 0
}

export async function portFree(port: number) {
  const server = createServer()

  return new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false))
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)))
  })
}

export async function freePort() {
  const server = createServer()

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  await new Promise((resolve) => server.close(resolve))
  if (typeof address !== "object" || !address) throw new Error("No free port")

  return address.port
}

async function targets(cdpPort: number) {
  return fetch(`http://127.0.0.1:${cdpPort}/json`)
    .then((response) => response.json() as Promise<{ type: string; url: string; webSocketDebuggerUrl: string }[]>)
    .catch(() => [])
}

export async function waitFor<T>(
  what: string,
  check: () => Promise<T | undefined | false>,
  timeout: number,
  every = 250,
) {
  const deadline = Date.now() + timeout

  while (Date.now() < deadline) {
    const value = await check().catch(() => undefined)

    if (value) return value
    await Bun.sleep(every)
  }

  throw new Error(`Timed out waiting for ${what}`)
}

export async function connect(url: string) {
  const ws = new WebSocket(url)
  const pending = new Map<number, (message: any) => void>()
  let id = 0

  await new Promise((resolve) => (ws.onopen = resolve))
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data))

    pending.get(message.id)?.(message)
    pending.delete(message.id)
  }

  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((resolve) => {
      pending.set(++id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
    })

  return {
    send,
    value: async <T>(expression: string) =>
      (await send("Runtime.evaluate", { expression, returnByValue: true })).result?.result?.value as T,
    close: () => ws.close(),
  }
}

/** An instance's URL and PAT from the local harness' generated environment. */
export async function localInstance(name: "ALPHA" | "BETA") {
  const env = await Bun.file(path.join(repo, "dynwork/test/sp-local/.env.local"))
    .text()
    .catch(() => {
      throw new Error("dynwork/test/sp-local/.env.local is missing: run `bun dynwork/script/sp-local.ts up`")
    })
  const read = (key: string) => new RegExp(`^${key}=(.*)$`, "m").exec(env)?.[1]?.trim()
  const url = read(`SP_${name}_URL`)
  const pat = read(`SP_${name}_PAT`)

  if (!url || !pat) throw new Error(`SP_${name}_URL or SP_${name}_PAT is missing from the local harness' environment`)

  return { url, pat, userId: read(`SP_${name}_USER_ID`) }
}
