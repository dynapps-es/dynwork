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

export type Recorded = { method: string; path: string; headers: Record<string, string>; body: string }

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
    // Device credentials the instance issued, with the device each enrols, and the device of each fingerprint
    devices: new Map<string, { device_id: string; consumer_id: string }>(),
    fingerprints: new Map<string, string>(),
    // Plans served by publication id: the ones observed on the local harness for alpha's skills
    plans: structuredClone(consumer.plans) as Record<string, (typeof consumer.plans)["alpha_notes"]>,
    receipts: [] as Array<{ key: string; receipt_id: string; body: string }>,
    requests: [] as Recorded[],
    // Plugin bundle files by `<plugin>/<path>`, served at `/v1/bridge/plugins/<plugin>/<path>`
    files: {} as Record<string, Uint8Array | string>,
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      const body = await request.text()
      state.requests.push({
        method: request.method,
        path: url.pathname,
        headers: Object.fromEntries(request.headers),
        body,
      })
      if (state.override !== undefined && (state.override.path === undefined || state.override.path === url.pathname))
        return Response.json(state.override.body ?? null, {
          status: state.override.status,
          headers: state.override.headers,
        })
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
      state.jwts.add(token)
      return Response.json({
        ...deviceLink.round_trip.pat_to_jwt.body,
        token,
        device_token: `eyJ${randomBytes(24).toString("hex")}`,
        headers: {
          ...deviceLink.round_trip.pat_to_jwt.body.headers,
          "x-session-id": request.headers.get("x-session-id") ?? `sess_${randomBytes(8).toString("hex")}`,
        },
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
