import { sha256 } from "@noble/hashes/sha2.js"
import { Clock, Duration, Effect, Schema } from "effect"
import { Incompatible, Protocol, RateLimited, Unauthorized, Unreachable } from "./errors"

// Mobile sign-in, path 1 (PROTOCOL.md section 11): the phone signs in to an instance the way DynWork desktop does,
// through the system browser and the instance's own login, and comes back on `dynwork://auth/callback` with a
// one-time code bound to its PKCE challenge. The code becomes a revocable mobile credential (`dwm1_`) and a one-hour
// JWT. Runs on Hermes: no `node:` or Bun API, no WebAssembly, no `URL` or `URLSearchParams` (React Native's are
// partial), randomness from `crypto.getRandomValues` (react-native-get-random-values on a phone). Nothing here stores,
// caches or logs a credential, and no error carries one.

export const redirectUri = "dynwork://auth/callback"

export const basePath = "/api/dynwork/mobile/v1"

const requestTimeout = Duration.seconds(30)

const codePattern = /^dwa1_[A-Za-z0-9_-]{43}$/

const credentialPattern = /^dwm1_[A-Za-z0-9_-]{43}$/

const peerPattern = /^[0-9a-f]{32}$/

export type Pkce = { verifier: string; challenge: string }

export type Callback = { _tag: "Code"; code: string } | { _tag: "Denied" }

export type Account = { id: string; email: string; name: string }

export type MobileSession = {
  token: string
  ttl: number
  // Epoch milliseconds on the caller's clock: the time of the answer plus `ttl`
  expiresAt: number
  deviceId: string
  account: Account
}

export type MobileSignIn = MobileSession & { credential: string; peerId: string }

export type MobileInstance = { baseUrl: string; displayName: string; authorizePath: string }

const AccountBody = Schema.Struct({ id: Schema.String, email: Schema.String, name: Schema.String })

const SessionBody = Schema.Struct({
  token: Schema.String.check(Schema.isNonEmpty()),
  expires_in: Schema.Number.check(Schema.isGreaterThan(0)),
  device_id: Schema.String,
  account: AccountBody,
})

const SignedInBody = Schema.Struct({ ...SessionBody.fields, credential: Schema.String, peer_id: Schema.String })

const DiscoveryBody = Schema.Struct({
  version: Schema.Number,
  display_name: Schema.String,
  redirect_uri: Schema.String,
  authorize_path: Schema.String,
})

const ErrorBody = Schema.Struct({ error: Schema.optional(Schema.String), message: Schema.optional(Schema.String) })

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

// Unpadded base64url (RFC 4648 section 5)
export function base64url(bytes: Uint8Array) {
  const at = (index: number) => alphabet[index] ?? ""
  return Array.from({ length: Math.ceil(bytes.length / 3) }, (_, group) => {
    const [a = 0, b = 0, c = 0] = bytes.slice(group * 3, group * 3 + 3)
    const left = bytes.length - group * 3
    const chars = at(a >> 2) + at(((a & 3) << 4) | (b >> 4)) + at(((b & 15) << 2) | (c >> 6)) + at(c & 63)
    return chars.slice(0, Math.min(4, left + 1))
  }).join("")
}

const randomBytes = (length: number) => globalThis.crypto.getRandomValues(new Uint8Array(length))

// 32 random bytes as 43 base64url characters: a PKCE verifier or a `state`.
export function randomSecret(random = randomBytes) {
  return base64url(random(32))
}

// S256: BASE64URL(SHA256(ASCII(verifier))). Verifiers are ASCII by construction (RFC 7636 section 4.1).
export function challengeOf(verifier: string) {
  return base64url(sha256(Uint8Array.from(verifier, (char) => char.charCodeAt(0))))
}

export function createPkce(random = randomBytes): Pkce {
  const verifier = randomSecret(random)
  return { verifier, challenge: challengeOf(verifier) }
}

// The instance base URL: https, or http to this machine only, with no credentials, query or fragment.
export function instanceUrl(baseUrl: string) {
  const match = /^(https?):\/\/([^/?#@\s]+)(\/[^?#\s]*)?$/.exec(baseUrl.trim())
  const host = match?.[2]?.toLowerCase().replace(/:\d+$/, "")
  if (match === null || host === undefined) return undefined
  if (match[1] === "http" && !["127.0.0.1", "localhost", "[::1]"].includes(host)) return undefined
  return `${match[1]}://${match[2]}${(match[3] ?? "").replace(/\/+$/, "")}`
}

const base = (baseUrl: string, endpoint: string) => {
  const url = instanceUrl(baseUrl)
  return url === undefined
    ? Effect.fail(
        new Protocol({
          endpoint,
          message: "the instance URL must be https (or http to this machine) with no credentials, query or fragment",
        }),
      )
    : Effect.succeed(url)
}

// The page the system browser opens (ASWebAuthenticationSession, Custom Tabs). Throws on a base URL that is not one.
export function authorizeUrl(baseUrl: string, request: { challenge: string; state: string; deviceName: string }) {
  const url = instanceUrl(baseUrl)
  if (url === undefined) throw new TypeError("the instance URL must be https, or http to this machine")
  const query = [
    ["redirect_uri", redirectUri],
    ["code_challenge", request.challenge],
    ["code_challenge_method", "S256"],
    ["state", request.state],
    ["device_name", request.deviceName],
  ]
    .map(([key, value]) => `${key}=${encodeURIComponent(value ?? "")}`)
    .join("&")
  return `${url}${basePath}/authorize?${query}`
}

function sameSecret(a: string, b: string) {
  if (a.length !== b.length) return false
  return Array.from(a).reduce((diff, char, index) => diff | (char.charCodeAt(0) ^ b.charCodeAt(index)), 0) === 0
}

// Reads the URL the browser session handed back. Anything that is not the callback carrying the expected `state` is
// `undefined`: a stray or forged redirect is ignored, never treated as an answer.
export function parseCallback(url: string, state: string): Callback | undefined {
  const prefix = `${redirectUri}?`
  if (state === "" || !url.startsWith(prefix)) return undefined
  const query = new Map(
    url
      .slice(prefix.length)
      .split("#")[0]
      ?.split("&")
      .map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)] as const),
  )
  if (!sameSecret(query.get("state") ?? "", state)) return undefined
  if (query.get("error") === "access_denied") return { _tag: "Denied" }
  const code = query.get("code")
  return code !== undefined && codePattern.test(code) ? { _tag: "Code", code } : undefined
}

type Call = { method: "GET" | "POST"; path: string; bearer?: string; body?: unknown }

const send = Effect.fnUntraced(function* (baseUrl: string, call: Call) {
  const endpoint = `${call.method} ${call.path}`
  const url = yield* base(baseUrl, endpoint)
  const unreachable = (message: string) => new Unreachable({ endpoint, message })
  const answer = yield* Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(`${url}${call.path}`, {
        method: call.method,
        headers: {
          accept: "application/json",
          ...(call.bearer === undefined ? {} : { authorization: `Bearer ${call.bearer}` }),
          ...(call.body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: call.body === undefined ? undefined : JSON.stringify(call.body),
        redirect: "manual",
        signal,
      })
      return { status: response.status, headers: response.headers, body: await response.text() }
    },
    // A fixed message: a fetch error can quote request headers, and so the bearer
    catch: () => unreachable("the request failed"),
  }).pipe(
    Effect.timeoutOrElse({
      duration: requestTimeout,
      orElse: () => Effect.fail(unreachable(`no answer within ${Duration.format(requestTimeout)}`)),
    }),
  )
  if (answer.status < 300) return answer
  const envelope = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorBody))(answer.body)
  const details = {
    endpoint,
    message:
      envelope._tag === "Some" ? (envelope.value.message ?? `status ${answer.status}`) : `status ${answer.status}`,
    ...(envelope._tag === "Some" && envelope.value.error !== undefined ? { errorKey: envelope.value.error } : {}),
  }
  if (answer.status === 401) return yield* new Unauthorized(details)
  if (answer.status === 429) return yield* new RateLimited({ endpoint, message: details.message })
  if (answer.status >= 500) return yield* new Unreachable({ endpoint, message: details.message, status: answer.status })
  return yield* new Protocol({ ...details, status: answer.status })
})

const decode = <A>(endpoint: string, schema: Schema.Decoder<A>, body: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(body).pipe(
    Effect.mapError(() => new Protocol({ endpoint, message: "the answer does not have the expected shape" })),
  )

const toSession = Effect.fnUntraced(function* (body: typeof SessionBody.Type) {
  const now = yield* Clock.currentTimeMillis
  return {
    token: body.token,
    ttl: body.expires_in,
    expiresAt: now + body.expires_in * 1000,
    deviceId: body.device_id,
    account: body.account,
  } satisfies MobileSession
})

// Whether the instance offers path 1. `Incompatible` when it does not (an instance without the DynWork extension).
export const discover = Effect.fn("SpMobile.discover")(function* (baseUrl: string) {
  const endpoint = `GET ${basePath}/discovery`
  const url = yield* base(baseUrl, endpoint)
  const answer = yield* send(url, { method: "GET", path: `${basePath}/discovery` }).pipe(
    Effect.catchIf(
      (error) => error instanceof Protocol && error.status === 404,
      () =>
        Effect.fail(
          new Incompatible({
            endpoint,
            message: "the instance does not offer the mobile sign-in",
            supported: "1",
            found: "none",
          }),
        ),
    ),
  )
  const body = yield* decode(endpoint, DiscoveryBody, answer.body)
  if (body.version !== 1 || body.redirect_uri !== redirectUri || body.authorize_path !== `${basePath}/authorize`)
    return yield* new Incompatible({
      endpoint,
      message: "the mobile sign-in speaks another version",
      supported: "1",
      found: String(body.version),
    })
  return { baseUrl: url, displayName: body.display_name, authorizePath: body.authorize_path } satisfies MobileInstance
})

// Trades the callback's code, its PKCE verifier and the phone's peer id for a mobile credential and a JWT.
export const exchange = Effect.fn("SpMobile.exchange")(function* (
  baseUrl: string,
  request: { code: string; verifier: string; peerId: string },
) {
  const endpoint = `POST ${basePath}/token`
  if (!peerPattern.test(request.peerId))
    return yield* new Protocol({ endpoint, message: "the peer id is 32 lowercase hex digits" })
  const answer = yield* send(baseUrl, {
    method: "POST",
    path: `${basePath}/token`,
    body: { code: request.code, code_verifier: request.verifier, peer_id: request.peerId },
  })
  const body = yield* decode(endpoint, SignedInBody, answer.body)
  if (!credentialPattern.test(body.credential))
    return yield* new Protocol({ endpoint, message: "the credential is not a mobile credential", path: "credential" })
  return { ...(yield* toSession(body)), credential: body.credential, peerId: body.peer_id } satisfies MobileSignIn
})

// A fresh JWT from the mobile credential. `Unauthorized` means the device was revoked: the phone is signed out.
export const refresh = Effect.fn("SpMobile.refresh")(function* (baseUrl: string, credential: string) {
  const answer = yield* send(baseUrl, { method: "POST", path: `${basePath}/refresh`, bearer: credential })
  return yield* toSession(yield* decode(`POST ${basePath}/refresh`, SessionBody, answer.body))
})

// Signs the phone out: the instance revokes its device, and the credential stops working everywhere.
export const signOut = Effect.fn("SpMobile.signOut")(function* (baseUrl: string, credential: string) {
  yield* send(baseUrl, { method: "POST", path: `${basePath}/revoke`, bearer: credential })
})
