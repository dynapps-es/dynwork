import type { Reply, Script } from "./fake"
import type { Scenario } from "./record"

// Every scenario is a prompt that names itself (`[scenario:<name>]`) and a script of replies by step, so what the
// recorder sees is the same on every run: no randomness reaches the model's side of a conversation. A step is how many
// assistant turns the conversation already holds, so `step` 0 is the reply to the prompt and `step` 1 the reply to the
// tool results of step 0.

const answer = (text: string): Reply => ({ blocks: [{ text }] })

const summary = [
  "## Objective",
  "- Count the words in the notes",
  "",
  "## Requirements",
  "- (none)",
  "",
  "## Decisions",
  "- (none)",
  "",
  "## Work State",
  "### Completed",
  "- Counted the words",
  "",
  "### Active",
  "- (none)",
  "",
  "### Blocked",
  "- (none)",
  "",
  "## Next Move",
  "1. (none)",
  "",
  "## Relevant Files",
  "- (none)",
  "",
  "## Important Context",
  "- (none)",
].join("\n")

export const scripts: Record<string, Script> = {
  plain: () =>
    answer("Hello from the fake provider. This is a plain answer, with `inline code` and a list:\n\n- one\n- two"),

  reasoning: (call) =>
    call.step === 0
      ? {
          blocks: [
            { thinking: "The user asks for the sum. Two and two make four, so the answer is four." },
            { text: "Two plus two is four." },
          ],
        }
      : answer("unexpected step"),

  tools: (call) => {
    if (call.step === 0)
      return {
        blocks: [
          { text: "I will look at the notes first." },
          { tool: "glob", input: { pattern: "*.md" } },
          { tool: "grep", input: { pattern: "alpha" } },
        ],
      }
    if (call.step === 1)
      return {
        blocks: [
          { tool: "read", input: { path: "notes.md" } },
          { tool: "shell", input: { command: "wc -w notes.md", description: "Count the words" } },
          { tool: "read", input: { path: "missing.md" } },
        ],
      }
    return answer("The notes hold three lines about alpha, beta and gamma.")
  },

  edit: (call) => {
    if (call.step === 0)
      return { blocks: [{ tool: "edit", input: { path: "hello.txt", oldString: "world", newString: "mobile" } }] }
    if (call.step === 1)
      return { blocks: [{ tool: "write", input: { path: "added.txt", content: "one\ntwo\nthree\n" } }] }
    return answer("I changed hello.txt and added added.txt.")
  },

  "subagent-foreground": (call) => {
    if (call.step === 0)
      return {
        blocks: [
          {
            tool: "subagent",
            input: {
              agent: "explore",
              description: "Read the notes",
              prompt: "[scenario:subagent-foreground/child] Read notes.md and report what it holds.",
            },
          },
        ],
      }
    return answer("The subagent read the notes: three lines.")
  },
  "subagent-foreground/child": (call) =>
    call.step === 0
      ? {
          blocks: [
            { tool: "shell", input: { command: "sleep 2 && cat notes.md", description: "Read the notes slowly" } },
          ],
        }
      : answer("notes.md holds three lines: alpha, beta, gamma."),

  "subagent-background": (call) => {
    if (call.step === 0)
      return {
        blocks: [
          { text: "I will run a subagent in the background." },
          {
            tool: "subagent",
            input: {
              agent: "general",
              description: "Slow count",
              prompt: "[scenario:subagent-background/child] Count to three slowly.",
              background: true,
            },
          },
        ],
      }
    if (call.step === 1) return answer("The subagent is running. I will wait for its report.")
    return answer("The subagent finished: it counted to three.")
  },
  "subagent-background/child": (call) =>
    call.step === 0
      ? {
          blocks: [{ tool: "shell", input: { command: "sleep 2 && echo one two three", description: "Count slowly" } }],
        }
      : answer("one two three"),

  "shell-background": (call) => {
    if (call.step === 0)
      return {
        blocks: [
          { tool: "shell", input: { command: "sleep 2 && echo built", description: "Slow build", background: true } },
        ],
      }
    if (call.step === 1) return answer("The build runs in the background.")
    return answer("The build finished.")
  },

  permission: (call) =>
    call.step === 0
      ? { blocks: [{ tool: "edit", input: { path: "hello.txt", oldString: "world", newString: "phone" } }] }
      : answer("The edit was applied."),

  question: (call) =>
    call.step === 0
      ? {
          blocks: [
            {
              tool: "question",
              input: {
                questions: [
                  {
                    header: "Language",
                    question: "Which language should the greeting use?",
                    options: [
                      { label: "English", description: "Say hello" },
                      { label: "Spanish", description: "Say hola" },
                    ],
                  },
                ],
              },
            },
          ],
        }
      : answer("Understood, I will greet in Spanish."),

  retry: (call) => {
    if (call.step === 0 && call.attempt === 1)
      return { status: 529, type: "overloaded_error", message: "The fake provider is overloaded" }
    return answer("The second attempt worked.")
  },

  compaction: (call) => {
    if (call.compaction) return answer(summary)
    return answer(call.step === 0 ? "The first answer." : "The second answer.")
  },

  todos: (call) => {
    if (call.step === 0)
      return {
        blocks: [
          {
            tool: "todowrite",
            input: {
              todos: [
                { content: "Read the notes", status: "in_progress" },
                { content: "Write the summary", status: "pending" },
                { content: "Send it", status: "pending" },
              ],
            },
          },
        ],
      }
    if (call.step === 1)
      return {
        blocks: [
          {
            tool: "todowrite",
            input: {
              todos: [
                { content: "Read the notes", status: "completed" },
                { content: "Write the summary", status: "in_progress" },
                { content: "Send it", status: "pending" },
              ],
            },
          },
        ],
      }
    return answer("Two of three steps are on their way.")
  },

  abort: () => ({
    blocks: [{ text: "Working on it, this will take a while and then some more words follow" }],
    hold: 120_000,
  }),

  error: () => ({ status: 400, type: "invalid_request_error", message: "The fake provider refuses this request" }),
}

const notes = "alpha line\nbeta line\ngamma line\n"

export const scenarios: Scenario[] = [
  {
    name: "plain",
    description: "A plain markdown answer",
    run: async (context) => {
      await context.prompt("[scenario:plain] Say hello")
      await context.wait()
      await context.snapshot("final")
    },
  },
  {
    name: "reasoning",
    description: "A reasoning block before the answer",
    run: async (context) => {
      await context.prompt("[scenario:reasoning] What is two plus two?")
      await context.wait()
      await context.snapshot("final")
    },
  },
  {
    name: "tools",
    description: "Several tool calls across two steps, one of them failing",
    files: { "notes.md": notes },
    run: async (context) => {
      await context.prompt("[scenario:tools] Summarise the notes")
      await context.wait()
      await context.snapshot("final")
    },
  },
  {
    name: "edit",
    description: "An edit and a new file, which produce a diff",
    files: { "hello.txt": "hello world\n" },
    run: async (context) => {
      await context.prompt("[scenario:edit] Change the greeting")
      await context.wait()
      await context.snapshot("final")
    },
  },
  {
    name: "subagent-foreground",
    description: "A subagent the parent waits for",
    files: { "notes.md": notes },
    run: async (context) => {
      await context.prompt("[scenario:subagent-foreground] Ask a subagent to read the notes")
      await context.until("the subagent to start", (events) =>
        events.some((event) => event.type === "session.created" && event.data.parentID),
      )
      await context.snapshot("running")
      await context.wait()
      await context.snapshot("final")
    },
  },
  {
    name: "subagent-background",
    description: "A subagent in the background that reports after the parent's turn",
    run: async (context) => {
      await context.prompt("[scenario:subagent-background] Run a slow subagent")
      await context.until("the parent to go idle with the subagent still running", (events) =>
        events.some(
          (event) => event.type === "session.execution.succeeded" && event.data.sessionID === context.session,
        ),
      )
      await context.snapshot("running")
      await context.until(
        "the parent's second turn",
        (events) =>
          events.filter(
            (event) => event.type === "session.execution.succeeded" && event.data.sessionID === context.session,
          ).length >= 2,
      )
      await context.wait()
      await context.snapshot("final")
    },
  },
  {
    name: "shell-background",
    description: "A shell command in the background that reports after the turn",
    run: async (context) => {
      await context.prompt("[scenario:shell-background] Start a slow build")
      await context.until("the first turn to end", (events) =>
        events.some((event) => event.type === "session.execution.succeeded"),
      )
      await context.snapshot("running")
      await context.until(
        "the second turn",
        (events) => events.filter((event) => event.type === "session.execution.succeeded").length >= 2,
      )
      await context.wait()
      await context.snapshot("final")
    },
  },
  {
    name: "permission",
    description: "A permission asked and granted",
    files: { "hello.txt": "hello world\n" },
    permissions: [{ action: "edit", resource: "*", effect: "ask" }],
    run: async (context) => {
      await context.prompt("[scenario:permission] Change the greeting")
      await context.until("the permission request", (events) =>
        events.some((event) => event.type === "permission.asked"),
      )
      await context.snapshot("pending")
      const asked = context.events().find((event) => event.type === "permission.asked")!
      await context.post(`/api/session/${context.session}/permission/${asked.data.id}/reply`, { decision: "once" })
      await context.wait()
      await context.snapshot("final")
    },
  },
  {
    name: "question",
    description: "A question the model asks and the user answers",
    run: async (context) => {
      await context.prompt("[scenario:question] Greet me")
      await context.until("the question form", (events) => events.some((event) => event.type === "form.created"))
      await context.snapshot("pending")
      const created = context.events().find((event) => event.type === "form.created")!
      await context.post(`/api/session/${context.session}/form/${created.data.form.id}/reply`, {
        answer: { q0: "Spanish" },
      })
      await context.wait()
      await context.snapshot("final")
    },
  },
  {
    name: "retry",
    description: "A retry after a provider error",
    run: async (context) => {
      await context.prompt("[scenario:retry] Say hello")
      await context.until("the retry", (events) => events.some((event) => event.type === "session.retry.scheduled"))
      await context.snapshot("retrying")
      await context.wait()
      await context.snapshot("final")
    },
  },
  {
    name: "compaction",
    description: "A manual compaction after two exchanges",
    run: async (context) => {
      await context.prompt("[scenario:compaction] First question")
      await context.wait()
      await context.prompt("[scenario:compaction] Second question")
      await context.wait()
      await context.post(`/api/session/${context.session}/compact`, {})
      await context.until("the compaction to end", (events) =>
        events.some((event) => event.type === "session.compaction.ended" || event.type === "session.compaction.failed"),
      )
      await context.wait()
      await context.snapshot("final")
    },
  },
  {
    name: "todos",
    description: "A todo list the model updates",
    run: async (context) => {
      await context.prompt("[scenario:todos] Plan the work")
      await context.wait()
      await context.snapshot("final")
    },
  },
  {
    name: "abort",
    description: "A step interrupted while it streams",
    run: async (context) => {
      await context.prompt("[scenario:abort] Take your time")
      await context.until("the text to stream", (events) => events.some((event) => event.type === "session.text.delta"))
      await context.snapshot("streaming")
      await context.post(`/api/session/${context.session}/interrupt`)
      await context.wait()
      await context.snapshot("final")
    },
  },
  {
    name: "error",
    description: "A provider error that ends the turn",
    run: async (context) => {
      await context.prompt("[scenario:error] Say hello")
      await context.wait()
      await context.snapshot("final")
    },
  },
]
