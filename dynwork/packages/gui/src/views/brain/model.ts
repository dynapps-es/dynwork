// The Brain view's logic, kept out of the components so it runs in plain tests: the tree, the Markdown the documents
// use, and the search.
import type { Doc, Grant, Space, TreeNode } from "./demo"

/** Where a document sits: its space, the folders above it and its own tree node. */
export interface Located {
  readonly space: Space
  readonly trail: readonly TreeNode[]
  readonly node: TreeNode
}

/** Every document of the spaces, in tree order. */
export function listDocuments(spaces: readonly Space[]): readonly Located[] {
  return spaces.flatMap((space) => walk(space, space.children, []))
}

export function locate(spaces: readonly Space[], id: string) {
  return listDocuments(spaces).find((item) => item.node.id === id)
}

function walk(space: Space, nodes: readonly TreeNode[], trail: readonly TreeNode[]): readonly Located[] {
  return nodes.flatMap((node) =>
    node.children ? walk(space, node.children, [...trail, node]) : [{ space, trail, node }],
  )
}

/** The grants a document shows: its space's, then the ones set on the document. */
export function grantsOf(space: Space, doc: Doc): readonly Grant[] {
  return [
    ...space.access.map((grant): Grant => ({ ...grant, source: "inherited" })),
    ...doc.explicit.map((grant): Grant => ({ ...grant, source: "explicit" })),
  ]
}

/** How the "Canonical state" cell reads: a dot tone and a message key with its parameters. */
export function canonicalState(doc: Pick<Doc, "canon" | "review">) {
  if (doc.canon === "Verified") return { tone: "success", key: "brain.canon.verified", date: doc.review } as const
  if (doc.canon === "Draft") return { tone: "none", key: "brain.canon.draft", date: "" } as const
  return { tone: "none", key: "brain.canon.source", date: "" } as const
}

// ── Markdown ──

export type Inline = { readonly kind: "text" | "code" | "strong"; readonly text: string }

export type Block =
  | { readonly kind: "heading"; readonly level: number; readonly text: readonly Inline[] }
  | { readonly kind: "paragraph"; readonly text: readonly Inline[] }
  | { readonly kind: "quote"; readonly text: readonly Inline[] }
  | { readonly kind: "list"; readonly ordered: boolean; readonly items: readonly (readonly Inline[])[] }
  | {
      readonly kind: "table"
      readonly head: readonly (readonly Inline[])[]
      readonly rows: readonly (readonly (readonly Inline[])[])[]
    }

export function stripFrontMatter(source: string) {
  return source.replace(/^---\n[\s\S]*?\n---\n/, "")
}

/** Enough Markdown for the demo documents: headings, paragraphs, lists, tables, quotes, bold and code. */
export function parseMarkdown(source: string): readonly Block[] {
  return stripFrontMatter(source)
    .trim()
    .split(/\n{2,}/)
    .filter((block) => block.trim().length > 0)
    .map((block): Block => {
      const lines = block.split("\n")
      const heading = block.match(/^(#{1,6}) (.*)$/)
      if (heading) return { kind: "heading", level: heading[1].length, text: inline(heading[2]) }
      if (lines.every((line) => line.startsWith("- "))) {
        return { kind: "list", ordered: false, items: lines.map((line) => inline(line.slice(2))) }
      }
      if (lines.every((line) => /^\d+\. /.test(line))) {
        return { kind: "list", ordered: true, items: lines.map((line) => inline(line.replace(/^\d+\. /, ""))) }
      }
      if (lines[0].startsWith("> ")) {
        return { kind: "quote", text: inline(lines.map((line) => line.slice(2)).join(" ")) }
      }
      if (lines[0].startsWith("|")) {
        return { kind: "table", head: cells(lines[0]), rows: lines.slice(2).map(cells) }
      }
      return { kind: "paragraph", text: inline(lines.join(" ")) }
    })
}

function cells(line: string) {
  return line
    .split("|")
    .slice(1, -1)
    .map((cell) => inline(cell.trim()))
}

function inline(text: string): readonly Inline[] {
  return text
    .split(/(`[^`]+`|\*\*[^*]+\*\*)/)
    .filter((part) => part.length > 0)
    .map((part): Inline => {
      if (part.startsWith("`") && part.endsWith("`") && part.length > 1)
        return { kind: "code", text: part.slice(1, -1) }
      if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
        return { kind: "strong", text: part.slice(2, -2) }
      }
      return { kind: "text", text: part }
    })
}

/** The Markdown source line by line, each tagged for the code view: front matter, heading or plain. */
export function sourceLines(source: string) {
  const lines = source.trimEnd().split("\n")
  return lines.reduce<{ front: boolean; lines: readonly { readonly text: string; readonly kind: "fm" | "h" | "" }[] }>(
    (acc, text, index) => {
      const front = text === "---" ? index === 0 : acc.front
      const kind = text === "---" || front ? "fm" : /^#{1,6} /.test(text) ? "h" : ""
      return { front, lines: [...acc.lines, { text, kind }] }
    },
    { front: false, lines: [] },
  ).lines
}

// ── Search ──

export interface Segment {
  readonly text: string
  readonly match: boolean
}

export interface Hit {
  readonly id: string
  readonly title: string
  readonly space: string
  readonly snippet: readonly Segment[]
}

// Question words that say nothing about the document: "how long are backups kept" searches for "backup" and "kept".
const stop = new Set(
  "how what when where who why are is the a an to of do does we our and or for in on with long can i".split(" "),
)

/** The words a query searches for: lower case, without question words, plural "s" dropped. */
export function searchTerms(query: string) {
  return query
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .filter((word) => word.length > 2 && !stop.has(word))
    .map((word) => word.replace(/s$/, ""))
}

/** Documents whose title or body holds the query's words, best first, each with a snippet around the first match. */
export function search(spaces: readonly Space[], docs: Readonly<Record<string, Doc>>, query: string): readonly Hit[] {
  const terms = searchTerms(query)
  if (terms.length === 0) return []
  return listDocuments(spaces)
    .flatMap((item) => {
      const doc = docs[item.node.id]
      if (!doc) return []
      const body = stripFrontMatter(doc.markdown)
        .replace(/[#|>*`-]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
      const title = item.node.title.toLowerCase()
      const lower = body.toLowerCase()
      const score = terms.reduce((sum, term) => sum + (title.includes(term) ? 2 : lower.includes(term) ? 1 : 0), 0)
      if (score === 0) return []
      const first = lower.indexOf(terms.find((term) => lower.includes(term)) ?? "")
      const start = first <= 0 ? 0 : Math.max(0, body.lastIndexOf(". ", first) + 2)
      return [
        {
          score,
          hit: {
            id: item.node.id,
            title: item.node.title,
            space: item.space.name,
            snippet: highlight(body.slice(start, start + 180), terms),
          },
        },
      ]
    })
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.hit)
}

/** Splits text into runs, marking the ones that match a term. */
export function highlight(text: string, terms: readonly string[]): readonly Segment[] {
  if (terms.length === 0) return [{ text, match: false }]
  const pattern = new RegExp(`(${terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi")
  return text
    .split(pattern)
    .map((part, index): Segment => ({ text: part, match: index % 2 === 1 }))
    .filter((segment) => segment.text.length > 0)
}

/** The documents as the shell's sub-navigation rows, for a narrow window where the tree is a select. */
export function navGroups(spaces: readonly Space[]) {
  return spaces.map((space) => ({
    label: space.name,
    items: walk(space, space.children, []).map((item) => ({
      id: item.node.id,
      label: [...item.trail, item.node].map((node) => node.title).join(" / "),
    })),
  }))
}
