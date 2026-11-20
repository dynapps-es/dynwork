import { Clock, Duration, Effect, Schema } from "effect"
import { Incompatible, Protocol, RateLimited, Unauthorized, Unreachable } from "./errors"
import { createPkce, randomSecret } from "./mobile"

// The person's own UI session (0.84, core "First-party desktop UI", PROTOCOL.md section 13): a public native client the
// operator declares `person_ui`, signed in with authorization code + PKCE (S256) in the system browser on a loopback
// redirect. Its access token has only the `ui` audience, lasts 300 seconds and acts as the person on the documents,
// folders and uploads routes; its refresh token rotates and ends 12 hours after the sign-in, whatever the refreshes.
// Nothing here stores, caches or logs a token, a code or a verifier, and no error carries one.

/** DynWork's `person_ui` client, as the Dynapps extension declares it (`services/identity/dynwork-desktop.yaml`). */
export const clientId = "dynwork-desktop"

/**
 * The redirect the client declares: the core takes it on any port when host, path and query match (RFC 8252 7.3).
 * Always the IP literal: `localhost` is not a loopback literal for the core.
 */
export const redirectUri = "http://127.0.0.1/oauth/callback"

export const callbackPath = "/oauth/callback"

/** The session ends this long after the sign-in (`UI_SESSION_ABSOLUTE_SECS`), refreshes or not. */
export const lifetime = 12 * 3600_000

/** Sharing, transfer, delete and agent caps want a sign-in no older than this (`UI_SESSION_STEP_UP_MAX_AGE_SECS`). */
export const recent = 600

const authorizePath = "/api/v1/core/oauth/authorize"
const tokenPath = "/api/v1/core/oauth/token"
const revokePath = "/api/v1/core/oauth/revoke"

const requestTimeout = Duration.seconds(30)

export type Tokens = {
  access: string
  refresh: string
  // Epoch milliseconds on the caller's clock: the time of the answer plus `expires_in`
  expiresAt: number
  ttl: number
  // The sign-in (`auth_time`), epoch milliseconds: refreshing keeps it
  signedInAt: number
  // The person (`sub`)
  user: string
}

export type Callback = { _tag: "Code"; code: string } | { _tag: "Denied" }

/** A fresh PKCE pair (S256) and `state` for one sign-in: 32 random bytes each, as 43 base64url characters. */
export function begin() {
  return { ...createPkce(), state: randomSecret() }
}

const TokenBody = Schema.Struct({
  access_token: Schema.String.check(Schema.isNonEmpty()),
  refresh_token: Schema.String.check(Schema.isNonEmpty()),
  expires_in: Schema.Number.check(Schema.isGreaterThan(0)),
})

// What DynWork reads of the access token's claims: only to tell a UI session from any other token and when it began.
// The signature is the instance's to check; this is no verification.
const Claims = Schema.Struct({
  aud: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  ui_session: Schema.optional(Schema.Boolean),
  auth_time: Schema.Number,
  sub: Schema.String,
})

const OAuthError = Schema.Struct({ error: Schema.String, error_description: Schema.optional(Schema.String) })

/**
 * The page the system browser opens. `redirect` is the loopback listener's (`http://127.0.0.1:<port>/oauth/callback`);
 * `state` is at least 32 characters (the core refuses shorter ones). `maxAge` asks for a sign-in no older than that
 * (OIDC `max_age`): 0.84 does not read it, and every code it issues is a new sign-in.
 */
export function authorizeUrl(
  baseUrl: string,
  request: { redirect: string; state: string; challenge: string; maxAge?: number },
) {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: request.redirect,
    scope: "user",
    state: request.state,
    code_challenge: request.challenge,
    code_challenge_method: "S256",
    ...(request.maxAge === undefined ? {} : { max_age: String(request.maxAge) }),
  })
  return `${baseUrl}${authorizePath}?${query}`
}

/**
 * Reads the browser's GET on the loopback listener: a code, or the person's refusal (`error=access_denied`), with the
 * expected `state`. Anything else is undefined, so the listener keeps waiting.
 */
export function parseCallback(url: URL, state: string): Callback | undefined {
  const query = url.searchParams
  if (state === "" || !sameSecret(query.get("state") ?? "", state)) return undefined
  if (query.get("error") === "access_denied") return { _tag: "Denied" }
  const code = query.get("code")
  return code === null || code === "" ? undefined : { _tag: "Code", code }
}

/**
 * Whether the instance declares DynWork's client: its authorize page answers the declared redirect (a sign-in page, or
 * a redirect to the instance's own login page) where an unknown client is refused `400`. Signs nobody in. Whether the
 * client is a `person_ui` one shows only in the tokens a sign-in gets (`exchange`).
 */
export const available = Effect.fn("SpPerson.available")(function* (baseUrl: string) {
  const endpoint = `GET ${authorizePath}`
  const probe = authorizeUrl(baseUrl, {
    redirect: redirectUri,
    state: randomSecret(),
    challenge: randomSecret(),
  })
  const answer = yield* send(endpoint, probe, { method: "GET" })
  if (answer.status === 200) return true
  // A redirect to the redirect URI carries an error; one elsewhere is the instance's own login page
  if (answer.status >= 300 && answer.status < 400)
    return !(answer.headers.get("location") ?? "").startsWith("http://127.0.0.1")
  if (answer.status === 400 || answer.status === 401 || answer.status === 404) return false
  return yield* failure(endpoint, answer)
})

/** Trades the code for the person's UI session. A token that is not one (`ui` audience, `ui_session`) is refused. */
export const exchange = Effect.fn("SpPerson.exchange")(function* (
  baseUrl: string,
  grant: { code: string; redirect: string; verifier: string },
) {
  return yield* token(baseUrl, {
    grant_type: "authorization_code",
    client_id: clientId,
    code: grant.code,
    redirect_uri: grant.redirect,
    code_verifier: grant.verifier,
  })
})

/**
 * A new access token and a new refresh token for the held one, which stops working: keep the new one before anything
 * else. `Unauthorized` means the session is over: the 12 hours ran out, it was revoked, or the refresh token was used
 * twice (which ends the whole family).
 */
export const refresh = Effect.fn("SpPerson.refresh")(function* (baseUrl: string, refreshToken: string) {
  return yield* token(baseUrl, { grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken })
})

/**
 * Ends the session at the instance: the refresh token's family stops working. The revoke route does not take the UI
 * token itself, so `bearer` is another token of the same person (DynWork's JWT).
 */
export const revoke = Effect.fn("SpPerson.revoke")(function* (
  baseUrl: string,
  input: { refreshToken: string; bearer: string },
) {
  const endpoint = `POST ${revokePath}`
  const answer = yield* send(endpoint, `${baseUrl}${revokePath}`, {
    method: "POST",
    bearer: input.bearer,
    form: { token: input.refreshToken, token_type_hint: "refresh_token", client_id: clientId },
  })
  if (answer.status !== 200) return yield* failure(endpoint, answer)
})

const token = Effect.fnUntraced(function* (baseUrl: string, form: Record<string, string>) {
  const endpoint = `POST ${tokenPath}`
  const answer = yield* send(endpoint, `${baseUrl}${tokenPath}`, { method: "POST", form })
  if (answer.status !== 200) return yield* failure(endpoint, answer)
  const body = yield* decode(endpoint, TokenBody, answer.body)
  const claims = yield* decode(endpoint, Claims, payload(body.access_token))
  const audience = typeof claims.aud === "string" ? [claims.aud] : claims.aud
  if (claims.ui_session !== true || !audience.includes("ui"))
    return yield* new Incompatible({
      endpoint,
      message: "the instance did not issue a UI session for DynWork's client",
      supported: "ui_session",
      found: "none",
    })
  const now = yield* Clock.currentTimeMillis
  return {
    access: body.access_token,
    refresh: body.refresh_token,
    ttl: body.expires_in,
    expiresAt: now + body.expires_in * 1000,
    signedInAt: claims.auth_time * 1000,
    user: claims.sub,
  } satisfies Tokens
})

type Answer = { status: number; headers: Headers; body: string }

const send = Effect.fnUntraced(function* (
  endpoint: string,
  url: string,
  request: { method: "GET" | "POST"; bearer?: string; form?: Record<string, string> },
) {
  const unreachable = (message: string) => new Unreachable({ endpoint, message })
  const target = URL.canParse(url) ? new URL(url) : undefined
  // Plain http would put the tokens on the wire in clear text; only a local instance may use it
  if (
    target === undefined ||
    !(target.protocol === "https:" || (target.protocol === "http:" && local(target.hostname)))
  )
    return yield* new Protocol({ endpoint, message: "the instance URL must use https unless it is local" })
  return yield* Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(target, {
        method: request.method,
        headers: {
          accept: "application/json",
          ...(request.bearer === undefined ? {} : { authorization: `Bearer ${request.bearer}` }),
          ...(request.form === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" }),
        },
        body: request.form === undefined ? undefined : new URLSearchParams(request.form).toString(),
        // A redirect is never followed: it could carry a token to another origin
        redirect: "manual",
        signal,
      })
      return { status: response.status, headers: response.headers, body: await response.text() } satisfies Answer
    },
    // A fixed message: a fetch error can quote the request, and so a code or a token
    catch: () => unreachable("the request failed"),
  }).pipe(
    Effect.timeoutOrElse({
      duration: requestTimeout,
      orElse: () => Effect.fail(unreachable(`no answer within ${Duration.format(requestTimeout)}`)),
    }),
  )
})

// The OAuth error envelope (`invalid_grant`, `invalid_client`, ...) without its description, which may quote the
// request. A dead grant or an unknown client is a refusal: the session cannot go on.
const failure = Effect.fnUntraced(function* (endpoint: string, answer: Answer) {
  const found = Schema.decodeUnknownOption(Schema.fromJsonString(OAuthError))(answer.body)
  const error = found._tag === "Some" ? found.value.error : undefined
  const message = error ?? `status ${answer.status}`
  if (answer.status === 401 || error === "invalid_grant" || error === "invalid_client")
    return yield* new Unauthorized({ endpoint, message, errorKey: error })
  if (answer.status === 429) return yield* new RateLimited({ endpoint, message })
  if (answer.status >= 500) return yield* new Unreachable({ endpoint, message, status: answer.status })
  return yield* new Protocol({ endpoint, message, status: answer.status, errorKey: error })
})

const decode = <A>(endpoint: string, schema: Schema.Decoder<A>, body: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(body).pipe(
    Effect.mapError(() => new Protocol({ endpoint, message: "the answer is not what the token endpoint gives" })),
  )

// The claims of a JWT, as JSON text; anything else decodes as nothing
function payload(jwt: string) {
  const part = jwt.split(".")[1]
  return part === undefined ? "" : Buffer.from(part, "base64url").toString()
}

function local(hostname: string) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]"
}

function sameSecret(a: string, b: string) {
  if (a.length !== b.length) return false
  return Array.from(a).reduce((diff, char, index) => diff | (char.charCodeAt(0) ^ b.charCodeAt(index)), 0) === 0
}
