export * as Rules from "./rules"

// Decision P2 as one table. `project.ts` reads `route` and the code that builds each block follows the row it
// belongs to; `test/rules.test.ts` has a test per row, by id.

export type Route = "tool" | "diff" | "subagent" | "todos" | "question"

export const table = [
  { id: "text", from: "assistant text", to: "text", rule: "full markdown, shown as it streams" },
  { id: "reasoning", from: "assistant reasoning", to: "reasoning", rule: "collapsed, with how long it took" },
  {
    id: "tools",
    from: "consecutive tool calls",
    to: "toolGroup",
    rule: "one line per run of calls, opening a sheet; text between them ends the run",
  },
  {
    id: "diff",
    from: "edit, write and patch calls",
    to: "diffSummary",
    rule: "one card per turn: files, additions, deletions",
  },
  {
    id: "subagent",
    from: "a subagent call",
    to: "subagent",
    rule: "a live card that opens the child session read-only",
  },
  {
    id: "background",
    from: "a subagent or shell command left running",
    to: "Background",
    rule: "a bar above the composer, a count on the session row",
  },
  {
    id: "permission",
    from: "a permission request",
    to: "permission",
    rule: "a blocking card while it waits; afterwards a mark on the call",
  },
  {
    id: "question",
    from: "the question tool and its form",
    to: "question",
    rule: "native chips while it waits, the answer afterwards",
  },
  { id: "todos", from: "todowrite calls", to: "todos", rule: "one progress line: the latest list of the session" },
  { id: "compaction", from: "a compaction message", to: "compaction", rule: "a separator" },
  { id: "retry", from: "a step waiting to retry", to: "retry", rule: "a line while it waits" },
  {
    id: "error",
    from: "a failed step or turn",
    to: "error",
    rule: "one line; a user interruption is a turn status, not an error",
  },
  { id: "unknown", from: "any part or message kind not listed", to: "unknown", rule: "a generic line, never a crash" },
] as const

export type RuleID = (typeof table)[number]["id"]

const routes: Record<string, Route> = {
  edit: "diff",
  write: "diff",
  patch: "diff",
  subagent: "subagent",
  todowrite: "todos",
  question: "question",
}

export function route(name: string): Route {
  return routes[name] ?? "tool"
}

/** The one line a call gets in the sheet: its file, pattern, address or command. */
export function label(name: string, input: Record<string, unknown>): string {
  const pick = (...keys: string[]) => {
    const found = keys.map((key) => input[key]).find((value) => typeof value === "string" && value !== "")
    return typeof found === "string" ? found : undefined
  }
  const detail = pick("description", "path", "filePath", "pattern", "command", "url", "query")
  return detail ? `${name} ${detail}` : name
}
