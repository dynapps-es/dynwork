import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { DynWorkAccounts } from "../../src/accounts/accounts"
import { Failure } from "../../src/routines/contract"
import { FarmClient } from "../../src/routines/farm/client"
import { FarmCloud } from "../../src/routines/farm/cloud"
import { setup, startFake, type Fake } from "../accounts/fixture"
import { crossing } from "./wire"

// One stand-in for both ends Cloud reaches: the Governance MCP proxy in front of the farm, answering `farm_whoami` and
// `farm_request_credential_upload` as the farm does, and the farm's own upload route, which takes the PAT once per
// ticket with no key. `elsewhere` is where a redirect from the upload route would lead.
type Upload = { path: string; authorization: string | null; body: string }

let sp: Fake
let farm: ReturnType<typeof Bun.serve>
const calls: { name: string; body: string }[] = []
const uploads: Upload[] = []
const elsewhere: Upload[] = []
const state: {
  stored?: string
  tickets: Set<string>
  unavailable: boolean
  link?: (ticket: string) => string
  answer?: () => Response
} = { tickets: new Set(), unavailable: false }

const base = () => `http://127.0.0.1:${farm.port}`

const result = (id: unknown, structured: Record<string, unknown>) =>
  Response.json({
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured },
  })

beforeAll(() => {
  sp = startFake()
  farm = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      const seen = {
        path: url.pathname,
        authorization: request.headers.get("authorization"),
        body: await request.text(),
      }
      if (url.pathname === "/elsewhere") {
        elsewhere.push(seen)
        return new Response(null, { status: 204 })
      }
      if (request.method === "PUT" && url.pathname.startsWith("/farm/api/v1/credential-uploads/")) {
        uploads.push(seen)
        if (state.answer) return state.answer()
        const ticket = url.pathname.split("/").at(-1) ?? ""
        if (!state.tickets.delete(ticket)) return Response.json({ error: { code: "not_found" } }, { status: 404 })
        state.stored = (JSON.parse(seen.body) as { value: string }).value
        return new Response(null, { status: 204 })
      }
      if (request.method !== "POST" || url.pathname !== "/api/v1/mcp/dynapps-farm/mcp")
        return new Response("not found", { status: 404 })
      const jwt = seen.authorization?.replace(/^Bearer /, "") ?? ""
      if (!sp.state.jwts.has(jwt)) return Response.json({ error: "invalid_token" }, { status: 401 })
      const body = JSON.parse(seen.body) as { id: unknown; params: { name: string } }
      calls.push({ name: body.params.name, body: seen.body })
      if (state.unavailable) return Response.json({ error: "service_not_running" }, { status: 503 })
      if (body.params.name === "farm_whoami")
        return result(body.id, { subject: "a@b.c", gateway_identity: { user_credential: state.stored !== undefined } })
      if (body.params.name === "farm_request_credential_upload") {
        const ticket = crypto.randomUUID()
        state.tickets.add(ticket)
        return result(body.id, {
          upload_url: state.link?.(ticket) ?? `${base()}/farm/api/v1/credential-uploads/${ticket}`,
          method: "PUT",
          expires_at: "2026-11-19T10:01:00Z",
          type: "gateway_pat",
          name: "sp-gateway",
        })
      }
      return new Response("unknown tool", { status: 400 })
    },
  })
})

afterAll(() => {
  farm.stop(true)
  sp.stop()
})

afterEach(() => {
  calls.length = 0
  uploads.length = 0
  elsewhere.length = 0
  state.stored = undefined
  state.tickets.clear()
  state.unavailable = false
  state.link = undefined
  state.answer = undefined
})

// A signed-in account through the real accounts module, its instance URL pointed at the stand-in. Its PAT is lent the
// way the accounts lend it: only while the account is signed in.
async function signedIn() {
  const context = setup(sp)
  const held = { pat: sp.issuePat() }
  await context.accounts.signInToken({ url: sp.url, token: held.pat })
  const id = context.accounts.active() ?? ""
  const transport = FarmClient.viaSp({
    accounts: {
      active: context.accounts.active,
      session: context.accounts.session,
      stored: (key) => {
        const stored = context.accounts.stored(key)
        return stored && { ...stored, url: base() }
      },
    },
  })
  const accounts: FarmCloud.Accounts = {
    active: context.accounts.active,
    withPat: async (key, use) => {
      if (context.accounts.list().find((account) => account.id === key)?.status !== "signedIn")
        throw new DynWorkAccounts.NotSignedIn({ id: key })
      return use(held.pat)
    },
  }
  const logs: string[] = []
  const cloud = FarmCloud.make({ transport, accounts, log: (line) => logs.push(line) })
  return { ...context, id, held, cloud, logs }
}

const named = (name: string) => calls.filter((call) => call.name === name).length

describe("Cloud access with the account's PAT", () => {
  test("no PAT in the farm: asks for one link and uploads once, with no key", async () => {
    const context = await signedIn()

    expect(await context.cloud.ensure()).toEqual({ ok: true, state: "uploaded" })

    expect(calls.map((call) => call.name)).toEqual(["farm_whoami", "farm_request_credential_upload"])
    expect(JSON.parse(calls[1]?.body ?? "{}").params.arguments).toEqual({ type: "gateway_pat", name: "sp-gateway" })
    expect(uploads).toHaveLength(1)
    expect(uploads[0]?.authorization).toBeNull()
    expect(state.stored).toBe(context.held.pat)
    context.accounts.dispose()
  })

  test("a PAT already in the farm: nothing is uploaded", async () => {
    const context = await signedIn()
    state.stored = "held-by-the-farm"

    expect(await context.cloud.ensure("capabilities")).toEqual({ ok: true, state: "present" })

    expect(calls.map((call) => call.name)).toEqual(["farm_whoami"])
    expect(uploads).toHaveLength(0)
    context.accounts.dispose()
  })

  test("a task refused by the gateway uploads again, even with a PAT in the farm; other reasons do not", async () => {
    const context = await signedIn()
    state.stored = "revoked-in-governance"

    expect(await context.cloud.retry("timeout")).toBeUndefined()
    expect(await context.cloud.retry(undefined)).toBeUndefined()
    expect(calls).toHaveLength(0)

    expect(await context.cloud.retry("farm_access_revoked")).toEqual({ ok: true, state: "uploaded" })
    expect(state.stored).toBe(context.held.pat)
    expect(await context.cloud.retry("user_gateway_credential_missing")).toEqual({ ok: true, state: "uploaded" })
    expect(named("farm_whoami")).toBe(0)
    expect(uploads).toHaveLength(2)
    context.accounts.dispose()
  })

  test("503 service_not_running: Cloud is unavailable and nothing is asked or uploaded", async () => {
    const context = await signedIn()
    state.unavailable = true

    const shown = await context.cloud.ensure("capabilities")
    const refused = await context.cloud.retry("farm_access_revoked")

    expect(shown).toMatchObject({ ok: false, code: "unavailable" })
    expect(refused).toMatchObject({ ok: false, code: "unavailable" })
    expect(named("farm_request_credential_upload")).toBe(1)
    expect(named("farm_whoami")).toBe(1)
    expect(uploads).toHaveLength(0)
    context.accounts.dispose()
  })

  test("two at once share one upload; one that must upload waits for a check and then uploads", async () => {
    const context = await signedIn()

    const both = await Promise.all([context.cloud.ensure(), context.cloud.ensure()])
    expect(both).toEqual([
      { ok: true, state: "uploaded" },
      { ok: true, state: "uploaded" },
    ])
    expect(named("farm_request_credential_upload")).toBe(1)
    expect(uploads).toHaveLength(1)

    const mixed = await Promise.all([
      context.cloud.ensure("capabilities"),
      context.cloud.retry("farm_access_revoked"),
      context.cloud.retry("farm_access_revoked"),
    ])
    expect(mixed).toEqual([
      { ok: true, state: "present" },
      { ok: true, state: "uploaded" },
      { ok: true, state: "uploaded" },
    ])
    expect(uploads).toHaveLength(2)
    context.accounts.dispose()
  })

  test("a new PAT for the account is uploaded; the same one is not uploaded twice", async () => {
    const context = await signedIn()
    state.stored = "from-an-earlier-launch"

    expect(await context.cloud.ensure("account")).toEqual({ ok: true, state: "uploaded" })
    expect(await context.cloud.ensure("account")).toEqual({ ok: true, state: "unchanged" })
    expect(uploads).toHaveLength(1)

    context.held.pat = sp.issuePat()
    await context.accounts.signInToken({ url: sp.url, token: context.held.pat })
    expect(await context.cloud.ensure("account")).toEqual({ ok: true, state: "uploaded" })
    expect(state.stored).toBe(context.held.pat)
    expect(uploads).toHaveLength(2)
    context.accounts.dispose()
  })

  test("signed out: no request, a signed-out answer", async () => {
    const context = await signedIn()
    context.accounts.signOut(context.id)

    expect(await context.cloud.ensure()).toMatchObject({ ok: false, code: "signed_out" })
    expect(await context.cloud.retry("farm_access_revoked")).toMatchObject({ ok: false, code: "signed_out" })
    expect(calls).toHaveLength(0)
    expect(uploads).toHaveLength(0)
    context.accounts.dispose()
  })

  test("the PAT reaches no MCP call, log line, Ipc answer or stored state", async () => {
    const context = await signedIn()
    const outcomes = [
      await context.cloud.ensure(),
      await context.cloud.retry("farm_access_revoked"),
      await context.cloud.ensure("account"),
    ]
    state.answer = () => Response.json({ error: { code: "credential_value_invalid" } }, { status: 422 })
    outcomes.push(await context.cloud.retry("farm_access_revoked"))
    state.answer = undefined
    state.unavailable = true
    outcomes.push(await context.cloud.ensure())

    const pat = context.held.pat
    expect(calls.length).toBeGreaterThan(0)
    calls.forEach((call) => expect(call.body).not.toContain(pat))
    expect(context.logs.length).toBeGreaterThan(0)
    context.logs.forEach((line) => expect(line).not.toContain(pat))
    context.logs.forEach((line) => expect(line).not.toContain("credential-uploads"))
    outcomes.forEach((outcome) => expect(JSON.stringify(outcome)).not.toContain(pat))
    outcomes
      .flatMap((outcome) => (outcome?.ok === false ? [outcome.failure] : []))
      .forEach((failure) => expect(JSON.stringify(crossing(Failure, failure))).not.toContain(pat))
    expect(context.store.disk.json).not.toContain(pat)
    uploads.forEach((upload) => expect(upload.path).not.toContain(pat))
    context.accounts.dispose()
  })

  test("the upload carries no key and never follows a redirect", async () => {
    const context = await signedIn()
    state.answer = () => new Response(null, { status: 307, headers: { location: `${base()}/elsewhere` } })

    expect(await context.cloud.ensure()).toMatchObject({ ok: false, code: "upload_307" })

    expect(uploads).toHaveLength(1)
    expect(uploads[0]?.authorization).toBeNull()
    expect(elsewhere).toHaveLength(0)
    context.accounts.dispose()
  })

  test("a link that is not the farm's https upload route gets nothing", async () => {
    const context = await signedIn()
    const links = [
      (ticket: string) => `http://farm.example.com/farm/api/v1/credential-uploads/${ticket}`,
      (ticket: string) => `http://user:pw@127.0.0.1:${farm.port}/farm/api/v1/credential-uploads/${ticket}`,
      () => `${base()}/elsewhere`,
      (ticket: string) => `${base()}/farm/api/v1/credential-uploads/${ticket}?then=/elsewhere`,
      () => "not a url",
    ]
    const outcomes = await links.reduce(
      async (done, link) => {
        const list = await done
        state.link = link
        return [...list, await context.cloud.retry("farm_access_revoked")]
      },
      Promise.resolve([] as (FarmCloud.Outcome | undefined)[]),
    )

    outcomes.forEach((outcome) => expect(outcome).toMatchObject({ ok: false, code: "upload_refused" }))
    expect(uploads).toHaveLength(0)
    expect(elsewhere).toHaveLength(0)
    context.accounts.dispose()
  })
})
