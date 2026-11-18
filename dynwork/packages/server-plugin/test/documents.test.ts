import { describe, expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { DynWorkDocuments } from "../src/documents"
import { DynWorkInstructions } from "../src/instructions"
import { DynWorkMapping } from "../src/mapping"
import { alpha, apply } from "./fixture"

// The `documents` server's tools as the service sees them: which calls are the agent's writes, what a completed one
// says it touched, how main adds a folder and a message before one, and the rules the agent reads about the server.

const done = (tool: string, input: unknown, output: unknown) => ({
  tool,
  sessionID: "ses_q3",
  id: "call_1",
  input,
  status: "completed" as const,
  result: { output },
})

describe("which calls are writes", () => {
  test("the five writes of the server, as OpenCode names a server's tool", () => {
    expect(
      ["create", "edit", "upload", "update", "copy"].map((tool) =>
        DynWorkDocuments.verb(`documents_documents_${tool}`),
      ),
    ).toEqual(["create", "edit", "upload", "update", "copy"])
  })

  test("not a read, a comment, another server's tool, or a tool that only ends the same way", () => {
    for (const tool of [
      "documents_documents_read",
      "documents_documents_comment",
      "documents_documents_trash",
      "other_documents_create",
      "documents_create",
      "documents_documents_create_all",
      "edit",
    ])
      expect(DynWorkDocuments.verb(tool)).toBeUndefined()
  })
})

describe("what a completed write touched", () => {
  test("a creation names its document and revision, and keeps nothing else the server said", () => {
    const touched = DynWorkDocuments.touch(
      done(
        "documents_documents_create",
        { template_id: "blank-markdown", name: "Plan.md", message: "x", content: { markdown: "private" } },
        { document_id: "doc-1", revision_id: "rev-1", format: "markdown", name: "Plan.md", written: ["l1| text"] },
      ),
    )
    expect(touched).toEqual({
      session: "ses_q3",
      call: "call_1",
      verb: "create",
      input: { name: "Plan.md", message: "x" },
      output: { document_id: "doc-1", revision_id: "rev-1", format: "markdown", name: "Plan.md" },
    })
  })

  test("an upload names the blob to import", () => {
    expect(
      DynWorkDocuments.touch(
        done(
          "documents_documents_upload",
          { name: "a.html", mime: "text/html", content_base64: "PGgxLz4=" },
          {
            mode: "inline",
            blob_ref: "abc",
            mime: "text/html",
          },
        ),
      ),
    ).toMatchObject({ verb: "upload", input: { name: "a.html", mime: "text/html" }, output: { blob_ref: "abc" } })
  })

  test("a proposal says so, through the id of its proposal", () => {
    expect(
      DynWorkDocuments.touch(
        done("documents_documents_edit", { document_id: "d", mode: "propose" }, { revision_id: "r", proposal_id: "p" }),
      )?.output.proposal_id,
    ).toBe("p")
  })

  test("a failed write, a read and an answer that is not a record are nothing", () => {
    expect(
      DynWorkDocuments.touch({ ...done("documents_documents_create", {}, {}), status: "error", result: undefined }),
    ).toBeUndefined()
    expect(DynWorkDocuments.touch(done("documents_documents_read", { document_id: "d" }, {}))).toBeUndefined()
    expect(DynWorkDocuments.touch(done("documents_documents_create", {}, "created Plan.md"))).toBeUndefined()
    expect(DynWorkDocuments.touch(done("documents_documents_create", "not a record", {}))).toBeUndefined()
  })
})

describe("what main adds before a write", () => {
  const asks: DynWorkDocuments.Ask[] = []
  const emitter: DynWorkDocuments.Emitter = { ask: (request) => Effect.sync(() => void asks.push(request)) }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  test("the ask is published and main's answer is what the write waits for", async () => {
    const running = Effect.runPromise(
      DynWorkDocuments.ask(emitter, { id: "call_a", session: "ses_q3", verb: "create" }),
    )
    await settle()
    expect(asks.at(-1)).toEqual({ id: "call_a", session: "ses_q3", verb: "create" })
    expect(DynWorkDocuments.answer({ id: "call_a", folder: "f1", message: "Q3 by DynWork" })).toEqual({
      accepted: true,
    })
    expect(await running).toEqual({ id: "call_a", folder: "f1", message: "Q3 by DynWork" })
  })

  test("an answer for nothing that waits is not accepted, and a stopped write stops waiting", async () => {
    expect(DynWorkDocuments.answer({ id: "call_gone" })).toEqual({ accepted: false })
    const fiber = Effect.runFork(DynWorkDocuments.ask(emitter, { id: "call_b", session: "ses_q3", verb: "edit" }))
    await settle()
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(DynWorkDocuments.answer({ id: "call_b" })).toEqual({ accepted: false })
  })

  test("a new document takes the folder only when the agent named none, and every write keeps its message first", () => {
    const answer = { id: "x", folder: "f1", message: "Q3 by DynWork" }
    expect(DynWorkDocuments.apply("create", { name: "a" }, answer)).toEqual({
      name: "a",
      folder_id: "f1",
      message: "Q3 by DynWork",
    })
    expect(DynWorkDocuments.apply("create", { name: "a", folder_id: "mine", message: "Draft" }, answer)).toEqual({
      name: "a",
      folder_id: "mine",
      message: "Draft (Q3 by DynWork)",
    })
    expect(DynWorkDocuments.apply("edit", { document_id: "d" }, answer)).toEqual({
      document_id: "d",
      message: "Q3 by DynWork",
    })
  })

  test("a message already signed is not signed twice, and an answer with nothing leaves the input as it was", () => {
    expect(
      DynWorkDocuments.apply("edit", { message: "Fix (Q3 by DynWork)" }, { id: "x", message: "Q3 by DynWork" }),
    ).toEqual({
      message: "Fix (Q3 by DynWork)",
    })
    const input = { document_id: "d" }
    expect(DynWorkDocuments.apply("edit", input, { id: "x" })).toEqual(input)
    expect(DynWorkDocuments.apply("edit", "not a record", { id: "x", message: "m" })).toBe("not a record")
  })
})

describe("the rules about the server", () => {
  const documents = (url = "http://127.0.0.1:18101/api/v1/mcp/documents/mcp") => ({
    ...alpha,
    managed_mcp_servers: [{ id: "documents", name: "documents", url }],
  })

  test("follow the instance's own in the managed block, and only where the server is there", () => {
    const withServer = DynWorkMapping.map(apply(documents()))
    expect(withServer.rules).toBe(1)
    expect(withServer.instructions).toContain("alpha conventions")
    expect(withServer.instructions).toContain("## Documents in Dynwork")
    expect(withServer.instructions?.indexOf("alpha conventions")).toBeLessThan(
      withServer.instructions?.indexOf("Documents in Dynwork") ?? 0,
    )
    expect(withServer.instructions).toContain("documents_upload")
    expect(DynWorkInstructions.overBudget(withServer.instructions)).toBeUndefined()
    expect(DynWorkMapping.map(apply()).instructions).not.toContain("Documents in Dynwork")
  })

  test("are the block of a manifest that has no rules of its own, and none for a server the plugin could not take", () => {
    const only = DynWorkMapping.map(apply({ ...documents(), rules: [] }))
    expect(only.rules).toBe(0)
    expect(only.instructions).toContain("## Documents in Dynwork")
    // Plain HTTP to a remote host never carries the JWT: the plugin drops the server, and the rule with it.
    expect(
      DynWorkMapping.map(apply({ ...documents("http://example.com/mcp"), rules: [] })).instructions,
    ).toBeUndefined()
  })

  test("name no product the user does not know", () => {
    const text = DynWorkDocuments.rules(["documents"])
      .map((rule) => rule.instructions)
      .join("\n")
    expect(text).not.toMatch(/systemprompt|agent farm|routine/i)
  })
})
