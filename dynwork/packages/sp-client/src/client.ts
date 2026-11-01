import { createHash, createPublicKey, timingSafeEqual, verify } from "node:crypto"
import { Clock, Duration, Effect, Schema, SchemaIssue } from "effect"
import { Incompatible, KeyChanged, Protocol, RateLimited, SignatureInvalid, Unauthorized, Unreachable } from "./errors"
export * from "./errors"

import {
  Capabilities,
  Discovery,
  Envelope,
  ErrorEnvelope,
  Health,
  Manifest,
  Models,
  PatSession,
  Profile,
  PublicKey,
  SessionPat,
  Whoami,
} from "./schema"

// A clean-room client for the parts of systemprompt 0.76 DynWork needs, written from PROTOCOL.md and HTTP observation
// only. Every function takes the instance base URL and the credential it needs as plain values: nothing is stored,
// cached or logged here, and no error carries a credential.

// The discovery contract and the manifest schema this client understands.
export const contract = "1"
export const schemaVersion = 1

// Declared client kind. The instance's vocabulary is closed and has no `dynwork`; no attestation header is ever sent,
// since DynWork verifies no host token.
export const clientKind = "opencode"

// Paths for instances without discovery (older than 0.76, or discovery not configured): the Dynapps brand's.
export const fallback = { deviceLinkPath: "/bridge-auth/device-link", identityPath: "/api/public/bridge/whoami" }

const requestTimeout = Duration.seconds(30)

const codePattern = /^[0-9a-f]{64}$/

export type Instance = {
  baseUrl: string
  // false when the instance has no discovery document and the fallback paths are used
  discovered: boolean
  deviceLinkPath: string
  identityPath: string
  displayName?: string
  enabledHosts: readonly string[]
  // Sign-in modes from `/v1/auth/bridge/capabilities` (`pat`, `session`, `oauth-client`)
  modes: readonly string[]
  // Server version from the health endpoint, when it reports one
  version?: string
}

export type Session = {
  token: string
  ttl: number
  // Epoch milliseconds on the caller's clock: the time of the answer plus `ttl`
  expiresAt: number
  // Session id the instance bound the JWT to, to replay as `x-session-id`
  sessionId?: string
}

export type ManifestResult =
  | { _tag: "NotModified"; etag: string }
  // `payload` is the signed JCS string, kept so a caller can persist it and verify it again
  | { _tag: "Manifest"; etag: string; manifest: Manifest; payload: string }

export const discover = Effect.fn("SpClient.discover")(function* (baseUrl: string) {
  const base = yield* instanceUrl(baseUrl)
  const results = yield* Effect.all([wellKnown(base), capabilities(base), health(base)], { concurrency: 3 })
  const found = results[0]
  if (found === undefined)
    return {
      baseUrl: base,
      discovered: false,
      ...fallback,
      enabledHosts: [],
      modes: results[1],
      version: results[2],
    } satisfies Instance
  return {
    baseUrl: base,
    discovered: true,
    deviceLinkPath: yield* sameOrigin(base, found.device_link_path, "device_link_path"),
    identityPath: yield* sameOrigin(base, found.identity_path ?? fallback.identityPath, "identity_path"),
    displayName: found.branding?.display_name,
    enabledHosts: found.enabled_hosts ?? [],
    modes: results[1],
    version: results[2],
  } satisfies Instance
})

// The page the system browser opens. `redirect` must be a loopback URL the instance accepts (PROTOCOL.md section 2);
// `state` goes inside it, since the page drops any `state` of its own and keeps the redirect's query verbatim. It is
// required: without it any local page could hand the listener a code for another account.
export function deviceLinkUrl(instance: Pick<Instance, "baseUrl" | "deviceLinkPath">, redirect: string, state: string) {
  const target = new URL(redirect)
  if (!loopbackRedirect(target))
    throw new TypeError("redirect must be http://127.0.0.1:<port> or http://localhost:<port> with an explicit port")
  target.searchParams.set("state", state)
  const page = new URL(`${instance.baseUrl}${instance.deviceLinkPath}`)
  page.searchParams.set("redirect", target.href)
  return page.href
}

// Reads the browser's GET on the loopback listener. Anything that is not a well-formed answer carrying the expected
// state is `undefined`, so the listener keeps waiting.
export function parseCallback(url: string | URL, state: string) {
  const query = new URL(url).searchParams
  if (state === "" || !sameSecret(query.get("state") ?? "", state)) return undefined
  if (query.get("error") === "denied") return { _tag: "Denied" as const }
  const code = query.get("code")
  if (code === null || !codePattern.test(code)) return undefined
  return { _tag: "Code" as const, code }
}

// Trades a one-time code (device link or pasted) for a durable PAT. `deviceName` names it in the user's token list.
export const exchangeCode = Effect.fn("SpClient.exchangeCode")(function* (
  baseUrl: string,
  code: string,
  deviceName?: string,
) {
  const answer = yield* call(baseUrl, SessionPat, {
    method: "POST",
    path: "/v1/auth/bridge/session-pat",
    body: { code: code.trim(), ...(deviceName === undefined ? {} : { device_name: deviceName }) },
  })
  return answer.pat
})

// Mints a JWT from a PAT. There is no refresh token: mint again before `expiresAt`, and once after an `Unauthorized`.
export const mintJwt = Effect.fn("SpClient.mintJwt")(function* (
  baseUrl: string,
  pat: string,
  options?: { sessionId?: string },
) {
  const answer = yield* call(baseUrl, PatSession, {
    method: "POST",
    path: "/v1/auth/bridge/pat",
    bearer: pat,
    headers: options?.sessionId === undefined ? undefined : { "x-session-id": options.sessionId },
  })
  const now = yield* Clock.currentTimeMillis
  return {
    token: answer.token,
    ttl: answer.ttl,
    expiresAt: now + answer.ttl * 1000,
    sessionId: answer.headers?.["x-session-id"],
  } satisfies Session
})

// Runs `use` with a JWT for `pat`: the given session's, or a fresh one. When a given session's JWT is refused, mints
// once more and retries once; a second refusal is the caller's signed-out signal.
export const withJwt = <A, E, R>(
  baseUrl: string,
  pat: string,
  session: Session | undefined,
  use: (token: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fresh = () =>
      Effect.gen(function* () {
        const next = yield* mintJwt(baseUrl, pat, { sessionId: session?.sessionId })
        return { value: yield* use(next.token), session: next }
      })
    // A JWT within a minute of its expiry is not worth a request that is certain to be refused
    if (session === undefined || session.expiresAt - 60_000 <= (yield* Clock.currentTimeMillis)) return yield* fresh()
    return yield* use(session.token).pipe(
      Effect.map((value) => ({ value, session })),
      Effect.catchIf((error) => error instanceof Unauthorized, fresh),
    )
  })

export const publicKey = Effect.fn("SpClient.publicKey")(function* (baseUrl: string) {
  const answer = yield* call(baseUrl, PublicKey, { method: "GET", path: "/v1/bridge/pubkey" })
  if (Buffer.from(answer.pubkey, "base64").length !== 32)
    return yield* new Protocol({
      endpoint: "GET /v1/bridge/pubkey",
      message: "the manifest key is not a 32-byte ed25519 key",
      path: "pubkey",
    })
  return { key: answer.pubkey, fingerprint: fingerprint(answer.pubkey) }
})

// What a user compares to trust a key on first use: SHA-256 of the raw key bytes.
export function fingerprint(key: string) {
  return `sha256:${createHash("sha256").update(Buffer.from(key, "base64")).digest("hex")}`
}

// The envelope signature is ed25519 over the exact bytes of the payload string; the key is the raw 32 bytes in base64.
export function verifySignature(payload: string, signature: string, key: string) {
  const raw = Buffer.from(key, "base64")
  const signed = Buffer.from(signature, "base64")
  if (raw.length !== 32 || signed.length !== 64) return false
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw])
  return verify(null, Buffer.from(payload), createPublicKey({ key: spki, format: "der", type: "spki" }), signed)
}

// The signed per-user catalog. `key` is the manifest key pinned for this instance; `etag` turns an unchanged catalog
// into a 304; `fresh` asks the instance to revalidate its short-lived cache (polling).
export const manifest = Effect.fn("SpClient.manifest")(function* (
  baseUrl: string,
  jwt: string,
  options: { key: string; etag?: string; fresh?: boolean },
) {
  const endpoint = "GET /v1/bridge/manifest"
  const answer = yield* send(baseUrl, {
    method: "GET",
    path: "/v1/bridge/manifest",
    bearer: jwt,
    headers: {
      ...(options.etag === undefined ? {} : { "if-none-match": options.etag }),
      ...(options.fresh ? { "cache-control": "no-cache" } : {}),
    },
  })
  const etag = answer.headers.get("etag")
  if (answer.status === 304) return { _tag: "NotModified", etag: etag ?? options.etag ?? "" } satisfies ManifestResult
  if (answer.status !== 200) return yield* failure(endpoint, answer)
  if (etag === null) return yield* new Protocol({ endpoint, message: "the manifest came without an ETag", status: 200 })
  const envelope = yield* decode(endpoint, Envelope, answer.body)
  if (!verifySignature(envelope.payload, envelope.signature, options.key)) {
    const served = yield* publicKey(baseUrl)
    if (served.fingerprint !== fingerprint(options.key))
      return yield* new KeyChanged({
        endpoint,
        message: "the instance serves a different manifest key than the pinned one",
        pinned: fingerprint(options.key),
        served: served.fingerprint,
      })
    return yield* new SignatureInvalid({ endpoint, message: "the manifest signature does not verify" })
  }
  // Read the schema floor first, so a newer schema reports as such instead of as a field it does not decode
  const floor = yield* decode(endpoint, Schema.Struct({ min_schema_version: Schema.Number }), envelope.payload)
  if (floor.min_schema_version > schemaVersion)
    return yield* new Incompatible({
      endpoint,
      message: "the manifest needs a newer schema",
      supported: String(schemaVersion),
      found: String(floor.min_schema_version),
    })
  return {
    _tag: "Manifest",
    etag,
    manifest: yield* decode(endpoint, Manifest, envelope.payload),
    payload: envelope.payload,
  } satisfies ManifestResult
})

// Models admitted for this user, the default one and per-model limits. `inference_gateway_base_url` is the instance's
// internal address (`http://localhost:8080/v1` locally), so model calls use `<baseUrl>/v1` instead.
export const profile = Effect.fn("SpClient.profile")(function* (baseUrl: string, jwt: string) {
  return yield* call(baseUrl, Profile, { method: "GET", path: "/v1/bridge/profile", bearer: jwt })
})

// The instance-wide model catalog, Anthropic shape.
export const models = Effect.fn("SpClient.models")(function* (baseUrl: string, jwt: string) {
  return (yield* call(baseUrl, Models, { method: "GET", path: "/v1/models", bearer: jwt })).data
})

export const whoami = Effect.fn("SpClient.whoami")(function* (baseUrl: string, jwt: string) {
  return yield* call(baseUrl, Whoami, { method: "GET", path: "/v1/bridge/whoami", bearer: jwt })
})

type Request = {
  method: "GET" | "POST"
  path: string
  bearer?: string
  body?: unknown
  headers?: Record<string, string>
}

const wellKnown = Effect.fnUntraced(function* (base: string) {
  const endpoint = "GET /.well-known/systemprompt-bridge"
  const answer = yield* send(base, { method: "GET", path: "/.well-known/systemprompt-bridge" })
  if (answer.status === 404) return undefined
  if (answer.status !== 200) return yield* failure(endpoint, answer)
  const found = yield* decode(endpoint, Discovery, answer.body)
  if (found.contract !== contract)
    return yield* new Incompatible({
      endpoint,
      message: "the instance publishes a discovery contract this client does not know",
      supported: contract,
      found: found.contract,
    })
  return found
})

// Instances older than 0.76 have no capabilities route; they sign in with the fallback paths and report no modes.
const capabilities = Effect.fnUntraced(function* (base: string) {
  return yield* call(base, Capabilities, { method: "GET", path: "/v1/auth/bridge/capabilities" }).pipe(
    Effect.map((answer): readonly string[] => answer.modes),
    Effect.catchIf(
      (error) => error instanceof Protocol && error.status === 404,
      () => Effect.succeed([]),
    ),
  )
})

// The version is informative: discovery and the sign-in routes are what the client depends on, so any failure here
// only leaves the version unknown.
const health = Effect.fnUntraced(
  function* (base: string) {
    const answer = yield* send(base, { method: "GET", path: "/api/v1/health" })
    if (answer.status !== 200) return undefined
    return (yield* decode("GET /api/v1/health", Health, answer.body)).version
  },
  Effect.orElseSucceed(() => undefined),
)

const call = Effect.fnUntraced(function* <A>(baseUrl: string, schema: Schema.Decoder<A>, request: Request) {
  const endpoint = `${request.method} ${request.path}`
  const answer = yield* send(baseUrl, request)
  if (answer.status !== 200) return yield* failure(endpoint, answer)
  return yield* decode(endpoint, schema, answer.body)
})

const send = Effect.fnUntraced(function* (baseUrl: string, request: Request) {
  const base = yield* instanceUrl(baseUrl)
  const endpoint = `${request.method} ${request.path}`
  const unreachable = (message: string) => new Unreachable({ endpoint, message })
  // The timeout covers the whole answer, body included: a server that stalls mid-body is as unreachable as a silent one
  return yield* Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(`${base}${request.path}`, {
        method: request.method,
        headers: {
          accept: "application/json",
          "x-systemprompt-client": clientKind,
          ...(request.bearer === undefined ? {} : { authorization: `Bearer ${request.bearer}` }),
          ...(request.body === undefined ? {} : { "content-type": "application/json" }),
          ...request.headers,
        },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        // A redirect is never followed: it could carry the bearer to another origin
        redirect: "manual",
        signal,
      })
      return { status: response.status, headers: response.headers, body: await response.text() }
    },
    // Bun's fetch errors name the failure and the URL, never the request headers
    catch: (cause) => unreachable(cause instanceof Error ? cause.message : "the request failed"),
  }).pipe(
    Effect.timeoutOrElse({
      duration: requestTimeout,
      orElse: () => Effect.fail(unreachable(`no answer within ${Duration.format(requestTimeout)}`)),
    }),
  )
})

type Answer = { status: number; headers: Headers; body: string }

const failure = Effect.fnUntraced(function* (endpoint: string, response: Answer) {
  const envelope = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorEnvelope))(response.body)
  const details = {
    endpoint,
    message:
      envelope._tag === "Some" ? (envelope.value.message ?? `status ${response.status}`) : `status ${response.status}`,
    ...(envelope._tag === "Some" && envelope.value.error_key !== undefined
      ? { errorKey: envelope.value.error_key }
      : {}),
  }
  if (response.status === 401) return yield* new Unauthorized(details)
  if (response.status === 429) {
    const now = yield* Clock.currentTimeMillis
    return yield* new RateLimited({ endpoint, message: details.message, retryAfterMs: retryAfter(response, now) })
  }
  if (response.status >= 500)
    return yield* new Unreachable({ endpoint, message: details.message, status: response.status })
  return yield* new Protocol({ ...details, status: response.status })
})

const decode = <A>(endpoint: string, schema: Schema.Decoder<A>, body: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(body).pipe(
    Effect.mapError((error) => {
      const first = SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues[0]
      const path = (first?.path ?? []).map((segment) => String(typeof segment === "object" ? segment.key : segment))
      return new Protocol({
        endpoint,
        message: first?.message ?? error.message,
        path: path.length === 0 ? undefined : path.join("."),
      })
    }),
  )

// `Retry-After` is either whole seconds or an HTTP date (always in GMT); anything else is unreadable, not "now".
function retryAfter(response: Answer, now: number) {
  const value = response.headers.get("retry-after")?.trim()
  if (value === undefined) return undefined
  if (/^\d+$/.test(value)) return Number(value) * 1000
  if (!value.endsWith("GMT")) return undefined
  const at = Date.parse(value)
  return Number.isNaN(at) ? undefined : Math.max(0, at - now)
}

const instanceUrl = (baseUrl: string) => {
  const url = URL.canParse(baseUrl) ? new URL(baseUrl) : undefined
  if (url === undefined || (url.protocol !== "https:" && url.protocol !== "http:"))
    return Effect.fail(new Protocol({ endpoint: "base URL", message: "the instance URL must be an http or https URL" }))
  // Plain http would put the PAT and JWTs on the wire in clear text; only a local instance may use it
  if (url.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    return Effect.fail(
      new Protocol({ endpoint: "base URL", message: "the instance URL must use https unless it is local" }),
    )
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "")
    return Effect.fail(
      new Protocol({
        endpoint: "base URL",
        message: "the instance URL must not carry credentials, a query or a fragment",
      }),
    )
  return Effect.succeed(`${url.origin}${url.pathname.replace(/\/+$/, "")}`)
}

// Discovery paths are gateway-relative; one that would leave the instance's origin is refused.
const sameOrigin = (base: string, path: string, field: string) => {
  if (
    path.startsWith("/") &&
    !path.startsWith("//") &&
    !path.includes("\\") &&
    new URL(`${base}${path}`).origin === new URL(base).origin
  )
    return Effect.succeed(path)
  return Effect.fail(
    new Protocol({
      endpoint: "GET /.well-known/systemprompt-bridge",
      message: "a discovery path leaves the instance origin",
      path: field,
    }),
  )
}

function loopbackRedirect(url: URL) {
  return (
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
    url.port !== "" &&
    url.username === "" &&
    url.password === ""
  )
}

function sameSecret(a: string, b: string) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
