export * as DynWorkMapping from "./mapping"

import { Mcp, Skill } from "@opencode/plugin/effect"
import { Option, Schema } from "effect"
import type { DynWorkSync } from "./contract"
import { DynWorkInstructions } from "./instructions"
import { DynWorkSkills } from "./skills"

// Turns an instance manifest into what the plugin's transforms add (decision D8). Pure and total: an entry the
// service could not take is left out instead of failing, because a transform that throws disables the whole plugin.

/** The hosts an entry may target for DynWork to apply it. */
const hosts = ["opencode", "opencode-cli"]

export interface Agent {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly system?: string
  /** A gateway model id: the agent runs on `systemprompt/<model>`. Absent when the gateway does not serve it. */
  readonly model?: string
  /** Instance agents are sub-agents; the one `cli_defaults` names is also selectable as the primary agent. */
  readonly mode: "subagent" | "all"
}

export interface Mapped {
  /** The skills for a service without its own config dir; with one they are `skillFiles` instead. */
  readonly skills: ReadonlyArray<Skill.Info>
  /** The skills as the bridge's files (`DynWorkSkills.project`), or undefined when everything managed is to go. */
  readonly skillFiles?: DynWorkSkills.Projection
  readonly agents: ReadonlyArray<Agent>
  readonly mcp: ReadonlyArray<readonly [string, Mcp.ServerConfig]>
  /** How many rules `instructions` carries. */
  readonly rules: number
  /** The rules as the managed `AGENTS.md` block (`DynWorkInstructions.block`), or undefined without rules. */
  readonly instructions?: string
  readonly defaults: {
    readonly agent?: string
    readonly model?: { readonly providerID: string; readonly modelID: string }
  }
}

export const empty: Mapped = { skills: [], agents: [], mcp: [], rules: 0, defaults: {} }

export function map(input: DynWorkSync.Apply): Mapped {
  const manifest = input.manifest
  // Absent means empty means cleared, like the bridge's `serde(default)`
  if (!manifest.enabled_hosts?.some((host) => hosts.includes(host))) return empty
  const key = input.instance.key
  const name = (id: string) => `${key}-${id}`
  const settings = cliDefaults(manifest)
  const defaultAgent = unique(manifest.agents).find(
    (agent) => agent.enabled !== false && (agent.id === settings.agent || agent.name === settings.agent),
  )
  const served = new Set(input.gateway?.models.map((model) => model.id))
  const rules = DynWorkInstructions.select(manifest.rules)
  const skills = unique(manifest.skills).filter((skill) => applies(skill.hosts) && skill.instructions?.trim())
  return {
    skills: skills.flatMap((skill) =>
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
    skillFiles: DynWorkSkills.project(manifest, skills),
    agents: unique(manifest.agents)
      .filter((agent) => agent.enabled !== false)
      .map((agent) => ({
        id: name(agent.id),
        name: agent.display_name || agent.name,
        description: agent.description,
        system: agent.system_prompt,
        ...(agent.model && served.has(agent.model) ? { model: agent.model } : {}),
        mode: agent.id === defaultAgent?.id ? "all" : "subagent",
      })),
    // Two servers that share a slug keep the last one, like the bridge's table insert
    mcp: [
      ...new Map(
        unique(manifest.managed_mcp_servers).flatMap((server) =>
          Option.toArray(remote(server, input)).map((config) => [serverName(server.name), config] as const),
        ),
      ),
    ],
    rules: rules.length,
    instructions: DynWorkInstructions.block(rules),
    defaults: {
      agent: defaultAgent ? name(defaultAgent.id) : undefined,
      model: settings.model,
    },
  }
}

// The bridge's `normalize_key` (`mcp_registry.rs`): lowercase `[a-z0-9_]`, any run of other characters becomes one `-`,
// no leading or trailing `-`. OpenCode names an MCP tool `<server>_<tool>`, so this is what skills and rules call
// (`dynbrain_docs_search`). The server is not prefixed with the instance key: a server of the same name that the user
// configured is replaced by the instance's, as the transform's `editor.set` always does.
function serverName(name: string) {
  const slug = name
    .replace(/[^A-Za-z0-9_]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
  return slug || "mcp-server"
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
