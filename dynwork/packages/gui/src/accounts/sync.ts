export * as DynWorkSyncMain from "./sync"

import type { ServerEndpoints } from "@opencode/plugin/gui/main"
import type { Catalog, Manifest, Profile } from "@dynwork/sp-client"
import { DynWorkSyncClient } from "@dynwork/server-plugin/client"
import { DynWorkSync } from "@dynwork/server-plugin/contract"
import { Schema } from "effect"

// Main's side of the server plugin: pushes the active account's verified manifest, gateway models and JWT to
// DynWork's own service (the "sidecar" endpoint, whose headers carry the service password), pushes each renewed JWT,
// follows the plugin's requests for one, and clears it all on sign-out. The sync engine decides when; this only speaks
// the RPC.

interface Account {
  readonly label: string
  readonly url: string
}

export function make(endpoints: ServerEndpoints) {
  const client = DynWorkSyncClient.make(() => endpoints.get("sidecar"))
  return {
    apply: (input: {
      readonly account: Account
      readonly manifest: Manifest
      readonly jwt: string
      readonly expiresAt: number
      /** Without a profile the service gets no `systemprompt` provider. */
      readonly profile?: Profile
      readonly catalog?: Catalog
      /** The plugin bundle files the plugin projects, fetched by main; the plugin checks them against the manifest. */
      readonly files?: ReadonlyArray<DynWorkSync.BundleFile>
    }) =>
      client.apply({
        instance: instance(input.account),
        manifest: input.manifest,
        jwt: input.jwt,
        expiresAt: input.expiresAt,
        ...(input.profile ? { gateway: gateway(input.account.label, input.profile, input.catalog) } : {}),
        ...(input.files ? { files: input.files } : {}),
      }),
    /** Pushes a renewed JWT; false when the service holds another instance. */
    token: (input: { readonly account: Account; readonly jwt: string; readonly expiresAt: number }) =>
      client.token({ instance: instance(input.account), jwt: input.jwt, expiresAt: input.expiresAt }),
    clear: client.clear,
    /**
     * Follows the plugin's events until `signal` aborts or the service closes the stream. On `refresh` with reason
     * `rejected` the gateway refused the JWT the plugin holds, so main mints a new one instead of handing out its
     * cached JWT; on `rejected` the new one was refused too.
     */
    listen: client.listen,
  }
}

const instance = (account: Account) => ({ key: key(account.label), url: account.url })

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

/**
 * The gateway models for the plugin: the ids `profile` admits for the user, named and sized from the `models`
 * catalog, each with the route its provider is served on and the client families it is served to, which the plugin
 * filters by the manifest's `host_model_protocols`. A provider the instance has not configured is left out,
 * and so is any entry the plugin's contract would refuse, so one odd model never fails the whole apply.
 */
export function gateway(label: string, profile: Profile, catalog: Catalog = []): DynWorkSync.Gateway {
  const named = new Map(catalog.map((model) => [model.id, model]))
  const models = [...new Set(profile.models)].flatMap((id) => {
    // A provider the instance configured wins over one listed earlier that it has not
    const serving = profile.providers?.filter((entry) => entry.models?.includes(id)) ?? []
    const provider = serving.find((entry) => entry.configured !== false) ?? serving[0]
    if (provider?.configured === false) return []
    const api = route(provider?.clients)
    const entry = named.get(id)
    const limits = profile.model_limits?.[id]
    const model = decodeModel({
      id,
      api,
      ...(provider?.clients ? { clients: provider.clients } : {}),
      ...(entry?.display_name ? { name: entry.display_name } : {}),
      ...size("context", [limits?.context_window, entry?.max_input_tokens]),
      ...size("output", [limits?.max_output_tokens, entry?.max_tokens]),
    })
    return model._tag === "Some" ? [model.value] : []
  })
  // `default_model` may carry a context-window suffix such as `[1m]`, which is not part of the id.
  const suggested = profile.default_model?.replace(/\[[^\]]*\]$/, "")
  return {
    label: label.trim().slice(0, 120) || "systemprompt",
    models,
    ...(suggested && models.some((model) => model.id === suggested) ? { default: suggested } : {}),
  }
}

const decodeModel = Schema.decodeUnknownOption(DynWorkSync.GatewayModel)

// The instance's `/v1/models` catalog is Anthropic-shaped: a model whose provider declares no client kinds is served
// on `/v1/messages`.
function route(clients: ReadonlyArray<string> | undefined) {
  if (clients === undefined || clients.includes("claude")) return "messages"
  if (clients.includes("openai")) return "chat"
  return undefined
}

// The first valid size: a profile limit that is not one does not hide the catalog's.
function size(name: "context" | "output", values: ReadonlyArray<number | undefined>) {
  const value = values.find((entry) => entry !== undefined && Number.isInteger(entry) && entry > 0)
  return value === undefined ? {} : { [name]: value }
}
