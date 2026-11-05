export * as DynWorkUsage from "./usage"

import type { DynWorkSync } from "./contract"

// The totals the systemprompt bridge's heartbeat reports (`proxy/heartbeat/mod.rs`), counted where DynWork's model
// calls are: the bridge's proxy counts every request it forwards (`forwarded_total`), the tokens of the answers
// (`tokens_in_total`, `tokens_out_total`) and the time of the last successful one (`last_activity_at`). DynWork has no
// proxy, so the plugin counts each call to the instance's gateway and the tokens OpenCode records for its steps. They
// count from the moment the instance is applied, and start again for another instance, as a new bridge session does.

export interface Usage {
  /** The instance counted, by key and URL. */
  readonly instance: string
  forwarded: number
  tokensIn: number
  tokensOut: number
  lastActivity: number | undefined
}

export const id = (instance: DynWorkSync.Instance) => `${instance.key}\u001f${instance.url}`

export const start = (instance: DynWorkSync.Instance): Usage => ({
  instance: id(instance),
  forwarded: 0,
  tokensIn: 0,
  tokensOut: 0,
  lastActivity: undefined,
})

/** One answer of the gateway; a successful one is the latest activity. */
export function call(usage: Usage, ok: boolean, now: number) {
  usage.forwarded += 1
  if (ok) usage.lastActivity = now
}

/**
 * The tokens of one step. OpenCode keeps uncached input apart from cache reads and writes, and reasoning apart from
 * output: the gateway's OpenAI-shaped answer counts them together.
 */
export function tokens(
  usage: Usage,
  input: {
    readonly input: number
    readonly output: number
    readonly reasoning: number
    readonly cache: { readonly read: number; readonly write: number }
  },
) {
  usage.tokensIn += input.input + input.cache.read + input.cache.write
  usage.tokensOut += input.output + input.reasoning
}

/** The totals for `instance`: zeros for an instance that is not the one counted. */
export function report(usage: Usage | undefined, instance: DynWorkSync.Instance): DynWorkSync.Usage {
  if (usage === undefined || usage.instance !== id(instance)) return { forwarded: 0, tokens_in: 0, tokens_out: 0 }
  return {
    forwarded: usage.forwarded,
    tokens_in: usage.tokensIn,
    tokens_out: usage.tokensOut,
    ...(usage.lastActivity === undefined ? {} : { last_activity: usage.lastActivity }),
  }
}
