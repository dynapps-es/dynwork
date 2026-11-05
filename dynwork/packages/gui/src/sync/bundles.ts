export * as DynWorkBundleFiles from "./bundles"

import { createHash } from "node:crypto"
import { Effect } from "effect"
import { SpClient, SpPlugins } from "@dynwork/sp-client"
import { DynWorkBundles } from "@dynwork/server-plugin/bundles"
import type { DynWorkSync } from "@dynwork/server-plugin/contract"
import type { DynWorkAccounts } from "../accounts/accounts"

// The plugin bundle files the server plugin projects for OpenCode (agents, OpenCode plugins, pinned themes), fetched
// for it with the account's JWT, which only main holds: `GET /v1/bridge/plugins/{plugin}/{path}`, as the systemprompt
// bridge downloads them. Main hands the bytes on as they came; the plugin writes only those that have the SHA-256 the
// signed manifest gives them.

export function make(accounts: Pick<DynWorkAccounts.Accounts, "withJwt">) {
  // What was fetched at the manifest's digest, in base64 by digest: an unchanged file is not downloaded again.
  const held = new Map<string, string>()
  return {
    /**
     * The files `DynWorkBundles.wanted` lists for `manifest`. One the instance does not serve is left out, for the
     * plugin to report; a transport failure rejects, so the sync is tried again.
     */
    fetch: async (account: { readonly id: string; readonly url: string }, manifest: DynWorkSync.Manifest) => {
      const wanted = DynWorkBundles.wanted(manifest)
      const fetched = await Promise.all(
        wanted.map(async (file): Promise<DynWorkSync.BundleFile[]> => {
          const kept = held.get(file.sha256)
          if (kept !== undefined) return [{ plugin: file.plugin, path: file.path, content: kept }]
          const bytes = await accounts
            .withJwt(account.id, (token) =>
              Effect.runPromise(SpPlugins.file(account.url, token, file.plugin, file.path)),
            )
            .catch((error: unknown) => {
              if (error instanceof SpClient.Protocol) return undefined
              throw error
            })
          if (bytes === undefined) return []
          const content = Buffer.from(bytes).toString("base64")
          if (createHash("sha256").update(bytes).digest("hex") === file.sha256) held.set(file.sha256, content)
          return [{ plugin: file.plugin, path: file.path, content }]
        }),
      )
      const digests = new Set(wanted.map((file) => file.sha256))
      ;[...held.keys()].filter((digest) => !digests.has(digest)).forEach((digest) => held.delete(digest))
      return fetched.flat()
    },
  }
}
