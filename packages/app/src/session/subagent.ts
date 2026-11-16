import type { SessionInfo } from "@opencode/client/promise"

/**
 * Whether a routed session is a subagent's: a child shown read-only, with the SubagentBar instead of the composer. A
 * child whose metadata sets `conversation: true` is a conversation of its own and keeps the standard composer; the
 * breadcrumb, the session lists and cascade deletion still treat it as a child.
 */
export function isSubagentSession(parentID: string | undefined, info: Pick<SessionInfo, "metadata"> | undefined) {
  return !!parentID && info?.metadata?.conversation !== true
}
