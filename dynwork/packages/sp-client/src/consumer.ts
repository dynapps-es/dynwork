import { createHash } from "node:crypto"
import { Duration, Effect, Schema, SchemaIssue } from "effect"
import { Protocol, RateLimited, Unauthorized, Unreachable } from "./errors"
import type { Publication } from "./schema"

// The device-authenticated consumer API of systemprompt 0.76, as the systemprompt bridge uses it to deliver a skill's
// runtime files (`feedback/{enrol,transport,readback}.rs`): self-enrolment with the user's JWT gives an `sp_device_`
// credential; with it, each skill publication's installation plan (its bundle for one host) is read and, once the
// files are on disk and read back, a receipt is posted. Nothing is stored or logged here, and no error carries a
// credential.

/** The host the plans are asked for: OpenCode in the instance's `EvaluatorClient` vocabulary (kebab-case). */
export const host = "open-code"

const fingerprintDomain = "systemprompt-bridge-device/v1"

/**
 * The bridge's `device_fingerprint`: SHA-256 of the domain, the install id and the user id, one per line. The
 * instance keeps fingerprints globally unique, so the user is part of it.
 */
export function fingerprint(installId: string, userId: string) {
  return createHash("sha256").update(`${fingerprintDomain}\n${installId}\n${userId}`).digest("hex")
}

const Credential = Schema.String.check(Schema.isPattern(/^sp_device_[A-Za-z0-9._~+/=-]+$/), Schema.isMaxLength(256))

export const Enrolment = Schema.Struct({
  device_id: Schema.String,
  consumer_id: Schema.String,
  credential: Credential,
})
export type Enrolment = typeof Enrolment.Type

const Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
const Check = Schema.Literals(["verified", "mismatch", "unavailable"])
export type Check = typeof Check.Type

const CanonicalFile = Schema.Struct({
  revision_id: Schema.String,
  path: Schema.String,
  digest: Digest,
  bytes: Schema.Int,
  executable: Schema.Boolean,
  content_check: Check,
  mode_check: Check,
})

const Plan = Schema.Struct({
  publication_id: Schema.String,
  resource_id: Schema.String,
  revision_id: Schema.String,
  generation: Schema.Int,
  bundle_digest: Digest,
  host: Schema.String,
  canonical_files: Schema.Array(CanonicalFile),
  // `Vec<u8>` as serde writes it: an array of byte values
  runtime_files: Schema.Array(
    Schema.Struct({ path: Schema.String, bytes: Schema.Array(Schema.Number), executable: Schema.Boolean }),
  ),
})

export type Plan = Omit<typeof Plan.Type, "runtime_files"> & {
  readonly runtime_files: ReadonlyArray<{
    readonly path: string
    readonly bytes: Uint8Array
    readonly executable: boolean
  }>
}

export const Acknowledgement = Schema.Struct({
  receipt_id: Schema.String,
  acknowledgement: Schema.String,
  acknowledged_at: Schema.String,
  fully_verified: Schema.Boolean,
})
export type Acknowledgement = typeof Acknowledgement.Type

const RuntimeReadback = Schema.Struct({
  path: Schema.String,
  digest: Digest,
  bytes: Schema.Int,
  executable: Schema.Boolean,
  content_check: Check,
  mode_check: Check,
})

/** `ConsumerReceiptRequest`: what was read back from disk for one installed publication. */
export const Receipt = Schema.Struct({
  installation_id: Schema.String,
  publication_id: Schema.String,
  resource_id: Schema.String,
  revision_id: Schema.String,
  generation: Schema.Int,
  bundle_digest: Digest,
  host: Schema.String,
  observed_at: Schema.String,
  files: Schema.Array(CanonicalFile),
  runtime_files: Schema.Array(RuntimeReadback),
})
export type Receipt = typeof Receipt.Type

/** What one file on disk turned out to be, as the writer read it back. */
export type Readback = {
  readonly path: string
  readonly digest: string
  readonly bytes: number
  readonly executable: boolean
  readonly content: Check
  readonly mode: Check
}

/** Enrols this install for the signed-in user (`POST /v1/bridge/device`, the user's JWT) and returns its credential. */
export const enrol = Effect.fn("SpConsumer.enrol")(function* (
  baseUrl: string,
  jwt: string,
  input: { readonly fingerprint: string; readonly label: string },
) {
  return yield* call(Enrolment, {
    method: "POST",
    url: `${yield* base(baseUrl)}/v1/bridge/device`,
    endpoint: "POST /v1/bridge/device",
    bearer: jwt,
    body: input,
    limit: 4096,
  })
})

/**
 * The installation plan of `publication` for OpenCode, with the device credential. A plan for any other host,
 * publication, revision, generation or bundle than the manifest named is refused, as the bridge does.
 */
export const plan = Effect.fn("SpConsumer.plan")(function* (
  baseUrl: string,
  credential: string,
  publication: Publication,
) {
  const endpoint = "GET /api/v1/consumer/resources/{resource}/publications/{publication}/bundle"
  const decoded = yield* call(Plan, {
    method: "GET",
    url: `${yield* origin(baseUrl)}/api/v1/consumer/resources/${encodeURIComponent(publication.resource_id)}/publications/${encodeURIComponent(publication.publication_id)}/bundle?host=${host}`,
    endpoint,
    bearer: credential,
    limit: 64 * 1024 * 1024,
  })
  if (
    decoded.host !== host ||
    decoded.publication_id !== publication.publication_id ||
    decoded.resource_id !== publication.resource_id ||
    decoded.revision_id !== publication.revision_id ||
    decoded.generation !== publication.generation ||
    decoded.bundle_digest !== publication.bundle_digest
  )
    return yield* new Protocol({ endpoint, message: "the plan is not the one the manifest named", status: 200 })
  const files = decoded.runtime_files.map((file) => ({
    path: file.path,
    bytes: Uint8Array.from(file.bytes),
    executable: file.executable,
  }))
  // Uint8Array.from wraps an out-of-range value silently: compare it with what came
  if (files.some((file, index) => file.bytes.some((byte, at) => byte !== decoded.runtime_files[index]?.bytes[at])))
    return yield* new Protocol({ endpoint, message: "a runtime file holds a value that is not a byte", status: 200 })
  return { ...decoded, runtime_files: files } satisfies Plan
})

/** Posts a receipt (`POST /api/v1/consumer/receipts`) with the device credential. A retry of the same one is acknowledged too. */
export const post = Effect.fn("SpConsumer.post")(function* (baseUrl: string, credential: string, receipt: Receipt) {
  return yield* call(Acknowledgement, {
    method: "POST",
    url: `${yield* origin(baseUrl)}/api/v1/consumer/receipts`,
    endpoint: "POST /api/v1/consumer/receipts",
    bearer: credential,
    body: receipt,
    limit: 1024 * 1024,
  })
})

/**
 * The bridge's `readback::verify`, from what the writer read back: every runtime file must be on disk with the plan's
 * bytes, and every canonical file must match its copy under `.systemprompt-source/<revision>/`. Returns the receipt, or
 * the path that does not hold.
 */
export function receipt(
  input: Plan,
  readback: ReadonlyArray<Readback>,
  installationId: string,
  observedAt: string,
): { readonly receipt: Receipt } | { readonly mismatch: string } {
  const read = input.runtime_files.map((file) => {
    const found = readback.find((entry) => entry.path === file.path)
    const digest = createHash("sha256").update(file.bytes).digest("hex")
    if (
      found === undefined ||
      found.content !== "verified" ||
      found.mode === "mismatch" ||
      found.digest !== digest ||
      found.bytes !== file.bytes.length ||
      found.executable !== file.executable
    )
      return undefined
    return {
      path: file.path,
      digest,
      bytes: file.bytes.length,
      executable: file.executable,
      content_check: found.content,
      mode_check: found.mode,
    }
  })
  const unread = input.runtime_files.find((_, index) => read[index] === undefined)
  if (unread) return { mismatch: unread.path }
  const runtime = read.filter((entry) => entry !== undefined)
  const copies = input.canonical_files.map((file) => {
    const copy = runtime.find((entry) => entry.path === `.systemprompt-source/${file.revision_id}/${file.path}`)
    if (
      copy === undefined ||
      copy.digest !== file.digest ||
      copy.bytes !== file.bytes ||
      copy.executable !== file.executable
    )
      return undefined
    return { ...file, content_check: copy.content_check, mode_check: copy.mode_check }
  })
  const uncopied = input.canonical_files.find((_, index) => copies[index] === undefined)
  if (uncopied) return { mismatch: `.systemprompt-source/${uncopied.revision_id}/${uncopied.path}` }
  return {
    receipt: {
      installation_id: installationId,
      publication_id: input.publication_id,
      resource_id: input.resource_id,
      revision_id: input.revision_id,
      generation: input.generation,
      bundle_digest: input.bundle_digest,
      host: input.host,
      observed_at: observedAt,
      files: copies
        .filter((entry) => entry !== undefined)
        .toSorted((a, b) => compare(`${a.revision_id}\0${a.path}`, `${b.revision_id}\0${b.path}`)),
      runtime_files: runtime.toSorted((a, b) => compare(a.path, b.path)),
    },
  }
}

/** Whether the instance counts the receipt as fully verified: every file's content, and the mode of executables. */
export function fullyVerified(input: Receipt) {
  const verified = (file: { executable: boolean; content_check: Check; mode_check: Check }) =>
    file.content_check === "verified" &&
    (file.mode_check === "verified" || (!file.executable && file.mode_check === "unavailable"))
  return input.runtime_files.length > 0 && input.runtime_files.every(verified) && input.files.every(verified)
}

function compare(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0
}

// The bridge's transport timeout: the whole answer, body included.
const timeout = Duration.seconds(20)

type Request = {
  readonly method: "GET" | "POST"
  readonly url: string
  // Method and path template only, never ids, a query or a credential
  readonly endpoint: string
  readonly bearer: string
  readonly body?: unknown
  readonly limit: number
}

const call = Effect.fnUntraced(function* <A>(schema: Schema.Decoder<A>, request: Request) {
  const endpoint = request.endpoint
  const unreachable = (message: string) => new Unreachable({ endpoint, message })
  const answer = yield* Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(request.url, {
        method: request.method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${request.bearer}`,
          ...(request.body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        // A redirect is never followed: it could carry the credential to another origin
        redirect: "manual",
        signal,
      })
      return { status: response.status, body: await bounded(response, request.limit) }
    },
    // A fixed message: a fetch error can quote request headers, and so the credential
    catch: () => unreachable("the request failed"),
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () => Effect.fail(unreachable(`no answer within ${Duration.format(timeout)}`)),
    }),
  )
  if (answer.body === undefined)
    return yield* new Protocol({ endpoint, message: "the answer is larger than allowed", status: answer.status })
  if (answer.status !== 200) return yield* failure(endpoint, answer.status, answer.body)
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(answer.body).pipe(
    Effect.mapError((error) => {
      const first = SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues[0]
      const path = (first?.path ?? []).map((segment) => String(typeof segment === "object" ? segment.key : segment))
      return new Protocol({
        endpoint,
        message: first?.message ?? error.message,
        status: 200,
        path: path.length === 0 ? undefined : path.join("."),
      })
    }),
  )
})

// The body, or undefined once it passes `limit` bytes: a plan may legitimately be large, but not unbounded.
async function bounded(response: Response, limit: number) {
  if (Number(response.headers.get("content-length") ?? 0) > limit) return undefined
  const chunks: Uint8Array[] = []
  const total = { bytes: 0 }
  for await (const chunk of response.body ?? []) {
    total.bytes += chunk.length
    if (total.bytes > limit) return undefined
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString("utf8")
}

// The consumer routes answer problem documents (`detail`); the bridge routes the platform's envelope (`message`).
const Problem = Schema.Struct({ detail: Schema.optional(Schema.String), message: Schema.optional(Schema.String) })

const failure = Effect.fnUntraced(function* (endpoint: string, status: number, body: string) {
  const problem = Schema.decodeUnknownOption(Schema.fromJsonString(Problem))(body)
  const message =
    (problem._tag === "Some" ? (problem.value.detail ?? problem.value.message) : undefined) ?? `status ${status}`
  if (status === 401) return yield* new Unauthorized({ endpoint, message })
  if (status === 429) return yield* new RateLimited({ endpoint, message })
  if (status >= 500) return yield* new Unreachable({ endpoint, message, status })
  return yield* new Protocol({ endpoint, message, status })
})

// The account's base URL as the client checks it: https, or http on loopback only.
const base = Effect.fnUntraced(function* (baseUrl: string) {
  const url = URL.canParse(baseUrl) ? new URL(baseUrl) : undefined
  const local = url !== undefined && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  if (
    url === undefined ||
    !(url.protocol === "https:" || (url.protocol === "http:" && local)) ||
    url.username !== "" ||
    url.password !== ""
  )
    return yield* new Protocol({ endpoint: "base URL", message: "the instance URL must use https unless it is local" })
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`
})

// The consumer API is rooted at the instance's origin, like the bridge's `GatewayOrigin`.
const origin = (baseUrl: string) => base(baseUrl).pipe(Effect.map((url) => new URL(url).origin))
