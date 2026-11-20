export * as DriveArtifacts from "./artifacts"

import type { Document, Link } from "./contract"

/**
 * A conversation's documents (G07): what the local index holds for it and what the instance lists for its context
 * (`docsByContext`), one entry per act, newest first.
 * - A document both know keeps the index's acts, which the Drive does not tell, at the instance's head revision and
 *   with the later of the two times.
 * - A document only the instance lists (written from another computer of the account, or before the index kept it)
 *   is `edited`, at its head, `via: "server"`: the instance says that the conversation wrote, not what.
 * - A document only the index holds stays: an attachment the conversation never wrote to, or what the instance no
 *   longer lists.
 * The window names every document from what the instance answers, never from the index, which keeps no names.
 */
export function merge(conversation: string, local: readonly Link[], listed: readonly Document[]) {
  const heads = new Map(listed.map((document) => [document.id, document]))
  const known = new Set(local.map((link) => link.document))
  return [
    ...local.map((link) => {
      const document = heads.get(link.document)
      if (!document) return link
      return { ...link, revision: document.revision, at: Math.max(link.at, document.updated) }
    }),
    ...listed
      .filter((document) => !known.has(document.id))
      .map(
        (document): Link => ({
          conversation,
          document: document.id,
          act: "edited",
          revision: document.revision,
          via: "server",
          at: document.updated,
        }),
      ),
  ].toSorted((a, b) => b.at - a.at)
}
