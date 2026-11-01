export * as DynWorkTelemetry from "./telemetry"

import { createHash } from "node:crypto"
import { Option, Schema } from "effect"
import type { DynWorkSync } from "./contract"
import { DynWorkMapping } from "./mapping"
import { DynWorkSkills } from "./skills"

// The governance events of the systemprompt bridge's `systemprompt-hooks.js` (`integration/opencode/managed_resources`),
// sent from the service straight to the instance instead of through the bridge's loopback proxy. Same events, same
// bodies, same `plugin_id`; the hook token the proxy would mint (`auth/plugin_oauth`) is minted here with the user's JWT,
// and the session the proxy moves into `metadata.user_id` (`proxy/forward/body.rs`) is put there here. Nothing is
// retried or queued: like the bridge's plugin, a failed event is dropped and never holds up a step.

/** The bridge's `OPENCODE_SESSION_NAMESPACE`: both sides derive the same v5 UUID from a native `ses_…` id. */
export const namespace = "7c1f5b6e-3a2d-4e8f-9b0c-2d6a1e4f8c73"

export const host = "opencode"

/**
 * The host as the bridge's proxy stamps it beside the device credential: the evaluator client kind, which is what the
 * instance checks the device against (0.76 answers `opencode` there with 400 "Invalid device host").
 */
export const client = "open-code"

/** Every call to the instance gives up after this long, like the bridge's plugin. */
export const timeout = 5_000

/** A hook token this close to its expiry is minted again, like the bridge's proxy. */
export const refresh = 300_000

/** The instance, the plugin whose governance events these are, and the skill map, for an applied manifest. */
export interface Target {
  readonly base: string
  readonly plugin: string
  /** Skill directory to `<owner plugin>:<directory>`, the bridge's `skill_map`. */
  readonly skills: Readonly<Record<string, string>>
}

export interface Hooks {
  /** The instance's per-user hook client (`/v1/auth/bridge/oauth-client`), held in memory only. */
  client?: { readonly base: string; readonly id: string; readonly secret: string; readonly endpoint: string }
  /** Hook tokens by instance and plugin. */
  readonly tokens: Map<string, { readonly token: string; readonly expiresAt: number }>
}

export function hooks(): Hooks {
  return { tokens: new Map() }
}

/** The RFC 4122 v5 UUID of a native session id under `namespace`, as the bridge's plugin and proxy derive it. */
export function session(native: string) {
  const digest = createHash("sha1")
    .update(Buffer.from(namespace.replace(/-/g, ""), "hex"))
    .update(native)
    .digest()
    .subarray(0, 16)
  digest[6] = (digest[6]! & 0x0f) | 0x50
  digest[8] = (digest[8]! & 0x3f) | 0x80
  const hex = digest.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Where an apply's events go, or undefined when none are sent: no manifest plugin owns governance (the bridge then
 * removes its hooks plugin), OpenCode is not an enabled host, or the instance URL may not receive the JWT.
 */
export function target(input: DynWorkSync.Apply): Target | undefined {
  const plugin = input.manifest.plugins?.find((entry) => entry.hooks?.governance)
  const url = URL.canParse(input.instance.url) ? new URL(input.instance.url) : undefined
  if (!plugin || !url || !DynWorkMapping.secure(url)) return undefined
  if (!input.manifest.enabled_hosts?.some((entry) => entry === "opencode" || entry === "opencode-cli")) return undefined
  return {
    base: `${url.origin}${url.pathname.replace(/\/+$/, "")}`,
    plugin: plugin.id,
    skills: Object.fromEntries(
      input.manifest.skills
        .filter((skill) => !skill.hosts?.length || skill.hosts.some((entry) => entry.startsWith("opencode")))
        .map((skill) => {
          const dir = DynWorkSkills.kebab(skill.id)
          return [dir, `${skill.plugins?.[0] ?? host}:${dir}`]
        }),
    ),
  }
}

/**
 * Posts one event for `target`'s plugin. Never rejects: any failure drops the event, like the bridge's plugin. With the
 * device credential main enrolled, the call carries it as the bridge's proxy forwards a hook (`feedback/hooks.rs`).
 */
export async function send(
  hooks: Hooks,
  target: Target,
  jwt: string,
  body: Record<string, unknown>,
  device?: string,
) {
  const token = await hookToken(hooks, target, jwt).catch(() => undefined)
  if (!token) return
  const id = body.tool_use_id ?? body.prompt_id ?? body.event_id
  await fetch(`${target.base}/api/public/hooks/track?plugin_id=${encodeURIComponent(target.plugin)}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(device ? { "x-systemprompt-device-credential": device, "x-systemprompt-host": client } : { "x-systemprompt-host": host }),
      // The bridge's proxy gives an event without its own id a fresh one, so the instance can deduplicate retries.
      "x-ingestion-event-id": String(id ?? crypto.randomUUID()),
    },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(timeout),
  })
    .then((response) => response.body?.cancel())
    .catch(() => undefined)
}

/** OpenCode's session events, in the hook vocabulary Claude Code speaks, as the bridge's plugin translates them. */
const lifecycles: Record<string, string> = {
  "session.created": "SessionStart",
  "session.idle": "Stop",
  "session.deleted": "SessionEnd",
}

export function lifecycle(type: string, native: string, cwd: string, eventID: string) {
  const name = lifecycles[type]
  if (!name) return undefined
  return {
    hook_event_name: name,
    session_id: session(native),
    native_session_id: native,
    cwd,
    native_host: host,
    event_id: eventID,
  }
}

interface Message {
  readonly id?: string
  readonly role: string
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string | null }>
}

/**
 * The prompt of the latest user message, or undefined when it was already reported: the context hook runs before every
 * step, so the bridge reports a prompt only when the latest user message differs from the one it last reported.
 */
export function prompt(messages: ReadonlyArray<Message>, native: string, cwd: string, last: Map<string, string>) {
  const index = messages.findLastIndex((message) => message.role === "user")
  const latest = messages[index]
  if (!latest) return undefined
  const text = latest.content.flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : [])).join("\n")
  if (!text.trim()) return undefined
  const key = `${index}:${text}`
  if (last.get(native) === key) return undefined
  last.set(native, key)
  return {
    hook_event_name: "UserPromptSubmit",
    session_id: session(native),
    native_session_id: native,
    cwd,
    prompt: text,
    prompt_id: latest.id ?? crypto.randomUUID(),
    native_host: host,
  }
}

interface ToolEvent {
  readonly tool: string
  readonly sessionID: string
  readonly id: string
  readonly input: unknown
  readonly status: "completed" | "error"
  readonly result?: { readonly title?: string; readonly output?: unknown; readonly metadata?: unknown }
  readonly error?: { readonly message?: string }
}

/**
 * Every tool completion with its whole output, as the bridge reports it (the instance bounds and stores it). OpenCode 2's
 * skill tool takes `{ id }`, which the bridge's template, reading `name`, never sees; the id is reported as its `name`.
 */
export function tool(event: ToolEvent, skills: Target["skills"], cwd: string) {
  const args: Record<string, unknown> =
    typeof event.input === "object" && event.input !== null ? { ...event.input } : {}
  const skill = event.tool === "skill"
  const name = [args.id, args.name].find((value) => typeof value === "string") ?? ""
  if (!event.tool || (skill && !name)) return undefined
  const result = event.status === "completed" ? (event.result ?? {}) : {}
  const output =
    event.status === "error"
      ? String(event.error?.message ?? "")
      : result.output === undefined
        ? ""
        : typeof result.output === "string"
          ? result.output
          : JSON.stringify(result.output)
  return {
    hook_event_name: "PostToolUse",
    session_id: session(event.sessionID),
    native_session_id: event.sessionID,
    cwd,
    tool_name: event.tool,
    tool_input: skill ? { name } : args,
    tool_use_id: event.id,
    tool_response: { title: result.title, output, metadata: result.metadata },
    native_host: host,
    ...(skill ? { skill_ref: skills[name] ?? `${host}:${name}` } : {}),
  }
}

/**
 * A model call with the session in `metadata.user_id`, where the bridge's proxy puts the plugin's `x-opencode-session`
 * so the gateway lands the call on the hook events' context; that header is dropped, as the proxy drops it. A body that
 * is not a JSON object, or already names a `user_id`, goes as it is.
 */
export async function stamp(request: Request, native: string) {
  const headers = new Headers(request.headers)
  headers.delete("x-opencode-session")
  const text = await request.clone().text()
  const body = parse(text)
  const metadata = body?.metadata ?? {}
  if (!body || typeof metadata !== "object" || metadata === null || "user_id" in metadata)
    return new Request(request, { headers })
  return new Request(request, {
    headers,
    body: JSON.stringify({ ...body, metadata: { ...metadata, user_id: JSON.stringify({ session_id: session(native) }) } }),
  })
}

const parse = (text: string) =>
  Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(text),
  )

// The plugin's hook token, minted with the instance's per-user hook client like the bridge's proxy: provisioned with the
// user's JWT when there is none, and provisioned again once when the instance refuses its secret (another client of
// the same user rotated it). The token goes only to the instance's own origin.
async function hookToken(hooks: Hooks, target: Target, jwt: string) {
  const key = `${target.base}\u001f${target.plugin}`
  const held = hooks.tokens.get(key)
  if (held && held.expiresAt - refresh > Date.now()) return held.token
  const client = hooks.client?.base === target.base ? hooks.client : await provision(hooks, target.base, jwt)
  const first = await mint(client, target.plugin)
  const minted = first.status === 401 ? await mint(await provision(hooks, target.base, jwt), target.plugin) : first
  if (!minted.ok) return undefined
  const body: { access_token?: unknown; expires_in?: unknown } = await minted.json()
  if (typeof body.access_token !== "string" || typeof body.expires_in !== "number") return undefined
  hooks.tokens.set(key, { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 })
  return body.access_token
}

async function provision(hooks: Hooks, base: string, jwt: string) {
  const response = await fetch(`${base}/v1/auth/bridge/oauth-client`, {
    method: "POST",
    headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
    body: "{}",
    redirect: "error",
    signal: AbortSignal.timeout(timeout),
  })
  if (!response.ok) throw new Error(`oauth-client ${response.status}`)
  const body: { client_id?: unknown; client_secret?: unknown; token_endpoint?: unknown } = await response.json()
  if (typeof body.client_id !== "string" || typeof body.client_secret !== "string") throw new Error("oauth-client body")
  // The advertised endpoint is used only on the instance's own origin; any other address gets its path on that origin,
  // like the bridge re-points a loopback one, so the secret never leaves for another host.
  const advertised =
    typeof body.token_endpoint === "string" && URL.canParse(body.token_endpoint) ? new URL(body.token_endpoint) : undefined
  const origin = new URL(base).origin
  const endpoint =
    advertised?.origin === origin
      ? advertised.href
      : `${origin}${advertised?.pathname ?? "/api/v1/core/oauth/token"}`
  hooks.client = { base, id: body.client_id, secret: body.client_secret, endpoint }
  return hooks.client
}

function mint(client: NonNullable<Hooks["client"]>, plugin: string) {
  return fetch(client.endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: client.id,
      client_secret: client.secret,
      scope: "hook:govern hook:track",
      audience: "hook",
      plugin_id: plugin,
    }),
    redirect: "error",
    signal: AbortSignal.timeout(timeout),
  })
}
