export * as DynWorkMapping from "./mapping"

import { createHash } from "node:crypto"
import { Mcp, Skill } from "@opencode/plugin/effect"
import { Option, Schema } from "effect"
import type { DynWorkSync } from "./contract"

// Turns an instance manifest into what the plugin's transforms add (decision D8). Pure and total: an entry the
// service could not take is left out instead of failing, because a transform that throws disables the whole plugin.

/** OpenCode reads at most this much of the managed rules block, like the instance's own AGENTS.md projection. */
export const rulesBudget = 24_000

/** The hosts an entry may target for DynWork to apply it. */
const hosts = ["opencode", "opencode-cli"]

export interface Agent {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly system?: string
  /** Instance agents are sub-agents; the one `cli_defaults` names is also selectable as the primary agent. */
  readonly mode: "subagent" | "all"
}

export interface Mapped {
  readonly skills: ReadonlyArray<Skill.Info>
  readonly agents: ReadonlyArray<Agent>
  readonly mcp: ReadonlyArray<readonly [string, Mcp.ServerConfig]>
  /** How many rules the system text carries. */
  readonly rules: number
  /** The rules as one system part, or undefined without rules. */
  readonly system?: string
  readonly defaults: {
    readonly agent?: string
    readonly model?: { readonly providerID: string; readonly modelID: string }
  }
}

export const empty: Mapped = { skills: [], agents: [], mcp: [], rules: 0, defaults: {} }

export function map(input: DynWorkSync.Apply): Mapped {
  const manifest = input.manifest
  if (manifest.enabled_hosts !== undefined && !manifest.enabled_hosts.some((host) => hosts.includes(host))) return empty
  const key = input.instance.key
  const name = (id: string) => `${key}-${id}`
  const settings = cliDefaults(manifest)
  const defaultAgent = unique(manifest.agents).find(
    (agent) => agent.enabled !== false && (agent.id === settings.agent || agent.name === settings.agent),
  )
  const rules = unique(manifest.rules)
    .filter((rule) => applies(rule.hosts) && rule.instructions?.trim())
    .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return {
    skills: unique(manifest.skills)
      .filter((skill) => applies(skill.hosts) && skill.instructions?.trim())
      .flatMap((skill) =>
        Option.toArray(
          decodeSkill({
            id: name(skill.id),
            name: skill.name,
            ...(skill.description ? { description: skill.description } : {}),
            path: `dynwork://${key}/skills/${skill.id}`,
            content: skill.instructions,
          }),
        ),
      ),
    agents: unique(manifest.agents)
      .filter((agent) => agent.enabled !== false)
      .map((agent) => ({
        id: name(agent.id),
        name: agent.display_name || agent.name,
        description: agent.description,
        system: agent.system_prompt,
        mode: agent.id === defaultAgent?.id ? "all" : "subagent",
      })),
    mcp: unique(manifest.managed_mcp_servers).flatMap((server) =>
      Option.toArray(remote(server, input)).map((config) => [serverName(key, server.id), config] as const),
    ),
    rules: rules.length,
    system: rules.length === 0 ? undefined : rulesText(rules.map((rule) => rule.instructions?.trim() ?? "")),
    defaults: {
      agent: defaultAgent ? name(defaultAgent.id) : undefined,
      model: settings.model,
    },
  }
}

// OpenCode names an MCP tool `<server>_<tool>`, and providers cap tool names at 64 characters: a long server name is
// cut and made unique again with a short hash of the full one.
const serverLimit = 32

function serverName(key: string, id: string) {
  const full = `${key}-${id}`
  if (full.length <= serverLimit) return full
  return `${full.slice(0, serverLimit - 7)}-${createHash("sha256").update(full).digest("hex").slice(0, 6)}`
}

/** Ids become OpenCode ids, a virtual path and part of MCP tool names: anything else is skipped. */
const safeID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function unique<T extends { readonly id: string }>(entries: ReadonlyArray<T>) {
  return [...new Map(entries.filter((entry) => safeID.test(entry.id)).map((entry) => [entry.id, entry])).values()]
}

function applies(targets: ReadonlyArray<string> | undefined) {
  return targets === undefined || targets.length === 0 || targets.some((host) => hosts.includes(host))
}

const decodeSkill = Schema.decodeUnknownOption(Skill.Info)
const decodeRemote = Schema.decodeUnknownOption(Mcp.ServerConfig)

// The JWT authenticates the user on their instance, so it only goes to MCP servers on the instance's own origin
// (the instance proxies connector and externally authenticated servers through it). Any other server gets only the
// headers the manifest declares, and like the protocol client, plain HTTP only reaches loopback.
function remote(server: DynWorkSync.Manifest["managed_mcp_servers"][number], input: DynWorkSync.Apply) {
  const url = URL.canParse(server.url) ? new URL(server.url) : undefined
  if (!url || !secure(url)) return Option.none()
  const origin = URL.canParse(input.instance.url) ? new URL(input.instance.url).origin : undefined
  const declared = Object.entries(server.headers ?? {}).filter((entry) => entry[0].toLowerCase() !== "authorization")
  const headers = Object.fromEntries(
    url.origin === origin ? [...declared, ["Authorization", `Bearer ${input.jwt}`]] : declared,
  )
  return decodeRemote({ type: "remote", url: url.href, headers, oauth: false })
}

/** Plain HTTP only reaches loopback, so a JWT never travels in clear text to a remote host. */
export function secure(url: URL) {
  if (url.protocol === "https:") return true
  return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
}

function rulesText(rules: ReadonlyArray<string>) {
  const text = ["# Rules from your systemprompt instance", ...rules].join("\n\n")
  return text.length <= rulesBudget ? text : text.slice(0, rulesBudget)
}

// `cli_defaults` is the free-form settings map of a marketplace's `opencode` block. DynWork reads the default agent
// (`default_agent`, an instance agent id or name) and the default model (`model`, `provider/model`).
function cliDefaults(manifest: DynWorkSync.Manifest) {
  const defaults = (manifest.marketplaces ?? [])
    .map((marketplace) => marketplace.opencode?.cli_defaults)
    .find((value): value is Record<string, unknown> => typeof value === "object" && value !== null)
  const agent = typeof defaults?.default_agent === "string" ? defaults.default_agent : undefined
  const model = typeof defaults?.model === "string" ? defaults.model : undefined
  const slash = model?.indexOf("/") ?? -1
  return {
    agent,
    model:
      model && slash > 0 && slash < model.length - 1
        ? { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }
        : undefined,
  }
}
