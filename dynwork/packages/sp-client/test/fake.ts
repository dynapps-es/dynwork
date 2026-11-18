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
}

export function startDrive() {
  return {
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
    // Size of each upload part the instance asks for
    partSize: 8 * 1024 * 1024,
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
      return route(request, url.pathname, body)
    },
  })

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
    if (route === "GET /api/v1/health") return Response.json(alpha.health.body)
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
  const driveRoute = async (request: Request, url: URL, raw: Uint8Array) => {
    const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "")
    if (bearer === undefined || !state.jwts.has(bearer)) return Response.json(alpha.rejected_jwt.body, { status: 401 })
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
        actor_kind: "agent",
        origin_kind: "api",
        message,
        created_at: now(),
      }
      entry.revisions.unshift(revision)
      entry.head_revision_id = revision.id
      entry.updated_at = revision.created_at
      entry.bytes = bytes
      if (context !== null) entry.contexts.push(context)
      return revision
    }
    const create = (name: string, folder: unknown, declared: string, bytes: Uint8Array, template: string | null) => {
      const id = crypto.randomUUID()
      // A multipart file type may carry parameters (`text/html;charset=utf-8`); the instance keeps the bare type
      const mime = declared.split(";")[0] ?? declared
      const format = mime === "text/html" ? "html" : mime === "text/markdown" ? "markdown" : "binary"
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
      const revision = revise(id, bytes, null, null)
      return Response.json({ document: view(id), revision }, { status: 201 })
    }
    const view = (id: string) => {
      const entry = drive.documents.get(id)!
      return Object.fromEntries(
        Object.entries(entry).filter(([key]) => !["revisions", "bytes", "contexts"].includes(key)),
      ) as FakeDocument
    }
    const found = (id: string | undefined) => (id === undefined ? undefined : drive.documents.get(id))
    const quoted = (revision: string) => ({ etag: `"${revision}"` })

    if (route === "GET /api/v1/documents") {
      const scope = url.searchParams.get("scope") ?? "mine"
      const folder = url.searchParams.get("folder")
      const query = url.searchParams.get("query")?.toLowerCase()
      const matching = [...drive.documents.values()]
        .filter((entry) => (scope === "folder" ? entry.folder_id === folder : scope !== "shared"))
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
    if (route === "GET /api/v1/document-folders")
      return Response.json({ folders: [...drive.folders.values()], documents: [], next_cursor: null })
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
        return create(name, form.get("folder_id"), file.type, new Uint8Array(await file.arrayBuffer()), null)
      }
      const input = json()
      return create(
        String(input.name),
        input.folder_id,
        "text/markdown",
        new TextEncoder().encode("# Untitled\n"),
        String(input.template_id),
      )
    }
    if (route === "POST /api/v1/documents/import") {
      const input = json()
      const blob = drive.blobs.get(String(input.blob_ref))
      if (blob === undefined) return refuse(400, "invalid_request", "invalid request body")
      return create(String(input.name), input.folder_id, blob.mime, blob.bytes, null)
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
        if (url.searchParams.get("format") !== "pdf")
          return new Response(entry.bytes, {
            headers: { "content-type": entry.mime_type, ...quoted(entry.head_revision_id) },
          })
        return new Response(new TextEncoder().encode(`%PDF-1.7 ${entry.name}`), {
          headers: { "content-type": "application/pdf", ...quoted(entry.head_revision_id), ...sha256 },
        })
      }
      if (route.startsWith("GET") && rest === "read") {
        if (url.searchParams.get("view") !== "outline") return refuse(400, "invalid_params", "unknown view")
        // The node ids are those a comment anchors to; `n1` is the first line, the one the fake accepts
        return Response.json({
          revision_id: entry.head_revision_id,
          format: entry.format,
          lines: ["n1:3639efcd| # Hola", "gap 2 nodes", ...(text.length > 0 ? ["n2:9a8b7c6d| second"] : [])],
        })
      }
      if (route.startsWith("GET") && rest === "revisions") return Response.json({ revisions: entry.revisions })
      if (route.startsWith("GET") && rest === "proposals")
        return Response.json({ proposals: drive.proposals.get(entry.id) ?? [] })
      if (route.startsWith("GET") && rest === "agent-cap")
        return Response.json(cap("document", entry.id, "edit", "edit"))
      if (route.startsWith("GET") && rest === "access")
        return Response.json({
          document_id: entry.id,
          owner: user,
          my_access: "own",
          grants: [],
          inherited: [],
          agent_cap: {
            cap: "edit",
            policy_cap: "edit",
            reason: "the dynapps-document-classes agent policy caps agents at edit",
          },
        })
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
          ops?: Array<{ op: string; markdown?: string }>
          base_revision?: string
          mode?: string
          message?: string
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
        if (request.method === "GET") return Response.json({ comments: all })
        const input = json() as { body?: string; anchor?: { node: string; find?: string }; parent_id?: string }
        if (input.anchor === undefined && input.parent_id === undefined)
          return refuse(400, "invalid_params", "invalid comment: a comment needs a node anchor or a parent_id")
        if (input.anchor !== undefined && input.anchor.node !== "n1")
          return refuse(409, "not_found", `node ${input.anchor.node} does not exist at the head revision`, {
            code: "conflict_error",
          })
        const parent = all.find((item) => item.id === input.parent_id)
        const comment = {
          id: crypto.randomUUID(),
          anchor: input.anchor ?? parent?.anchor,
          author_user_id: user,
          body: input.body,
          ...(input.parent_id === undefined ? {} : { parent_id: input.parent_id }),
          created_at: now(),
        }
        drive.comments.set(entry.id, [...all, comment])
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
    stop: () => server.stop(true),
  }
}
