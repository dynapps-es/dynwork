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
  /** P10: comments on a cell range (0.85). A PDF takes none: the core does not read PDF (D22). */
  rangeComments: Schema.Boolean,
  /**
   * P13: the agent rewrites HTML with scripts through the MCP (`documents_edit {content_blob_ref}`, 0.84). Off: DynWork
   * refuses the agent's edits by ops of an HTML document, which strip its scripts (D21), and the agent uploads the whole
   * page again as a new document.
   */
  rawHtmlByMcp: Schema.Boolean,
  /**
   * P4: the agent imports what it uploaded (`documents_import`, scripts kept) and makes folders (`documents_folder`)
   * through the MCP, 0.84. Off: DynWork imports an uploaded page and makes the conversation's folder by REST.
   */
  mcpFolders: Schema.Boolean,
  /** P5: an MCP write carries the conversation. Off: DynWork records it in its local index. */
  contextByMcp: Schema.Boolean,
  /** P3: the Drive lists the documents of a conversation. Off: only the local index knows. */
  docsByContext: Schema.Boolean,
  /** P6: the instance tells DynWork of changes (`document.drive.changed`, 0.84). Off: DynWork polls. */
  pushChanges: Schema.Boolean,
  /** G13: the instance names people by id (`/api/v1/documents/people`, 0.84). Off: only the grants of a document do. */
  peopleByRest: Schema.Boolean,
})
export type Capabilities = typeof Capabilities.Type
export type Key = keyof Capabilities

/** Today's instance: none delivered. */
export const none: Capabilities = {
  personActions: false,
  conversationLabel: false,
  rangeComments: false,
  rawHtmlByMcp: false,
  mcpFolders: false,
  contextByMcp: false,
  docsByContext: false,
  pushChanges: false,
  peopleByRest: false,
}

/** How often the Drive is read for changes. */
export const POLL = 5 * 60_000
/** How often while a window watches it (the Drive view or a document tab is open). */
export const WATCHED = 20_000

/**
 * Who a write is attributed to (D2): the instance names the agent from the signed token, so DynWork says the rest in
 * the revision message, and gives a conversation's writes its `x-context-id` (the instance's id for it, D20; none while
 * it is not registered).
 * - From a conversation: "<conversation> by DynWork", until the instance shows the conversation itself (`conversationLabel`).
 * - Direct: "<user> by DynWork", until DynWork acts as the person (`personActions`), when it needs no message.
 */
export function attribution(
  capabilities: Capabilities,
  author: { user: string; conversation?: { name: string; context?: string } },
) {
  if (author.conversation)
    return {
      contextId: author.conversation.context,
      message: capabilities.conversationLabel ? undefined : `${author.conversation.name} by DynWork`,
    }
  return { contextId: undefined, message: capabilities.personActions ? undefined : `${author.user} by DynWork` }
}

/** Whether a comment may be anchored there: a node always; a cell range only once delivered. */
export function anchorable(capabilities: Capabilities, anchor: Anchor) {
  if (anchor.kind === "range") return capabilities.rangeComments
  return true
}

/**
 * Whether the agent's `documents_edit` may go to the instance (D21). An edit by ops of an HTML document strips its
 * scripts and styles until the instance keeps the page whole (`rawHtmlByMcp`): DynWork refuses it and the agent uploads
 * the whole page again. Replacing the content with an uploaded blob (`content_blob_ref`) keeps it, and goes.
 */
export function agentEdits(capabilities: Capabilities, edit: { format: string; replace: boolean }) {
  return edit.replace || edit.format !== "html" || capabilities.rawHtmlByMcp
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
 * DynWork makes the folder and imports the agent's `blob_ref`; `mcp`, the agent does it itself. `documents_import`
 * stores a page byte for byte, scripts kept (0.84), so HTML needs nothing more than any other format: it is the agent's
 * to import once `mcpFolders` is on. `rawHtmlByMcp` is about changing a page, not about bringing one in.
 */
export function agentFiling(capabilities: Capabilities) {
  return capabilities.mcpFolders ? ("mcp" as const) : ("rest" as const)
}
