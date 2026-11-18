import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SpClient, SpDrive } from "../src"
import { startDrive, startFake } from "./fake"

const fake = startFake()

afterAll(() => fake.stop())

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const fail = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(effect))

const state = { jwt: "" }

beforeAll(async () => {
  state.jwt = (await run(SpClient.mintJwt(fake.url, fake.issuePat()))).token
})

beforeEach(() => {
  fake.state.drive = startDrive()
  fake.state.override = undefined
  fake.state.requests.length = 0
})

const text = (value: string) => new TextEncoder().encode(value)
const html = "<!doctype html><h1>Hola</h1><script>1</script>"

// Documents and folders go in through the client under test, as a user's would
const folder = (name: string, parentId?: string) => run(SpDrive.createFolder(fake.url, state.jwt, { name, parentId }))
const upload = (name: string, content: string, folderId?: string) =>
  run(SpDrive.importFile(fake.url, state.jwt, { name, bytes: text(content), mime: "text/html", folderId })).then(
    (created) => created.document,
  )
const sent = (path: string, method?: string) =>
  fake.state.requests.filter((entry) => entry.path === path && (method === undefined || entry.method === method))

describe("listing", () => {
  test("lists the user's documents with their size and access", async () => {
    await upload("a.html", html)
    const listing = await run(SpDrive.list(fake.url, state.jwt))
    expect(listing.documents.map((entry) => entry.name)).toEqual(["a.html"])
    expect(listing.documents[0]).toMatchObject({ format: "html", size_bytes: html.length, my_access: "own" })
    expect(listing.next_cursor).toBeNull()
    expect(sent("/api/v1/documents", "GET")[0]?.headers.authorization).toBe(`Bearer ${state.jwt}`)
  })

  test("a folder's listing brings its sub-folders and only its documents", async () => {
    const parent = await folder("Projects")
    const child = await folder("Q3", parent.id)
    await upload("inside.html", html, parent.id)
    await upload("outside.html", html)
    const listing = await run(SpDrive.list(fake.url, state.jwt, { scope: "folder", folder: parent.id }))
    expect(listing.documents.map((entry) => entry.name)).toEqual(["inside.html"])
    expect(listing.folders.map((entry) => entry.id)).toEqual([child.id])
    expect(sent("/api/v1/documents", "GET").at(-1)?.query).toBe(`?scope=folder&folder=${parent.id}`)
  })

  test("follows the cursor until the last page", async () => {
    await Promise.all(["a", "b", "c"].map((name) => upload(`${name}.html`, html)))
    const first = await run(SpDrive.list(fake.url, state.jwt, { sort: "name", limit: 2 }))
    expect(first.documents.map((entry) => entry.name)).toEqual(["a.html", "b.html"])
    const second = await run(
      SpDrive.list(fake.url, state.jwt, { sort: "name", limit: 2, cursor: first.next_cursor ?? "" }),
    )
    expect(second.documents.map((entry) => entry.name)).toEqual(["c.html"])
    expect(second.next_cursor).toBeNull()
    expect(sent("/api/v1/documents", "GET").at(-1)?.query).toContain(`cursor=${first.next_cursor}`)
  })

  test("search narrows the listing by name", async () => {
    await upload("report-q3.html", html)
    await upload("notes.html", html)
    const found = await run(SpDrive.search(fake.url, state.jwt, "REPORT"))
    expect(found.documents.map((entry) => entry.name)).toEqual(["report-q3.html"])
    expect(sent("/api/v1/documents", "GET").at(-1)?.query).toBe("?scope=mine&query=REPORT")
  })

  test("folders answers every folder, flat", async () => {
    const parent = await folder("Projects")
    const child = await folder("Q3", parent.id)
    const all = await run(SpDrive.folders(fake.url, state.jwt))
    expect(all.map((entry) => [entry.name, entry.parent_id ?? null])).toEqual([
      ["Projects", null],
      ["Q3", parent.id],
    ])
    expect(child.parent_id).toBe(parent.id)
  })
})

describe("reading", () => {
  test("get gives the head revision, the access and the folder path", async () => {
    const parent = await folder("Projects")
    const created = await upload("a.html", html, parent.id)
    const detail = await run(SpDrive.get(fake.url, state.jwt, created.id))
    expect(detail.head.id).toBe(created.head_revision_id)
    expect(detail).toMatchObject({ my_access: "own", folder_path: "Projects" })
  })

  test("a document that is not there is NotFound, with the instance's key", async () => {
    const error = await fail(SpDrive.get(fake.url, state.jwt, crypto.randomUUID()))
    expect(error).toBeInstanceOf(SpClient.NotFound)
    expect(error).toMatchObject({ endpoint: "GET /api/v1/documents/{id}", errorKey: "not_found" })
  })

  test("rendered keeps the scripts and reports the CSP of the answer, not a fixed one", async () => {
    const created = await upload("a.html", html)
    fake.state.drive.csp = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' https:"
    const shown = await run(SpDrive.rendered(fake.url, state.jwt, created.id))
    expect(shown.html).toBe(html)
    expect(shown.csp).toBe(fake.state.drive.csp)
    expect(shown.revision).toBe(created.head_revision_id)
    expect(shown.sha256).toHaveLength(64)
  })

  test("rendered of an earlier revision asks for it by id", async () => {
    const created = await upload("a.html", html)
    const first = created.head_revision_id
    await run(SpDrive.edit(fake.url, state.jwt, created.id, { ops: [{ op: "append_markdown", markdown: "x" }] }))
    const shown = await run(SpDrive.rendered(fake.url, state.jwt, created.id, { revision: first }))
    expect(shown.revision).toBe(first)
    expect(sent(`/api/v1/documents/${created.id}/rendered`)[0]?.query).toBe(`?revision=${first}`)
    const error = await fail(SpDrive.rendered(fake.url, state.jwt, created.id, { revision: crypto.randomUUID() }))
    expect(error).toBeInstanceOf(SpClient.NotFound)
  })

  test("rendered of a format that is not HTML is a Protocol error carrying the key", async () => {
    const created = await run(
      SpDrive.importFile(fake.url, state.jwt, { name: "n.md", bytes: text("# n"), mime: "text/markdown" }),
    )
    const error = await fail(SpDrive.rendered(fake.url, state.jwt, created.document.id))
    expect(error).toBeInstanceOf(SpClient.Protocol)
    expect(error).toMatchObject({ status: 400, errorKey: "unsupported_op" })
  })

  test("preview is the sanitised page with its own, stricter CSP", async () => {
    const created = await upload("a.html", html)
    const shown = await run(SpDrive.preview(fake.url, state.jwt, created.id))
    expect(shown.html).toContain("<p>")
    expect(shown.csp).toContain("default-src 'none'")
    expect(shown.csp).not.toContain("allow-scripts")
  })

  test("outline lists the nodes a comment can be anchored to and drops lines that are not nodes", async () => {
    const created = await upload("a.html", html)
    const nodes = await run(SpDrive.outline(fake.url, state.jwt, created.id))
    expect(nodes).toEqual({
      revision: created.head_revision_id,
      format: "html",
      nodes: [
        { id: "n1", hash: "3639efcd", text: "# Hola" },
        { id: "n2", hash: "9a8b7c6d", text: "second" },
      ],
    })
    expect(sent(`/api/v1/documents/${created.id}/read`)[0]?.query).toBe("?view=outline")
  })

  test("the text view lists every node, blank ones included, where the outline leaves paragraphs out", async () => {
    const created = await upload("b.html", html)
    const nodes = await run(SpDrive.outline(fake.url, state.jwt, created.id, "text"))
    expect(nodes.nodes).toEqual([
      { id: "n1", hash: "3639efcd", text: "# Hola" },
      { id: "n2", hash: "e3b0c442", text: "" },
      { id: "n3", hash: "9a8b7c6d", text: "second" },
    ])
    expect(sent(`/api/v1/documents/${created.id}/read`).at(-1)?.query).toBe("?view=text")
  })

  test("content gives the stored bytes, at the head or at an earlier revision", async () => {
    const created = await upload("notes.md", "# Notes")
    const head = await run(SpDrive.content(fake.url, state.jwt, created.id))
    expect(new TextDecoder().decode(head.bytes)).toBe("# Notes")
    expect(head.revision).toBe(created.head_revision_id)
    expect(sent(`/api/v1/documents/${created.id}/content`)[0]?.query).toBe("")
    await run(SpDrive.content(fake.url, state.jwt, created.id, { revision: created.head_revision_id }))
    expect(sent(`/api/v1/documents/${created.id}/content`)[1]?.query).toBe(`?revision=${created.head_revision_id}`)
    const error = await fail(SpDrive.content(fake.url, state.jwt, created.id, { revision: crypto.randomUUID() }))
    expect(error).toBeInstanceOf(SpClient.NotFound)
  })

  test("pdf gives the bytes of the PDF", async () => {
    const created = await upload("a.html", html)
    const file = await run(SpDrive.pdf(fake.url, state.jwt, created.id))
    expect(new TextDecoder().decode(file.bytes.subarray(0, 5))).toBe("%PDF-")
    expect(file.revision).toBe(created.head_revision_id)
    expect(sent(`/api/v1/documents/${created.id}/content`)[0]?.query).toBe("?format=pdf")
    await run(SpDrive.pdf(fake.url, state.jwt, created.id, { revision: created.head_revision_id }))
    expect(sent(`/api/v1/documents/${created.id}/content`)[1]?.query).toBe(
      `?format=pdf&revision=${created.head_revision_id}`,
    )
  })

  test("access and the agent cap tell what DynWork may do as an attended agent", async () => {
    const created = await upload("a.html", html)
    const shared = await run(SpDrive.access(fake.url, state.jwt, created.id))
    expect(shared).toMatchObject({ my_access: "own", grants: [], agent_cap: { cap: "edit" } })
    const target = await folder("Projects")
    const reading = await run(SpDrive.agentCap(fake.url, state.jwt, { kind: "folder", id: target.id }))
    expect(reading.agent_cap).toBe("suggest")
    expect(reading.attended.agent_cap).toBe("edit")
    const document = await run(SpDrive.agentCap(fake.url, state.jwt, { kind: "document", id: created.id }))
    expect(document).toMatchObject({ target_kind: "document", target_id: created.id })
  })
})

describe("importing", () => {
  test("a small file goes up as one multipart request, with the conversation", async () => {
    const parent = await folder("Artifacts")
    const context = crypto.randomUUID()
    const created = await run(
      SpDrive.importFile(fake.url, state.jwt, {
        name: "chart.html",
        bytes: text(html),
        mime: "text/html",
        folderId: parent.id,
        contextId: context,
      }),
    )
    expect(created.document).toMatchObject({ name: "chart.html", format: "html", folder_id: parent.id })
    expect(created.revision.actor_kind).toBe("agent")
    const request = sent("/api/v1/documents", "POST").at(-1)
    expect(request?.headers["content-type"]).toStartWith("multipart/form-data")
    expect(request?.headers["x-context-id"]).toBe(context)
    expect(fake.state.drive.documents.get(created.document.id)?.contexts).toEqual([context])
    expect(sent("/api/v1/uploads")).toHaveLength(0)
  })

  test("a template makes a document in the folder, with the conversation and no message", async () => {
    const parent = await folder("Reports")
    const context = crypto.randomUUID()
    const created = await run(
      SpDrive.create(fake.url, state.jwt, {
        templateId: "dynapps-word",
        name: "Q3 report",
        folderId: parent.id,
        contextId: context,
      }),
    )
    expect(created.document).toMatchObject({ name: "Q3 report", template_id: "dynapps-word", folder_id: parent.id })
    const request = sent("/api/v1/documents", "POST").at(-1)
    expect(request?.headers["content-type"]).toBe("application/json")
    expect(request?.headers["x-context-id"]).toBe(context)
    expect(JSON.parse(request?.body ?? "{}")).toEqual({
      template_id: "dynapps-word",
      name: "Q3 report",
      folder_id: parent.id,
    })
  })

  test("a file past the inline limit goes up in parts and is imported by its blob", async () => {
    fake.state.drive.partSize = 4 * 1024 * 1024
    const bytes = new Uint8Array(SpDrive.inlineLimit + 1).fill(7)
    const created = await run(
      SpDrive.importFile(fake.url, state.jwt, { name: "big.bin", bytes, message: "big by DynWork" }),
    )
    const stored = fake.state.drive.documents.get(created.document.id)
    expect(stored?.bytes.length).toBe(bytes.length)
    const parts = fake.state.requests.filter((entry) => entry.method === "PUT")
    expect(parts.map((entry) => entry.path.split("/").at(-1))).toEqual(["1", "2", "3"])
    expect(sent("/api/v1/documents/import", "POST")).toHaveLength(1)
    expect(JSON.parse(sent("/api/v1/documents/import", "POST")[0]?.body ?? "{}")).toMatchObject({
      name: "big.bin",
      message: "big by DynWork",
    })
  })

  test("an interrupted upload resumes with only the parts the instance lacks", async () => {
    fake.state.drive.partSize = 4
    const bytes = text("abcdefghij")
    const opened = await run(SpDrive.openUpload(fake.url, state.jwt, { name: "r.txt", mime: "text/plain", bytes }))
    expect(opened).toMatchObject({ part_size: 4, part_count: 3, missing_parts: [1, 2, 3] })
    fake.state.drive.uploads.get(opened.upload_id)?.parts.set(1, bytes.subarray(0, 4))
    const status = await run(SpDrive.uploadStatus(fake.url, state.jwt, opened.upload_id))
    expect(status.missing_parts).toEqual([2, 3])
    fake.state.requests.length = 0
    const blob = await run(SpDrive.finishUpload(fake.url, state.jwt, status, bytes))
    expect(fake.state.requests.filter((entry) => entry.method === "PUT").map((entry) => entry.path.at(-1))).toEqual([
      "2",
      "3",
    ])
    expect(fake.state.drive.blobs.get(blob.blob_ref)?.bytes).toEqual(bytes)
  })

  test("finishing an upload with other bytes than it was opened with sends nothing", async () => {
    const opened = await run(
      SpDrive.openUpload(fake.url, state.jwt, { name: "r.txt", mime: "text/plain", bytes: text("abc") }),
    )
    fake.state.requests.length = 0
    const error = await fail(SpDrive.finishUpload(fake.url, state.jwt, opened, text("abcd")))
    expect(error).toBeInstanceOf(SpClient.Protocol)
    expect(fake.state.requests).toHaveLength(0)
  })

  test("a blob the agent uploaded is imported by its reference, with the message and the conversation", async () => {
    const parent = await folder("Artifacts")
    const bytes = text(html)
    const opened = await run(SpDrive.openUpload(fake.url, state.jwt, { name: "agent.html", mime: "text/html", bytes }))
    const blob = await run(SpDrive.finishUpload(fake.url, state.jwt, opened, bytes))
    const context = crypto.randomUUID()
    const created = await run(
      SpDrive.importBlob(fake.url, state.jwt, {
        blobRef: blob.blob_ref,
        name: "agent.html",
        folderId: parent.id,
        message: "Chart by DynWork",
        contextId: context,
      }),
    )
    expect(created.document).toMatchObject({ name: "agent.html", folder_id: parent.id })
    const request = sent("/api/v1/documents/import", "POST")[0]
    expect(request?.headers["x-context-id"]).toBe(context)
    expect(JSON.parse(request?.body ?? "{}")).toMatchObject({ blob_ref: blob.blob_ref, message: "Chart by DynWork" })
    const shown = await run(SpDrive.rendered(fake.url, state.jwt, created.document.id))
    expect(shown.html).toBe(html)
  })

  test("a blob the instance does not hold is refused, not imported", async () => {
    const error = await fail(SpDrive.importBlob(fake.url, state.jwt, { blobRef: "0".repeat(64), name: "x.html" }))
    expect(error).toBeInstanceOf(SpClient.Protocol)
    expect(error).toMatchObject({ status: 400 })
  })
})

describe("editing", () => {
  test("an edit lands as the agent with the message and the conversation", async () => {
    const created = await upload("a.html", html)
    const context = crypto.randomUUID()
    const edited = await run(
      SpDrive.edit(fake.url, state.jwt, created.id, {
        ops: [{ op: "append_markdown", markdown: "More" }],
        message: "Report Q3 by DynWork",
        contextId: context,
        opId: "op-1",
      }),
    )
    expect(edited._tag).toBe("Landed")
    expect(edited.revision).toMatchObject({ message: "Report Q3 by DynWork", actor_kind: "agent" })
    const revisions = await run(SpDrive.revisions(fake.url, state.jwt, created.id))
    expect(revisions.map((entry) => entry.message)).toEqual(["Report Q3 by DynWork", null])
    expect(fake.state.drive.documents.get(created.id)?.contexts).toContain(context)
    const body = JSON.parse(sent(`/api/v1/documents/${created.id}/edits`)[0]?.body ?? "{}")
    expect(body).toMatchObject({ op_id: "op-1", message: "Report Q3 by DynWork" })
    expect(body).not.toHaveProperty("base_revision")
    expect(body).not.toHaveProperty("mode")
  })

  test("an edit against an older revision reports the one it merged onto", async () => {
    const created = await upload("a.html", html)
    await run(SpDrive.edit(fake.url, state.jwt, created.id, { ops: [{ op: "append_markdown", markdown: "one" }] }))
    const head = (await run(SpDrive.get(fake.url, state.jwt, created.id))).head.id
    const merged = await run(
      SpDrive.edit(fake.url, state.jwt, created.id, {
        ops: [{ op: "append_markdown", markdown: "two" }],
        baseRevision: created.head_revision_id,
      }),
    )
    expect(merged).toMatchObject({ _tag: "Landed", mergedFrom: head })
  })

  test("a proposal is left for review and shows in the document's proposals", async () => {
    const created = await upload("a.html", html)
    const proposed = await run(
      SpDrive.edit(fake.url, state.jwt, created.id, {
        ops: [{ op: "append_markdown", markdown: "maybe" }],
        mode: "propose",
        message: "Suggestion by DynWork",
      }),
    )
    expect(proposed._tag).toBe("Proposed")
    const open = await run(SpDrive.proposals(fake.url, state.jwt, created.id))
    expect(open.map((entry) => [entry.status, entry.message])).toEqual([["open", "Suggestion by DynWork"]])
    expect((await run(SpDrive.revisions(fake.url, state.jwt, created.id))).map((entry) => entry.message)).toEqual([
      null,
    ])
  })

  test("what the instance keeps for the person is AgentRefused, naming the capability", async () => {
    const created = await upload("a.html", html)
    const error = await fail(
      SpDrive.edit(fake.url, state.jwt, created.id, { ops: [{ op: "set_html", html: "<b>x</b>" }] }),
    )
    expect(error).toBeInstanceOf(SpClient.AgentRefused)
    expect(error).toMatchObject({ errorKey: "agent_forbidden", capability: "person" })
  })

  test("a token capped at suggest is refused for writes with the capability it lacks, and reads still work", async () => {
    const created = await upload("a.html", html)
    fake.state.drive.suggestOnly = true
    const refused = await fail(
      SpDrive.edit(fake.url, state.jwt, created.id, { ops: [{ op: "append_markdown", markdown: "x" }] }),
    )
    expect(refused).toMatchObject({ _tag: "AgentRefused", errorKey: "agent_suggest_only", capability: "edit" })
    expect(await fail(SpDrive.createFolder(fake.url, state.jwt, { name: "Nope" }))).toBeInstanceOf(
      SpClient.AgentRefused,
    )
    expect((await run(SpDrive.get(fake.url, state.jwt, created.id))).document.id).toBe(created.id)
  })
})

describe("comments", () => {
  test("creates a comment on a node and a quote, replies to it and resolves it", async () => {
    const created = await upload("a.html", html)
    const context = crypto.randomUUID()
    const root = await run(
      SpDrive.createComment(fake.url, state.jwt, created.id, {
        body: "Check this",
        anchor: { node: "n1", find: "Hola" },
        contextId: context,
      }),
    )
    expect(root).toMatchObject({ body: "Check this", anchor: { node: "n1", find: "Hola" } })
    const reply = await run(SpDrive.replyComment(fake.url, state.jwt, created.id, { body: "Done", parentId: root.id }))
    expect(reply.parent_id).toBe(root.id)
    const resolved = await run(SpDrive.resolveComment(fake.url, state.jwt, created.id, root.id))
    expect(resolved.resolved_at).toBeTruthy()
    const again = await run(SpDrive.resolveComment(fake.url, state.jwt, created.id, root.id))
    expect(again.resolved_at).toBe(resolved.resolved_at)
    const all = await run(SpDrive.comments(fake.url, state.jwt, created.id))
    expect(all.map((entry) => [entry.id, entry.resolved_at ? "resolved" : "open"])).toEqual([
      [root.id, "resolved"],
      [reply.id, "open"],
    ])
    expect(sent(`/api/v1/documents/${created.id}/comments`, "POST")[0]?.headers["x-context-id"]).toBe(context)
  })

  test("an anchor whose node is gone is a Conflict, not a created comment", async () => {
    const created = await upload("a.html", html)
    const error = await fail(
      SpDrive.createComment(fake.url, state.jwt, created.id, { body: "x", anchor: { node: "gone.1", find: "zzz" } }),
    )
    expect(error).toBeInstanceOf(SpClient.Conflict)
    expect(error).toMatchObject({ errorKey: "not_found" })
    expect(await run(SpDrive.comments(fake.url, state.jwt, created.id))).toEqual([])
  })

  test("resolving a comment that does not exist is NotFound", async () => {
    const created = await upload("a.html", html)
    const error = await fail(SpDrive.resolveComment(fake.url, state.jwt, created.id, crypto.randomUUID()))
    expect(error).toBeInstanceOf(SpClient.NotFound)
  })
})

describe("errors as data", () => {
  test("a 409 with the head the write lost to reads it from the body or from the detail", async () => {
    const created = await upload("a.html", html)
    const path = `/api/v1/documents/${created.id}/edits`
    const ops = [{ op: "append_markdown", markdown: "x" }]
    fake.state.override = {
      path,
      status: 409,
      body: {
        code: "conflict",
        message: "stale",
        error_key: "stale_base",
        head_revision_id: "h1",
        head_content_sha256: "s1",
        base_revision_id: "b1",
      },
    }
    expect(await fail(SpDrive.edit(fake.url, state.jwt, created.id, { ops }))).toMatchObject({
      _tag: "Conflict",
      errorKey: "stale_base",
      headRevisionId: "h1",
      headContentSha256: "s1",
      baseRevisionId: "b1",
    })
    fake.state.override = {
      path,
      status: 409,
      body: { message: "stale", error_key: "stale_base", detail: { head_revision_id: "h2", base_revision_id: "b2" } },
    }
    expect(await fail(SpDrive.edit(fake.url, state.jwt, created.id, { ops }))).toMatchObject({
      _tag: "Conflict",
      headRevisionId: "h2",
      baseRevisionId: "b2",
    })
  })

  test("a 403 that is not an agent refusal is Forbidden", async () => {
    fake.state.override = {
      path: "/api/v1/documents",
      status: 403,
      body: { message: "no access", error_key: "no_access" },
    }
    expect(await fail(SpDrive.list(fake.url, state.jwt))).toMatchObject({ _tag: "Forbidden", errorKey: "no_access" })
  })

  test("an agent_* key this client does not know is still AgentRefused, with no capability", async () => {
    fake.state.override = { path: "/api/v1/documents", status: 403, body: { message: "no", error_key: "agent_hidden" } }
    const error = await fail(SpDrive.list(fake.url, state.jwt))
    expect(error).toMatchObject({ _tag: "AgentRefused", errorKey: "agent_hidden" })
    expect(error).not.toHaveProperty("capability", "edit")
  })

  test("a 429 carries Retry-After in milliseconds", async () => {
    fake.state.override = { path: "/api/v1/documents", status: 429, body: {}, headers: { "retry-after": "7" } }
    expect(await fail(SpDrive.list(fake.url, state.jwt))).toMatchObject({ _tag: "RateLimited", retryAfterMs: 7000 })
  })

  test("a refused JWT is Unauthorized, so the caller mints another", async () => {
    const error = await fail(SpDrive.list(fake.url, fake.staleJwt()))
    expect(error).toBeInstanceOf(SpClient.Unauthorized)
  })

  test("a 5xx is Unreachable", async () => {
    fake.state.override = { path: "/api/v1/documents", status: 502, body: { message: "bad gateway" } }
    expect(await fail(SpDrive.list(fake.url, state.jwt))).toMatchObject({ _tag: "Unreachable", status: 502 })
  })

  test("a body that does not decode names the field", async () => {
    fake.state.override = {
      path: "/api/v1/documents",
      status: 200,
      body: { folders: [], documents: [{ id: 1 }], next_cursor: null },
    }
    const error = await fail(SpDrive.list(fake.url, state.jwt))
    expect(error).toBeInstanceOf(SpClient.Protocol)
    expect(error).toMatchObject({ path: expect.stringContaining("documents.0") })
  })

  test("an http instance that is not local is refused before anything is sent", async () => {
    const error = await fail(SpDrive.list("http://drive.example.com", state.jwt))
    expect(error).toBeInstanceOf(SpClient.Protocol)
    expect(fake.state.requests).toHaveLength(0)
  })

  test("no error carries the credential", async () => {
    const errors = [
      await fail(SpDrive.get(fake.url, state.jwt, crypto.randomUUID())),
      await fail(SpDrive.list(fake.url, fake.staleJwt())),
      await fail(SpDrive.list("http://127.0.0.1:1", state.jwt)),
    ]
    expect(errors.map((error) => error._tag)).toEqual(["NotFound", "Unauthorized", "Unreachable"])
    errors.forEach((error) => expect(JSON.stringify(error)).not.toContain(state.jwt))
  })
})
