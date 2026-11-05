import { describe, expect, test } from "bun:test"
import type { FormInfo } from "@opencode/client"
import { Rules } from "../src"
import { assistant, call, idle, open, text, user } from "./build"

// One test per row of the table in `rules.ts`, by id, on a session built by hand. The recorded scenarios cover the same
// rules on real data; these pin each one on its own.

const turn = (...content: Parameters<typeof assistant>[1]) => [
  user("msg_1", "go"),
  assistant("msg_2", content),
  idle("msg_3", "succeeded"),
]

describe("rules", () => {
  test("every id in the table has a test here", () => {
    const covered = [
      "text",
      "reasoning",
      "tools",
      "diff",
      "subagent",
      "background",
      "permission",
      "question",
      "todos",
      "compaction",
      "retry",
      "error",
      "unknown",
    ]
    expect(Rules.table.map((row): string => row.id)).toEqual(covered)
  })

  test("text: full text, streaming only while the step runs", () => {
    expect(open(turn(text("hello **world**"))).blocks).toEqual([
      { kind: "text", text: "hello **world**", streaming: false },
    ])
  })

  test("reasoning: collapsed text with its duration", () => {
    const { blocks } = open(
      turn({ type: "reasoning", text: "hm", time: { created: 100, completed: 350 } }, text("done")),
    )
    expect(blocks[0]).toEqual({ kind: "reasoning", text: "hm", running: false, durationMs: 250 })
  })

  test("tools: a run of calls is one group, text ends the run", () => {
    const { blocks } = open(
      turn(
        call("a", "read", { path: "a.ts" }),
        call("b", "grep", { pattern: "x" }),
        text("between"),
        call("c", "glob", { pattern: "*" }),
      ),
    )
    expect(blocks.map((block) => block.kind)).toEqual(["toolGroup", "text", "toolGroup"])
    expect(blocks[0]).toMatchObject({ kind: "toolGroup", running: 0, failed: 0 })
    expect(blocks[0]?.kind === "toolGroup" && blocks[0].tools.map((tool) => tool.label)).toEqual([
      "read a.ts",
      "grep x",
    ])
  })

  test("tools: a failing call counts and keeps its message", () => {
    const { blocks } = open(turn(call("a", "read", { path: "x" }, { status: "error", message: "File not found" })))
    expect(blocks[0]).toMatchObject({ kind: "toolGroup", failed: 1 })
    expect(blocks[0]?.kind === "toolGroup" && blocks[0].tools[0]?.error).toBe("File not found")
  })

  test("diff: one card per turn adds files up across edits", () => {
    const patch = (file: string, additions: number, deletions: number) => ({
      files: [{ file, patch: "", additions, deletions, status: "modified" }],
    })
    const { blocks } = open(
      turn(
        call("a", "edit", { path: "a.ts" }, { status: "completed", metadata: patch("a.ts", 2, 1) }),
        call("b", "edit", { path: "a.ts" }, { status: "completed", metadata: patch("a.ts", 1, 0) }),
        call(
          "c",
          "write",
          { path: "b.ts", content: "one\ntwo\n" },
          { status: "completed", text: "Created file successfully: b.ts" },
        ),
      ),
    )
    expect(blocks[blocks.length - 1]).toEqual({
      kind: "diffSummary",
      additions: 5,
      deletions: 1,
      files: [
        { file: "a.ts", additions: 3, deletions: 1, status: "modified" },
        { file: "b.ts", additions: 2, deletions: 0, status: "added" },
      ],
    })
  })

  test("subagent: a card for the call, finished with the child's answer", () => {
    const { blocks } = open(
      turn(
        call(
          "s",
          "subagent",
          { agent: "explore", description: "Read it", prompt: "p" },
          {
            status: "completed",
            text: '<subagent sessionID="ses_c" state="completed">\nthree lines\n</subagent>',
            metadata: { sessionID: "ses_c", status: "completed" },
          },
        ),
      ),
    )
    expect(blocks[0]).toEqual({
      kind: "subagent",
      id: "s",
      sessionID: "ses_c",
      agent: "explore",
      description: "Read it",
      state: "completed",
      output: "three lines",
    })
  })

  test("subagent: a running call is a live card", () => {
    const { blocks } = open(
      [
        user("msg_1", "go"),
        assistant(
          "msg_2",
          [
            call(
              "s",
              "subagent",
              { agent: "general", description: "Work", prompt: "p" },
              { status: "running", metadata: { sessionID: "ses_c", status: "running" } },
            ),
          ],
          { time: { created: 5 } },
        ),
      ],
      {},
      {},
    )
    expect(blocks[0]).toMatchObject({ kind: "subagent", state: "running", sessionID: "ses_c" })
  })

  test("background: a subagent left running is in the bar and on the row until it reports", () => {
    const launched = call(
      "s",
      "subagent",
      { agent: "general", description: "Slow", prompt: "p", background: true },
      { status: "completed", metadata: { sessionID: "ses_c", status: "running" } },
    )
    const running = open(turn(launched))
    expect(running.view.background.items).toEqual([
      { kind: "subagent", id: "ses_c", sessionID: "ses_c", label: "Slow" },
    ])
    expect(running.view.row.background).toBe(1)
    expect(running.blocks[0]).toMatchObject({ kind: "subagent", state: "background" })

    const report = {
      type: "synthetic",
      id: "msg_9",
      text: '<subagent sessionID="ses_c" state="completed">\nit counted\n</subagent>',
      metadata: { source: "subagent", childID: "ses_c", state: "completed" },
      time: { created: 99 },
    } as const
    const reported = open([...turn(launched), report])
    expect(reported.view.background.items).toEqual([])
    expect(reported.view.row.background).toBe(0)
    expect(reported.blocks.find((block) => block.kind === "subagent")).toMatchObject({
      state: "completed",
      output: "it counted",
    })
  })

  test("background: a shell command left running is in the bar until it reports", () => {
    const started = call(
      "sh",
      "shell",
      { command: "make", background: true },
      { status: "completed", text: "Command moved to the background (shell ID: sh_1).\nOutput is streaming" },
    )
    expect(open(turn(started)).view.background.items).toEqual([{ kind: "shell", id: "sh_1", label: "make" }])
    const report = {
      type: "synthetic",
      id: "msg_9",
      text: "<shell>done</shell>",
      metadata: { source: "shell", shellID: "sh_1", state: "completed" },
      time: { created: 99 },
    } as const
    expect(open([...turn(started), report]).view.background.items).toEqual([])
  })

  test("permission: a waiting request is a blocking card and marks its row; answered, it marks the call", () => {
    const request = {
      id: "per_1",
      sessionID: "ses_a",
      action: "edit",
      resources: ["a.ts"],
      source: { type: "tool" as const, messageID: "msg_2", id: "e" },
    }
    const waiting = open(
      [
        user("msg_1", "go"),
        assistant("msg_2", [call("e", "edit", { path: "a.ts" }, { status: "running" })], { time: { created: 5 } }),
      ],
      { permissions: [request] },
    )
    expect(waiting.blocks[waiting.blocks.length - 1]).toMatchObject({
      kind: "permission",
      id: "per_1",
      action: "edit",
      tool: "e",
    })
    expect(waiting.view.row.status).toBe("needs-you")
    expect(waiting.view.needs).toHaveLength(1)
    const tools = waiting.blocks[0]
    expect(tools?.kind === "toolGroup" && tools.tools[0]?.approval).toBe("waiting")
  })

  test("question: chips while it waits, the answer afterwards", () => {
    const input = {
      questions: [
        {
          header: "Lang",
          question: "Which?",
          options: [
            { label: "A", description: "a" },
            { label: "B", description: "b" },
          ],
        },
      ],
    }
    const form: FormInfo = {
      id: "frm_1",
      sessionID: "ses_a",
      title: "Questions",
      metadata: { kind: "question", tool: { messageID: "msg_2", id: "q" } },
      fields: [{ key: "q0", type: "string", options: [{ value: "A", label: "A" }] }],
    }
    const asking = open(
      [
        user("msg_1", "go"),
        assistant("msg_2", [call("q", "question", input, { status: "running" })], { time: { created: 5 } }),
      ],
      { forms: [form] },
    )
    expect(asking.blocks[0]).toMatchObject({ kind: "question", status: "pending", formID: "frm_1" })
    expect(asking.view.needs).toHaveLength(1)
    const answered = open(turn(call("q", "question", input, { status: "completed", metadata: { answers: [["B"]] } })))
    expect(answered.blocks[0]).toMatchObject({ kind: "question", status: "answered", answers: [["B"]] })
    expect(answered.view.needs).toHaveLength(0)
  })

  test("todos: only the latest list of the session, as one progress line", () => {
    const list = (...status: string[]) => ({
      todos: status.map((value, index) => ({ content: `step ${index}`, status: value })),
    })
    const { blocks } = open([
      user("msg_1", "go"),
      assistant("msg_2", [call("t1", "todowrite", list("in_progress", "pending"))]),
      assistant("msg_3", [call("t2", "todowrite", list("completed", "in_progress"))]),
      idle("msg_4", "succeeded"),
    ])
    expect(blocks).toEqual([
      {
        kind: "todos",
        done: 1,
        total: 2,
        items: [
          { content: "step 0", status: "completed" },
          { content: "step 1", status: "in_progress" },
        ],
      },
    ])
  })

  test("compaction: a separator", () => {
    const { blocks } = open([
      user("msg_1", "go"),
      { type: "compaction", id: "msg_2", status: "completed", reason: "auto", summary: "s", time: { created: 5 } },
    ])
    expect(blocks).toEqual([{ kind: "compaction", status: "completed", reason: "auto", summary: "s" }])
  })

  test("retry: a line while the step waits", () => {
    const { blocks } = open([
      user("msg_1", "go"),
      assistant("msg_2", [], {
        retry: { attempt: 2, at: 9, error: { type: "provider.internal", message: "overloaded" } },
        time: { created: 5 },
      }),
    ])
    expect(blocks).toEqual([{ kind: "retry", attempt: 2, at: 9, message: "overloaded" }])
  })

  test("error: one line, and an interruption is a status, not an error", () => {
    const failure = { type: "provider.invalid-request", message: "no" }
    const failed = open(
      [
        user("msg_1", "go"),
        assistant("msg_2", [], { error: failure, finish: "error" }),
        idle("msg_3", "failed", failure),
      ],
      {},
      { outcome: "failed" },
    )
    expect(failed.blocks).toEqual([{ kind: "error", message: "no", code: "provider.invalid-request" }])
    expect(failed.view.turns[0]?.status).toBe("error")
    expect(failed.view.row.status).toBe("error")

    const aborted = open([
      user("msg_1", "go"),
      assistant("msg_2", [text("par")], { error: { type: "aborted", message: "Step interrupted" }, finish: "error" }),
      idle("msg_3", "interrupted"),
    ])
    expect(aborted.blocks.map((block) => block.kind)).toEqual(["text"])
    expect(aborted.view.turns[0]?.status).toBe("interrupted")
  })

  test("unknown: a part kind and a message kind this version does not know are lines, not crashes", () => {
    const strange = { type: "hologram", text: "?" } as unknown as Parameters<typeof assistant>[1][number]
    const { blocks } = open([
      user("msg_1", "go"),
      assistant("msg_2", [strange, text("after")]),
      { type: "teleport", id: "msg_3", time: { created: 5 } } as never,
      { type: "synthetic", id: "msg_4", text: "hidden text", description: "A note", time: { created: 6 } },
    ])
    expect(blocks).toEqual([
      { kind: "unknown", label: "hologram" },
      { kind: "text", text: "after", streaming: false },
      { kind: "unknown", label: "A note" },
    ])
  })

  test("route: calls are routed by name, the rest are plain tools", () => {
    expect(["edit", "write", "patch", "subagent", "todowrite", "question", "read", "mcp_x"].map(Rules.route)).toEqual([
      "diff",
      "diff",
      "diff",
      "subagent",
      "todos",
      "question",
      "tool",
      "tool",
    ])
  })
})
