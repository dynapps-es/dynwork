export * as DynWorkGateway from "./gateway"

import { Model, Provider } from "@opencode/plugin/effect"
import { Effect, Option } from "effect"
import type { DynWorkSync } from "./contract"
import { DynWorkMapping } from "./mapping"

// The instance gateway as the `systemprompt` provider. Calls go to the instance's own base URL plus `/v1`, never to
// the profile's `inference_gateway_base_url`, which is the instance's internal address. The JWT is never part of the
// provider or a credential (decision T6): the `model.request` hook adds the one held in memory to each call.

export const providerID = Provider.ID.make("systemprompt")

/** The declared client kind; the instance accepts only its closed list. */
export const client = "opencode"

/** A JWT this close to its expiry is renewed before a call, like main renews before it hands one out. */
export const skew = 60_000

/** How long a model call waits for main to push a newer JWT. */
export const refreshWait = 15_000

/** The AI SDK package for each gateway route. */
export const packages = {
  messages: "@opencode/ai/providers/anthropic-compatible",
  chat: "@opencode/ai/providers/openai-compatible",
} as const

export interface Provided {
  readonly info: Provider.Info
  readonly models: ReadonlyArray<Model.Info>
  /** Where every call goes, whatever a later transform or the user's config set as the provider's base URL. */
  readonly baseURL: string
  readonly default?: string
}

/** The provider for an apply, or undefined without models or on a base URL a JWT may not travel to. */
export function provider(input: DynWorkSync.Apply): Provided | undefined {
  const gateway = input.gateway
  const url = URL.canParse(input.instance.url) ? new URL(input.instance.url) : undefined
  if (!gateway || !url || !DynWorkMapping.secure(url)) return undefined
  const allowed = families(input.manifest)
  const models = [...new Map(gateway.models.map((model) => [model.id, model])).values()].flatMap((model) => {
    const api = route(model, allowed)
    if (!api) return []
    const base = Model.Info.default(providerID, Model.ID.make(model.id))
    return [
      {
        ...base,
        name: model.name || model.id,
        package: packages[api],
        limit: { context: model.context ?? base.limit.context, output: model.output ?? base.limit.output },
      } satisfies Model.Info,
    ]
  })
  if (models.length === 0) return undefined
  const baseURL = `${url.origin}${url.pathname.replace(/\/+$/, "")}/v1`
  return {
    info: {
      id: providerID,
      name: gateway.label,
      activation: "enabled",
      package: packages.messages,
      settings: { baseURL },
    },
    models,
    baseURL,
    default: models.some((model) => model.id === gateway.default) ? gateway.default : undefined,
  }
}

/**
 * The client families the instance lets OpenCode list models for: the manifest's `host_model_protocols` entry for
 * DynWork's host (`opencode`, else `opencode-cli`), or undefined, every family DynWork can call, without one. The bridge
 * defaults to `openai` instead because its OpenCode provider speaks only Chat Completions.
 */
export function families(manifest: DynWorkSync.Manifest) {
  return manifest.host_model_protocols?.opencode ?? manifest.host_model_protocols?.["opencode-cli"]
}

// The route of a model the allowed families may list, preferring `/v1/messages`; undefined when none may. A model
// without its client families is served to the family of its route.
function route(model: DynWorkSync.Gateway["models"][number], allowed: ReadonlyArray<string> | undefined) {
  const clients = (model.clients ?? [model.api === "chat" ? "openai" : "claude"]).filter(
    (family) => allowed === undefined || allowed.includes(family),
  )
  if (clients.includes("claude")) return "messages"
  if (clients.includes("openai")) return "chat"
  return undefined
}

export interface Token {
  readonly jwt: string
  /** Epoch milliseconds. */
  readonly expiresAt: number
}

export interface Tokens {
  current: Token | undefined
  /** Model calls waiting for main to push a newer JWT. */
  readonly waiters: Set<(token: Token | undefined) => void>
  /** The JWT each Session's last call carried, so a refusal is matched to the token it refused. */
  readonly sent: Map<string, string>
  /** The JWT main minted for each Session's step after a refusal: if the gateway refuses it too, it is signed out. */
  readonly answered: Map<string, string>
  /** How long a call waits for main, in milliseconds. */
  readonly wait: number
}

export interface Events {
  readonly refresh: (reason: DynWorkSync.Refresh["reason"]) => Effect.Effect<void>
  readonly rejected: () => Effect.Effect<void>
}

export function tokens(wait = refreshWait): Tokens {
  return { current: undefined, waiters: new Set(), sent: new Map(), answered: new Map(), wait }
}

/** Holds `token` (undefined on sign-out) and wakes the calls waiting for one. */
export function push(tokens: Tokens, token: Token | undefined) {
  tokens.current = token
  if (token === undefined) {
    tokens.sent.clear()
    tokens.answered.clear()
  }
  for (const waiter of [...tokens.waiters]) waiter(token)
}

/**
 * The JWT for a Session's next call: the held one while fresh, else a newer one from main. An expired JWT is never
 * sent: without a fresh one the call goes without, the gateway refuses it, and `refused` decides.
 */
export const authorize = Effect.fnUntraced(function* (tokens: Tokens, events: Events, sessionID: string) {
  const held = tokens.current
  const token =
    held === undefined || held.expiresAt - skew > Date.now()
      ? held
      : // No newer JWT in time: the held one while it lasts, unless a sign-out or switch cleared it meanwhile
        ((yield* renew(tokens, events, held, "expired")) ?? (tokens.current === held ? held : undefined))
  const jwt = token !== undefined && token.expiresAt > Date.now() ? token.jwt : undefined
  remember(tokens.sent, sessionID, jwt)
  return jwt
})

/**
 * After the gateway refused a Session's call (401): true when the call may run once more with a newer JWT. A step's
 * first refusal asks main for another JWT; a refusal of that one marks the instance signed out and gives up. `first`
 * is true on the step's first failed attempt.
 */
export const refused = Effect.fnUntraced(function* (tokens: Tokens, events: Events, sessionID: string, first: boolean) {
  const used = tokens.sent.get(sessionID)
  const answered = tokens.answered.get(sessionID)
  tokens.sent.delete(sessionID)
  tokens.answered.delete(sessionID)
  const held = tokens.current
  if (held === undefined) return false
  // Main renewed the JWT while the call was out, or one arrived after a call that went without.
  if (used !== held.jwt) return held.expiresAt > Date.now()
  if (!first && answered === used) {
    push(tokens, undefined)
    yield* events.rejected()
    return false
  }
  const next = yield* renew(tokens, events, held, "rejected")
  if (next === undefined) return false
  remember(tokens.answered, sessionID, next.jwt)
  return true
})

// Sessions that never come back would keep their entry: only the most recent ones are kept.
const remembered = 256

function remember(map: Map<string, string>, sessionID: string, jwt: string | undefined) {
  map.delete(sessionID)
  if (jwt !== undefined) map.set(sessionID, jwt)
  if (map.size > remembered) map.delete(map.keys().next().value ?? "")
}

// Asks main for a JWT other than `old` and waits for it; undefined when none comes in time or the instance is cleared.
// Calls that wait together share one request.
const renew = Effect.fnUntraced(function* (
  tokens: Tokens,
  events: Events,
  old: Token,
  reason: DynWorkSync.Refresh["reason"],
) {
  const asked = tokens.waiters.size > 0
  // Registered before main is asked, so an answer that arrives at once is not missed.
  const pending = Promise.withResolvers<Token | undefined>()
  const waiter = (token: Token | undefined) => {
    if (token !== undefined && token.jwt === old.jwt) return
    tokens.waiters.delete(waiter)
    pending.resolve(token)
  }
  tokens.waiters.add(waiter)
  if (!asked) yield* events.refresh(reason)
  return yield* Effect.promise(() => pending.promise).pipe(
    Effect.timeoutOption(tokens.wait),
    Effect.map(Option.getOrUndefined),
    Effect.ensuring(Effect.sync(() => tokens.waiters.delete(waiter))),
  )
})
