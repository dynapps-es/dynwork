#!/usr/bin/env bun
// Launches the installed DynWork in an isolated profile, waits for its window, takes a screenshot and reads the
// theme background colors over CDP, then stops the processes it started.
//
//   bun dynwork/script/smoke.ts [screenshot] [theme-id] [light|dark] [view] [width] [--with-foreign-service]
//
// The screenshot defaults to plans/done/2026-10-dynwork-pilot/docs/smoke.png. With a theme id and a color scheme the
// script stores them as the app's theme preference and reloads before it reads the colors, for example
// `bun dynwork/script/smoke.ts /tmp/deep.png oc-2-deep dark`.
//
// The view defaults to home. new-session and first-launch start as a fresh install, which opens on the new session
// screen: new-session shoots that screen, applying the theme live, and first-launch shoots the first-launch splash when
// its wordmark has drawn, before any theme preference can be stored.
//
// A fresh profile opens on the DynWork sign-in screen. home stores the signed-in flag and reloads, new-session signs in
// through the screen, since a reload would leave the new session. The signin views shoot the screen itself: signin at
// step 1, signin-choose at step 2, signin-finalizing while it syncs and signin-done the app once it has faded out. A
// width in CSS pixels shoots the window at that width, for example 800 for the stacked layout.
//
// The profile follows packages/desktop/script/bench-startup.ts: its own home, userData, XDG directories, database,
// config and service registration, a private service port and none of the developer's OPENCODE_* variables. It never
// attaches to or restarts the developer's running OpenCode service. DynWork runs its own service under its userData, on
// its fixed port (`DynWorkIdentity.servicePort`), so a DynWork already running on this Mac makes the smoke fail early.
//
// --with-foreign-service plays OpenCode.app: before DynWork starts, an `opencode serve --service` from this checkout,
// with another version string, registers at the default location of the profile. Once DynWork is ready the smoke checks
// that the foreign service still runs with the same pid and that DynWork registered its own service under its userData.
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { DynWorkIdentity } from "../packages/branding/src/identity"

const repo = path.resolve(import.meta.dir, "../..")

const exe = "/Applications/DynWork.app/Contents/MacOS/DynWork"

const args = process.argv.slice(2).filter((arg) => !arg.startsWith("--"))

const withForeign = process.argv.includes("--with-foreign-service")

const screenshot = path.resolve(repo, args[0] ?? "plans/done/2026-10-dynwork-pilot/docs/smoke.png")

const themeID = args[1]

const colorScheme = args[2]

const view = args[3] ?? "home"

const width = args[4] ? Number(args[4]) : undefined

const signInViews = ["signin", "signin-choose", "signin-finalizing", "signin-done"]

const signedIn = JSON.stringify({
  url: "https://sp.dynapps.es",
  instance: { id: "dynapps", name: "Dynapps", host: "sp.dynapps.es" },
})

// Stands in for an OPENCODE_CONFIG_CONTENT exported by the login shell, which DynWork's service must never see.
const shellConfig = JSON.stringify({ username: "dynwork-smoke-shell-config" })

if (!(await portFree(DynWorkIdentity.servicePort)))
  throw new Error(`Port ${DynWorkIdentity.servicePort} is in use: quit DynWork before running the smoke`)

const root = await mkdtemp(path.join(tmpdir(), "dynwork-smoke-"))

const config = path.join(root, "config/opencode")

// The default registration of the profile, where OpenCode.app's service would register.
const registration = path.join(root, "state/opencode/service.json")

// DynWork's own registration, under its userData (`<root>/desktop`, see OPENCODE_DESKTOP_TEST_ROOT).
const ownRegistration = path.join(root, "desktop/service/state/opencode/service.json")

const foreignVersion = "0.0.0-foreign"

const cdpPort = await freePort()

for (const dir of ["home", "data", "desktop", "state/opencode"]) await mkdir(path.join(root, dir), { recursive: true })

await mkdir(config, { recursive: true })

// A service using this config dir would otherwise listen on the channel's default port, which the developer's own
// service holds. DynWork's own service ignores it; the foreign one and a DynWork without its own service use it.
await Bun.write(path.join(config, "service.json"), JSON.stringify({ port: await freePort() }))

await Bun.write(
  path.join(root, "desktop/opencode.settings"),
  JSON.stringify({ firstLaunchOnboardingComplete: view !== "new-session" && view !== "first-launch" }),
)

const env = {
  ...Object.fromEntries(Object.entries(process.env).filter((entry) => !/^(OPENCODE_|OTEL_|SENTRY_)/.test(entry[0]))),
  HOME: path.join(root, "home"),
  OPENCODE_DESKTOP_TEST_ROOT: root,
  OPENCODE_DB: path.join(root, "data/opencode.db"),
  OPENCODE_CONFIG_DIR: config,
  OPENCODE_CONFIG_CONTENT: shellConfig,
  // A closed proxy port makes the update check fail at once and offline.
  HTTPS_PROXY: "http://127.0.0.1:9",
}

const foreign = withForeign ? await startForeign() : undefined

const app = Bun.spawn([exe, `--remote-debugging-port=${cdpPort}`], { env, stdio: ["ignore", "ignore", "ignore"] })

console.log(`smoke: pid ${app.pid}, root ${root}, cdp ${cdpPort}`)

const result = await run()
  .then(async (value) => ({ ...value, service: await services() }))
  .catch((error: unknown) => error)

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

  if (width)
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 0, deviceScaleFactor: 0, mobile: false })

  if (signInViews.includes(view)) return signIn(cdp)

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

  // The shell loads under the sign-in screen. home stores the signed-in flag for the reload below; the new session
  // would not survive a reload, so that view signs in through the screen.
  if (view === "new-session") await submitSignIn(cdp, "signin-done")

  if (view === "home") await cdp.value(`localStorage.setItem("dynwork-signin", ${JSON.stringify(signedIn)})`)

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
  }

  if (view === "home") {
    await cdp.send("Page.reload")
    // The old document stays alive for a moment after the reload call.
    await Bun.sleep(1000)
    await shell()
  }

  if (themeID && colorScheme)
    await waitFor(
      `theme ${themeID}`,
      async () => (await cdp.value<string>("document.documentElement.dataset.theme")) === themeID,
      15_000,
    )

  if (await cdp.value<boolean>(`!!document.querySelector('[data-component="dynwork-signin"]')`))
    throw new Error("The sign-in screen still covers the app")

  return shoot(cdp)
}

// Shoots the sign-in screen once the startup splash has faded from it, after driving it to the view's step.
async function signIn(cdp: Awaited<ReturnType<typeof connect>>) {
  const screen = () =>
    waitFor(
      "the sign-in screen",
      async () =>
        cdp.value<boolean>(
          `!!document.querySelector('[data-component="dynwork-signin"]') && !document.querySelector('[data-component="startup-overlay"]')`,
        ),
      90_000,
    )

  await screen()

  if (themeID && colorScheme) {
    await cdp.value(
      `localStorage.setItem("opencode-theme-id", ${JSON.stringify(themeID)}); localStorage.setItem("opencode-color-scheme", ${JSON.stringify(colorScheme)})`,
    )
    await cdp.send("Page.reload")
    await Bun.sleep(1000)
    await screen()
    await waitFor(
      `theme ${themeID}`,
      async () => (await cdp.value<string>("document.documentElement.dataset.theme")) === themeID,
      15_000,
    )
  }

  if (view !== "signin") await submitSignIn(cdp, view)

  return shoot(cdp)
}

// Types a valid instance URL, waits for the green status and presses Enter, then Enter again on Finish, the way a
// keyboard user would, and stops at the given step.
async function submitSignIn(cdp: Awaited<ReturnType<typeof connect>>, until: string) {
  const enter = async () => {
    for (const type of ["keyDown", "keyUp"])
      await cdp.send("Input.dispatchKeyEvent", {
        type,
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        ...(type === "keyDown" ? { text: "\r" } : {}),
      })
  }
  const seen = (selector: string) => cdp.value<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`)

  await waitFor("the instance URL field", async () => seen("#dynwork-signin-url"), 60_000)
  await cdp.value(`document.querySelector("#dynwork-signin-url").focus()`)
  await cdp.send("Input.insertText", { text: "https://sp.dynapps.es" })
  await waitFor("a reachable instance URL", async () => seen('[data-slot="signin-status"][data-tone="valid"]'), 5_000)
  await enter()
  await waitFor("the instance list", async () => seen('[data-slot="signin-instances"]'), 5_000)

  if (until === "signin-choose") return Bun.sleep(300)
  await enter()
  await waitFor("the finalizing state", async () => seen('[data-slot="signin-finalizing"]'), 5_000)

  if (until === "signin-finalizing") return Bun.sleep(700)
  await waitFor("the sign-in screen to fade out", async () => !(await seen('[data-component="dynwork-signin"]')), 5_000)
}

async function shoot(cdp: Awaited<ReturnType<typeof connect>>) {
  // Let the theme apply and the first paint settle; the timed sign-in steps are shot as they are.
  if (view !== "signin-choose" && view !== "signin-finalizing") await Bun.sleep(2000)

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

// Starts an `opencode serve --service` from the checkout's sources in the profile, with another version string, and
// waits until it answers at the profile's default registration.
async function startForeign() {
  const service = Bun.spawn(
    [
      process.execPath,
      "--define",
      `OPENCODE_VERSION:${JSON.stringify(foreignVersion)}`,
      "--define",
      'OPENCODE_CHANNEL:"latest"',
      "src/index.ts",
      "serve",
      "--service",
      "--port",
      String(await freePort()),
    ],
    {
      cwd: path.join(repo, "packages/cli"),
      env: {
        ...Object.fromEntries(Object.entries(env).filter((entry) => entry[0] !== "OPENCODE_CONFIG_CONTENT")),
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_STATE_HOME: path.join(root, "state"),
      },
      stdio: ["ignore", "ignore", "ignore"],
    },
  )

  const info = await waitFor(
    "the foreign service",
    async () => {
      const registered = await read(registration)

      if (registered?.pid !== service.pid) return undefined
      const answer = await health(registered)

      return answer?.version === foreignVersion ? registered : undefined
    },
    60_000,
  ).catch(async (error: unknown) => {
    service.kill("SIGKILL")
    await rm(root, { recursive: true, force: true })
    throw error
  })

  console.log(`smoke: foreign service pid ${info.pid}, ${info.url}, version ${foreignVersion}`)

  return { service, info }
}

// DynWork's own service, without the shell's config, and the foreign one: the same pid still registered and answering,
// never adopted or replaced.
async function services() {
  const own = await waitFor(
    `DynWork's service at ${ownRegistration}`,
    async () => {
      const registered = await read(ownRegistration)

      return registered && (await health(registered)) ? registered : undefined
    },
    30_000,
  )

  if (!(await Bun.$`ps -p ${own.pid} -o command=`.nothrow().text()).includes(root))
    throw new Error(`DynWork's service ${own.pid} does not run from the profile`)

  if (new URL(own.url).port !== String(DynWorkIdentity.servicePort))
    throw new Error(`DynWork's service listens on ${own.url}, not on port ${DynWorkIdentity.servicePort}`)

  // The config documents and sources the service loaded, lowest to highest priority.
  const loaded = await fetch(new URL("/api/config", own.url), { headers: authorization(own) }).then((response) =>
    response.text(),
  )

  if (!loaded.includes("desktop/service/config"))
    throw new Error(`DynWork's service does not read its own config dir: ${loaded.slice(0, 300)}`)

  if (loaded.includes("dynwork-smoke-shell-config"))
    throw new Error("DynWork's service loaded the login shell's OPENCODE_CONFIG_CONTENT")

  const dynwork = {
    registration: ownRegistration,
    pid: own.pid,
    url: own.url,
    version: own.version,
    shellConfig: "not loaded",
  }

  if (!foreign) return { dynwork }
  const registered = await read(registration)
  const answer = registered && (await health(registered))
  const after = { pid: registered?.pid, alive: alive(foreign.info.pid), version: answer?.version }

  if (after.pid !== foreign.info.pid || !after.alive || after.version !== foreignVersion)
    throw new Error(`The foreign service changed: ${JSON.stringify({ before: foreign.info.pid, after })}`)

  if (own.pid === foreign.info.pid) throw new Error("DynWork adopted the foreign service")

  return { dynwork, foreign: { registration, before: foreign.info.pid, after: after.pid, unchanged: true } }
}

async function read(file: string) {
  return Bun.file(file)
    .json()
    .then((value: { pid: number; url: string; version?: string; password?: string }) => value)
    .catch(() => undefined)
}

function authorization(info: { password?: string }) {
  if (!info.password) return undefined

  return { authorization: `Basic ${Buffer.from(`opencode:${info.password}`).toString("base64")}` }
}

async function health(info: { url: string; password?: string }) {
  return fetch(new URL("/api/info", info.url), {
    headers: authorization(info),
    signal: AbortSignal.timeout(2000),
  })
    .then((response) => response.json() as Promise<{ version?: string; pid?: number }>)
    .catch(() => undefined)
}

// Stops only what this run started: the app, its children, the background services registered in the profile and
// the foreign service.
async function stop() {
  const registered = (
    await Promise.all([registration, ownRegistration].map(async (file) => (await read(file))?.pid))
  ).filter((pid): pid is number => pid !== undefined)

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

  const tree = new Set([app.pid, ...(foreign ? [foreign.service.pid] : [])])

  for (const _ of rows) for (const row of rows) if (tree.has(row[1])) tree.add(row[0])

  const pids = [...tree, ...service]

  for (const pid of new Set(pids)) if (alive(pid)) process.kill(pid, "SIGTERM")
  await Bun.sleep(3000)
  for (const pid of new Set(pids)) if (alive(pid)) process.kill(pid, "SIGKILL")
  await Bun.sleep(500)
}

function alive(pid: number) {
  return Bun.spawnSync(["kill", "-0", String(pid)]).exitCode === 0
}

async function portFree(port: number) {
  const server = createServer()

  return new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false))
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)))
  })
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
