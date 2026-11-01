export * as DynWorkHeartbeat from "./heartbeat"

import { Effect } from "effect"
import { SpClient, SpConsumer } from "@dynwork/sp-client"
import type { DynWorkSync } from "@dynwork/server-plugin/contract"
import { DynWorkAccounts } from "../accounts/accounts"
import type { DynWorkSyncMain } from "../accounts/sync"

// The systemprompt bridge's heartbeat (`proxy/heartbeat/mod.rs`): every 30 seconds while the active account is signed
// in, `POST /v1/bridge/heartbeat` with its JWT, naming the session the JWT was minted for (the instance refuses any
// other), so the instance lists this device as online. The totals the bridge's proxy counts come from DynWork's own
// service, where the model calls are (`DynWorkUsage`). Like the bridge, it pauses while nobody is signed in, warns
// once when it starts failing and once when the instance reports this version as unsupported, and never retries
// faster than its pace.

export const interval = 30_000

export type Options = {
  accounts: Pick<DynWorkAccounts.Accounts, "active" | "list" | "stored" | "session">
  plugin: Pick<ReturnType<typeof DynWorkSyncMain.make>, "usage">
  /** DynWork's own version, the `release_version`. */
  version: string
  hostname: string
  platform: NodeJS.Platform
  log: (level: "info" | "warn", message: string, data?: Record<string, unknown>) => void
}

export function make(options: Options) {
  const accounts = options.accounts
  const log = options.log
  const life = {
    disposed: false,
    running: false,
    paused: false,
    failing: false,
    // The last unsupported answer warned about, so an unchanged one is not repeated every 30 seconds
    answer: "",
    // What the service last counted for the account: a service that does not answer reports it again
    last: undefined as { id: string; usage: DynWorkSync.Usage } | undefined,
  }

  const send = async (id: string) => {
    const stored = accounts.stored(id)
    if (stored === undefined) return
    const account = { label: stored.label, url: stored.url }
    const usage = await options.plugin
      .usage({ account })
      .catch(() => (life.last?.id === id ? life.last.usage : { forwarded: 0, tokens_in: 0, tokens_out: 0 }))
    life.last = { id, usage }
    const post = async (fresh: boolean) => {
      const session = await accounts.session(id, fresh)
      if (session.sessionId === undefined)
        throw new SpClient.Protocol({ endpoint: "POST /v1/auth/bridge/pat", message: "the JWT came without a session" })
      return Effect.runPromise(
        SpConsumer.heartbeat(stored.url, session.token, {
          session_id: session.sessionId,
          bridge_version: SpConsumer.bridgeVersion,
          os: os(options.platform),
          hostname: options.hostname.trim() || "unknown",
          last_activity_at: usage.last_activity === undefined ? null : new Date(usage.last_activity).toISOString(),
          forwarded_total: usage.forwarded,
          tokens_in_total: usage.tokens_in,
          tokens_out_total: usage.tokens_out,
          release_version: options.version,
          state: "active",
        }),
      )
    }
    // A refused JWT is minted again once, as for every other call with it
    const answer = await post(false).catch((error) => {
      if (error instanceof SpClient.Unauthorized) return post(true)
      throw error
    })
    const unsupported = !answer.compatible || answer.window_status === "below" || answer.window_status === "above"
    const seen = unsupported ? JSON.stringify(answer) : ""
    if (seen !== "" && seen !== life.answer)
      log("warn", "systemprompt reports this DynWork as outside the versions it supports", {
        bridgeVersion: SpConsumer.bridgeVersion,
        release: options.version,
        minimum: answer.min_bridge_version,
        window: answer.window_status,
      })
    life.answer = seen
  }

  const tick = async () => {
    if (life.disposed || life.running) return
    const id = accounts.active()
    if (id === undefined || accounts.list().find((account) => account.id === id)?.status !== "signedIn") {
      if (!life.paused) log("info", "systemprompt heartbeat paused until an account is signed in")
      life.paused = true
      return
    }
    life.paused = false
    life.running = true
    await send(id).then(
      () => {
        if (life.failing) log("info", "systemprompt heartbeat recovered")
        life.failing = false
      },
      (error: unknown) => {
        // Signed out while the tick ran: the next one pauses
        if (error instanceof DynWorkAccounts.NotSignedIn) return
        if (!life.failing) log("warn", "systemprompt heartbeat failed", { error: describe(error) })
        life.failing = true
      },
    )
    life.running = false
  }

  // Like the bridge's interval, the first heartbeat goes one interval after start
  const timer = setInterval(() => void tick(), interval)
  return {
    tick,
    dispose: () => {
      life.disposed = true
      clearInterval(timer)
    },
  }
}

export type Heartbeat = ReturnType<typeof make>

// The bridge's `std::env::consts::OS`
function os(platform: NodeJS.Platform) {
  if (platform === "darwin") return "macos"
  if (platform === "win32") return "windows"
  return platform
}

// The error's tag and fixed message: SpClient errors never carry a credential.
function describe(error: unknown) {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}
