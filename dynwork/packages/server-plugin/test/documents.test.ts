import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Schema } from "effect"
import type { DynWorkSync } from "../src/contract"
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
  test("the seven writes of the server, as OpenCode names a server's tool", () => {
    expect(
      ["create", "edit", "upload", "update", "copy", "import", "folder"].map((tool) =>
        DynWorkDocuments.verb(`documents_documents_${tool}`),
      ),
    ).toEqual(["create", "edit", "upload", "update", "copy", "import", "folder"])
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

  test("an import (0.84) names the document it made, like a creation", () => {
    expect(
      DynWorkDocuments.touch(
        done(
          "documents_documents_import",
          { blob_ref: "abc", name: "report.html", folder_id: "f1" },
          { document_id: "doc-2", revision_id: "rev-1", format: "html", name: "report.html", written: ["l1| x"] },
        ),
      ),
    ).toEqual({
      session: "ses_q3",
      call: "call_1",
      verb: "import",
      input: { name: "report.html", folder_id: "f1" },
      output: { document_id: "doc-2", revision_id: "rev-1", format: "html", name: "report.html" },
    })
  })

  test("a page rewritten whole (0.84) is an edit that names its document and the blob it was written from", () => {
    expect(
      DynWorkDocuments.touch(
        done(
          "documents_documents_edit",
          { document_id: "d", content_blob_ref: "blob-1", base_revision: "rev-1" },
          { document_id: "d", revision_id: "rev-2" },
        ),
      ),
    ).toMatchObject({
      verb: "edit",
      input: { document_id: "d", content_blob_ref: "blob-1" },
      output: { document_id: "d", revision_id: "rev-2" },
    })
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

  test("an import is asked about, so main can give it the conversation's folder; an upload still is not", () => {
    expect(
      DynWorkDocuments.asking(call("documents_documents_import", { blob_ref: "abc", name: "report.html" })),
    ).toEqual({ id: "call_1", session: "ses_q3", verb: "import" })
    expect(DynWorkDocuments.asking(call("documents_documents_upload", { name: "a.html" }))).toBeUndefined()
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

  test("an import takes the folder and the message, which documents_import carries since 0.84.0", () => {
    const answer = { id: "x", folder: "f1", message: "Q3 by DynWork" }
    expect(DynWorkDocuments.apply("import", { blob_ref: "abc", name: "a.html" }, answer)).toEqual({
      blob_ref: "abc",
      name: "a.html",
      folder_id: "f1",
      message: "Q3 by DynWork",
    })
    expect(DynWorkDocuments.apply("import", { blob_ref: "abc", name: "a.html", folder_id: "mine" }, answer)).toEqual({
      blob_ref: "abc",
      name: "a.html",
      folder_id: "mine",
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

describe("the conversation in each write (contextByMcp, 0.84)", () => {
  const call = (tool: string, input: unknown, session = "ses_q3") => ({ tool, sessionID: session, id: "call_1", input })
  const on = { contextByMcp: true }

  test("the writes that take a context_id are asked about with it on, and only the ones that write", () => {
    const asked = (tool: string, input: unknown) => DynWorkDocuments.asking(call(`documents_documents_${tool}`, input), on)
    expect(asked("comment", { action: "create", document_id: "d", body: "x" })?.verb).toBe("comment")
    expect(asked("comment", { action: "resolve", document_id: "d", comment_id: "c" })?.verb).toBe("comment")
    expect(asked("proposals", { action: "accept", proposal_id: "p" })?.verb).toBe("proposals")
    expect(asked("proposals", { action: "reject", proposal_id: "p" })?.verb).toBe("proposals")
    expect(asked("copy", { document_id: "d" })?.verb).toBe("copy")
    // Reading comments or proposals writes nothing.
    expect(asked("comment", { action: "list", document_id: "d" })).toBeUndefined()
    expect(asked("proposals", { document_id: "d" })).toBeUndefined()
    expect(asked("proposals", { action: "list" })).toBeUndefined()
    // Neither does a read, a share (it has its own card) or an upload (it takes no context).
    for (const tool of ["read", "list", "share", "upload", "people"])
      expect(asked(tool, { document_id: "d" })).toBeUndefined()
  })

  test("on 0.83 nothing but a creation, an import and an edit is asked about, as before", () => {
    for (const switches of [{}, { contextByMcp: false }]) {
      expect(DynWorkDocuments.asking(call("documents_documents_comment", { action: "create" }), switches)).toBeUndefined()
      expect(DynWorkDocuments.asking(call("documents_documents_copy", { document_id: "d" }), switches)).toBeUndefined()
      expect(DynWorkDocuments.asking(call("documents_documents_create", { name: "a" }), switches)?.verb).toBe("create")
    }
  })

  test("each write carries the context main gave its call, and only that: the agent's own never goes", () => {
    const answer = { id: "x", context: "ctx-q3" }
    // Another conversation's id the agent copied from a revision it read is replaced by its own conversation's.
    for (const write of ["create", "edit", "import", "comment", "proposals", "copy"] as const)
      expect(DynWorkDocuments.apply(write, { document_id: "d", context_id: "ctx-other" }, answer)).toEqual({
        document_id: "d",
        context_id: "ctx-q3",
      })
    // Main gave none (the registration failed, or main did not answer): the call goes without one.
    expect(DynWorkDocuments.apply("comment", { document_id: "d", context_id: "ctx-other" }, { id: "x" })).toEqual({
      document_id: "d",
    })
    expect(DynWorkDocuments.apply("create", { name: "a", context_id: "ctx-other" }, { id: "x", message: "m" })).toEqual({
      name: "a",
      message: "m",
    })
  })

  test("a comment, a review and a copy take only the context: no folder, no message", () => {
    const answer = { id: "x", folder: "f1", message: "Q3 by DynWork", context: "ctx-q3" }
    expect(DynWorkDocuments.apply("comment", { action: "create", body: "x" }, answer)).toEqual({
      action: "create",
      body: "x",
      context_id: "ctx-q3",
    })
    expect(DynWorkDocuments.apply("copy", { document_id: "d" }, answer)).toEqual({ document_id: "d", context_id: "ctx-q3" })
    expect(DynWorkDocuments.apply("proposals", { action: "accept" }, answer)).toEqual({
      action: "accept",
      context_id: "ctx-q3",
    })
  })

  test("a write refused for a context the instance does not know names it to main; anything else does not", () => {
    const refused = (tool: string, context: string | undefined, message: string) =>
      DynWorkDocuments.stale({
        ...call(`documents_documents_${tool}`, { name: "a", ...(context === undefined ? {} : { context_id: context }) }),
        status: "error",
        error: { message },
      })
    const unknown = (id: string) =>
      `context ${id} is not one of your conversations: send the id of a conversation you own (POST /api/v1/core/contexts creates one), or none to write without one`
    expect(refused("create", "ctx-q3", unknown("ctx-q3"))).toEqual({ session: "ses_q3", context: "ctx-q3" })
    expect(refused("comment", "ctx-q3", unknown("ctx-q3"))).toEqual({ session: "ses_q3", context: "ctx-q3" })
    expect(refused("create", "ctx-q3", unknown("ctx-other"))).toBeUndefined()
    expect(refused("create", undefined, unknown("ctx-q3"))).toBeUndefined()
    expect(refused("create", "ctx-q3", "no such folder")).toBeUndefined()
    expect(refused("read", "ctx-q3", unknown("ctx-q3"))).toBeUndefined()
    expect(
      DynWorkDocuments.stale({ ...done("documents_documents_create", { context_id: "ctx-q3" }, {}) }),
    ).toBeUndefined()
  })

  test("the context and the stale conversation keep their shape across the RPC", () => {
    const answer = { id: "call_1", message: "m", context: "ctx-q3" }
    expect(Schema.decodeUnknownSync(DynWorkDocuments.Answer)(answer)).toEqual(answer)
    const stale = { session: "ses_q3", context: "ctx-q3" }
    expect(Schema.decodeUnknownSync(DynWorkDocuments.Stale)(stale)).toEqual(stale)
  })
})

describe("folders the agent makes (mcpFolders, 0.84)", () => {
  const refused = (input: unknown, message: string) => ({
    tool: "documents_documents_folder",
    sessionID: "ses_q3",
    id: "call_7",
    input,
    status: "error" as const,
    error: { message },
  })
  const taken = (name: string) =>
    `a folder named "${name}" already exists there; choose another name or use that folder`

  test("a folder refused as name_taken asks main which one is there, under its parent or at the root", () => {
    expect(
      DynWorkDocuments.taken(refused({ action: "create", name: "Billing", parent_id: "f-art" }, taken("Billing"))),
    ).toEqual({ id: "call_7:taken", session: "ses_q3", verb: "folder", name: "Billing", parent: "f-art" })
    for (const input of [
      { action: "create", name: "Artifacts" },
      { action: "create", name: "Artifacts", parent_id: null },
    ])
      expect(DynWorkDocuments.taken(refused(input, taken("Artifacts")))).toEqual({
        id: "call_7:taken",
        session: "ses_q3",
        verb: "folder",
        name: "Artifacts",
      })
  })

  test("any other failure, a rename, a folder made and another tool ask nothing", () => {
    expect(DynWorkDocuments.taken(refused({ action: "create", name: "A" }, "forbidden"))).toBeUndefined()
    expect(DynWorkDocuments.taken(refused({ action: "update", folder_id: "f", name: "A" }, taken("A")))).toBeUndefined()
    expect(DynWorkDocuments.taken(refused({ action: "create" }, taken("A")))).toBeUndefined()
    expect(
      DynWorkDocuments.taken({ ...refused({ action: "create", name: "A" }, taken("A")), tool: "documents_documents_create" }),
    ).toBeUndefined()
    expect(
      DynWorkDocuments.taken(done("documents_documents_folder", { action: "create", name: "A" }, { folder_id: "f" })),
    ).toBeUndefined()
  })

  test("the refusal the agent reads names the folder to use", () => {
    expect(DynWorkDocuments.reuse(taken("Billing"), "f-bill")).toBe(
      `${taken("Billing")} It is folder_id f-bill: use that folder.`,
    )
  })

  test("a folder made is a write main hears of, with the folder it made", () => {
    expect(
      DynWorkDocuments.touch(
        done(
          "documents_documents_folder",
          { action: "create", name: "Q3 report", parent_id: "f-bill" },
          { folder_id: "f-q3", parent_id: "f-bill", name: "Q3 report" },
        ),
      ),
    ).toEqual({
      session: "ses_q3",
      call: "call_1",
      verb: "folder",
      input: { action: "create", name: "Q3 report", parent_id: "f-bill" },
      output: { folder_id: "f-q3", name: "Q3 report" },
    })
  })

  test("the folder ask and its answer keep their shape across the RPC", () => {
    const ask = { id: "call_7:taken", session: "ses_q3", verb: "folder" as const, name: "Billing", parent: "f-art" }
    expect(Schema.decodeUnknownSync(DynWorkDocuments.Ask)(ask)).toEqual(ask)
    const making = { ...ask, id: "call_7", making: true }
    expect(Schema.decodeUnknownSync(DynWorkDocuments.Ask)(making)).toEqual(making)
    const named = { id: "call_7", name: "Q3 report" }
    expect(Schema.decodeUnknownSync(DynWorkDocuments.Answer)(named)).toEqual(named)
  })

  test("with mcpFolders, a folder about to be made inside another asks main for its name; at the root, or on 0.83, not", () => {
    const making = (input: unknown, switches: DynWorkSync.Documents = { mcpFolders: true }) =>
      DynWorkDocuments.asking(
        { tool: "documents_documents_folder", sessionID: "ses_q3", id: "call_7", input },
        switches,
      )
    expect(making({ action: "create", name: "Sales", parent_id: "f-bill" })).toEqual({
      id: "call_7",
      session: "ses_q3",
      verb: "folder",
      name: "Sales",
      parent: "f-bill",
      making: true,
    })
    expect(making({ action: "create", name: "Artifacts" })).toBeUndefined()
    expect(making({ action: "create", name: "Artifacts", parent_id: null })).toBeUndefined()
    expect(making({ action: "update", folder_id: "f", name: "Sales", parent_id: "f-bill" })).toBeUndefined()
    expect(making({ action: "create", parent_id: "f-bill" })).toBeUndefined()
    expect(making({ action: "create", name: "Sales", parent_id: "f-bill" }, {})).toBeUndefined()
    expect(making({ action: "create", name: "Sales", parent_id: "f-bill" }, { contextByMcp: true })).toBeUndefined()
  })

  test("the folder takes the name main gives it, whatever the agent wrote; without one it keeps the agent's", () => {
    const input = { action: "create", name: "VAT analysis", parent_id: "f-bill" }
    expect(DynWorkDocuments.apply("folder", input, { id: "call_7", name: "Q3 report" })).toEqual({
      action: "create",
      name: "Q3 report",
      parent_id: "f-bill",
    })
    expect(DynWorkDocuments.apply("folder", input, { id: "call_7" })).toEqual(input)
    // A name is only ever a folder's: no other write takes it.
    expect(DynWorkDocuments.apply("create", { name: "a.md" }, { id: "x", name: "Q3 report" })).toEqual({ name: "a.md" })
    expect(
      DynWorkDocuments.apply("folder", { action: "update", folder_id: "f", name: "Mine" }, { id: "x", name: "Q3 report" }),
    ).toEqual({ action: "update", folder_id: "f", name: "Mine" })
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

  test("the people a documents_people call answered go to main as id, name and email only", () => {
    const answer = {
      people: [
        { user_id: "u-1", name: "Ana Ruiz", email: "ana@dynapps.es", access: "edit" },
        { user_id: "u-2", name: "Bea Gil" },
      ],
    }
    expect(
      DynWorkDocuments.heard({
        tool: "documents_documents_people",
        sessionID: "ses_seen",
        id: "c",
        input: { query: "a" },
        status: "completed",
        result: { output: answer },
      }),
    ).toEqual({
      people: [
        { user_id: "u-1", name: "Ana Ruiz", email: "ana@dynapps.es" },
        { user_id: "u-2", name: "Bea Gil" },
      ],
    })
    // Nothing to tell main: an empty answer, or another call.
    const none = { sessionID: "ses_seen", id: "c", input: {}, status: "completed" as const }
    expect(
      DynWorkDocuments.heard({ ...none, tool: "documents_documents_people", result: { output: { people: [] } } }),
    ).toBeUndefined()
    expect(
      DynWorkDocuments.heard({ ...none, tool: "documents_documents_read", result: { output: answer } }),
    ).toBeUndefined()
    const seen = { people: [{ user_id: "u-1", name: "Ana Ruiz", email: "ana@dynapps.es" }] }
    expect(Schema.decodeUnknownSync(DynWorkDocuments.Seen)(seen)).toEqual(seen)
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
  // The text is wrapped for the file; what the agent reads is the words.
  const flat = (text: string) => text.replace(/\s+/g, " ")

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

  test("send the work to the Drive, not to local files, and a page up from one program without the disk", () => {
    const text = flat(DynWorkDocuments.instructions())
    expect(text).toContain("not in local files")
    expect(text).toContain("only when the user asks for one")
    expect(text).toContain("inside one Code Mode call")
    expect(text).toContain("TextEncoder, then btoa over chunks")
    expect(text).toContain("Never write it to a file first, never start a local server, never fetch a file")
    expect(text).toContain("do not open it in a browser")
    // The managed block carries the same text.
    expect(flat(DynWorkDocuments.rules(["documents"])[0]?.instructions ?? "")).toBe(text)
  })

  test("do not let the agent judge a page's look from the text views", () => {
    const text = flat(DynWorkDocuments.instructions())
    expect(text).toContain("documents_read (model, outline) and documents_export (preview) show")
    expect(text).toContain("never judge how a page looks from them")
  })

  test("today's instance (0.83): a changed page is uploaded again as a new document, and the user is told", () => {
    for (const text of [flat(DynWorkDocuments.instructions()), flat(DynWorkDocuments.instructions({}))]) {
      expect(text).toContain("upload the whole changed page again under a new name")
      expect(text).toContain("you tell the user so in one line")
      expect(text).toContain("Dynwork imports that upload as a document of this conversation")
      expect(text).not.toContain("content_blob_ref")
      expect(text).not.toContain("documents_import")
      expect(text).not.toContain("documents_folder")
    }
  })

  test("rawHtmlByMcp (0.84): a page is changed in the same document with the blob it uploaded", () => {
    const text = flat(DynWorkDocuments.instructions({ rawHtmlByMcp: true }))
    expect(text).toContain("documents_edit with document_id, content_blob_ref and base_revision")
    expect(text).toContain("the same document, scripts kept")
    expect(text).not.toContain("as a new document next to the old one")
    // Only the way to change a page moved: a new page still waits for DynWork's import.
    expect(text).toContain("Dynwork imports that upload as a document of this conversation")
  })

  test("mcpFolders (0.84): the agent makes the conversation's folders and imports the upload itself, once, into it", () => {
    const text = flat(DynWorkDocuments.instructions({ mcpFolders: true }))
    expect(text).toContain("Artifacts/<project>/<conversation>")
    expect(text).toContain("documents_folder {action: create, name, parent_id}")
    expect(text).toContain("refused as name_taken with its folder_id")
    expect(text).toContain("never make a second one under another name")
    // DynWork names the project's and the conversation's folders (phase 23): the agent no longer picks a title.
    expect(text).toContain("<conversation> the conversation's title, and Dynwork gives both folders their exact names")
    expect(text).not.toContain("a short title for what the conversation is about")
    expect(text).toContain("call documents_import once with the returned blob_ref, the same name and the conversation's folder_id")
    expect(text).not.toContain("Dynwork files every document you create")
    expect(text).not.toContain("do not import it yourself")
    expect(text).not.toContain("content_blob_ref")
  })

  test("rawHtmlByMcp (0.84): an edit by ops that would strip a page is the instance's to refuse, and someone else's page is proposed", () => {
    const text = flat(DynWorkDocuments.instructions({ rawHtmlByMcp: true }))
    expect(text).toContain("refused as unsupported_op")
    expect(text).toContain("send the same documents_edit with mode: propose")
    expect(text).not.toContain("refuses documents_edit on an HTML document")
    expect(flat(DynWorkDocuments.instructions())).not.toContain("mode: propose")
  })

  test("contextByMcp (0.84): the agent leaves the conversation to Dynwork and repeats a write refused as unknown_context", () => {
    const text = flat(DynWorkDocuments.instructions({ contextByMcp: true }))
    expect(text).toContain("leave out context_id")
    expect(text).toContain("refused as unknown_context once more, unchanged")
    expect(flat(DynWorkDocuments.instructions())).not.toContain("context_id")
  })

  test("each account gets the variant of its instance: the switches main applies choose the rules the agent reads", () => {
    const at84 = { rawHtmlByMcp: true, mcpFolders: true, contextByMcp: true, peopleByRest: true }
    const mapped = (switches?: DynWorkDocuments.Switches) =>
      flat(DynWorkMapping.map(apply(documents(), switches === undefined ? {} : { documents: switches })).instructions ?? "")
    expect(mapped(at84)).toContain(flat(DynWorkDocuments.instructions(at84)))
    expect(mapped(at84)).not.toContain("look them up with documents_people")
    for (const off of [undefined, {}, { rawHtmlByMcp: false, mcpFolders: false, contextByMcp: false, peopleByRest: false }])
      expect(mapped(off)).toContain(flat(DynWorkDocuments.instructions()))
    expect(
      DynWorkInstructions.overBudget(DynWorkMapping.map(apply(documents(), { documents: at84 })).instructions),
    ).toBeUndefined()
  })

  test("both switches on read as both changes, and the rules carry them to the managed block", () => {
    const both = { rawHtmlByMcp: true, mcpFolders: true }
    const text = flat(DynWorkDocuments.instructions(both))
    expect(text).toContain("documents_import")
    expect(text).toContain("content_blob_ref")
    expect(flat(DynWorkDocuments.rules(["documents"], both)[0]?.instructions ?? "")).toBe(text)
    expect(DynWorkDocuments.rules(["other"], both)).toEqual([])
    for (const variant of [{}, { rawHtmlByMcp: true }, { mcpFolders: true }, both])
      expect(
        DynWorkInstructions.overBudget(DynWorkInstructions.block(DynWorkDocuments.rules(["documents"], variant))),
      ).toBeUndefined()
  })

  test("on 0.83 the agent looks a person up right before sharing; an instance that names people by id does not need it", () => {
    const line = "look them up with documents_people by name or email in the same Code Mode call"
    expect(flat(DynWorkDocuments.instructions())).toContain(line)
    expect(flat(DynWorkDocuments.instructions({ rawHtmlByMcp: true, mcpFolders: true }))).toContain(line)
    expect(flat(DynWorkDocuments.instructions({ peopleByRest: true }))).not.toContain(line)
    expect(flat(DynWorkDocuments.instructions({ peopleByRest: true }))).toContain("Before every documents_share")
    for (const variant of [{}, { peopleByRest: true }, { rawHtmlByMcp: true, mcpFolders: true }])
      expect(
        DynWorkInstructions.overBudget(DynWorkInstructions.block(DynWorkDocuments.rules(["documents"], variant))),
      ).toBeUndefined()
  })

  test("0.84 comments: the agent reopens a resolved thread and points a spreadsheet's comment at cells of a sheet", () => {
    const at84 = { reopenComments: true, rangeComments: true }
    const text = flat(DynWorkDocuments.instructions(at84))
    expect(text).toContain("documents_comment {action: reopen, comment_id}")
    expect(text).toContain("node is the sheet's node (sheet[<name>]) and cells an A1")
    expect(flat(DynWorkDocuments.instructions({ reopenComments: true }))).not.toContain("sheet[<name>]")
    expect(flat(DynWorkDocuments.instructions({ rangeComments: true }))).not.toContain("action: reopen")
    for (const off of [{}, { reopenComments: false, rangeComments: false }]) {
      expect(flat(DynWorkDocuments.instructions(off))).not.toContain("action: reopen")
      expect(flat(DynWorkDocuments.instructions(off))).not.toContain("sheet[<name>]")
    }
    const every = { rawHtmlByMcp: true, mcpFolders: true, contextByMcp: true, peopleByRest: true, ...at84 }
    expect(
      DynWorkInstructions.overBudget(DynWorkInstructions.block(DynWorkDocuments.rules(["documents"], every))),
    ).toBeUndefined()
  })

  test("name no product the user does not know", () => {
    for (const variant of [
      {},
      { rawHtmlByMcp: true },
      { mcpFolders: true },
      { contextByMcp: true },
      { rawHtmlByMcp: true, mcpFolders: true, contextByMcp: true, peopleByRest: true },
      { rangeComments: true, reopenComments: true },
    ])
      expect(DynWorkDocuments.instructions(variant)).not.toMatch(/systemprompt|agent farm|routine/i)
  })
})
