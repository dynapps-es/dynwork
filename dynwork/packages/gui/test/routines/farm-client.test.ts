import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { Failure } from "../../src/routines/contract"
import { FarmClient } from "../../src/routines/farm/client"
import { mints, setup, startFake, type Fake } from "../accounts/fixture"
import { crossing } from "./wire"

// A stand-in for the Governance MCP proxy in front of the farm (`/api/v1/mcp/dynapps-farm/mcp`): stateless Streamable
// HTTP, JSON or an event stream, a bearer checked against the JWTs the fake instance minted. `answer` decides the
// response to each request; by default every tool answers `{ tool, arguments }` as its structured content.
type Seen = { url: string; authorization: string | null; accept: string | null; body: Record<string, unknown> }
type Reply = (seen: Seen, jwt: string) => Response | undefined

let sp: Fake
let proxy: ReturnType<typeof Bun.serve>
const seen: Seen[] = []
const control: { answer?: Reply; refuse: Set<string> } = { refuse: new Set() }

const result = (id: unknown, structured: Record<string, unknown>, isError = false) =>
  Response.json({
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured, isError },
  })

const farmError = (code: string, message: string, retryable = false, details?: Record<string, unknown>) =>
  ((request: Seen) => result(request.body.id, { error: { code, message, retryable, details } }, true)) satisfies Reply

beforeAll(() => {
  sp = startFake()
  proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      if (request.method !== "POST" || url.pathname !== "/api/v1/mcp/dynapps-farm/mcp")
        return new Response("not found", { status: 404 })
      const request_ = {
        url: request.url,
        authorization: request.headers.get("authorization"),
        accept: request.headers.get("accept"),
        body: (await request.json()) as Record<string, unknown>,
      }
      seen.push(request_)
      const jwt = request_.authorization?.replace(/^Bearer /, "") ?? ""
      if (!sp.state.jwts.has(jwt) || control.refuse.has(jwt))
        return Response.json({ error: "invalid_token", detail: `refused ${jwt}` }, { status: 401 })
      const custom = control.answer?.(request_, jwt)
      if (custom) return custom
      const params = request_.body.params as { name: string; arguments: unknown }
      return result(request_.body.id, { tool: params.name, arguments: params.arguments })
    },
  })
})

afterAll(() => {
  proxy.stop(true)
  sp.stop()
})

afterEach(() => {
  seen.length = 0
  control.answer = undefined
  control.refuse.clear()
})

// A signed-in account through the real accounts module; only its instance URL points at the proxy stand-in.
async function signedIn() {
  const context = setup(sp)
  await context.accounts.signInToken({ url: sp.url, token: sp.issuePat() })
  const accounts: FarmClient.Accounts = {
    active: context.accounts.active,
    session: context.accounts.session,
    stored: (id) => {
      const stored = context.accounts.stored(id)
      return stored && { ...stored, url: `http://127.0.0.1:${proxy.port}` }
    },
  }
  return { ...context, view: accounts, id: context.accounts.active() ?? "" }
}

function transport(accounts: FarmClient.Accounts, options?: Partial<FarmClient.ViaSpOptions>) {
  const logs: string[] = []
  const waits: number[] = []
  const client = FarmClient.viaSp({
    accounts,
    log: (line) => logs.push(line),
    sleep: async (ms) => void waits.push(ms),
    ...options,
  })
  return { client, logs, waits }
}

describe("farm client via Governance", () => {
  test("posts a stateless tools/call with the account's JWT in the Authorization header only", async () => {
    const context = await signedIn()
    const { client } = transport(context.view)
    const jwt = await context.accounts.jwt(context.id)

    const answer = await client.callTool("farm_list_schedules", { state: "active" })

    expect(answer).toEqual({ ok: true, value: { tool: "farm_list_schedules", arguments: { state: "active" } } })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.authorization).toBe(`Bearer ${jwt}`)
    expect(seen[0]?.accept).toContain("text/event-stream")
    expect(seen[0]?.url).not.toContain(jwt)
    expect(JSON.stringify(seen[0]?.body)).not.toContain(jwt)
    expect(seen[0]?.body).toMatchObject({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "farm_list_schedules" },
    })
    expect(client.mode).toBe("sp")
    context.accounts.dispose()
  })

  test("reads an answer sent as an event stream", async () => {
    const context = await signedIn()
    const { client } = transport(context.view)
    control.answer = (request) =>
      new Response(
        `event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n` +
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: request.body.id, result: { structuredContent: { subject: "a@b.c" } } })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      )

    expect(await client.callTool("farm_whoami")).toEqual({ ok: true, value: { subject: "a@b.c" } })
    context.accounts.dispose()
  })

  test("a refused JWT is minted again once and the call repeated", async () => {
    const context = await signedIn()
    const { client } = transport(context.view)
    const first = await context.accounts.jwt(context.id)
    control.refuse.add(first)
    const before = mints(sp)

    const answer = await client.callTool("farm_whoami")

    expect(answer.ok).toBe(true)
    expect(mints(sp)).toBe(before + 1)
    expect(seen.map((request) => request.authorization)).toEqual([
      `Bearer ${first}`,
      `Bearer ${await context.accounts.jwt(context.id)}`,
    ])
    context.accounts.dispose()
  })

  test("a JWT refused twice is unauthorized and signed out, after one new mint only", async () => {
    const context = await signedIn()
    const { client } = transport(context.view)
    control.answer = () => Response.json({ error: "invalid_token" }, { status: 401 })
    const before = mints(sp)

    const answer = await client.callTool("farm_whoami")

    expect(answer).toMatchObject({ ok: false, code: "unauthorized", failure: { code: "signed-out" } })
    expect(seen).toHaveLength(2)
    expect(mints(sp)).toBe(before + 1)
    context.accounts.dispose()
  })

  test("503 service_not_running is Cloud not available, without retrying", async () => {
    const context = await signedIn()
    const { client, waits } = transport(context.view)
    control.answer = () =>
      Response.json({ error: "service_not_running", details: "token accessor returned status 403" }, { status: 503 })

    const answer = await client.callTool("farm_whoami")

    expect(answer).toMatchObject({
      ok: false,
      code: "unavailable",
      failure: { code: "failed", message: "Cloud is not available for this account.", retryable: false },
    })
    expect(seen).toHaveLength(1)
    expect(waits).toEqual([])
    context.accounts.dispose()
  })

  test("413 is too_large, and any other 5xx unreachable", async () => {
    const context = await signedIn()
    const { client } = transport(context.view)
    control.answer = () => new Response("Payload Too Large", { status: 413 })
    expect(await client.callTool("farm_whoami")).toMatchObject({
      ok: false,
      code: "too_large",
      failure: { code: "failed" },
    })

    control.answer = () => new Response("bad gateway", { status: 502 })
    expect(await client.callTool("farm_whoami")).toMatchObject({
      ok: false,
      code: "http_502",
      failure: { code: "unreachable", retryable: true },
    })
    context.accounts.dispose()
  })

  test("429 waits for retry-after and tries again; too long a wait or too many answer unreachable", async () => {
    const context = await signedIn()
    const { client, waits } = transport(context.view)
    const left = { limited: 1 }
    control.answer = () =>
      left.limited-- > 0 ? new Response("slow down", { status: 429, headers: { "retry-after": "2" } }) : undefined

    expect((await client.callTool("farm_whoami")).ok).toBe(true)
    expect(waits).toEqual([2_000])
    expect(seen).toHaveLength(2)

    control.answer = () => new Response("slow down", { status: 429, headers: { "retry-after": "1" } })
    expect(await client.callTool("farm_whoami")).toMatchObject({
      ok: false,
      code: "rate_limited",
      failure: { code: "unreachable" },
    })
    // Three tries in all: two waits.
    expect(waits).toEqual([2_000, 1_000, 1_000])

    control.answer = () => new Response("slow down", { status: 429, headers: { "retry-after": "3600" } })
    const before = seen.length
    expect(await client.callTool("farm_whoami")).toMatchObject({ ok: false, code: "rate_limited" })
    expect(seen.length - before).toBe(1)
    context.accounts.dispose()
  })

  test("the farm's errors become failures, keeping the farm's code", async () => {
    const context = await signedIn()
    const { client } = transport(context.view)
    const cases = [
      ["not_found", "not-found"],
      ["agent_not_found", "not-found"],
      ["quota_exceeded", "quota"],
      ["task_not_cancellable", "conflict"],
      ["token_expired", "signed-out"],
      ["model_unknown", "invalid"],
      ["insufficient_scope", "failed"],
    ] as const
    for (const [farm, code] of cases) {
      control.answer = farmError(farm, `farm says ${farm}`)
      expect(await client.callTool("farm_get_schedule", { schedule_id: "s1" })).toEqual({
        ok: false,
        code: farm,
        failure: { code, message: `farm says ${farm}`, retryable: code === "unreachable" },
      })
    }
    control.answer = farmError("timezone_invalid", "Not an IANA zone.", false, { field: "recurrence.timezone" })
    expect(await client.callTool("farm_create_schedule", { name: "x" })).toMatchObject({
      ok: false,
      failure: { code: "invalid", fields: { "recurrence.timezone": "Not an IANA zone." } },
    })
    context.accounts.dispose()
  })

  test("only a farm error marked retryable is tried again", async () => {
    const context = await signedIn()
    const { client, waits } = transport(context.view)
    const left = { busy: 1 }
    control.answer = (request) =>
      left.busy-- > 0 ? farmError("database_busy", "Busy, retry.", true)(request) : undefined
    expect((await client.callTool("farm_whoami")).ok).toBe(true)
    expect(seen).toHaveLength(2)
    expect(waits).toHaveLength(1)

    control.answer = farmError("payload_invalid", "No.")
    expect(await client.callTool("farm_whoami")).toMatchObject({ ok: false, code: "payload_invalid" })
    expect(seen).toHaveLength(3)

    control.answer = farmError("database_busy", "Busy, retry.", true)
    expect(await client.callTool("farm_whoami")).toMatchObject({
      ok: false,
      code: "database_busy",
      failure: { code: "unreachable", retryable: true },
    })
    expect(seen).toHaveLength(6)
    context.accounts.dispose()
  })

  test("a protocol error, a timeout and a dead endpoint are failures, never rejections", async () => {
    const context = await signedIn()
    const { client } = transport(context.view, { timeout: 200 })
    control.answer = (request) =>
      Response.json({ jsonrpc: "2.0", id: request.body.id, error: { code: -32602, message: "Unknown tool" } })
    expect(await client.callTool("farm_nope")).toMatchObject({
      ok: false,
      code: "protocol",
      failure: { code: "failed" },
    })

    control.answer = () => new Response("<html>not json</html>", { headers: { "content-type": "application/json" } })
    expect(await client.callTool("farm_whoami")).toMatchObject({ ok: false, code: "protocol" })

    control.answer = () => undefined
    const slow = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Promise<Response>(() => {}) })
    const late = transport(
      { ...context.view, stored: (id) => ({ ...context.accounts.stored(id)!, url: `http://127.0.0.1:${slow.port}` }) },
      { timeout: 200 },
    )
    expect(await late.client.callTool("farm_whoami")).toMatchObject({
      ok: false,
      code: "timeout",
      failure: { code: "unreachable" },
    })
    slow.stop(true)

    const dead = transport({
      ...context.view,
      stored: (id) => ({ ...context.accounts.stored(id)!, url: "http://127.0.0.1:9" }),
    })
    expect(await dead.client.callTool("farm_whoami")).toMatchObject({
      ok: false,
      code: "network",
      failure: { code: "unreachable" },
    })
    context.accounts.dispose()
  })

  test("refuses a credential-shaped argument at any depth before any request", async () => {
    const context = await signedIn()
    const { client } = transport(context.view)
    const refused = [{ value: "x" }, { nested: { Token: "x" } }, { list: [{ ok: 1 }, { PAT: "x" }] }]
    for (const args of refused) {
      // SAFETY: the type already refuses the lowercase top-level keys; this is the run-time check behind it.
      const answer = await client.callTool("farm_create_schedule", args as FarmClient.Arguments)
      expect(answer).toMatchObject({ ok: false, code: "secret_argument", failure: { code: "invalid" } })
    }
    expect(seen).toHaveLength(0)
    expect((await client.callTool("farm_create_schedule", { name: "token budget", tokens: 3 })).ok).toBe(true)
    context.accounts.dispose()
  })

  test("signed out: no request, a signed-out failure", async () => {
    const context = await signedIn()
    context.accounts.signOut(context.id)
    const { client } = transport(context.view)
    expect(await client.callTool("farm_whoami")).toMatchObject({
      ok: false,
      code: "signed_out",
      failure: { code: "signed-out" },
    })
    expect(seen).toHaveLength(0)
    context.accounts.dispose()
  })

  test("the JWT never reaches a failure, a log line or the Ipc, even when a server echoes it", async () => {
    const context = await signedIn()
    const { client, logs } = transport(context.view)
    const answers: FarmClient.Answer[] = []
    const echo = (status: number) => (request: Seen, jwt: string) =>
      new Response(`bearer was ${jwt} for ${request.url}`, { status })
    const replies: Reply[] = [
      (request, jwt) => farmError("not_found", `no schedule for ${jwt}`)(request),
      (request, jwt) => farmError(`code_${jwt}`, `bad ${jwt}`, false, { field: `field ${jwt}` })(request),
      echo(503),
      echo(413),
      echo(500),
      echo(400),
      (request, jwt) => farmError("database_busy", `busy ${jwt}`, true)(request),
    ]
    for (const reply of replies) {
      control.answer = reply
      answers.push(await client.callTool("farm_whoami"))
    }
    control.answer = () => Response.json({ error: "invalid_token" }, { status: 401 })
    answers.push(await client.callTool("farm_whoami"))

    const jwts = [...sp.state.jwts]
    const failures = answers.flatMap((answer) => (answer.ok ? [] : [answer]))
    expect(failures).toHaveLength(replies.length + 1)
    const wire = failures.map((answer) => JSON.stringify(crossing(Failure, answer.failure)))
    const text = JSON.stringify(failures) + wire.join("") + logs.join("\n")
    expect(logs.length).toBeGreaterThan(0)
    // A proxy body is never echoed, whatever it holds.
    expect(text).not.toContain("bearer was")
    for (const jwt of jwts) expect(text).not.toContain(jwt)
    context.accounts.dispose()
  })
})

describe("connection mode", () => {
  test("is read from one variable: absent or empty is sp, known values pass, anything else is unknown", () => {
    expect(FarmClient.mode({})).toBe("sp")
    expect(FarmClient.mode({ [FarmClient.connection]: "" })).toBe("sp")
    expect(FarmClient.mode({ [FarmClient.connection]: "sp" })).toBe("sp")
    expect(FarmClient.mode({ [FarmClient.connection]: "direct" })).toBe("direct")
    expect(FarmClient.mode({ [FarmClient.connection]: "DIRECT" })).toBeUndefined()
  })

  test("direct says it is not available and never falls back to Governance, even signed in", async () => {
    const context = await signedIn()
    const chosen = FarmClient.select(FarmClient.mode({ [FarmClient.connection]: "direct" }), { accounts: context.view })

    expect(chosen.mode).toBe("direct")
    expect(await chosen.callTool("farm_whoami")).toEqual({
      ok: false,
      code: "direct_not_available",
      failure: {
        code: "unsupported",
        message: "Connecting to Cloud without Governance is not available yet.",
        retryable: false,
      },
    })
    expect(seen).toHaveLength(0)
    context.accounts.dispose()
  })

  test("an unknown mode is refused, not guessed; sp selects the Governance transport", async () => {
    const context = await signedIn()
    const unknown = FarmClient.select(FarmClient.mode({ [FarmClient.connection]: "farm" }), { accounts: context.view })
    expect(unknown.mode).toBe("unknown")
    expect(await unknown.callTool("farm_whoami")).toMatchObject({ ok: false, code: "mode_unknown" })
    expect(seen).toHaveLength(0)

    const sp_ = FarmClient.select(FarmClient.mode({}), { accounts: context.view })
    expect(sp_.mode).toBe("sp")
    expect((await sp_.callTool("farm_whoami")).ok).toBe(true)
    expect(seen).toHaveLength(1)
    context.accounts.dispose()
  })
})
