import { beforeAll, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { Effect } from "effect"
import path from "node:path"
import { SpMobile } from "../../src"

// Path 1 against the mobile project's alpha (`sp-local.ts up --image local`, the relay image). Runs only when
// SP_LOCAL_ENV points at that project's env file, relative to the package directory; the phase verify sets it and
// exports SP_LOCAL_PROJECT, which `sp-local.ts dev-login` needs. The browser half is played with fetch: the instance
// session comes from the instance's own development login (no IdP), then the consent page and its form, exactly as
// the system browser would submit them. Nothing here prints a secret.

const envPath = process.env.SP_LOCAL_ENV === undefined ? undefined : path.resolve(process.env.SP_LOCAL_ENV)
const script = path.resolve(import.meta.dir, "../../../../script/sp-local.ts")

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const fail = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(effect))

async function readEnv() {
  if (envPath === undefined) return {}
  const text = await Bun.file(envPath).text()
  return Object.fromEntries(
    text
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  )
}

const env = await readEnv()
const base = `http://127.0.0.1:${env.SP_ALPHA_PORT ?? ""}`
const browser = { cookie: "" }

// The system browser: authorize with the instance session, then the consent form. The callback the instance sends it to.
async function consent(decision: "allow" | "deny", pkce: SpMobile.Pkce, state: string) {
  const page = await fetch(
    SpMobile.authorizeUrl(base, { challenge: pkce.challenge, state, deviceName: "Pixel live" }),
    {
      headers: { cookie: browser.cookie },
      redirect: "manual",
    },
  )
  expect(page.status).toBe(200)
  const html = await page.text()
  expect(html).toContain("Pixel live")
  const request = /name="request" value="([^"]+)"/.exec(html)?.[1] ?? ""
  const answer = await fetch(`${base}/api/dynwork/mobile/v1/authorize/decision`, {
    method: "POST",
    headers: { cookie: browser.cookie, "content-type": "application/x-www-form-urlencoded" },
    body: `request=${request}&decision=${decision}`,
    redirect: "manual",
  })
  expect(answer.status).toBe(303)
  return answer.headers.get("location") ?? ""
}

async function signIn(peerId: string) {
  const pkce = SpMobile.createPkce()
  const state = SpMobile.randomSecret()
  const callback = SpMobile.parseCallback(await consent("allow", pkce, state), state)
  if (callback?._tag !== "Code") throw new Error("the instance did not answer with a code")
  return {
    pkce,
    code: callback.code,
    signedIn: await run(SpMobile.exchange(base, { code: callback.code, verifier: pkce.verifier, peerId })),
  }
}

// Whether the relay's device socket opens for a credential.
function deviceSocketOpens(credential: string) {
  const { promise, resolve } = Promise.withResolvers<boolean>()
  const socket = new WebSocket(`ws://127.0.0.1:${env.SP_ALPHA_PORT}/api/dynwork/relay/v1/device`, {
    headers: { authorization: `Bearer ${credential}` },
  })
  socket.onopen = () => {
    socket.close()
    resolve(true)
  }
  socket.onerror = () => resolve(false)
  socket.onclose = () => resolve(false)
  return promise
}

const peer = () => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex")

describe.skipIf(envPath === undefined)("path 1 on the mobile alpha", () => {
  beforeAll(async () => {
    const link = (await $`bun ${script} dev-login alpha`.quiet().text()).trim().split("\n").at(-1) ?? ""
    const signedIn = await fetch(link, { redirect: "manual" })
    browser.cookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0] ?? ""
    expect(browser.cookie.startsWith("access_token=eyJ")).toBe(true)
  }, 120_000)

  test("the relay image offers path 1", async () => {
    const instance = await run(SpMobile.discover(base))
    expect(instance.authorizePath).toBe("/api/dynwork/mobile/v1/authorize")
    console.log(`alpha ${base}: path 1 offered by "${instance.displayName}"`)
  })

  test("a browser without the instance session is sent through the instance login", async () => {
    const pkce = SpMobile.createPkce()
    const answer = await fetch(
      SpMobile.authorizeUrl(base, { challenge: pkce.challenge, state: SpMobile.randomSecret(), deviceName: "Pixel" }),
      {
        redirect: "manual",
      },
    )
    expect(answer.status).toBe(307)
    expect(answer.headers.get("location")).toStartWith(
      "/admin/login?redirect=%2Fapi%2Fdynwork%2Fmobile%2Fv1%2Fauthorize",
    )
  })

  test("round trip: consent, callback, exchange, session, refresh, device socket, sign-out", async () => {
    const { signedIn } = await signIn(peer())
    expect(signedIn.credential).toStartWith("dwm1_")
    expect(signedIn.account.email).toBe("dev@dynapps.test")
    const current = await fetch(`${base}/api/dynwork/mobile/v1/session`, {
      headers: { authorization: `Bearer ${signedIn.token}` },
    })
    expect(current.status).toBe(200)
    expect(((await current.json()) as { device_id: string }).device_id).toBe(signedIn.deviceId)
    const refreshed = await run(SpMobile.refresh(base, signedIn.credential))
    expect(refreshed.deviceId).toBe(signedIn.deviceId)
    expect(await deviceSocketOpens(signedIn.credential)).toBe(true)
    await run(SpMobile.signOut(base, signedIn.credential))
    expect((await fail(SpMobile.refresh(base, signedIn.credential)))._tag).toBe("Unauthorized")
    expect(await deviceSocketOpens(signedIn.credential)).toBe(false)
  })

  test("a code works once, and its replay signs the first device out", async () => {
    const id = peer()
    const { pkce, code, signedIn } = await signIn(id)
    const replay = await fail(SpMobile.exchange(base, { code, verifier: pkce.verifier, peerId: id }))
    expect(replay).toMatchObject({ _tag: "Protocol", status: 400, errorKey: "invalid_grant" })
    expect((await fail(SpMobile.refresh(base, signedIn.credential)))._tag).toBe("Unauthorized")
  })

  test("a wrong verifier is refused", async () => {
    const pkce = SpMobile.createPkce()
    const state = SpMobile.randomSecret()
    const callback = SpMobile.parseCallback(await consent("allow", pkce, state), state)
    if (callback?._tag !== "Code") throw new Error("the instance did not answer with a code")
    const error = await fail(
      SpMobile.exchange(base, { code: callback.code, verifier: SpMobile.randomSecret(), peerId: peer() }),
    )
    expect(error).toMatchObject({ _tag: "Protocol", errorKey: "invalid_grant" })
  })

  test("Deny comes back as a denial with the state", async () => {
    const state = SpMobile.randomSecret()
    expect(SpMobile.parseCallback(await consent("deny", SpMobile.createPkce(), state), state)).toEqual({
      _tag: "Denied",
    })
  })
})
