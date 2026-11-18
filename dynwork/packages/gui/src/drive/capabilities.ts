export * as DriveCapabilities from "./capabilities"

import { Schema } from "effect"
import type { Anchor } from "./contract"

// What the Drive does differently once the instance delivers what DynWork asked for (`docs/ed/` of the Drive plan).
// Each one is a switch per account, off until the instance gives it; how it gets switched on (the core's version or
// an announcement in the manifest) is decided when the first one arrives. Every decision a switch changes is a pure
// function here, so both states are tested without an instance.

export const Capabilities = Schema.Struct({
  /** P1: DynWork acts as the person. Off: as an agent, and what the instance keeps to a person goes to Governance. */
  personActions: Schema.Boolean,
  /** P11: Governance names the conversation of a write. Off: the revision message names it. */
  conversationLabel: Schema.Boolean,
  /** P10: comments on a cell range. */
  rangeComments: Schema.Boolean,
  /** P10: comments on a point of a PDF. */
  pdfComments: Schema.Boolean,
  /** P13: the agent writes HTML with scripts through the MCP. Off: DynWork imports the HTML it uploaded. */
  rawHtmlByMcp: Schema.Boolean,
  /** P4: the agent makes folders and imports what it uploaded through the MCP. Off: DynWork does both by REST. */
  mcpFolders: Schema.Boolean,
  /** P5: an MCP write carries the conversation. Off: DynWork records it in its local index. */
  contextByMcp: Schema.Boolean,
  /** P3: the Drive lists the documents of a conversation. Off: only the local index knows. */
  docsByContext: Schema.Boolean,
  /** P6: the instance tells DynWork of changes. Off: DynWork polls. */
  pushChanges: Schema.Boolean,
})
export type Capabilities = typeof Capabilities.Type
export type Key = keyof Capabilities

/** Today's instance: none delivered. */
export const none: Capabilities = {
  personActions: false,
  conversationLabel: false,
  rangeComments: false,
  pdfComments: false,
  rawHtmlByMcp: false,
  mcpFolders: false,
  contextByMcp: false,
  docsByContext: false,
  pushChanges: false,
}

/** How often the Drive is read for changes. */
export const POLL = 5 * 60_000
/** How often while a window watches it (the Drive view or a document tab is open). */
export const WATCHED = 20_000

/**
 * Who a write is attributed to (D2): the instance names the agent from the signed token, so DynWork says the rest in
 * the revision message, and gives a conversation's writes its `x-context-id`.
 * - From a conversation: "<conversation> by DynWork", until the instance shows the conversation itself (`conversationLabel`).
 * - Direct: "<user> by DynWork", until DynWork acts as the person (`personActions`), when it needs no message.
 */
export function attribution(
  capabilities: Capabilities,
  author: { user: string; conversation?: { name: string; context: string } },
) {
  if (author.conversation)
    return {
      contextId: author.conversation.context,
      message: capabilities.conversationLabel ? undefined : `${author.conversation.name} by DynWork`,
    }
  return { contextId: undefined, message: capabilities.personActions ? undefined : `${author.user} by DynWork` }
}

/** Whether a comment may be anchored there: a node always; a cell range and a point on a PDF only once delivered. */
export function anchorable(capabilities: Capabilities, anchor: Anchor) {
  if (anchor.kind === "range") return capabilities.rangeComments
  if (anchor.kind === "page") return capabilities.pdfComments
  return true
}

/**
 * The time to the next read (D10). With the instance's push, a watched Drive needs no fast poll: the slow one stays as
 * the net for a change the push missed.
 */
export function pollEvery(capabilities: Capabilities, watched: boolean) {
  if (watched && !capabilities.pushChanges) return WATCHED
  return POLL
}

/**
 * Whether the local index must record a conversation's write: only what the Drive cannot answer by itself. A REST
 * write carries its `x-context-id`, so the Drive knows it once it lists by conversation (`docsByContext`); an MCP
 * write carries it only with `contextByMcp` too.
 */
export function indexed(capabilities: Capabilities, via: "rest" | "mcp") {
  if (!capabilities.docsByContext) return true
  return via === "mcp" && !capabilities.contextByMcp
}

/**
 * How a file the agent made reaches the conversation's folder (`Artifacts/<project>/<conversation>`, D8): `rest`,
 * DynWork makes the folder and imports the agent's `blob_ref`; `mcp`, the agent does it itself. HTML also needs the MCP
 * to keep its scripts (`rawHtmlByMcp`): until then an HTML file is imported, which keeps them (C7).
 */
export function agentFiling(capabilities: Capabilities, format: string) {
  if (!capabilities.mcpFolders) return "rest" as const
  if (format === "html" && !capabilities.rawHtmlByMcp) return "rest" as const
  return "mcp" as const
}
