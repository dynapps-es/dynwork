export * as View from "./view"

// What the phone draws (decision P2): compact, one line per thing. These are the only types the app imports.

export type Status = "working" | "needs-you" | "done" | "error"

export type Row = {
  id: string
  parentID?: string
  title: string
  /** The folder the session works in, by name. */
  project: string
  directory: string
  /** The paired desktop's name. */
  desktop: string
  status: Status
  /** Epoch milliseconds of the last thing that happened. */
  updated: number
  /** How many background subagents and tasks are still running. */
  background: number
}

export type Tool = {
  id: string
  name: string
  /** One line for the sheet: the file, the pattern, the command. */
  label: string
  status: "running" | "done" | "error"
  /** What a permission request decided for this call, or that one is waiting. */
  approval?: "waiting" | "granted" | "rejected"
  error?: string
  output?: string
}

export type DiffFile = { file: string; additions: number; deletions: number; status: "added" | "deleted" | "modified" }

export type Question = {
  /** The key the form's reply is keyed by. */
  key: string
  header?: string
  question: string
  options: Array<{ label: string; description?: string }>
  multiple: boolean
}

export type Block =
  | { kind: "text"; text: string; streaming: boolean }
  | { kind: "reasoning"; text: string; running: boolean; durationMs?: number }
  | { kind: "toolGroup"; tools: Tool[]; running: number; failed: number }
  | { kind: "diffSummary"; files: DiffFile[]; additions: number; deletions: number }
  | {
      kind: "subagent"
      /** The call's id. */
      id: string
      /** The child session, which opens read-only. */
      sessionID?: string
      agent: string
      description: string
      state: "running" | "background" | "completed" | "error"
      output?: string
    }
  | {
      kind: "todos"
      items: Array<{ content: string; status: "pending" | "in_progress" | "completed" | "cancelled" }>
      done: number
      total: number
    }
  | { kind: "compaction"; status: "running" | "completed" | "failed"; reason: "auto" | "manual"; summary?: string }
  | { kind: "retry"; attempt: number; at: number; message: string }
  | { kind: "error"; message: string; code: string }
  | {
      kind: "question"
      /** The call's id. */
      id: string
      /** The form to reply to, while there is one. */
      formID?: string
      status: "pending" | "answered" | "cancelled"
      questions: Question[]
      answers?: string[][]
    }
  | { kind: "permission"; id: string; action: string; resources: string[]; message?: string; tool?: string }
  | { kind: "unknown"; label: string }

export type Turn = {
  id: string
  user?: { id: string; text: string; files: number }
  blocks: Block[]
  status: "running" | "done" | "error" | "interrupted"
  startedAt: number
  endedAt?: number
}

export type Background = {
  items: Array<{ kind: "subagent" | "shell"; id: string; label: string; sessionID?: string }>
}

export type Session = {
  row: Row
  turns: Turn[]
  background: Background
  /** What is blocking the session: permissions and questions waiting for an answer, oldest first. */
  needs: Array<Extract<Block, { kind: "permission" | "question" }>>
  children: Row[]
  /** For "Session info" and the context gauge: tokens and cost live here and nowhere else. */
  info: Usage
}

export type Tokens = { input: number; output: number; reasoning: number; cache: { read: number; write: number } }

export type Usage = {
  agent?: string
  /** The session's model, `provider/model`. */
  model?: string
  /** This session's own cost in USD. */
  cost: number
  /** With its subagents' (the desktop's figure for a root session); a subagent's own cost otherwise. */
  familyCost: number
  /** The session's total tokens over all its steps. */
  tokens: Tokens
  /**
   * What the context window holds now, as the desktop counts it: the last step with usage after the last completed
   * compaction, all its tokens (input, output, reasoning and the cache read and written). None before a first step.
   */
  context?: { tokens: Tokens; total: number; model?: string; cost?: number; at: number }
  messages: { user: number; assistant: number }
  compactions: number
  created: number
  updated: number
}
