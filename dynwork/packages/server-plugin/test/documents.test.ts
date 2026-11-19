import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Schema } from "effect"
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

describe("what main is asked before a write", () => {
  const call = (tool: string, input: unknown) => ({ tool, sessionID: "ses_q3", id: "call_1", input })

  test("a creation, and an edit naming its document and whether it replaces the content from a blob", () => {
    expect(DynWorkDocuments.asking(call("documents_documents_create", { name: "a.md", document_id: "x" }))).toEqual({
      id: "call_1",
      session: "ses_q3",
      verb: "create",
    })
    expect(
      DynWorkDocuments.asking(call("documents_documents_edit", { document_id: "d", ops: [{ op: "str_replace" }] })),
    ).toEqual({ id: "call_1", session: "ses_q3", verb: "edit", document: "d" })
    expect(
      DynWorkDocuments.asking(call("documents_documents_edit", { document_id: "d", content_blob_ref: "blob-1" })),
    ).toEqual({ id: "call_1", session: "ses_q3", verb: "edit", document: "d", replace: true })
  })

  test("an edit main cannot read the document of is still asked, and other calls are not asked about", () => {
    expect(DynWorkDocuments.asking(call("documents_documents_edit", "not a record"))).toEqual({
      id: "call_1",
      session: "ses_q3",
      verb: "edit",
    })
    expect(DynWorkDocuments.asking(call("documents_documents_upload", { name: "a.html" }))).toBeUndefined()
    expect(DynWorkDocuments.asking(call("documents_documents_read", { document_id: "d" }))).toBeUndefined()
  })

  test("main's refusal travels in its answer, and the ask and the answer keep their shape across the RPC", () => {
    const answer = { id: "call_1", refuse: "Upload the whole page again." }
    expect(Schema.decodeUnknownSync(DynWorkDocuments.Answer)(answer)).toEqual(answer)
    const ask = { id: "call_1", session: "ses_q3", verb: "edit" as const, document: "d", replace: true }
    expect(Schema.decodeUnknownSync(DynWorkDocuments.Ask)(ask)).toEqual(ask)
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

describe("what the user confirms before the agent shares", () => {
  const call = (input: unknown, sessionID = "ses_q3", tool = "documents_documents_share") => ({
    tool,
    sessionID,
    id: "call_s",
    input,
  })

  test("documents_share asks for confirmation in its own conversation, naming what, with whom and at which level", () => {
    expect(
      DynWorkDocuments.sharing(
        call({ document_id: "d1", subject_kind: "user", subject_value: "user-luis", level: "edit", message: "fyi" }),
      ),
    ).toEqual({
      id: "call_s",
      session: "ses_q3",
      kind: "grant",
      document: "d1",
      subject: { kind: "user", value: "user-luis" },
      level: "edit",
    })
    // Each conversation asks for itself: what one allowed says nothing about another.
    expect(
      DynWorkDocuments.sharing(
        call(
          { folder_id: "f1", subject_kind: "group", subject_value: "sales", level: "view", valid_until: "2026-12-01" },
          "ses_other",
        ),
      ),
    ).toEqual({
      id: "call_s",
      session: "ses_other",
      kind: "grant",
      folder: "f1",
      subject: { kind: "group", value: "sales" },
      level: "view",
      until: "2026-12-01",
    })
  })

  test("a person the conversation looked up with documents_people shows by name and email", () => {
    DynWorkDocuments.heard({
      tool: "documents_documents_people",
      sessionID: "ses_people",
      id: "call_p",
      input: { query: "jes" },
      status: "completed",
      result: {
        output: {
          people: [
            { user_id: "e51c808f-1", name: "Jesús Pérez", email: "jesus.perez@dynapps.es", access: "view" },
            { user_id: "e51c808f-2", name: "Jesús Gil" },
          ],
        },
      },
    })
    const grant = (value: string, session = "ses_people") =>
      DynWorkDocuments.sharing(
        call({ document_id: "d1", subject_kind: "user", subject_value: value, level: "view" }, session),
      )?.subject
    expect(grant("e51c808f-1")).toEqual({
      kind: "user",
      value: "e51c808f-1",
      name: "Jesús Pérez",
      email: "jesus.perez@dynapps.es",
    })
    expect(grant("e51c808f-2")).toEqual({ kind: "user", value: "e51c808f-2", name: "Jesús Gil" })
    expect(
      DynWorkDocuments.sharing(call({ document_id: "d1", transfer_to: "e51c808f-1" }, "ses_people"))?.subject,
    ).toMatchObject({
      name: "Jesús Pérez",
    })
    // An email is shown as it is; an id never seen, or seen in another conversation, stays the raw id.
    expect(grant("luis@dynapps.es")).toEqual({ kind: "user", value: "luis@dynapps.es" })
    expect(grant("e51c808f-9")).toEqual({ kind: "user", value: "e51c808f-9" })
    expect(grant("e51c808f-1", "ses_other")).toEqual({ kind: "user", value: "e51c808f-1" })
  })

  test("only a completed documents_people answer is kept", () => {
    const people = { people: [{ user_id: "u-x", name: "Xavi" }] }
    for (const event of [
      { tool: "documents_documents_people", status: "error" as const, result: { output: people } },
      { tool: "documents_documents_access", status: "completed" as const, result: { output: people } },
      { tool: "documents_documents_people", status: "completed" as const, result: { output: "3 people" } },
    ])
      DynWorkDocuments.heard({ ...event, sessionID: "ses_px", id: "c", input: {} })
    expect(DynWorkDocuments.sharing(call({ subject_kind: "user", subject_value: "u-x" }, "ses_px"))?.subject).toEqual({
      kind: "user",
      value: "u-x",
    })
  })

  test("a transfer and a revoke_all are asked about too, each as what it is", () => {
    expect(DynWorkDocuments.sharing(call({ document_id: "d1", transfer_to: "user-luis" }))).toEqual({
      id: "call_s",
      session: "ses_q3",
      kind: "transfer",
      document: "d1",
      subject: { kind: "user", value: "user-luis" },
    })
    expect(DynWorkDocuments.sharing(call({ document_id: "d1", revoke_all: true }))).toEqual({
      id: "call_s",
      session: "ses_q3",
      kind: "revoke",
      document: "d1",
    })
  })

  test("nothing is shared unasked: a call whose input cannot be read is still asked about", () => {
    expect(DynWorkDocuments.sharing(call("not a record"))).toEqual({ id: "call_s", session: "ses_q3", kind: "grant" })
    expect(DynWorkDocuments.sharing(call({ document_id: 7, level: ["edit"] }))).toEqual({
      id: "call_s",
      session: "ses_q3",
      kind: "grant",
    })
  })

  test("no other tool asks: not a write, a read, the access check, or another server's share", () => {
    for (const tool of [
      "documents_documents_create",
      "documents_documents_access",
      "documents_documents_people",
      "drive_documents_share",
      "documents_share",
      "documents_documents_share_all",
    ])
      expect(DynWorkDocuments.sharing(call({ document_id: "d1" }, "ses_q3", tool))).toBeUndefined()
  })

  test("a scheduled task's conversation has nobody to confirm: its share is refused at once", () => {
    expect(DynWorkDocuments.unattended("ses_aut_dynwork_3f2a")).toBe(true)
    expect(DynWorkDocuments.unattended("ses_aut_1")).toBe(true)
    expect(DynWorkDocuments.unattended("ses_q3")).toBe(false)
    expect(DynWorkDocuments.nobody).toContain("scheduled task")
    expect(DynWorkDocuments.nobody).toContain("nothing was shared")
  })

  test("a refusal tells the agent what the user declined, and not to try again on its own", () => {
    const share = { id: "c", session: "ses_q3" }
    expect(
      DynWorkDocuments.declined({
        ...share,
        kind: "grant",
        document: "d1",
        subject: { kind: "user", value: "user-luis" },
        level: "edit",
      }),
    ).toBe(
      "The user declined to share document d1 with user user-luis (edit): nothing was shared. Do not try again unless the user asks you to.",
    )
    expect(
      DynWorkDocuments.declined({ ...share, kind: "grant", folder: "f1", subject: { kind: "group", value: "sales" } }),
    ).toBe(
      "The user declined to share folder f1 with group sales: nothing was shared. Do not try again unless the user asks you to.",
    )
    expect(
      DynWorkDocuments.declined({
        ...share,
        kind: "transfer",
        document: "d1",
        subject: { kind: "user", value: "user-luis" },
      }),
    ).toBe(
      "The user declined to transfer ownership of document d1 to user user-luis: nothing changed. Do not try again unless the user asks you to.",
    )
    expect(DynWorkDocuments.declined({ ...share, kind: "revoke", document: "d1" })).toBe(
      "The user declined to revoke every grant on document d1: nothing changed. Do not try again unless the user asks you to.",
    )
  })

  test("the share and the user's decision keep their shape across the RPC", () => {
    const share = {
      id: "c",
      session: "ses_q3",
      kind: "grant" as const,
      document: "d1",
      subject: { kind: "user", value: "u" },
      level: "view",
      until: "2026-12-01",
    }
    expect(Schema.decodeUnknownSync(DynWorkDocuments.Share)(share)).toEqual(share)
    expect(Schema.decodeUnknownSync(DynWorkDocuments.Decision)({ id: "c", allow: false })).toEqual({
      id: "c",
      allow: false,
    })
  })
})

describe("waiting for the user's decision on a share", () => {
  const shown: DynWorkDocuments.Share[] = []
  const withdrawn: string[] = []
  const confirmer: DynWorkDocuments.Confirmer = {
    confirm: (share) => Effect.sync(() => void shown.push(share)),
    withdraw: (id) => Effect.sync(() => void withdrawn.push(id)),
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  const share = (id: string): DynWorkDocuments.Share => ({ id, session: "ses_q3", kind: "revoke", document: "d1" })

  test("the share is published and the call waits for the user's decision, as long as it takes", async () => {
    const running = Effect.runPromise(DynWorkDocuments.confirm(confirmer, share("call_x")))
    await settle()
    expect(shown.at(-1)).toEqual(share("call_x"))
    expect(DynWorkDocuments.shares().shares).toContainEqual(share("call_x"))
    expect(DynWorkDocuments.decide({ id: "call_x", allow: true })).toEqual({ accepted: true })
    expect(await running).toBe("allow")
    expect(DynWorkDocuments.shares().shares).not.toContainEqual(share("call_x"))
    const refused = Effect.runPromise(DynWorkDocuments.confirm(confirmer, share("call_y")))
    await settle()
    DynWorkDocuments.decide({ id: "call_y", allow: false })
    expect(await refused).toBe("reject")
  })

  test("nobody hearing the share refuses it, instead of leaving it waiting for nobody", async () => {
    const outcome = await Effect.runPromise(DynWorkDocuments.confirm(confirmer, share("call_unheard"), "30 millis"))
    expect(outcome).toBe("unheard")
    // The card that never showed is withdrawn, and a decision after it changes nothing.
    expect(withdrawn).toContain("call_unheard")
    expect(DynWorkDocuments.decide({ id: "call_unheard", allow: true })).toEqual({ accepted: false })
    expect(DynWorkDocuments.unheard).toContain("could not ask the user")
    expect(DynWorkDocuments.unheard).toContain("nothing was shared")
  })

  test("a card main shows waits for the user past that window, as long as it takes", async () => {
    const running = Effect.runPromise(DynWorkDocuments.confirm(confirmer, share("call_shown"), "30 millis"))
    await settle()
    expect(DynWorkDocuments.shown({ id: "call_shown" })).toEqual({ accepted: true })
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(DynWorkDocuments.shares().shares).toContainEqual(share("call_shown"))
    DynWorkDocuments.decide({ id: "call_shown", allow: true })
    expect(await running).toBe("allow")
    expect(DynWorkDocuments.shown({ id: "call_shown" })).toEqual({ accepted: false })
  })

  test("a stopped call withdraws its card, and a decision for nothing that waits is not accepted", async () => {
    expect(DynWorkDocuments.decide({ id: "call_gone", allow: true })).toEqual({ accepted: false })
    const fiber = Effect.runFork(DynWorkDocuments.confirm(confirmer, share("call_z")))
    await settle()
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(withdrawn).toContain("call_z")
    expect(DynWorkDocuments.decide({ id: "call_z", allow: true })).toEqual({ accepted: false })
    expect(DynWorkDocuments.shares().shares).not.toContainEqual(share("call_z"))
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

  test("tell the agent that an edit of an HTML page is refused and the page is uploaded again instead", () => {
    const text = DynWorkDocuments.rules(["documents"])
      .map((rule) => rule.instructions)
      .join("\n")
    expect(text).toContain("refuses documents_edit on an HTML document")
    expect(text).toContain("documents_upload")
  })

  test("name no product the user does not know", () => {
    const text = DynWorkDocuments.rules(["documents"])
      .map((rule) => rule.instructions)
      .join("\n")
    expect(text).not.toMatch(/systemprompt|agent farm|routine/i)
  })
})
