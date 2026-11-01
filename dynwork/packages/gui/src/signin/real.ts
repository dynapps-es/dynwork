export * as SignInReal from "./real"

import type { Client } from "../accounts/renderer"
import { SignInAccounts } from "./accounts"

// The part of the Ipc client the screen calls.
export type Accounts = Pick<
  Client,
  "probe" | "signInBrowser" | "signInToken" | "cancel" | "list" | "summary" | "activate"
>

// The screen's remote side over the `dynwork.accounts` Ipc. No call rejects: a failed Ipc call reads as a failed
// sign-in, an unreachable instance or empty counts, so the flow never waits on a promise that will not settle.
export function create(accounts: Accounts): SignInAccounts.Interface {
  return {
    probe: async (url) => {
      if (!SignInAccounts.parseURL(url)) return { reachable: false, reason: "format" }
      const probe = await accounts.probe(url).catch(() => undefined)

      if (probe === undefined) return { reachable: false, reason: "unreachable" }

      if (probe.reachable) return { reachable: true, host: probe.host, login: probe.deviceLink }

      return { reachable: false, reason: probe.reason === "Unreachable" ? "unreachable" : "incompatible" }
    },
    signInBrowser: (url, keep) => accounts.signInBrowser({ url, keep }).catch(() => "failed" as const),
    signInToken: (url, token, keep) => accounts.signInToken({ url, token, keep }).catch(() => "failed" as const),
    cancel: () => void accounts.cancel().catch(() => undefined),
    // The accounts signed in, the active one first: it is the one that was just signed in when the screen shows.
    instances: async () => {
      const signedIn = (await accounts.list().catch(() => [])).filter((account) => account.status === "signedIn")

      return Promise.all(
        signedIn
          .toSorted((a, b) => Number(b.active) - Number(a.active))
          .map(async (account) => {
            const summary = await accounts.summary(account.id).catch(() => undefined)

            return {
              id: account.id,
              name: account.label,
              host: new URL(account.url).host,
              role: summary?.role,
              skills: summary?.skills ?? 0,
              agents: summary?.agents ?? 0,
              servers: summary?.servers ?? 0,
            }
          }),
      )
    },
    finish: async (instance, progress) => {
      await accounts.activate(instance.id).catch(() => undefined)
      // STUB until phase 12 (live sync) reports the first sync: walk the skill count quickly so the state shows.
      for (const synced of Array.from({ length: instance.skills }, (_, index) => index + 1)) {
        await new Promise<void>((resolve) => setTimeout(resolve, 800 / instance.skills))
        progress(synced)
      }
    },
  }
}
