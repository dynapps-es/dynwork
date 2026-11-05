// The recorded sessions and their goldens, bundled (`#fixtures` in package.json): Hermes has no file system. The list
// must match the files; `fixtures.test.ts` checks it under Bun.
import abort from "./fixtures/abort.jsonl"
import compaction from "./fixtures/compaction.jsonl"
import edit from "./fixtures/edit.jsonl"
import error from "./fixtures/error.jsonl"
import permission from "./fixtures/permission.jsonl"
import plain from "./fixtures/plain.jsonl"
import question from "./fixtures/question.jsonl"
import reasoning from "./fixtures/reasoning.jsonl"
import retry from "./fixtures/retry.jsonl"
import shell_background from "./fixtures/shell-background.jsonl"
import subagent_background from "./fixtures/subagent-background.jsonl"
import subagent_foreground from "./fixtures/subagent-foreground.jsonl"
import todos from "./fixtures/todos.jsonl"
import tools from "./fixtures/tools.jsonl"
import abort_golden from "./golden/abort.json"
import compaction_golden from "./golden/compaction.json"
import edit_golden from "./golden/edit.json"
import error_golden from "./golden/error.json"
import permission_golden from "./golden/permission.json"
import plain_golden from "./golden/plain.json"
import question_golden from "./golden/question.json"
import reasoning_golden from "./golden/reasoning.json"
import retry_golden from "./golden/retry.json"
import shell_background_golden from "./golden/shell-background.json"
import subagent_background_golden from "./golden/subagent-background.json"
import subagent_foreground_golden from "./golden/subagent-foreground.json"
import todos_golden from "./golden/todos.json"
import tools_golden from "./golden/tools.json"

export const fixtures: Record<string, string> = {
  abort: abort,
  compaction: compaction,
  edit: edit,
  error: error,
  permission: permission,
  plain: plain,
  question: question,
  reasoning: reasoning,
  retry: retry,
  "shell-background": shell_background,
  "subagent-background": subagent_background,
  "subagent-foreground": subagent_foreground,
  todos: todos,
  tools: tools,
}

export const goldens: Record<string, unknown> = {
  abort: abort_golden,
  compaction: compaction_golden,
  edit: edit_golden,
  error: error_golden,
  permission: permission_golden,
  plain: plain_golden,
  question: question_golden,
  reasoning: reasoning_golden,
  retry: retry_golden,
  "shell-background": shell_background_golden,
  "subagent-background": subagent_background_golden,
  "subagent-foreground": subagent_foreground_golden,
  todos: todos_golden,
  tools: tools_golden,
}
