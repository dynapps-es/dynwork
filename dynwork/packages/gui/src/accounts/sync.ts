export * as DynWorkSyncMain from "./sync"

import type { ServerEndpoints } from "@opencode/plugin/gui/main"
import type { Manifest } from "@dynwork/sp-client"
import { DynWorkSyncClient } from "@dynwork/server-plugin/client"

// Main's side of the server plugin: pushes the active account's verified manifest and JWT to DynWork's own service
// (the "sidecar" endpoint, whose headers carry the service password), and clears it on sign-out. The sync engine
// decides when; this only speaks the RPC.

export function make(endpoints: ServerEndpoints) {
  const client = DynWorkSyncClient.make(() => endpoints.get("sidecar"))
  return {
    apply: (input: {
      readonly account: { readonly label: string; readonly url: string }
      readonly manifest: Manifest
      readonly jwt: string
      readonly expiresAt: number
    }) =>
      client.apply({
        instance: { key: key(input.account.label), url: input.account.url },
        manifest: input.manifest,
        jwt: input.jwt,
        expiresAt: input.expiresAt,
      }),
    clear: client.clear,
  }
}

/**
 * The prefix of the instance's ids in the service, from its label: lowercase, dashes, at most 24 characters. Only one
 * instance is active at a time, so two instances with the same label never clash; the prefix keeps instance content
 * apart from the user's own skills, agents and MCP servers.
 */
export function key(label: string) {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 24)
    .replace(/-+$/, "")
  return slug || "sp"
}
