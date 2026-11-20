export * as DriveCapabilities from "./capabilities"

import type { DynWorkSync } from "@dynwork/server-plugin/contract"
import { Schema } from "effect"
import type { Anchor } from "./contract"

// What the Drive does differently once the instance delivers what DynWork asked for (`docs/ed/` of the Drive plan).
// Each one is a switch per account, off until the instance gives it. What an instance gives is read from its own
// discovery (`delivered`), per account, when the account becomes active and when it reconnects. Every decision a switch
// changes is a pure function here, so both states are tested without an instance.

export const Capabilities = Schema.Struct({
  /** P1: DynWork acts as the person. Off: as an agent, and what the instance keeps to a person goes to Governance. */
  personActions: Schema.Boolean,
  /** P11: Governance names the conversation of a write. Off: the revision message names it. */
  conversationLabel: Schema.Boolean,
  /** P10: comments on a cell range of a sheet (G08, 0.84). A PDF takes none: the core does not read PDF (D22). */
  rangeComments: Schema.Boolean,
  /** G12: a resolved comment opens again (`POST …/comments/{id}/reopen`, 0.84). Off: resolving is for good. */
  reopenComments: Schema.Boolean,
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
  /**
   * P3: the Drive lists the documents of a conversation (G07, 0.84 `scope=context`), merged with the local index. Off:
   * only the local index knows.
   */
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
  reopenComments: false,
  rawHtmlByMcp: false,
  mcpFolders: false,
  contextByMcp: false,
  docsByContext: false,
  pushChanges: false,
  peopleByRest: false,
}

/**
 * What the instance's discovery (`GET /api/v1`) says, and what a probe found where it says neither:
 * - `documents`: discovery announces the Drive (`endpoints.documents`), which only 0.84 does, whether the store is on;
 * - `version`: the core's version, as discovery spells it;
 * - `people`: `GET /documents/people?ids=` answered (0.84), asked only when discovery tells neither of the other two.
 */
export interface Instance {
  documents?: boolean
  version?: string
  people?: boolean
}

/**
 * What an instance delivers, from what it says of itself: 0.84 gives the REST side of G02, G09 and G13
 * (`conversationLabel`, `pushChanges`, `peopleByRest`), the agent's side of G04, G05 and G06 through the MCP
 * (`rawHtmlByMcp`, `mcpFolders`, `contextByMcp`), comments on cell ranges and reopened (G08 `rangeComments`, G12
 * `reopenComments`) and a conversation's documents (G07 `docsByContext`); 0.83 and older, none. Undefined when nothing
 * tells, which asks for the probe. The rest of 0.84 is turned on by the phases that use it.
 */
export function delivered(instance: Instance): Capabilities | undefined {
  const at84 = instance.documents === true || (atLeast(instance.version, 84) ?? instance.people)
  if (at84 === undefined) return undefined
  return {
    ...none,
    conversationLabel: at84,
    pushChanges: at84,
    peopleByRest: at84,
    rawHtmlByMcp: at84,
    mcpFolders: at84,
    contextByMcp: at84,
    rangeComments: at84,
    reopenComments: at84,
    docsByContext: at84,
  }
}

/**
 * What the agent's `documents` rules and calls need of an account's capabilities, as the server plugin takes them with
 * each apply. `rawHtmlByMcp` and `mcpFolders` go together on 0.84: one without the other would have DynWork import a
 * page the agent uploaded only to rewrite another one.
 */
export function agent(capabilities: Capabilities): DynWorkSync.Documents {
  return {
    rawHtmlByMcp: capabilities.rawHtmlByMcp,
    mcpFolders: capabilities.mcpFolders,
    contextByMcp: capabilities.contextByMcp,
    peopleByRest: capabilities.peopleByRest,
    rangeComments: capabilities.rangeComments,
    reopenComments: capabilities.reopenComments,
  }
}

// Whether a `0.<minor>` version (a `v` and a pre-release suffix allowed) is at least `minor`; undefined when unreadable.
function atLeast(version: string | undefined, minor: number) {
  const parts = version === undefined ? undefined : /^v?(\d+)\.(\d+)(?:[.+-]|$)/.exec(version.trim())
  if (!parts) return undefined
  return Number(parts[1]) > 0 || Number(parts[2]) >= minor
}

/** Every capability's name. */
export const keys = Object.keys(none) as Key[]

/** How often the Drive is read for changes. */
export const POLL = 5 * 60_000
/** How often while a window watches it (the Drive view or a document tab is open). */
export const WATCHED = 20_000

/**
 * Who a write is attributed to (D2): the instance names the agent from the signed token, so DynWork says the rest in
 * the revision message, and gives a conversation's writes its `x-context-id` (the instance's id for it, D20; none while
 * it is not registered).
 * - From a conversation: "<conversation> by DynWork", until the instance records and shows the conversation itself
 *   (`conversationLabel`): then only for a write that does not carry the conversation's context, which the instance
 *   cannot name (one whose registration failed, or the agent's through the MCP until it carries it).
 * - Direct: "<user> by DynWork", until DynWork acts as the person (`personActions`), when it needs no message.
 */
export function attribution(
  capabilities: Capabilities,
  author: { user: string; conversation?: { name: string; context?: string } },
) {
  if (author.conversation)
    return {
      contextId: author.conversation.context,
      message:
        capabilities.conversationLabel && author.conversation.context !== undefined
          ? undefined
          : `${author.conversation.name} by DynWork`,
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
 * The time to the next read (D10). With the instance's push and its stream open (`pushed`), a watched Drive needs no
 * fast poll: the slow one stays as the net for a change the push missed. While the stream is down, the fast one is back.
 */
export function pollEvery(capabilities: Capabilities, watched: boolean, pushed: boolean) {
  if (watched && !(capabilities.pushChanges && pushed)) return WATCHED
  return POLL
}

/**
 * Who wrote a revision or a comment, as the instance tells it once it records the conversation (`conversationLabel`,
 * 0.84): "<conversation> · DynWork" for one of DynWork's own (`ours`), "<conversation> · <agent>" for another agent's
 * conversation of the user, the agent's name alone where there is no conversation's title (the instance tells it to
 * the conversation's owner only), and "DynWork" for DynWork's own without one. Undefined while off, or when the
 * instance names neither: the view keeps its own words.
 */
export function writer(capabilities: Capabilities, by: { conversation?: string; agent?: string; ours?: boolean }) {
  if (!capabilities.conversationLabel) return undefined
  const agent = by.ours ? "DynWork" : by.agent
  if (by.conversation === undefined) return agent
  return agent === undefined ? by.conversation : `${by.conversation} · ${agent}`
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
