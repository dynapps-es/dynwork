#!/usr/bin/env bun
// End to end against the two local systemprompt instances (`bun dynwork/script/sp-local.ts`), on the installed
// /Applications/DynWork.app in an isolated profile:
//
//   bun dynwork/script/e2e-sp.ts [screenshot dir]
//
//   1. sp-local up, seed and check;
//   2. DynWork signs in to alpha on the sign-in screen with alpha's PAT, and adds beta in Settings with a one-time code
//      from the instance CLI (the device-link page's paste-code flow: the page behind the browser link needs the
//      instance's Entra login, which the harness cannot reach);
//   3. alpha's skills, agents and MCP servers are in DynWork's service (its own HTTP API, credentials from the
//      profile's registration), with its rule and the gateway provider;
//   4. a skill created on alpha appears within 60 s without a restart, and disappears within 60 s once deleted;
//   5. switching to beta brings beta's content and removes alpha's within 5 s;
//   6. the app moved out of /Applications starts in the same profile, loads the server plugin from its own Resources
//      and syncs again;
//   7. signing out of both instances leaves no DynWork content in the service;
//   8. no PAT, JWT or code is in plaintext anywhere in the profile, the OpenCode database included.
//
// Screenshots per step go to the screenshot dir (default: `dynwork-e2e-shots` in the system temp dir). Every step
// prints what it waited for and how long it took. At the end the run revokes the PATs DynWork minted on the instances,
// removes the skill it created, stops only the processes it started, deletes the profile and checks both instances
// again.
import { mkdir, realpath, rm } from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import path from "node:path"
import { DynWorkIdentity } from "../packages/branding/src/identity"
import {
  type Cdp,
  type Profile,
  connect,
  authorization,
  fillConnect,
  freePort,
  health,
  installed,
  launch,
  localInstance,
  mainWindow,
  portFree,
  pressEnter,
  profile,
  read,
  repo,
  screenshot,
  shell,
  stop,
  waitFor,
} from "./desktop-profile"
import { exchangePat } from "./sp-local"

const shots = process.argv[2] ? path.resolve(repo, process.argv[2]) : path.join(tmpdir(), "dynwork-e2e-shots")

const harness = path.join(repo, "dynwork/test/sp-local")

// Both seeded instances are branded "Dynapps", so DynWork prefixes their ids in the service with the same key.
const prefix = "dynapps-"

// Like the bridge: skills are directories named after their id in kebab case, agents come from the plugin bundles'
// `agents/*.md`, and MCP servers are named after the server.
const expected = {
  alpha: { skills: ["alpha-notes", "alpha-review", "who-am-i"], agents: ["alpha_helper"], mcp: ["alpha-docs"] },
  beta: { skills: ["beta-review", "beta-triage", "who-am-i"], agents: ["beta_helper"], mcp: ["beta-docs"] },
}

// The titlebar pill, named "systemprompt: <instance>".
const pill = '[data-slot="titlebar-update"] button[aria-label^="systemprompt"]'

// The skill the run creates on alpha and deletes again, and the directory it becomes in DynWork's service.
const liveSkill = "alpha_e2e"
const liveSkillDir = "alpha-e2e"

// What the run can see of either instance; anything else in the service is the user's or upstream's.
const known = new Set([
  ...Object.values(expected).flatMap((want) => [...want.skills, ...want.agents, ...want.mcp]),
  liveSkillDir,
])

// The name DynWork gives the PATs it mints from a one-time code (`accounts/main.ts`).
const deviceName = `DynWork on ${hostname()}`

const report: { step: string; seconds: number; detail: string }[] = []

const started = Date.now()

const run = {
  apps: [] as number[],
  skillAdded: false,
  beforeKeys: { alpha: [] as string[], beta: [] as string[] },
  profile: undefined as Profile | undefined,
  code: undefined as string | undefined,
}

const outcome = await main().catch((error: unknown) => error)

const cleanup = await clean().catch((error: unknown) => error)

console.log("\ne2e: steps")
for (const entry of report) console.log(`  ${entry.seconds.toFixed(1).padStart(6)} s  ${entry.step}: ${entry.detail}`)
console.log(`  total ${((Date.now() - started) / 1000).toFixed(1)} s`)

if (outcome instanceof Error) {
  console.error(`e2e: FAILED: ${outcome.message}`)
  process.exit(1)
}
if (cleanup instanceof Error) {
  console.error(`e2e: cleanup FAILED: ${cleanup.message}`)
  process.exit(1)
}
console.log("e2e: OK")

async function main() {
  await mkdir(shots, { recursive: true })

  await step("1 sp-local up, seed, check", async () => {
    for (const command of ["up", "seed", "check"]) await spLocal(command)
    return "both instances answer with their seeded content"
  })

  if (!(await portFree(DynWorkIdentity.servicePort)))
    throw new Error(`Port ${DynWorkIdentity.servicePort} is in use: quit DynWork before running the e2e`)

  const alpha = await localInstance("ALPHA")
  const beta = await localInstance("BETA")
  run.beforeKeys = { alpha: await activeKeys("alpha", alpha.userId), beta: await activeKeys("beta", beta.userId) }

  // The secrets the run knows: alpha's PAT and beta's one-time code. The PAT DynWork minted on beta is only known by
  // its shape, which the scan looks for too.
  const secrets = () => [alpha.pat, ...(run.code ? [run.code] : [])]

  const target = await profile({ prefix: "dynwork-e2e-", onboarded: true })
  run.profile = target
  const project = path.join(target.root, "project")
  await mkdir(project, { recursive: true })
  const cdpPort = await freePort()
  const inspectPort = await freePort()
  run.apps.push(launch(target, cdpPort, installed, [`--inspect=127.0.0.1:${inspectPort}`]).pid)
  console.log(`e2e: root ${target.root}, cdp ${cdpPort}`)
  const first = await mainWindow(cdpPort)

  await step("2a sign in to alpha with its PAT", async () => {
    await signInScreen(first, { url: alpha.url, token: alpha.pat })
    await openAccounts(first)
    await trust(first, alpha.url)
    await shot(first, "01-alpha-signed-in.png")
    return `${alpha.url} active, its key trusted`
  })

  const service = await serviceOf(target)

  await step("2b add beta with a one-time code (device-link paste flow)", async () => {
    await spLocal("code", "beta")
    const code = (await harnessEnv()).SP_BETA_EXCHANGE_CODE
    if (!code) throw new Error("sp-local did not write beta's exchange code")
    run.code = code
    await click(first, '[data-action="accounts-add"]')
    await fillConnect(first, { url: beta.url, token: code })
    await pressEnter(first)
    await waitFor("beta in the list", async () => (await rowCount(first)) === 2, 20_000).catch(async (error: Error) => {
      const alert = await first.value<string>(`document.querySelector('[data-slot="signin-error"]')?.textContent ?? ""`)
      throw new Error(`${error.message}${alert ? `; the dialog says: ${alert}` : ""}`)
    })
    await waitFor("the Add instance dialog to close", async () => !(await seen(first, "#dynwork-signin-url")), 5_000)
    await trust(first, beta.url)
    await shot(first, "02-two-instances.png")
    // Both instances carry the label "Dynapps": the list and the pill show the host next to it.
    const labels = await first.value<string[]>(
      `[...document.querySelectorAll('[data-slot="accounts-instance-label"]')].map((node) => node.textContent)`,
    )
    if (!labels.every((label) => /\(127\.0\.0\.1:\d+\)$/.test(label)))
      throw new Error(`colliding labels do not show the host: ${JSON.stringify(labels)}`)
    await click(first, pill)
    await waitFor("the pill's menu", async () => seen(first, '[data-component="accounts-pill-menu"]'), 5_000)
    const items = await first.value<string[]>(
      `[...document.querySelectorAll('[data-slot="accounts-pill-name"]')].map((node) => node.textContent)`,
    )
    await shot(first, "03-pill-hosts.png")
    await first.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    })
    await first.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    })
    await waitFor(
      "the pill's menu to close",
      async () => !(await seen(first, '[data-component="accounts-pill-menu"]')),
      5_000,
    )
    return `beta signed in (code exchanged, never printed); labels ${labels.join(", ")}; pill lists ${items.join(", ")}`
  })

  await step("3 alpha's content in DynWork's service", async () => {
    const content = await waitFor(
      "alpha's skills, agents and MCP servers",
      async () => {
        const value = await synced(service, project)
        return holds(value, "alpha") && !mentions(value, "beta") ? value : undefined
      },
      30_000,
    )
    const rules = await rulesShown(first)
    if (rules !== 1) throw new Error(`the service holds ${rules} rules of alpha, expected 1`)
    const provider = await get(service, "/api/provider/systemprompt", project)
    const plugin = await pluginPath(service)
    if (!plugin.startsWith(path.join(installed, "Contents/Resources")))
      throw new Error(`the service loads the plugin from ${plugin}`)
    return `${describe(content)}; 1 rule; provider "${provider.data.name}" at ${provider.data.settings?.baseURL}; plugin ${plugin}`
  })

  await step("3b gateway routes on alpha (observed, not asserted)", async () => {
    const session = await exchangePat(alpha.url, alpha.pat)
    if (!session) throw new Error("alpha's PAT did not mint a JWT")
    // GET only: a request without a body never makes the instance call a model provider.
    const status = async (route: string) =>
      (await fetch(`${alpha.url}${route}`, { headers: { authorization: `Bearer ${session.token}` } })).status
    return `GET /v1/chat/completions ${await status("/v1/chat/completions")}, GET /v1/messages ${await status("/v1/messages")}`
  })

  // The sync polls every 30 s while a DynWork window has focus and every 5 min otherwise: the window takes focus the
  // way a user's click would give it.
  const focused = await focus(inspectPort)
  console.log(`e2e: focus: ${focused}`)
  // A failed live-sync step is recorded and the run goes on, so one run proves or disproves every later step too.
  const failed: string[] = []

  const added = await step(`4a skill ${liveSkill} created on alpha appears within 60 s`, async () => {
    const cli = await timed(() => addSkill())
    const served = await timed(() => waitServed(alpha, true))
    const shown = await timed(() =>
      waitFor(
        `${prefix}${liveSkill} in the service`,
        async () => (await synced(service, project)).skills.includes(liveSkillDir),
        60_000,
        500,
      ).catch(async (error: Error) => {
        const other = path.join(target.root, "project-late")
        await mkdir(other, { recursive: true })
        const late = await synced(service, other).catch(() => undefined)
        const counts = await first.value<string>(
          `document.querySelector('[data-action="accounts-detail-content"] [data-slot="settings-row-description"]')?.textContent ?? ""`,
        )
        throw new Error(
          `${error.message}; the active instance says ${await syncLine(first)}, content "${counts}"; a new Location lists ${late ? describe(late) : "nothing"}`,
        )
      }),
    )
    await shot(first, "04-skill-added.png")
    return `instance CLI ${cli} s, served after ${served} s, in DynWork ${shown} s after it was served`
  }).catch((error: Error) => {
    failed.push(`${error.message} (focus: ${focused})`)
    return undefined
  })

  if (added === undefined) skip(`4b skill ${liveSkill} deleted on alpha disappears within 60 s`, "4a failed")
  else
    await step(`4b skill ${liveSkill} deleted on alpha disappears within 60 s`, async () => {
      const cli = await timed(() => removeSkill())
      const served = await timed(() => waitServed(alpha, false))
      const gone = await timed(() =>
        waitFor(
          `${prefix}${liveSkill} gone from the service`,
          async () => !(await synced(service, project)).skills.includes(liveSkillDir),
          60_000,
          500,
        ).catch(async (error: Error) => {
          throw new Error(`${error.message}; the active instance says ${await syncLine(first)}`)
        }),
      )
      await shot(first, "05-skill-removed.png")
      return `instance CLI ${cli} s, gone from the manifest after ${served} s, gone from DynWork ${gone} s later`
    }).catch((error: Error) => void failed.push(error.message))

  await step("5 switch to beta within 5 s", async () => {
    await action(first, beta.url, "make-active")
    const switched = Date.now()
    const content = await waitFor(
      "beta's content and none of alpha's",
      async () => {
        const value = await synced(service, project)
        return holds(value, "beta") && !mentions(value, "alpha") ? value : undefined
      },
      5_000,
      100,
    )
    const seconds = (Date.now() - switched) / 1000
    await waitFor("beta's rule", async () => (await rulesShown(first)) === 1, 5_000)
    await shot(first, "06-switched-to-beta.png")
    return `${describe(content)} after ${seconds.toFixed(1)} s`
  })

  first.close()
  await stop(target.root, run.apps, [target.ownRegistration])

  // The moved copy lives inside the profile, so deleting the profile removes it.
  const moved = path.join(target.root, "moved/DynWork.app")
  const port = await freePort()
  const relaunched = await step("6 the app moved elsewhere loads its own plugin and syncs", async () => {
    await mkdir(path.dirname(moved), { recursive: true })
    await Bun.$`ditto ${installed} ${moved}`.quiet()
    run.apps.push(launch(target, port, moved).pid)
    const cdp = await mainWindow(port)
    // The window reopens where it was left: the Settings page here, else the app shell.
    await waitFor(
      "the app shell or the Settings page",
      async () =>
        cdp.value<boolean>(
          `!!document.querySelector('[data-action="accounts-add"], #root [data-titlebar-tab-link], #root [data-action="home-new-session"]')`,
        ),
      60_000,
    )
    const again = await serviceOf(target)
    if (again.pid === service.pid) throw new Error("the service did not restart with the moved app")
    const content = await waitFor(
      "beta's content after the restart",
      async () => {
        const value = await synced(again, project)
        return holds(value, "beta") && !mentions(value, "alpha") ? value : undefined
      },
      30_000,
    )
    const plugin = await pluginPath(again)
    // The temp dir is a symlink (/var -> /private/var): compare real paths.
    if (!plugin.startsWith(path.join(await realpath(moved), "Contents/Resources")))
      throw new Error(`the service loads the plugin from ${plugin}`)
    const clean = await scan(target.root, secrets(), "while signed in")
    await openAccounts(cdp)
    await shot(cdp, "07-moved-app.png")
    return { cdp, service: again, detail: `${moved}: plugin ${plugin}; ${describe(content)}; ${clean}` }
  })

  await step("7 sign out of both: no DynWork content left", async () => {
    const cdp = relaunched.cdp
    const again = relaunched.service
    await action(cdp, alpha.url, "sign-out", true)
    await waitFor(
      "alpha signed out",
      async () => cdp.value<boolean>(`${rowOf(alpha.url)}?.querySelector('[data-badge="signed-out"]') != null`),
      10_000,
    )
    await action(cdp, beta.url, "sign-out", true)
    const signedOut = Date.now()
    await waitFor(
      "no DynWork content in the service",
      async () => {
        const value = await synced(again, project)
        return value.skills.length + value.agents.length + value.mcp.length === 0
      },
      10_000,
      100,
    )
    const seconds = (Date.now() - signedOut) / 1000
    const provider = await fetch(
      `${again.url}/api/provider/systemprompt?location[directory]=${encodeURIComponent(project)}`,
      { headers: again.headers },
    )
    if (provider.ok) throw new Error("the systemprompt provider survived the sign-out")
    await waitFor("the sign-in screen", async () => seen(cdp, '[data-component="dynwork-signin"]'), 15_000)
    await shot(cdp, "08-signed-out.png")
    cdp.close()
    return {
      detail: `no skills, agents, MCP servers or provider ${seconds.toFixed(1)} s after the last sign-out; the sign-in screen is back`,
    }
  })

  await step("8 no PAT, JWT or code in plaintext in the profile", async () => {
    await stop(target.root, run.apps, [target.ownRegistration])
    run.apps = []
    const minted = await newKeys("beta", beta.userId)
    return { detail: await scan(target.root, secrets(), `after sign-out; ${minted.length} PAT(s) minted on beta`) }
  })

  if (failed.length > 0) throw new Error(failed.join("; "))
}

// Revokes the PATs DynWork minted, removes the live skill if it is still there, stops the app, deletes the profile and
// checks the instances.
async function clean() {
  const target = run.profile
  if (target) await stop(target.root, run.apps, [target.ownRegistration])
  if (run.skillAdded) await removeSkill()
  const alpha = await localInstance("ALPHA")
  const beta = await localInstance("BETA")
  const revoked = [...(await revokeNew("alpha", alpha.userId)), ...(await revokeNew("beta", beta.userId))]
  console.log(`e2e: revoked ${revoked.length} PAT(s) DynWork minted (${revoked.join(", ") || "none"})`)
  if (target) await rm(target.root, { recursive: true, force: true })
  await step("9 sp-local check after the run", async () => {
    await spLocal("check")
    return "both instances healthy"
  })
}

async function step<T extends string | { detail: string }>(name: string, body: () => Promise<T>) {
  const at = Date.now()
  console.log(`e2e: ${name} ...`)
  const value = await body().catch((error: unknown) => {
    const seconds = (Date.now() - at) / 1000
    report.push({ step: name, seconds, detail: `FAILED: ${error instanceof Error ? error.message : String(error)}` })
    throw error
  })
  const seconds = (Date.now() - at) / 1000
  const detail = typeof value === "string" ? value : value.detail
  report.push({ step: name, seconds, detail: `OK, ${detail}` })
  console.log(`e2e: ${name}: OK in ${seconds.toFixed(1)} s — ${detail}`)
  return value
}

function skip(name: string, why: string) {
  report.push({ step: name, seconds: 0, detail: `SKIPPED: ${why}` })
  console.log(`e2e: ${name}: SKIPPED, ${why}`)
}

async function timed(body: () => Promise<unknown>) {
  const at = Date.now()
  await body()
  return ((Date.now() - at) / 1000).toFixed(1)
}

async function spLocal(...args: string[]) {
  const result = await Bun.$`bun dynwork/script/sp-local.ts ${args}`.cwd(repo).quiet().nothrow()
  const output = `${result.stdout}${result.stderr}`.trim()
  console.log(output.replace(/^/gm, `  sp-local ${args[0]} | `))
  if (result.exitCode !== 0) throw new Error(`sp-local ${args.join(" ")} exited ${result.exitCode}`)
}

async function harnessEnv() {
  const text = await Bun.file(path.join(harness, ".env.local")).text()
  return Object.fromEntries(
    text
      .split("\n")
      .flatMap((line) =>
        line.includes("=") ? [[line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]] : [],
      ),
  )
}

function compose(...args: string[]) {
  return Bun.$`docker compose -p dynwork-sp-local -f ${path.join(harness, "compose.yml")} --env-file ${path.join(harness, ".env.local")} ${args}`
    .quiet()
    .nothrow()
}

async function instanceCli(instance: "alpha" | "beta", ...args: string[]) {
  const result = await compose("exec", "-T", instance, "/app/bin/systemprompt", ...args)
  if (result.exitCode !== 0)
    throw new Error(
      `${instance}: systemprompt ${args.slice(0, 3).join(" ")} failed: ${result.stderr.toString().slice(-400)}`,
    )
  return result.stdout.toString()
}

async function instanceShell(script: string) {
  const result = await compose("exec", "-T", "alpha", "sh", "-c", script)
  if (result.exitCode !== 0)
    throw new Error(`alpha: ${script.split("\n")[0]} failed: ${result.stderr.toString().slice(-400)}`)
}

// A skill is a directory under the services tree plus an entry in its plugin, applied with the instance CLI. The
// running instance serves it a few seconds after `admin config apply`, without a restart.
async function addSkill() {
  run.skillAdded = true
  await instanceShell(
    [
      "set -e",
      `mkdir -p /app/services/skills/${liveSkill}`,
      `printf 'id: ${liveSkill}\\nname: alpha e2e\\ndescription: Created by the DynWork e2e run.\\nenabled: true\\nfile: SKILL.md\\ncategory: development\\n' > /app/services/skills/${liveSkill}/config.yaml`,
      `printf -- '---\\ndescription: Created by the DynWork e2e run.\\n---\\n\\n# Alpha e2e\\n\\nSay that the e2e skill is live.\\n' > /app/services/skills/${liveSkill}/SKILL.md`,
      `grep -q -x '    - ${liveSkill}' /app/services/plugins/alpha-tools/config.yaml || sed -i 's/^    - alpha_review$/    - alpha_review\\n    - ${liveSkill}/' /app/services/plugins/alpha-tools/config.yaml`,
    ].join("\n"),
  )
  await apply("e2e: add a skill")
}

async function removeSkill() {
  await instanceShell(
    [
      "set -e",
      `rm -rf /app/services/skills/${liveSkill}`,
      `sed -i '/^    - ${liveSkill}$/d' /app/services/plugins/alpha-tools/config.yaml`,
    ].join("\n"),
  )
  await apply("e2e: remove a skill")
  run.skillAdded = false
}

async function apply(reason: string) {
  await instanceCli("alpha", "admin", "config", "apply", "--reason", reason)
}

// Whether alpha's manifest for the user carries the live skill, read with the harness PAT like DynWork would.
async function waitServed(alpha: { url: string; pat: string }, present: boolean) {
  await waitFor(
    `alpha's manifest ${present ? "with" : "without"} ${liveSkill}`,
    async () => {
      const session = await exchangePat(alpha.url, alpha.pat)
      if (!session) return false
      const response = await fetch(`${alpha.url}/v1/bridge/manifest`, {
        headers: { authorization: `Bearer ${session.token}`, "cache-control": "no-cache" },
      })
      const envelope: { payload: string } = await response.json()
      const manifest: { skills: { id: string }[] } = JSON.parse(envelope.payload)
      return manifest.skills.some((skill) => skill.id === liveSkill) === present
    },
    60_000,
    1000,
  )
}

// The active PATs on an instance named after this machine's DynWork; revoking one twice fails, so only new ones go.
async function activeKeys(instance: "alpha" | "beta", userId: string | undefined) {
  if (!userId) throw new Error(`${instance}: no user id in the harness' environment`)
  const card: { sections: { content: { id: string; name: string; revoked_at: string | null }[] }[] } = JSON.parse(
    await instanceCli(instance, "admin", "users", "api-key", "list", "--user", userId, "--json"),
  )
  return (card.sections[0]?.content ?? [])
    .filter((key) => key.name === deviceName && key.revoked_at === null)
    .map((key) => key.id)
}

async function newKeys(instance: "alpha" | "beta", userId: string | undefined) {
  const before = new Set(run.beforeKeys[instance])
  return (await activeKeys(instance, userId)).filter((id) => !before.has(id))
}

async function revokeNew(instance: "alpha" | "beta", userId: string | undefined) {
  const minted = await newKeys(instance, userId)
  for (const id of minted)
    await instanceCli(instance, "admin", "users", "api-key", "revoke", "--user", userId ?? "", "--id", id)
  return minted.map((id) => `${instance}:${id.slice(0, 8)}…`)
}

async function serviceOf(target: Profile) {
  const info = await waitFor(
    `DynWork's service at ${target.ownRegistration}`,
    async () => {
      const registered = await read(target.ownRegistration)
      return registered && (await health(registered)) ? registered : undefined
    },
    60_000,
  )
  return { url: info.url, pid: info.pid, headers: authorization(info) ?? {} }
}

type Service = Awaited<ReturnType<typeof serviceOf>>

async function get(service: Service, route: string, directory: string) {
  const response = await fetch(`${service.url}${route}?location[directory]=${encodeURIComponent(directory)}`, {
    headers: service.headers,
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`GET ${route}: ${response.status}`)
  return response.json()
}

// The synced items the service lists, without DynWork's prefix.
// macOS does not activate an app a background process starts, and the sync polls every 30 s only while a DynWork
// window has focus (5 min otherwise). The main process' inspector (on 127.0.0.1, this run only) gives the window focus
// the way a user's click would, then says what main sees.
async function focus(inspectPort: number) {
  const target = await waitFor(
    "the main process inspector",
    async () =>
      (
        await fetch(`http://127.0.0.1:${inspectPort}/json/list`)
          .then((response) => response.json() as Promise<{ webSocketDebuggerUrl: string }[]>)
          .catch(() => [])
      )[0]?.webSocketDebuggerUrl,
    15_000,
  )
  const main = await connect(target)
  const evaluate = async (expression: string) =>
    (
      await main.send("Runtime.evaluate", {
        expression,
        includeCommandLineAPI: true,
        awaitPromise: true,
        returnByValue: true,
      })
    ).result?.result?.value
  const real = await evaluate(`(() => {
      const electron = require("electron")
      electron.app.focus({ steal: true })
      electron.BrowserWindow.getAllWindows().find((item) => item.isVisible())?.focus()
      return new Promise((resolve) => setTimeout(() => resolve(electron.BrowserWindow.getAllWindows().some((item) => item.isFocused())), 500))
    })()`)
  // macOS refuses to activate an app another app started unless the user is there to click it. Main then gets what a
  // click would give it: the visible window reports focus and the app emits its focus event. The engine's own logic
  // (poll at once on focus, then every 30 s) runs unchanged.
  const simulated =
    real === true
      ? false
      : await evaluate(`(() => {
      const electron = require("electron")
      const window = electron.BrowserWindow.getAllWindows().find((item) => item.isVisible())
      if (!window) return false
      window.isFocused = () => true
      electron.app.emit("browser-window-focus", {}, window)
      return true
    })()`)
  main.close()
  if (real === true) return "macOS gave the window focus"
  if (simulated === true) return "macOS refused to activate the app; main was given the window's focus event"
  throw new Error("no visible DynWork window to focus")
}

// What the active instance's row says about its sync, for a failure message.
async function syncLine(cdp: Cdp) {
  return cdp.value<string>(
    `[...document.querySelectorAll('[data-component="accounts-instance"][data-active] [data-slot="accounts-sync"]')].map((node) => node.dataset.tone + ": " + node.textContent).join("; ")`,
  )
}

async function synced(service: Service, directory: string) {
  const ids = async (route: string, field: "id" | "name") => {
    const body: { data: Record<string, string>[] } = await get(service, route, directory)
    return body.data
      .map((entry) => entry[field] ?? "")
      .map((id) => id.replace(prefix, ""))
      .filter((id) => known.has(id))
      .toSorted()
  }
  const [skills, agents, mcp] = await Promise.all([
    ids("/api/skill", "id"),
    ids("/api/agent", "id"),
    ids("/api/mcp", "name"),
  ])
  return { skills, agents, mcp }
}

type Content = Awaited<ReturnType<typeof synced>>

function holds(content: Content, instance: "alpha" | "beta") {
  const want = expected[instance]
  return (
    want.skills.every((id) => content.skills.includes(id)) &&
    want.agents.every((id) => content.agents.includes(id)) &&
    want.mcp.every((id) => content.mcp.includes(id))
  )
}

function mentions(content: Content, instance: "alpha" | "beta") {
  return [...content.skills, ...content.agents, ...content.mcp].some((id) => id.includes(instance))
}

function describe(content: Content) {
  return `skills [${content.skills.join(", ")}], agents [${content.agents.join(", ")}], mcp [${content.mcp.join(", ")}]`
}

// Rules have no route of their own: the plugin puts them in every step's system prompt. The page shows the count the
// service answered the last apply with.
async function rulesShown(cdp: Cdp) {
  const text = await cdp.value<string>(
    `document.querySelector('[data-action="accounts-detail-rules"] [data-slot="settings-row-description"]')?.textContent ?? ""`,
  )
  return Number(/^\d+/.exec(text)?.[0] ?? 0)
}

// Where the service loads DynWork's server plugin from: the config it was started with.
async function pluginPath(service: Service) {
  const command = await Bun.$`ps eww -o command= -p ${service.pid}`.nothrow().text()
  const found = /[^\s"]*\/Contents\/Resources\/dynwork-server-plugin/.exec(command.replaceAll("\\/", "/"))?.[0]
  if (!found) throw new Error("the service's environment names no dynwork-server-plugin")
  return found
}

// Every file of the profile but the moved app bundle: no known PAT, no PAT at all (`sp-live-`), no JWT.
async function scan(root: string, secrets: string[], when: string) {
  const files = [...new Bun.Glob("**/*").scanSync({ cwd: root, absolute: true, dot: true, onlyFiles: true })].filter(
    (file) => !file.startsWith(path.join(root, "moved/")),
  )
  // The sign-in form's placeholder says "sp-live-…", which the window's code cache may hold: a PAT has a long tail.
  const pat = /sp-live-[A-Za-z0-9_-]{16,}/
  const jwt = /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/
  const found = (
    await Promise.all(
      files.map(async (file) => {
        const text = Buffer.from(
          await Bun.file(file)
            .bytes()
            .catch(() => new Uint8Array()),
        ).toString("latin1")
        const hits = [
          ...(secrets.some((secret) => text.includes(secret)) ? ["a known PAT"] : []),
          ...(pat.test(text) ? ["a PAT (sp-live-...)"] : []),
          ...(jwt.test(text) ? ["a JWT"] : []),
        ]
        return hits.map((hit) => `${hit} in ${path.relative(root, file)}`)
      }),
    )
  ).flat()
  if (found.length > 0) throw new Error(`plaintext secrets ${when}: ${found.join("; ")}`)
  const databases = files.filter((file) => /\.db(-wal)?$/.test(file)).map((file) => path.relative(root, file))
  return `${files.length} files clean ${when}, databases ${databases.join(", ")}`
}

function rowOf(url: string) {
  return `[...document.querySelectorAll('[data-component="accounts-instance"]')].find((row) => row.querySelector('[data-slot="accounts-instance-url"]')?.textContent === ${JSON.stringify(url)})`
}

function seen(cdp: Cdp, selector: string) {
  return cdp.value<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`)
}

async function click(cdp: Cdp, selector: string) {
  await waitFor(selector, async () => seen(cdp, selector), 15_000)
  await cdp.value(`document.querySelector(${JSON.stringify(selector)}).click()`)
}

function rowCount(cdp: Cdp) {
  return cdp.value<number>(`document.querySelectorAll('[data-component="accounts-instance"]').length`)
}

// Runs an action of an instance's row on the Accounts page, confirming it when the page asks.
async function action(cdp: Cdp, url: string, name: string, confirm = false) {
  const button = `${rowOf(url)}?.querySelector('[data-action="accounts-${name}"]')`
  await waitFor(`${name} on ${url}`, async () => cdp.value<boolean>(`${button} != null && !${button}.disabled`), 15_000)
  await cdp.value(`${button}.click()`)
  if (!confirm) return
  const confirmButton = `[...document.querySelectorAll('[role="dialog"] button')].filter((node) => node.textContent.trim() === "Sign out").pop()`
  await waitFor("the confirmation", async () => cdp.value<boolean>(`${confirmButton} != null`), 5_000)
  await cdp.value(`${confirmButton}.click()`)
}

async function trust(cdp: Cdp, url: string) {
  const button = `${rowOf(url)}?.querySelector('[data-action="accounts-trust"]')`
  await waitFor(`${url}'s key on offer`, async () => cdp.value<boolean>(`${button} != null`), 15_000)
  await cdp.value(`${button}.click()`)
  await waitFor(`${url}'s key to be trusted`, async () => cdp.value<boolean>(`${button} == null`), 10_000)
}

// The sign-in screen with a PAT: URL, green status, token, Enter, then Enter again on Finish, like a keyboard user.
async function signInScreen(cdp: Cdp, target: { url: string; token: string }) {
  await waitFor(
    "the sign-in screen",
    async () =>
      cdp.value<boolean>(
        `!!document.querySelector('[data-component="dynwork-signin"]') && !document.querySelector('[data-component="startup-overlay"]')`,
      ),
    90_000,
  )
  await fillConnect(cdp, target)
  await pressEnter(cdp)
  await waitFor("the instance list", async () => seen(cdp, '[data-slot="signin-instances"]'), 15_000)
  await pressEnter(cdp)
  await waitFor(
    "the sign-in screen to fade out",
    async () => !(await seen(cdp, '[data-component="dynwork-signin"]')),
    30_000,
  )
  await shell(cdp)
}

// Settings -> systemprompt through the titlebar pill's menu.
async function openAccounts(cdp: Cdp) {
  await click(cdp, pill)
  await waitFor("the pill's menu", async () => seen(cdp, '[data-component="accounts-pill-menu"]'), 5_000)
  await cdp.value(`document.querySelector('[data-slot="accounts-pill-actions"] > button:last-child').click()`)
  await waitFor("the systemprompt page", async () => seen(cdp, '[data-action="accounts-add"]'), 10_000)
  await waitFor("an instance", async () => (await rowCount(cdp)) > 0, 10_000)
}

async function shot(cdp: Cdp, name: string) {
  await Bun.sleep(800)
  await screenshot(cdp, path.join(shots, name))
}
