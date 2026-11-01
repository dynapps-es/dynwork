#!/usr/bin/env bun
// Launches the installed DynWork in an isolated profile, waits for its window, takes a screenshot and reads the
// theme background colors over CDP, then stops the processes it started.
//
//   bun dynwork/script/smoke.ts [screenshot] [theme-id] [light|dark] [home|new-session|first-launch]
//
// The screenshot defaults to plans/done/2026-10-dynwork-pilot/docs/smoke.png. With a theme id and a color scheme the
// script stores them as the app's theme preference and reloads before it reads the colors, for example
// `bun dynwork/script/smoke.ts /tmp/deep.png oc-2-deep dark`.
//
// The view defaults to home. new-session and first-launch start as a fresh install, which opens on the new session
// screen: new-session shoots that screen, applying the theme live, and first-launch shoots the first-launch splash when
// its wordmark has drawn, before any theme preference can be stored.
//
// The profile follows packages/desktop/script/bench-startup.ts: its own home, userData, XDG directories, database,
// config and service registration, a private service port and none of the developer's OPENCODE_* variables. It never
// attaches to or restarts the developer's running OpenCode service.
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"

const repo = path.resolve(import.meta.dir, "../..")

const exe = "/Applications/DynWork.app/Contents/MacOS/DynWork"

const screenshot = path.resolve(repo, process.argv[2] ?? "plans/done/2026-10-dynwork-pilot/docs/smoke.png")

const themeID = process.argv[3]

const colorScheme = process.argv[4]

const view = process.argv[5] ?? "home"

const root = await mkdtemp(path.join(tmpdir(), "dynwork-smoke-"))

const config = path.join(root, "config/opencode")

const registration = path.join(root, "state/opencode/service.json")

const cdpPort = await freePort()

for (const dir of ["home", "data", "desktop", "state/opencode"]) await mkdir(path.join(root, dir), { recursive: true })

await mkdir(config, { recursive: true })

// The service would otherwise listen on the channel's default port, which the developer's own service holds.
await Bun.write(path.join(config, "service.json"), JSON.stringify({ port: await freePort() }))

await Bun.write(
  path.join(root, "desktop/opencode.settings"),
  JSON.stringify({ firstLaunchOnboardingComplete: view === "home" }),
)

const env = {
  ...Object.fromEntries(Object.entries(process.env).filter((entry) => !/^(OPENCODE_|OTEL_|SENTRY_)/.test(entry[0]))),
  HOME: path.join(root, "home"),
  OPENCODE_DESKTOP_TEST_ROOT: root,
  OPENCODE_DB: path.join(root, "data/opencode.db"),
  OPENCODE_CONFIG_DIR: config,
  // A closed proxy port makes the update check fail at once and offline.
  HTTPS_PROXY: "http://127.0.0.1:9",
}

const app = Bun.spawn([exe, `--remote-debugging-port=${cdpPort}`], { env, stdio: ["ignore", "ignore", "ignore"] })

console.log(`smoke: pid ${app.pid}, root ${root}, cdp ${cdpPort}`)

const result = await run().catch((error: unknown) => error)

await stop()

await rm(root, { recursive: true, force: true })

if (result instanceof Error) throw result

console.log(JSON.stringify(result, null, 2))

async function run() {
  const page = await waitFor(
    "the main window",
    async () =>
      (await targets()).find((target) => target.type === "page" && target.url.startsWith("oc://"))
        ?.webSocketDebuggerUrl,
    90_000,
  )

  const cdp = await connect(page)

  if (view === "first-launch") return firstLaunch(cdp)

  const shell = () =>
    waitFor(
      "the app shell",
      async () =>
        cdp.value<boolean>(
          `!!document.querySelector('#root [data-titlebar-tab-link], #root [data-action="vertical-tabs-home"], #root [data-action="home-new-session"], #root [data-action="home-add-project-row"]')`,
        ),
      60_000,
    ).catch(async (error: Error) => {
      const seen = await cdp.value<string>(`location.href + " | " + document.body.innerText.slice(0, 300)`)
      throw new Error(`${error.message}; the window shows: ${seen}`)
    })

  await shell()

  if (view === "new-session")
    await waitFor(
      "the new session wordmark",
      async () => cdp.value<boolean>(`!!document.querySelector('[data-component="new-session-wordmark"]')`),
      15_000,
    ).catch(async (error: Error) => {
      const seen = await cdp.value<string>(`location.href + " | " + document.body.innerText.slice(0, 300)`)
      throw new Error(`${error.message}; the window shows: ${seen}`)
    })

  if (themeID && colorScheme) {
    await cdp.value(
      `localStorage.setItem("opencode-theme-id", ${JSON.stringify(themeID)}); localStorage.setItem("opencode-color-scheme", ${JSON.stringify(colorScheme)})`,
    )

    // A fresh install opens on the new session only once, so that view takes the theme live through the storage
    // events the theme context listens to; a reload would land on home.
    if (view === "new-session")
      await cdp.value(
        `[["opencode-theme-id", ${JSON.stringify(themeID)}], ["opencode-color-scheme", ${JSON.stringify(colorScheme)}]].forEach((entry) => window.dispatchEvent(new StorageEvent("storage", { key: entry[0], newValue: entry[1] })))`,
      )

    if (view !== "new-session") {
      await cdp.send("Page.reload")
      // The old document stays alive for a moment after the reload call.
      await Bun.sleep(1000)
      await shell()
    }

    await waitFor(
      `theme ${themeID}`,
      async () => (await cdp.value<string>("document.documentElement.dataset.theme")) === themeID,
      15_000,
    )
  }

  // Let the theme apply and the first paint settle.
  await Bun.sleep(2000)

  const colors = await cdp.value<Record<string, string>>(`(() => ({
    html: getComputedStyle(document.documentElement).backgroundColor,
    body: getComputedStyle(document.body).backgroundColor,
    scheme: getComputedStyle(document.documentElement).colorScheme,
    theme: document.documentElement.dataset.theme,
    colorScheme: document.documentElement.dataset.colorScheme,
    backgroundBase: getComputedStyle(document.documentElement).getPropertyValue("--background-base").trim(),
    v2BackgroundBase: getComputedStyle(document.documentElement).getPropertyValue("--v2-background-bg-base").trim(),
    primary: getComputedStyle(document.documentElement).getPropertyValue("--surface-brand-base").trim(),
  }))()`)

  const shot = await cdp.send("Page.captureScreenshot", { format: "png" })

  await Bun.write(screenshot, Buffer.from(shot.result.data, "base64"))
  cdp.close()

  return { screenshot, colors }
}

// The splash covers the window only until the app is ready, so it is caught as soon as it renders and shot when the
// letters finish drawing (the draw takes one second).
async function firstLaunch(cdp: Awaited<ReturnType<typeof connect>>) {
  await waitFor(
    "the first-launch splash",
    async () => cdp.value<boolean>(`!!document.querySelector('[data-component="first-launch-splash"]')`),
    30_000,
  )

  const drawn = await cdp.send("Runtime.evaluate", {
    expression: `Promise.race([
      Promise.all(
        document
          .getAnimations()
          .filter((animation) => animation.animationName === "first-launch-wordmark-draw")
          .map((animation) => animation.finished),
      ).then((all) => all.length),
      new Promise((resolve) => setTimeout(() => resolve(0), 3000)),
    ])`,
    awaitPromise: true,
    returnByValue: true,
  })

  const shot = await cdp.send("Page.captureScreenshot", { format: "png" })

  const visible = await cdp.value<boolean>(`!!document.querySelector('[data-component="first-launch-splash"]')`)

  await Bun.write(screenshot, Buffer.from(shot.result.data, "base64"))
  cdp.close()

  return { screenshot, drawn: drawn.result?.result?.value, visible }
}

// Stops only what this run started: the app, its children and the background service it registered in the profile.
async function stop() {
  const registered = await Bun.file(registration)
    .json()
    .then((value: { pid?: number }) => value.pid)
    .catch(() => undefined)

  const service =
    registered && (await Bun.$`ps -p ${registered} -o command=`.nothrow().text()).includes(root) ? [registered] : []

  const rows = (await Bun.$`ps -eo pid=,ppid=`.text())
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))

  const tree = new Set([app.pid])

  for (const _ of rows) for (const row of rows) if (tree.has(row[1])) tree.add(row[0])

  const pids = [...tree, ...service]

  for (const pid of pids) process.kill(pid, "SIGTERM")
  await Bun.sleep(3000)
  for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL")
  await Bun.sleep(500)
}

function alive(pid: number) {
  return Bun.spawnSync(["kill", "-0", String(pid)]).exitCode === 0
}

async function freePort() {
  const server = createServer()

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  await new Promise((resolve) => server.close(resolve))
  if (typeof address !== "object" || !address) throw new Error("No free port")

  return address.port
}

async function targets() {
  return fetch(`http://127.0.0.1:${cdpPort}/json`)
    .then((response) => response.json() as Promise<{ type: string; url: string; webSocketDebuggerUrl: string }[]>)
    .catch(() => [])
}

async function waitFor<T>(what: string, check: () => Promise<T | undefined | false>, timeout: number) {
  const deadline = Date.now() + timeout

  while (Date.now() < deadline) {
    const value = await check().catch(() => undefined)

    if (value) return value
    await Bun.sleep(250)
  }

  throw new Error(`Timed out waiting for ${what}`)
}

async function connect(url: string) {
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
