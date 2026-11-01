import { createStore } from "solid-js/store"
import { docs, groups, spaces, type Doc, type Role } from "./demo"
import { grantsOf, locate, search } from "./model"

export type Mode = "view" | "markdown"

/** The Brain view's state: the demo documents as a copy the view edits, and what the screen shows of them. */
export function createBrainStore() {
  const [state, setState] = createStore({
    docs: Object.fromEntries(docs.map((doc) => [doc.id, structuredClone(doc)])) as Record<string, Doc>,
    selected: "mig-18",
    mode: "view" as Mode,
    query: "",
    // Spaces and folders open at the start, as in the mockup.
    expanded: Object.fromEntries([...spaces.map((space) => space.id), "migrations"].map((id) => [id, true])) as Record<
      string,
      boolean
    >,
    accessOpen: false,
    editing: false,
    draft: "",
    // The language picked per document; none picked reads the document's first English or only language.
    languages: {} as Record<string, string>,
  })

  const located = () => locate(spaces, state.selected)
  const doc = () => state.docs[state.selected]
  // A mirrored space is read-only for everyone; otherwise the user's own role in the space decides.
  const canEdit = () => {
    const item = located()
    return item !== undefined && item.space.origin !== "mirror" && item.space.you === "Can edit"
  }
  const grants = () => {
    const item = located()
    return item ? grantsOf(item.space, doc()) : []
  }
  const language = () =>
    state.languages[state.selected] ?? (doc().langs.includes("English") ? "English" : doc().langs[0])
  // The groups still to offer in "Share with a group".
  const shareable = () => {
    const taken = new Set(grants().map((grant) => grant.id))
    return groups.filter((group) => !taken.has(group.id))
  }
  const results = () => search(spaces, state.docs, state.query)

  return {
    state,
    located,
    doc,
    canEdit,
    grants,
    language,
    results,
    /** Opens a document: its folders unfold in the tree and any edit in progress is dropped. */
    select(id: string) {
      const item = locate(spaces, id)
      if (!item) return
      setState("selected", id)
      setState("editing", false)
      setState(
        "expanded",
        Object.fromEntries([item.space.id, ...item.trail.map((node) => node.id)].map((key) => [key, true])),
      )
    },
    setMode(mode: Mode) {
      setState("mode", mode)
    },
    setQuery(query: string) {
      setState("query", query)
    },
    toggle(id: string) {
      setState("expanded", id, (open) => !open)
    },
    setLanguage(language: string) {
      setState("languages", state.selected, language)
    },
    toggleAccess() {
      setState("accessOpen", (open) => !open)
    },
    closeAccess() {
      setState("accessOpen", false)
    },
    /** Changes what a group can do on the open document. Ignored where the user cannot edit. */
    setRole(grantID: string, role: Role) {
      if (!canEdit()) return
      const item = located()
      if (!item) return
      const explicit = doc().explicit.findIndex((grant) => grant.id === grantID)
      if (explicit >= 0) return setState("docs", state.selected, "explicit", explicit, "role", role)
      // A space-level grant changed on one document becomes an explicit one there, so the space keeps its own.
      const inherited = item.space.access.find((grant) => grant.id === grantID)
      if (!inherited) return
      setState("docs", state.selected, "explicit", (list) => [...list, { ...inherited, role }])
    },
    shareable,
    /** Gives the next group read access to the open document. */
    share() {
      const next = shareable()[0]
      if (!canEdit() || !next) return
      setState("docs", state.selected, "explicit", (list) => [...list, { ...next, role: "Can read" as const }])
    },
    startEdit() {
      if (!canEdit()) return
      setState("draft", doc().markdown)
      setState("editing", true)
    },
    setDraft(draft: string) {
      setState("draft", draft)
    },
    cancelEdit() {
      setState("editing", false)
    },
    /** Writes the draft into the in-memory document. */
    save() {
      if (!state.editing) return
      setState("docs", state.selected, { markdown: state.draft, updated: "Just now" })
      setState("editing", false)
    },
  }
}

export type BrainStore = ReturnType<typeof createBrainStore>
