import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto"
import { Jcs } from "../src/jcs"
import deviceLink from "../../../test/sp-local/fixtures/device-link.json"
import alpha from "./fixtures/alpha.json"
import consumer from "./fixtures/consumer.json"

// A systemprompt 0.76 instance in miniature, answering with the bodies observed on the local harness: the device-link
// capture (`test/sp-local/fixtures/device-link.json`) and `fixtures/alpha.json`. Credentials are random
// stand-ins, and the manifest is signed with a key pair generated here, so tests can tamper with it or rotate the key.

export type KeyPair = ReturnType<typeof keyPair>

export function keyPair() {
  const pair = generateKeyPairSync("ed25519")
  // The SPKI DER of an ed25519 key is a 12-byte header followed by the 32 raw key bytes the instance publishes
  const raw = pair.publicKey.export({ format: "der", type: "spki" }).subarray(12)
  return {
    public: raw.toString("base64"),
    sign: (payload: string) => sign(null, Buffer.from(payload), pair.privateKey).toString("base64"),
  }
}

// The Drive store as sp-local 0.83 answers it (`docs/06-live-checks.md` of the Drive plan): documents with their
// revisions, folders, comments, resumable uploads and blobs, all in memory.
export type FakeDocument = {
  id: string
  folder_id: string | null
  name: string
  format: string
  mime_type: string
  head_revision_id: string
  template_id: string | null
  owner_user_id: string
  created_at: string
  updated_at: string
}

export type FakeRevision = {
  id: string
  document_id: string
  parent_revision_id: string | null
  content_sha256: string
  author_user_id: string
  actor_kind: string
  origin_kind: string
  message: string | null
  created_at: string
  // 0.84 records who wrote it: the conversation, and the token's agent and OAuth client
  context_id?: string | null
  agent_name?: string
  client_id?: string
}

// The OAuth client of DynWork's token (`docs/06-live-checks.md`), which 0.84 records as the agent too: the token has no
// `purpose`.
export const bridgeClient = "sp_bridge"

// A spreadsheet's only sheet in the fake, as the core names a sheet node, and the A1 text 0.84 takes as a cell range
// (the core's own pattern; it also refuses a range whose start is not its top-left).
const sheet = "sheet[Sales]"
const a1 = /^[A-Za-z]{1,3}[1-9][0-9]{0,6}(:[A-Za-z]{1,3}[1-9][0-9]{0,6})?$/
const spreadsheet = (mime: string) =>
  mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
  mime === "application/vnd.oasis.opendocument.spreadsheet"

export function startDrive() {
  return {
    // The core the Drive answers as: 0.83, or 0.84 with its discovery block, its attribution and `unknown_context`
    version: "0.83" as "0.83" | "0.84",
    folders: new Map<string, Record<string, unknown>>(),
    documents: new Map<string, FakeDocument & { revisions: FakeRevision[]; bytes: Uint8Array; contexts: string[] }>(),
    comments: new Map<string, Array<Record<string, unknown>>>(),
    proposals: new Map<string, Array<Record<string, unknown>>>(),
    uploads: new Map<string, { meta: Record<string, unknown>; parts: Map<number, Uint8Array> }>(),
    blobs: new Map<string, { bytes: Uint8Array; mime: string }>(),
    // The Content-Security-Policy `/rendered` answers with
    csp: "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; form-action 'none'; frame-ancestors 'self'",
    // Every write is refused as an agent capped at `suggest` (what an unattended token gets), unless it proposes
    suggestOnly: false,
    // The documents moved to the trash, by id: they leave every listing and read
    trashed: new Set<string>(),
    // The grants of each document, by document id
    grants: new Map<string, Array<{ id: string; kind: string; value: string; name: string; level: string }>>(),
    // The Dynapps extension 0.85 lets an attended agent share what it created (every document here is the agent's);
    // before it, every share and revocation of the agent is refused (0.83)
    agentShare: false,
    // Size of each upload part the instance asks for
    partSize: 8 * 1024 * 1024,
    // The conversations registered with `POST /api/v1/core/contexts`: name by `context_id`
    contexts: new Map<string, string>(),
    // The directory `GET /api/v1/documents/people` (0.84) reads, by user id
    people: new Map<string, { user_id: string; name: string; email: string }>(),
    // The bridge stream: what each open stream is sent, and the frames sent to every stream that opens from now on
    streams: new Set<(frame: string) => void>(),
    backlog: [] as string[],
    // `announce` sends a frame to the streams open now and to those that open later (the instance keeps no history, the
    // fake does, so that a test need not race the stream's opening).
    announce(name: string, value: Record<string, unknown>, keep = true) {
      const frame = `data: ${JSON.stringify({ type: "CUSTOM", timestamp: new Date().toISOString(), name, value })}\n\n`
      if (keep) this.backlog.push(frame)
      this.streams.forEach((send) => send(frame))
    },
  }
}

// DynWork's `person_ui` client as the Dynapps extension declares it on 0.84, and the redirect it declares, which the
// core takes on any port.
export const personClient = "dynwork-desktop"

function personRedirect(value: string) {
  const url = URL.canParse(value) ? new URL(value) : undefined
  return url !== undefined && url.protocol === "http:" && url.hostname === "127.0.0.1" && url.pathname === "/oauth/callback"
}

// The routes a UI session may call only within 600 s of its sign-in (0.84 `step_up.rs`): sharing, revoking all,
// transfer, delete and agent caps
function stepUp(method: string, path: string) {
  if (/\/grants(\/all)?$/.test(path) || /\/agent-cap$/.test(path) || /\/transfer$/.test(path)) return method !== "GET"
  if (/^\/api\/v1\/(documents|document-folders)\/[^/]+$/.test(path)) return method === "DELETE"
  return false
}

// The person's UI sessions the fake's OAuth server issued: codes waiting for their grant, live and spent refresh tokens
// by family, live access tokens, and what a UI token did on the Drive.
export function startPerson() {
  return {
    // `person_ui`: 0.84 with the client declared; `plain`: declared without `person_ui` (no UI session); `none`: 0.83
    // or not declared
    client: "person_ui" as "person_ui" | "plain" | "none",
    codes: new Map<string, { challenge: string; redirect: string; signedInAt: number; user: string }>(),
    refresh: new Map<string, { family: string; signedInAt: number; user: string }>(),
    spent: new Map<string, string>(),
    families: new Set<string>(),
    access: new Map<string, { signedInAt: number; expiresAt: number }>(),
    // The query of every authorize page asked for, and every Drive call a UI token made
    authorized: [] as Array<Record<string, string>>,
    acted: [] as string[],
  }
}

export type Recorded = { method: string; path: string; query: string; headers: Record<string, string>; body: string }

export function startFake() {
  const state = {
    key: keyPair(),
    discovery: deviceLink.instance.discovery.body as unknown,
    payload: structuredClone(alpha.manifest.payload) as Record<string, unknown>,
    // serve a payload one byte off the one that was signed
    tamper: false,
    // sign with this key while still publishing `key`
    signer: undefined as KeyPair | undefined,
    // answer every request, or only those to `path`, with this status and body
    override: undefined as
      | { path?: string; status: number; body?: unknown; headers?: Record<string, string> }
      | undefined,
    codes: new Set<string>(),
    pats: new Set<string>(),
    jwts: new Set<string>(),
    // The session each JWT was minted for, which a heartbeat must name
    sessions: new Map<string, string>(),
    heartbeats: [] as Array<Record<string, unknown>>,
    // Device credentials the instance issued, with the device each enrols, and the device of each fingerprint
    devices: new Map<string, { device_id: string; consumer_id: string }>(),
    fingerprints: new Map<string, string>(),
    // Plans served by publication id: the ones observed on the local harness for alpha's skills
    plans: structuredClone(consumer.plans) as Record<string, (typeof consumer.plans)["alpha_notes"]>,
    receipts: [] as Array<{ key: string; receipt_id: string; body: string }>,
    bindings: new Map<string, { id: string; bound_at: string }>(),
    requests: [] as Recorded[],
    drive: startDrive(),
    person: startPerson(),
    // Plugin bundle files by `<plugin>/<path>`, served at `/v1/bridge/plugins/<plugin>/<path>`
    files: {} as Record<string, Uint8Array | string>,
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      // Bytes, not text: an upload part is binary
      const raw = new Uint8Array(await request.arrayBuffer())
      const body = new TextDecoder().decode(raw)
      state.requests.push({
        method: request.method,
        path: url.pathname,
        query: url.search,
        headers: Object.fromEntries(request.headers),
        body,
      })
      if (state.override !== undefined && (state.override.path === undefined || state.override.path === url.pathname))
        return Response.json(state.override.body ?? null, {
          status: state.override.status,
          headers: state.override.headers,
        })
      if (/^\/api\/v1\/(documents|document-folders|uploads)/.test(url.pathname)) return driveRoute(request, url, raw)
      if (url.pathname === "/api/v1/mcp/documents/mcp") return documentsMcp(request, body)
      return route(request, url.pathname, body)
    },
  })

  // The root discovery document as each core answers it: 0.84 adds the Drive's block (`endpoints.documents`)
  const rootDiscovery = (base: string) => {
    const documents = {
      enabled: true,
      href: `${base}/api/v1/documents`,
      folders: `${base}/api/v1/document-folders`,
      uploads: `${base}/api/v1/uploads`,
      limits: { maxUploadBytes: 104_857_600, inlineMaxBytes: 8_388_608, uploadPartBytes: state.drive.partSize },
      renderedHtml: {
        scripts: true,
        remoteOrigins: ["https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net"],
        agentAuthored: { scripts: true, remoteOrigins: ["https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net"] },
      },
    }
    const at84 = state.drive.version === "0.84"
    return {
      data: {
        name: "Alpha API",
        version: at84 ? "0.84.0" : "0.83.0",
        build: { name: "core", version: at84 ? "0.84.0" : "0.83.0" },
        endpoints: {
          health: `${base}/api/v1/health`,
          core: { href: `${base}/api/v1/core` },
          ...(at84 ? { documents } : {}),
        },
      },
      meta: { timestamp: new Date().toISOString(), version: "1.0.0" },
    }
  }

  const issuePat = () => {
    const pat = `sp-live-${randomBytes(24).toString("hex")}`
    state.pats.add(pat)
    return pat
  }

  const route = (request: Request, path: string, body: string) => {
    const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "")
    const signedIn = bearer !== undefined && state.jwts.has(bearer)
    const route = `${request.method} ${path}`
    if (route === "GET /.well-known/systemprompt-bridge")
      return state.discovery === undefined
        ? Response.json(
            {
              code: "not_found",
              message: "bridge instance not configured",
              error_key: "bridge_instance_not_configured",
            },
            { status: 404 },
          )
        : Response.json(state.discovery)
    if (route === "GET /v1/auth/bridge/capabilities") return Response.json(alpha.capabilities.body)
    if (path.startsWith("/api/v1/core/oauth/")) return oauthRoute(request, path, body, bearer)
    if (route === "GET /api/v1/health") return Response.json(alpha.health.body)
    if (route === "GET /api/v1") return Response.json(rootDiscovery(new URL(request.url).origin))
    if (route === "GET /v1/bridge/pubkey") return Response.json({ pubkey: state.key.public })
    if (route === "POST /v1/auth/bridge/session-pat") {
      if (request.headers.get("content-type") !== "application/json")
        return new Response("Expected request with `Content-Type: application/json`", { status: 415 })
      const code = (JSON.parse(body) as { code?: string }).code ?? ""
      if (code === "") return Response.json(deviceLink.experiments.bad_codes.empty.body, { status: 400 })
      if (!state.codes.delete(code)) return Response.json(deviceLink.round_trip.second_use.body, { status: 401 })
      return Response.json({ pat: issuePat() })
    }
    if (route === "POST /v1/auth/bridge/pat") {
      if (bearer === undefined || !state.pats.has(bearer))
        return Response.json(deviceLink.experiments.revoked_pat.pat_to_jwt_after_revoke.body, { status: 401 })
      const token = `eyJ${randomBytes(24).toString("hex")}`
      const session = request.headers.get("x-session-id") ?? `sess_${randomBytes(8).toString("hex")}`
      state.jwts.add(token)
      state.sessions.set(token, session)
      return Response.json({
        ...deviceLink.round_trip.pat_to_jwt.body,
        token,
        device_token: `eyJ${randomBytes(24).toString("hex")}`,
        headers: { ...deviceLink.round_trip.pat_to_jwt.body.headers, "x-session-id": session },
      })
    }
    if (route === "POST /v1/bridge/device" && signedIn) {
      const input = JSON.parse(body) as { fingerprint: string; label: string }
      const device = state.fingerprints.get(input.fingerprint) ?? crypto.randomUUID()
      state.fingerprints.set(input.fingerprint, device)
      const credential = `sp_device_${randomBytes(36).toString("hex")}`
      state.devices.set(credential, { device_id: device, consumer_id: alpha.whoami.body.user_id })
      return Response.json({ ...consumer.enrol.body, device_id: device, credential })
    }
    if (path.startsWith("/api/v1/consumer/")) return consumerRoute(request, path, body, bearer)
    if (!signedIn) return Response.json(alpha.rejected_jwt.body, { status: 401 })
    if (route === "GET /v1/bridge/profile") return Response.json(alpha.profile.body)
    // Conversations as sp-local 0.83 registers them: the platform's `data` envelope, a plain `code` on a refusal
    const registered = (id: string) =>
      Response.json(
        {
          data: {
            context_id: id,
            user_id: alpha.whoami.body.user_id,
            name: state.drive.contexts.get(id),
            kind: "user",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          meta: { timestamp: new Date().toISOString(), version: "1.0.0" },
        },
        { status: request.method === "POST" ? 201 : 200 },
      )
    const named = () => String((JSON.parse(body) as { name?: unknown }).name ?? "").trim()
    if (route === "POST /api/v1/core/contexts") {
      if (named() === "")
        return Response.json({ code: "bad_request", message: "Context name cannot be empty" }, { status: 400 })
      const id = crypto.randomUUID()
      state.drive.contexts.set(id, named())
      return registered(id)
    }
    const context = /^\/api\/v1\/core\/contexts\/([^/]+)$/.exec(path)
    if (request.method === "PUT" && context) {
      const id = decodeURIComponent(context[1] ?? "")
      if (!state.drive.contexts.has(id))
        return Response.json({ code: "not_found", message: `context not found: ${id}` }, { status: 404 })
      state.drive.contexts.set(id, named())
      return registered(id)
    }
    // As 0.76 answers it (`bridge_heartbeat.rs`): the session must be the JWT's, the version at least 0.28.0
    if (route === "POST /v1/bridge/heartbeat") {
      const input = JSON.parse(body) as Record<string, unknown>
      if (input.session_id !== state.sessions.get(bearer ?? ""))
        return Response.json(
          {
            code: "unauthorized",
            message: "heartbeat session_id must match the authenticated session",
            error_key: "session_mismatch",
          },
          { status: 401 },
        )
      state.heartbeats.push(input)
      const [major = 0, minor = 0] = String(input.bridge_version).split(".").map(Number)
      return Response.json({
        min_bridge_version: "0.28.0",
        compatible: major > 0 || minor >= 28,
        window_status: "within",
      })
    }
    if (route === "GET /v1/models") return Response.json(alpha.models.body)
    if (route === "GET /v1/bridge/whoami") return Response.json(alpha.whoami.body)
    if (route === "GET /v1/bridge/stream") {
      const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "")
      if (bearer === undefined || !state.jwts.has(bearer))
        return Response.json(alpha.rejected_jwt.body, { status: 401 })
      const drive = state.drive
      const encoder = new TextEncoder()
      let send = (_frame: string) => {}
      return new Response(
        new ReadableStream({
          start(controller) {
            send = (frame) => controller.enqueue(encoder.encode(frame))
            // A comment line first, so that the headers go out before the first event does
            send(": connected\n\n")
            drive.streams.add(send)
            drive.backlog.forEach(send)
            request.signal.addEventListener("abort", () => {
              drive.streams.delete(send)
              controller.close()
            })
          },
          cancel() {
            drive.streams.delete(send)
          },
        }),
        { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
      )
    }
    if (request.method === "GET" && path.startsWith("/v1/bridge/plugins/")) {
      const file = state.files[path.slice("/v1/bridge/plugins/".length).split("/").map(decodeURIComponent).join("/")]
      if (file === undefined) return Response.json({ code: "not_found", message: "file not found" }, { status: 404 })
      return new Response(file)
    }
    if (route === "GET /v1/bridge/manifest") {
      const payload = Jcs.canonicalize(state.payload)
      const etag = `"${createHash("sha256").update(payload).digest("hex")}"`
      const headers = { etag, "cache-control": "private, no-cache" }
      if (request.headers.get("if-none-match")?.replace(/^W\//, "") === etag)
        return new Response(null, { status: 304, headers })
      const signature = (state.signer ?? state.key).sign(payload)
      return Response.json(
        { payload: state.tamper ? payload.replace("alpha", "alphb") : payload, signature },
        { headers },
      )
    }
    return Response.json({ code: "not_found", message: "no route" }, { status: 404 })
  }

  // The device-authenticated consumer API: plans by publication, receipts acknowledged once and then as retries.
  const consumerRoute = (request: Request, path: string, body: string, bearer: string | undefined) => {
    if (request.method === "POST" && path === "/api/v1/consumer/session-bindings") return binding(body, bearer)
    if (bearer === undefined || !state.devices.has(bearer))
      return Response.json(consumer.unauthorized.body, { status: 401 })
    const bundle = /^\/api\/v1\/consumer\/resources\/([^/]+)\/publications\/([^/]+)\/bundle$/.exec(path)
    if (request.method === "GET" && bundle) {
      if (new URL(request.url).searchParams.get("host") !== "open-code")
        return Response.json(consumer.bad_host.body, { status: 400 })
      const plan = Object.values(state.plans).find(
        (entry) => entry.resource_id === bundle[1] && entry.publication_id === bundle[2],
      )
      return plan ? Response.json(plan) : Response.json({ title: "Not Found", status: 404 }, { status: 404 })
    }
    if (request.method === "POST" && path === "/api/v1/consumer/receipts") {
      const input = JSON.parse(body) as { installation_id: string; publication_id: string; observed_at: string }
      const key = `${input.installation_id}:${input.publication_id}`
      const same = state.receipts.find((entry) => entry.key === key)
      const content = JSON.stringify({ ...input, observed_at: undefined })
      if (same && same.body !== content) return Response.json({ title: "Conflict", status: 409 }, { status: 409 })
      const receipt_id = same?.receipt_id ?? crypto.randomUUID()
      if (!same) state.receipts.push({ key, receipt_id, body: content })
      return Response.json({
        ...consumer.receipt.accepted.body,
        receipt_id,
        acknowledgement: same ? "identical_retry" : "accepted",
      })
    }
    return Response.json({ title: "Not Found", status: 404 }, { status: 404 })
  }

  // Session bindings as 0.76 answers them (phase 08b probe): an unknown device credential or a receipt this device did
  // not post is 403, a host that is not an evaluator client kind 422, the same binding again the same answer.
  const binding = (body: string, bearer: string | undefined) => {
    const forbidden = {
      type: "about:blank",
      title: "Forbidden",
      status: 403,
      detail: "Consumer evidence is unavailable to this identity",
    }
    if (bearer === undefined || !bearer.startsWith("sp_device_"))
      return Response.json(consumer.unauthorized.body, { status: 401 })
    if (!state.devices.has(bearer)) return Response.json(forbidden, { status: 403 })
    const input = JSON.parse(body) as { receipt_id: string; host: string; session_id: string }
    if (input.host !== "open-code")
      return Response.json({ type: "about:blank", title: "Unprocessable Entity", status: 422 }, { status: 422 })
    if (!state.receipts.some((entry) => entry.receipt_id === input.receipt_id))
      return Response.json(forbidden, { status: 403 })
    const key = `${input.receipt_id}:${input.session_id}`
    const bound = state.bindings.get(key) ?? { id: crypto.randomUUID(), bound_at: new Date().toISOString() }
    state.bindings.set(key, bound)
    return Response.json(bound)
  }

  // The Drive routes, answering as 0.83 does: bodies as observed, a `404`/`403` envelope with `error_key`, writes
  // attributed to the agent, `x-context-id` kept per revision.
  // The `documents` MCP server as far as DynWork's main calls it (0.83): `initialize` opens a session, and
  // `documents_people` searches by name or email prefix, never by id (as 0.83.0 does, whatever its text says), answered
  // as an event stream like the real server.
  const documentsMcp = (request: Request, body: string) => {
    const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "")
    if (bearer === undefined || !state.jwts.has(bearer)) return Response.json(alpha.rejected_jwt.body, { status: 401 })
    const call: {
      id: number
      method: string
      params?: { name?: string; arguments?: { query?: string; limit?: number } }
    } = JSON.parse(body)
    const stream = (result: unknown, headers: Record<string, string> = {}) =>
      new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: call.id, result })}\n\n`, {
        headers: { "content-type": "text/event-stream", ...headers },
      })
    if (call.method === "initialize")
      return stream(
        { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "documents", version: "0" } },
        { "mcp-session-id": "fake-session" },
      )
    if (request.headers.get("mcp-session-id") !== "fake-session") return new Response("no session", { status: 400 })
    if (call.method !== "tools/call" || call.params?.name !== "documents_people")
      return stream({ isError: true, content: [{ type: "text", text: "unknown tool" }] })
    const text = (call.params.arguments?.query ?? "").toLowerCase()
    const people = [...state.drive.people.values()]
      .filter((person) => [person.name, person.email].some((value) => value.toLowerCase().startsWith(text)))
      .slice(0, call.params.arguments?.limit ?? 20)
    return stream({ content: [{ type: "text", text: `${people.length} people` }], structuredContent: { people } })
  }

  const driveRoute = async (request: Request, url: URL, raw: Uint8Array) => {
    const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "")
    const person = bearer === undefined ? undefined : state.person.access.get(bearer)
    const ui = person !== undefined && person.expiresAt > Date.now()
    if (bearer === undefined || (!state.jwts.has(bearer) && !ui))
      return Response.json(alpha.rejected_jwt.body, { status: 401 })
    // 0.84's step-up: sharing, delete and agent caps want a person's sign-in no older than 600 s
    if (ui && stepUp(request.method, url.pathname) && Date.now() - person.signedInAt > 600_000)
      return Response.json(
        { code: "unauthorized", message: "this action needs a sign-in no older than the step-up window" },
        {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer error="insufficient_user_authentication", error_description="A more recent authentication is required", max_age=600',
          },
        },
      )
    if (ui) state.person.acted.push(`${request.method} ${url.pathname}`)
    const drive = state.drive
    const user = alpha.whoami.body.user_id
    const refuse = (status: number, error_key: string, message: string, extra: Record<string, unknown> = {}) =>
      Response.json({ code: "error", message, error_key, ...extra, detail: { code: error_key } }, { status })
    const notFound = (what: string) => refuse(404, "not_found", `${what} does not exist or has been deleted`)
    const route = `${request.method} ${url.pathname}`
    const context = request.headers.get("x-context-id")
    const json = () => JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>
    const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
    const now = () => new Date().toISOString()

    const at84 = drive.version === "0.84"
    // 0.84 writes nothing for a conversation the user does not own, or one that does not exist
    if (at84 && context !== null && request.method !== "GET" && !state.drive.contexts.has(context))
      return refuse(422, "unknown_context", `context ${context} is not one of the caller's conversations`)
    // What 0.84 tells about a write: its conversation's title, to its owner only (every conversation here is the user's)
    const named = (context_id: string | null | undefined) =>
      at84 ? { context_name: context_id ? (state.drive.contexts.get(context_id) ?? null) : null } : {}

    if (drive.suggestOnly && request.method !== "GET")
      return refuse(
        403,
        "agent_suggest_only",
        "agents may only suggest on this document: the dynapps-document-classes agent policy caps agents at suggest",
      )

    const revise = (id: string, bytes: Uint8Array, message: string | null, parent: string | null) => {
      const entry = drive.documents.get(id)!
      const revision: FakeRevision = {
        id: crypto.randomUUID(),
        document_id: id,
        parent_revision_id: parent,
        content_sha256: sha(bytes),
        author_user_id: user,
        // A person's UI session writes as the person (`user`, as 0.84 records it): no agent, its own OAuth client
        actor_kind: ui ? "user" : "agent",
        origin_kind: "api",
        message,
        created_at: now(),
        ...(at84
          ? { context_id: context, ...(ui ? { client_id: personClient } : { agent_name: bridgeClient, client_id: bridgeClient }) }
          : {}),
      }
      entry.revisions.unshift(revision)
      entry.head_revision_id = revision.id
      entry.updated_at = revision.created_at
      entry.bytes = bytes
      if (context !== null) entry.contexts.push(context)
      return revision
    }
    const create = (
      name: string,
      folder: unknown,
      declared: string,
      bytes: Uint8Array,
      template: string | null,
      message: unknown,
    ) => {
      const id = crypto.randomUUID()
      // A multipart file type may carry parameters (`text/html;charset=utf-8`); the instance keeps the bare type
      const mime = declared.split(";")[0] ?? declared
      // 0.83 keeps any other upload, a PDF included, as format `file`.
      const format = mime === "text/html" ? "html" : mime === "text/markdown" ? "markdown" : "file"
      drive.documents.set(id, {
        id,
        folder_id: typeof folder === "string" ? folder : null,
        name,
        format,
        mime_type: mime,
        head_revision_id: "",
        template_id: template,
        owner_user_id: user,
        created_at: now(),
        updated_at: now(),
        revisions: [],
        bytes: new Uint8Array(),
        contexts: [],
      })
      // 0.83 keeps no message on a document it creates; 0.84 keeps the one sent
      const revision = revise(id, bytes, at84 && typeof message === "string" ? message : null, null)
      return Response.json({ document: view(id), revision: { ...revision, ...named(revision.context_id) } }, { status: 201 })
    }
    const view = (id: string) => {
      const entry = drive.documents.get(id)!
      return Object.fromEntries(
        Object.entries(entry).filter(([key]) => !["revisions", "bytes", "contexts"].includes(key)),
      ) as FakeDocument
    }
    const found = (id: string | undefined) =>
      id === undefined || drive.trashed.has(id) ? undefined : drive.documents.get(id)
    const quoted = (revision: string) => ({ etag: `"${revision}"` })

    if (route === "GET /api/v1/documents") {
      const scope = url.searchParams.get("scope") ?? "mine"
      const folder = url.searchParams.get("folder")
      const query = url.searchParams.get("query")?.toLowerCase()
      // 0.84 lists what one of the user's conversations wrote a revision or a comment on; 0.83 has no such scope
      const conversation = url.searchParams.get("context_id")
      if (scope === "context" && (!at84 || conversation === null))
        return refuse(400, "invalid_params", "scope=context needs a context_id")
      if (scope === "context" && conversation !== null && !drive.contexts.has(conversation))
        return refuse(422, "unknown_context", `context ${conversation} is not one of the caller's conversations`)
      const touched = (entry: { id: string; contexts: string[] }) =>
        entry.contexts.includes(conversation ?? "") ||
        (drive.comments.get(entry.id) ?? []).some((comment) => comment.context_id === conversation)
      const matching = [...drive.documents.values()]
        .filter((entry) =>
          scope === "folder" ? entry.folder_id === folder : scope === "context" ? touched(entry) : scope !== "shared",
        )
        .filter((entry) => query === undefined || entry.name.toLowerCase().includes(query))
        .toSorted((a, b) =>
          url.searchParams.get("sort") === "name"
            ? a.name.localeCompare(b.name)
            : b.updated_at.localeCompare(a.updated_at),
        )
      const start = Number(Buffer.from(url.searchParams.get("cursor") ?? "MA", "base64url").toString())
      const limit = Number(url.searchParams.get("limit") ?? 50)
      const next = start + limit
      return Response.json({
        folders: scope === "folder" ? [...drive.folders.values()].filter((entry) => entry.parent_id === folder) : [],
        documents: matching.slice(start, next).map((entry) => ({
          ...view(entry.id),
          size_bytes: entry.bytes.length,
          my_access: "own",
        })),
        next_cursor: next < matching.length ? Buffer.from(String(next)).toString("base64url") : null,
      })
    }
    // As 0.83 answers: the roots, or with `?folder=<id>` the folders of that one; never the whole tree.
    if (route === "GET /api/v1/document-folders") {
      const parent = url.searchParams.get("folder")
      if (parent !== null && !drive.folders.has(parent)) return notFound(`folder ${parent}`)
      return Response.json({
        folders: [...drive.folders.values()].filter((entry) => entry.parent_id === parent),
        documents: [],
        next_cursor: null,
      })
    }
    if (route === "POST /api/v1/document-folders") {
      const input = json()
      const folder = {
        id: crypto.randomUUID(),
        parent_id: input.parent_id ?? null,
        name: input.name,
        owner_user_id: user,
        agent_edit_policy: "direct",
        created_at: now(),
        updated_at: now(),
      }
      drive.folders.set(folder.id, folder)
      return Response.json(folder, { status: 201 })
    }
    const folderCap = /^\/api\/v1\/document-folders\/([^/]+)\/agent-cap$/.exec(url.pathname)
    if (request.method === "GET" && folderCap) {
      if (!drive.folders.has(folderCap[1] ?? "")) return notFound("folder")
      return Response.json(cap("folder", folderCap[1] ?? "", "suggest", "edit"))
    }

    if (route === "POST /api/v1/documents") {
      if (request.headers.get("content-type")?.startsWith("multipart/form-data")) {
        const form = await new Response(raw, {
          headers: { "content-type": request.headers.get("content-type")! },
        }).formData()
        const file = form.get("file")
        if (!(file instanceof File)) return refuse(400, "invalid_request", "invalid request body")
        const name = String(form.get("name") ?? file.name)
        return create(
          name,
          form.get("folder_id"),
          file.type,
          new Uint8Array(await file.arrayBuffer()),
          null,
          form.get("message"),
        )
      }
      const input = json()
      return create(
        String(input.name),
        input.folder_id,
        "text/markdown",
        new TextEncoder().encode("# Untitled\n"),
        String(input.template_id),
        input.message,
      )
    }
    if (route === "POST /api/v1/documents/import") {
      const input = json()
      const blob = drive.blobs.get(String(input.blob_ref))
      if (blob === undefined) return refuse(400, "invalid_request", "invalid request body")
      return create(String(input.name), input.folder_id, blob.mime, blob.bytes, null, input.message)
    }

    // As 0.84 answers it: a search by name, email or id prefix, or a lookup of at most 20 ids, never both
    if (route === "GET /api/v1/documents/people") {
      const query = url.searchParams.get("query")
      const ids = url.searchParams.get("ids")?.split(",").filter(Boolean)
      if ((query === null) === (ids === undefined) || query?.trim() === "" || (ids?.length ?? 0) > 20)
        return refuse(400, "invalid_params", "name a query or at most 20 ids")
      const all = [...drive.people.values()]
      if (ids !== undefined) return Response.json({ people: all.filter((person) => ids.includes(person.user_id)) })
      const text = (query ?? "").toLowerCase()
      return Response.json({
        people: all
          .filter((person) =>
            [person.name, person.email, person.user_id].some((value) => value.toLowerCase().startsWith(text)),
          )
          .slice(0, Number(url.searchParams.get("limit") ?? 20)),
      })
    }

    const doc = /^\/api\/v1\/documents\/([^/]+)(?:\/(.+))?$/.exec(url.pathname)
    if (doc) {
      const entry = found(doc[1])
      if (entry === undefined) return notFound(`document ${doc[1]}`)
      const rest = doc[2] ?? ""
      const sha256 = { "x-document-content-sha256": sha(entry.bytes) }
      const text = new TextDecoder().decode(entry.bytes)
      if (route.startsWith("GET") && rest === "")
        return Response.json(
          {
            document: view(entry.id),
            head: entry.revisions[0],
            my_access: "own",
            folder_path: entry.folder_id === null ? null : String(drive.folders.get(entry.folder_id)?.name),
          },
          { headers: { ...quoted(entry.head_revision_id), ...sha256 } },
        )
      if (route.startsWith("GET") && rest === "rendered") {
        const revision = url.searchParams.get("revision")
        if (revision !== null && !entry.revisions.some((item) => item.id === revision)) return notFound("revision")
        if (entry.format !== "html")
          return refuse(400, "unsupported_op", `operation rendered is not supported for ${entry.format} documents`)
        return new Response(text, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": drive.csp,
            ...quoted(revision ?? entry.head_revision_id),
            ...sha256,
          },
        })
      }
      if (route.startsWith("GET") && rest === "preview")
        return new Response(`<p>${text}</p>`, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy":
              "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'",
            ...quoted(entry.head_revision_id),
            ...sha256,
          },
        })
      if (route.startsWith("GET") && rest === "content") {
        const revision = url.searchParams.get("revision")
        if (revision !== null && !entry.revisions.some((item) => item.id === revision)) return notFound("revision")
        if (url.searchParams.get("format") !== "pdf")
          return new Response(entry.bytes, {
            headers: { "content-type": entry.mime_type, ...quoted(revision ?? entry.head_revision_id), ...sha256 },
          })
        return new Response(new TextEncoder().encode(`%PDF-1.7 ${entry.name}`), {
          headers: { "content-type": "application/pdf", ...quoted(revision ?? entry.head_revision_id), ...sha256 },
        })
      }
      if (route.startsWith("GET") && rest === "read") {
        const view = url.searchParams.get("view")
        if (view !== "outline" && view !== "text") return refuse(400, "invalid_params", "unknown view")
        // The node ids are those a comment anchors to; `n1` is the first line, the one the fake accepts. The outline
        // leaves paragraphs behind a gap; the text lists every node, the blank ones too. A spreadsheet has one sheet,
        // `sheet[Sales]`, its node first and a row of it below, as the core names them.
        if (spreadsheet(entry.mime_type))
          return Response.json({
            revision_id: entry.head_revision_id,
            format: entry.format,
            lines: [`${sheet}:5f2c1a0e| Sales`, `${sheet}/row[1]:7d1e9b3a| Month\tTotal`],
          })
        return Response.json({
          revision_id: entry.head_revision_id,
          format: entry.format,
          lines:
            view === "text"
              ? ["n1:3639efcd| # Hola", "n2:e3b0c442| ", "n3:9a8b7c6d| second"]
              : ["n1:3639efcd| # Hola", "gap 2 nodes", ...(text.length > 0 ? ["n2:9a8b7c6d| second"] : [])],
        })
      }
      if (route.startsWith("GET") && rest === "revisions")
        return Response.json({
          revisions: entry.revisions.map((revision) => ({ ...revision, ...named(revision.context_id) })),
        })
      if (route.startsWith("GET") && rest === "proposals")
        return Response.json({ proposals: drive.proposals.get(entry.id) ?? [] })
      if (route.startsWith("GET") && rest === "agent-cap")
        return Response.json(cap("document", entry.id, "edit", "edit"))
      if (route.startsWith("GET") && rest === "access")
        return Response.json({
          document_id: entry.id,
          owner: user,
          my_access: "own",
          grants: (drive.grants.get(entry.id) ?? []).map((grant) => ({
            grant_id: grant.id,
            subject_kind: grant.kind,
            subject_value: grant.value,
            display_name: grant.name,
            level: grant.level,
            granted_by: user,
            granted_at: now(),
          })),
          // 0.83 leaves out an empty `inherited`, as it does the history and the requests.
          agent_cap: {
            cap: "edit",
            policy_cap: "edit",
            reason: "the dynapps-document-classes agent policy caps agents at edit",
          },
        })
      // What the core keeps to the owner, and from an agent unless its policy lifts it: trash, transfer, revoke every
      // grant. Only the person's UI session does them here.
      const owners = (request.method === "DELETE" && (rest === "" || rest === "grants/all")) || rest === "transfer"
      if (owners && !ui)
        return refuse(403, "agent_forbidden", "agents may not do this to documents, whatever their access; ask the user")
      if (request.method === "DELETE" && rest === "") {
        drive.trashed.add(entry.id)
        return new Response(null, { status: 204 })
      }
      if (request.method === "DELETE" && rest === "grants/all") {
        drive.grants.set(entry.id, [])
        return new Response(null, { status: 204 })
      }
      if (request.method === "POST" && rest === "transfer") {
        const input = json() as { transfer_to?: string }
        if (input.transfer_to === undefined || !state.drive.people.has(input.transfer_to))
          return refuse(422, "unknown_subject", `no user ${input.transfer_to}`)
        entry.owner_user_id = input.transfer_to
        return Response.json(view(entry.id))
      }
      // A review, as the core does: accepting lands the proposed revision as the head (the fake's base is the head),
      // rejecting records the reviewer and the note; a proposal reviewed before is closed.
      const reviewed = /^proposals\/([^/]+)\/(accept|reject)$/.exec(rest)
      if (request.method === "POST" && reviewed) {
        const target = (drive.proposals.get(entry.id) ?? []).find((item) => item.id === reviewed[1])
        if (target === undefined) return notFound("proposal")
        if (target.status !== "open") return refuse(409, "proposal_closed", "the proposal was already reviewed")
        const input = json() as { note?: string }
        target.status = reviewed[2] === "accept" ? "accepted" : "rejected"
        target.reviewer = user
        target.reviewed_at = now()
        target.note = input.note ?? null
        if (reviewed[2] === "reject") return Response.json({ proposal: target })
        const revision = revise(entry.id, entry.bytes, (target.message as string | null) ?? null, entry.head_revision_id)
        target.landed_revision_id = revision.id
        return Response.json({ proposal: target, revision })
      }
      // The person's UI session shares as the person: the agent rules are not theirs
      if ((route.startsWith("POST") || route.startsWith("DELETE")) && rest === "grants" && !drive.agentShare && !ui)
        return refuse(
          403,
          "agent_forbidden",
          "agents may not share documents, whatever their access; ask the user to do it themselves",
        )
      if (route.startsWith("POST") && rest === "grants") {
        const input = json() as { subject_kind: string; subject_value: string; level: string }
        const known = state.drive.people.get(input.subject_value)
        if (input.subject_kind === "user" && !known)
          return refuse(422, "unknown_subject", `no user ${input.subject_value}`)
        const grants = drive.grants.get(entry.id) ?? []
        const kept = grants.find((grant) => grant.kind === input.subject_kind && grant.value === input.subject_value)
        const made = {
          id: kept?.id ?? crypto.randomUUID(),
          kind: input.subject_kind,
          value: input.subject_value,
          name: known?.name ?? input.subject_value,
          level: input.level,
        }
        drive.grants.set(entry.id, [...grants.filter((grant) => grant !== kept), made])
        return Response.json(
          {
            id: made.id,
            document_id: entry.id,
            subject_kind: made.kind,
            subject_value: made.value,
            display_name: made.name,
            access_level: made.level,
            granted_by: user,
            valid_until: null,
            created_at: now(),
          },
          { status: 201 },
        )
      }
      if (route.startsWith("DELETE") && rest === "grants") {
        const id = url.searchParams.get("grant_id")
        const grants = drive.grants.get(entry.id) ?? []
        if (!grants.some((grant) => grant.id === id)) return refuse(404, "not_found", "no such grant")
        drive.grants.set(
          entry.id,
          grants.filter((grant) => grant.id !== id),
        )
        return new Response(null, { status: 204 })
      }
      if (route.startsWith("GET") && rest === "grants")
        return refuse(
          403,
          "agent_forbidden",
          "agents may not share documents, whatever their access; ask the user to do it themselves",
        )
      if (route.startsWith("PUT") && rest === "content")
        return refuse(
          403,
          "agent_forbidden",
          "agents may not replace_content documents, whatever their access; ask the user to do it themselves",
        )
      if (route.startsWith("POST") && rest === "edits") {
        const input = json() as {
          ops?: Array<{ op: string; markdown?: string; revision_id?: string }>
          base_revision?: string
          mode?: string
          message?: string
        }
        // `restore` makes an earlier revision the head as a new one, on the head only; an agent meets the rule
        const restore = input.ops?.length === 1 && input.ops[0]?.op === "restore" ? input.ops[0] : undefined
        if (restore && ui) {
          const earlier = entry.revisions.find((item) => item.id === restore.revision_id)
          if (earlier === undefined) return notFound("revision")
          if (input.base_revision !== entry.head_revision_id)
            return refuse(409, "stale_base", "restore applies only on the head", { head_revision: entry.head_revision_id })
          const revision = revise(entry.id, entry.bytes, input.message ?? null, entry.head_revision_id)
          return Response.json({ revision })
        }
        const unknown = input.ops?.find((item) => item.op !== "append_markdown")
        if (unknown !== undefined)
          return refuse(
            403,
            "agent_forbidden",
            `agents may not ${unknown.op} documents, whatever their access; ask the user to do it themselves`,
          )
        const added = new TextEncoder().encode(`\n${(input.ops ?? []).map((item) => item.markdown).join("\n")}\n`)
        const bytes = new Uint8Array([...entry.bytes, ...added])
        const parent = entry.head_revision_id
        if (input.mode === "propose") {
          const proposed = {
            id: crypto.randomUUID(),
            document_id: entry.id,
            base_revision_id: parent,
            proposed_revision_id: crypto.randomUUID(),
            proposer: user,
            actor_kind: "agent",
            status: "open",
            message: input.message ?? null,
            reviewer: null,
            reviewed_at: null,
            note: null,
            landed_revision_id: null,
            created_at: now(),
          }
          drive.proposals.set(entry.id, [...(drive.proposals.get(entry.id) ?? []), proposed])
          return Response.json(
            {
              proposal: proposed,
              revision: { ...entry.revisions[0], id: proposed.proposed_revision_id, message: input.message ?? null },
              superseded: [],
            },
            { status: 201 },
          )
        }
        const stale = input.base_revision !== undefined && input.base_revision !== parent
        const revision = revise(entry.id, bytes, input.message ?? null, parent)
        return Response.json({ revision, ...(stale ? { merged_from: parent } : {}) })
      }
      if (rest === "comments") {
        const all = drive.comments.get(entry.id) ?? []
        if (request.method === "GET")
          return Response.json({ comments: all.map((comment) => ({ ...comment, ...named(comment.context_id as string) })) })
        const input = json() as {
          body?: string
          anchor?: { node: string; find?: string; cells?: string }
          parent_id?: string
          mention_options?: Array<{ user_id: string; attention: string }>
        }
        // As the instance does: an option names a user the body mentions as `@[Name](user:<id>)`
        if (input.mention_options?.some((option) => !input.body?.includes(`](user:${option.user_id})`)))
          return refuse(400, "invalid_params", "every mention option must name a user the comment mentions")
        if (input.anchor === undefined && input.parent_id === undefined)
          return refuse(400, "invalid_params", "invalid comment: a comment needs a node anchor or a parent_id")
        // 0.84: a cell range anchors to a sheet node, never beside a quote, and is written upper-case
        const cells = at84 ? input.anchor?.cells : undefined
        if (
          cells !== undefined &&
          (!a1.test(cells) || input.anchor?.find !== undefined || input.anchor?.node !== sheet)
        )
          return refuse(400, "invalid_params", "invalid comment: a cell range anchors to a sheet node of a spreadsheet")
        const nodes = spreadsheet(entry.mime_type) ? [sheet, `${sheet}/row[1]`] : ["n1"]
        if (input.anchor !== undefined && !nodes.includes(input.anchor.node))
          return refuse(409, "not_found", `node ${input.anchor.node} does not exist at the head revision`, {
            code: "conflict_error",
          })
        const parent = all.find((item) => item.id === input.parent_id)
        const anchor =
          input.anchor === undefined
            ? parent?.anchor
            : { node: input.anchor.node, find: input.anchor.find, ...(cells ? { cells: cells.toUpperCase() } : {}) }
        const comment = {
          id: crypto.randomUUID(),
          anchor,
          author_user_id: user,
          body: input.body,
          ...(input.parent_id === undefined ? {} : { parent_id: input.parent_id }),
          created_at: now(),
          // 0.84 records the agent of the token, the conversation and the client
          ...(at84
            ? { context_id: context, ...(ui ? { client_id: personClient } : { via_agent: bridgeClient, client_id: bridgeClient }) }
            : {}),
        }
        drive.comments.set(entry.id, [...all, comment])
        // 0.83 announces each mention on the stream, whatever its attention; 0.84 announces a mention of the author
        // themself only at attention `agent`
        input.mention_options
          ?.filter((option) => !at84 || option.user_id !== user || option.attention === "agent")
          .forEach((option) =>
            drive.announce(
              "document.comment.mentioned",
              {
                document_id: entry.id,
                comment_id: comment.id,
                mentioned_user_id: option.user_id,
                author_id: user,
              },
              false,
            ),
          )
        return Response.json(comment, { status: 201 })
      }
      const resolve = /^comments\/([^/]+)\/resolve$/.exec(rest)
      if (request.method === "POST" && resolve) {
        const all = drive.comments.get(entry.id) ?? []
        const target = all.find((item) => item.id === resolve[1])
        if (target === undefined) return notFound("comment")
        target.resolved_at ??= now()
        target.resolved_by ??= user
        return Response.json(target)
      }
      // 0.84 reopens a resolved comment; an open one comes back unchanged. 0.83 has no such route.
      const reopen = /^comments\/([^/]+)\/reopen$/.exec(rest)
      if (at84 && request.method === "POST" && reopen) {
        const all = drive.comments.get(entry.id) ?? []
        const target = all.find((item) => item.id === reopen[1])
        if (target === undefined) return notFound("comment")
        if (target.resolved_at === undefined || target.resolved_at === null) return Response.json(target)
        target.resolved_at = null
        target.resolved_by = null
        target.reopened_at = now()
        target.reopened_by = user
        return Response.json(target)
      }
    }

    if (route === "POST /api/v1/uploads") {
      const input = json()
      const size = Number(input.size)
      const count = Math.max(1, Math.ceil(size / drive.partSize))
      const id = crypto.randomUUID()
      drive.uploads.set(id, {
        meta: {
          upload_id: id,
          name: input.name,
          mime: input.mime,
          size,
          sha256: input.sha256,
          part_size: drive.partSize,
          part_count: count,
          status: "open",
          blob_ref: null,
          expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        },
        parts: new Map(),
      })
      return Response.json(uploaded(id), { status: 201 })
    }
    const upload = /^\/api\/v1\/uploads\/([^/]+)(?:\/(.+))?$/.exec(url.pathname)
    if (upload) {
      const entry = drive.uploads.get(upload[1] ?? "")
      if (entry === undefined) return notFound("upload")
      const rest = upload[2] ?? ""
      if (request.method === "GET" && rest === "") return Response.json(uploaded(upload[1] ?? ""))
      const part = /^parts\/(\d+)$/.exec(rest)
      if (request.method === "PUT" && part) {
        const number = Number(part[1])
        if (number < 1 || number > Number(entry.meta.part_count))
          return refuse(400, "invalid_request", `part ${number} is outside 1..=${entry.meta.part_count}`)
        entry.parts.set(number, raw)
        return Response.json(
          { part_number: number, size_bytes: raw.length, sha256: sha(raw) },
          { headers: { etag: sha(raw) } },
        )
      }
      if (request.method === "POST" && rest === "complete") {
        const missing = uploaded(upload[1] ?? "").missing_parts
        if (missing.length > 0) return refuse(409, "missing_parts", `parts [${missing}] have not been uploaded`)
        const bytes = new Uint8Array([
          ...[...entry.parts.entries()].toSorted((a, b) => a[0] - b[0]).flatMap((item) => [...item[1]]),
        ])
        if (sha(bytes) !== entry.meta.sha256)
          return refuse(422, "checksum_mismatch", "upload refused (checksum_mismatch)")
        drive.blobs.set(sha(bytes), { bytes, mime: String(entry.meta.mime) })
        entry.meta.status = "complete"
        entry.meta.blob_ref = sha(bytes)
        return Response.json({
          upload_id: upload[1],
          blob_ref: sha(bytes),
          size_bytes: bytes.length,
          mime: entry.meta.mime,
          deduplicated: false,
        })
      }
    }
    return Response.json({ code: "not_found", message: `No route matches ${route}` }, { status: 404 })
  }

  const cap = (kind: string, id: string, unattended: string, attended: string) => {
    const reading = (value: string) => ({
      agent_cap: value,
      policy_cap: value,
      source: { kind: "policy", policy: "dynapps-document-classes" },
      reason: `the dynapps-document-classes agent policy caps agents at ${value}`,
    })
    return {
      target_kind: kind,
      target_id: id,
      override: null,
      ...reading(unattended),
      attended: reading(attended),
      unattended: reading(unattended),
    }
  }

  // The core's OAuth server as far as the person's UI session goes (0.84, observed on sp-local `dynwork-sp-084`):
  // authorize for DynWork's client, the code + PKCE grant, rotating refresh tokens whose family a reuse ends, the
  // 12-hour cap from the sign-in, and revoke, which takes the bridge JWT and not the UI token.
  const oauthRoute = (request: Request, path: string, body: string, bearer: string | undefined) => {
    const person = state.person
    const query = new URL(request.url).searchParams
    const oauthError = (status: number, error: string, description: string) =>
      Response.json({ error, error_description: description }, { status })
    if (request.method === "GET" && path === "/api/v1/core/oauth/authorize") {
      if (query.get("client_id") !== personClient || person.client === "none")
        return oauthError(400, "invalid_request", "Invalid client_id")
      if (!personRedirect(query.get("redirect_uri") ?? ""))
        return oauthError(400, "invalid_request", "redirect_uri not registered for client")
      if ((query.get("state") ?? "").length < 32)
        return oauthError(400, "invalid_request", "CSRF token (state parameter) is invalid")
      person.authorized.push(Object.fromEntries([...query.keys()].map((key) => [key, query.get(key) ?? ""])))
      return new Response("<!doctype html><title>Sign in</title>", { headers: { "content-type": "text/html" } })
    }
    const form = new URLSearchParams(body)
    if (request.method === "POST" && path === "/api/v1/core/oauth/token") {
      if (form.get("client_id") !== personClient || person.client === "none")
        return oauthError(401, "invalid_client", "Client authentication failed")
      if (form.get("grant_type") === "authorization_code") {
        const code = person.codes.get(form.get("code") ?? "")
        person.codes.delete(form.get("code") ?? "")
        const verifier = form.get("code_verifier") ?? ""
        if (
          code === undefined ||
          code.redirect !== form.get("redirect_uri") ||
          createHash("sha256").update(verifier).digest("base64url") !== code.challenge
        )
          return oauthError(400, "invalid_grant", "Invalid authorization code")
        return Response.json(issuePerson(crypto.randomUUID(), code.signedInAt, code.user))
      }
      if (form.get("grant_type") === "refresh_token") {
        const presented = form.get("refresh_token") ?? ""
        const held = person.refresh.get(presented)
        if (held === undefined) {
          // A refresh token spent once more ends its whole family
          const spent = person.spent.get(presented)
          if (spent !== undefined) person.families.delete(spent)
          return oauthError(400, "invalid_grant", "Refresh token invalid: Invalid refresh token")
        }
        person.refresh.delete(presented)
        person.spent.set(presented, held.family)
        if (!person.families.has(held.family) || Date.now() >= held.signedInAt + 12 * 3600_000)
          return oauthError(400, "invalid_grant", "Refresh token invalid: Invalid refresh token")
        return Response.json(issuePerson(held.family, held.signedInAt, held.user))
      }
      return oauthError(400, "unsupported_grant_type", "grant type not supported")
    }
    if (request.method === "POST" && path === "/api/v1/core/oauth/revoke") {
      if (bearer === undefined || !state.jwts.has(bearer))
        return Response.json({ code: "unauthorized", message: "Invalid or expired JWT token" }, { status: 401 })
      const held = person.refresh.get(form.get("token") ?? "")
      if (held !== undefined) person.families.delete(held.family)
      return new Response(null, { status: 200 })
    }
    return Response.json({ code: "not_found", message: "no route" }, { status: 404 })
  }

  // A 300-second access token for the person and a new refresh token of the family. The access token carries the
  // claims 0.84 gives a UI session, or an ordinary user token's when the client is not a `person_ui` one.
  const issuePerson = (family: string, signedInAt: number, user: string) => {
    const person = state.person
    person.families.add(family)
    const now = Date.now()
    const claims =
      person.client === "person_ui"
        ? { aud: ["ui"], ui_session: true }
        : { aud: ["web", "api", "a2a", "mcp"] }
    const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
    const access = [
      segment({ alg: "RS256", typ: "JWT" }),
      segment({
        ...claims,
        sub: user,
        auth_time: Math.floor(signedInAt / 1000),
        iat: Math.floor(now / 1000),
        exp: Math.floor(now / 1000) + 300,
        client_id: personClient,
        jti: randomBytes(8).toString("hex"),
      }),
      randomBytes(24).toString("base64url"),
    ].join(".")
    const refresh = `rt_${randomBytes(24).toString("hex")}`
    person.access.set(access, { signedInAt, expiresAt: now + 300_000 })
    person.refresh.set(refresh, { family, signedInAt, user })
    return { access_token: access, token_type: "Bearer", expires_in: 300, refresh_token: refresh, scope: "user" }
  }

  // Plays the person in the system browser on the authorize page `link`: signs in (as `user`, the account's own
  // unless said) and allows, or declines, and the page sends the browser to the redirect with the same `state`.
  // `state` replaces the one the link carries, as a page that is not the instance's might.
  const personBrowser = (
    link: string,
    options: { deny?: boolean; user?: string; state?: string } = {},
  ) => {
    const query = new URL(link).searchParams
    const redirect = new URL(query.get("redirect_uri") ?? "")
    redirect.searchParams.set("state", options.state ?? query.get("state") ?? "")
    if (options.deny) {
      redirect.searchParams.set("error", "access_denied")
      redirect.searchParams.set("error_description", "User denied the request")
    }
    if (!options.deny) {
      const code = randomBytes(21).toString("base64url")
      state.person.codes.set(code, {
        challenge: query.get("code_challenge") ?? "",
        redirect: query.get("redirect_uri") ?? "",
        signedInAt: Date.now(),
        user: options.user ?? alpha.whoami.body.user_id,
      })
      redirect.searchParams.set("code", code)
      redirect.searchParams.set("client_id", personClient)
      redirect.searchParams.set("iss", `http://127.0.0.1:${server.port}`)
    }
    return fetch(redirect)
  }

  const uploaded = (id: string) => {
    const entry = state.drive.uploads.get(id)!
    const count = Number(entry.meta.part_count)
    const received = [...entry.parts.keys()].toSorted((a, b) => a - b)
    return {
      ...entry.meta,
      received_bytes: [...entry.parts.values()].reduce((total, part) => total + part.length, 0),
      received_parts: received,
      missing_parts: Array.from({ length: count }, (_, index) => index + 1).filter(
        (number) => !received.includes(number),
      ),
    } as Record<string, unknown> & { missing_parts: number[] }
  }

  return {
    url: `http://127.0.0.1:${server.port}`,
    state,
    issuePat,
    issueCode: () => {
      const code = randomBytes(32).toString("hex")
      state.codes.add(code)
      return code
    },
    // A JWT the instance minted but now refuses, as after a server restart or revocation
    staleJwt: () => `eyJ${randomBytes(24).toString("hex")}`,
    personBrowser,
    stop: () => server.stop(true),
  }
}
