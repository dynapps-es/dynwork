import type { Thread } from "../../chats/contract"
import type { ViewNavGroup } from "../shell"

/** The id of the row that opens a new, empty chat. */
export const NEW = "new"

/**
 * The list as the shell's sub-navigation draws it: the chats newest first, then the archived ones, each named by its
 * title. A group with nothing in it is left out.
 */
export function navGroups(
  threads: readonly Thread[],
  t: (key: "chats.new" | "chats.recent" | "chats.archived" | "chats.untitled") => string,
): ViewNavGroup[] {
  const row = (thread: Thread) => ({ id: thread.id, label: thread.title.trim() || t("chats.untitled") })
  const recent = threads.filter((thread) => thread.archived === undefined)
  const archived = threads.filter((thread) => thread.archived !== undefined)
  return [
    { items: [{ id: NEW, label: t("chats.new"), icon: "plus" as const }] },
    ...(recent.length ? [{ label: t("chats.recent"), items: recent.map(row) }] : []),
    ...(archived.length ? [{ label: t("chats.archived"), items: archived.map(row) }] : []),
  ]
}
