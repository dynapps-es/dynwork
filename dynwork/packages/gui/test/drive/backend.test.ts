import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { DynWorkAccounts } from "../../src/accounts/accounts"
import { DriveBackend } from "../../src/drive/backend"
import { DriveFake } from "../../src/drive/fake"
import { startFake } from "../../../sp-client/test/fake"
import { Comment, isFailure, Revision } from "../../src/drive/contract"
import { conformance, expectFailure, ok } from "./conformance"
import { crossing } from "./wire"

// The real backend runs against sp-client's fake instance, which answers the Drive routes as sp-local 0.83 does.
const instance = startFake()
afterAll(() => instance.stop())

const user = "1ecce4e3-bc87-441d-b374-ea29bab88da8"

// A JWT the fake instance accepts, handed over as `DynWorkAccounts.withJwt` hands over the account's.
function remote(jwt = issued()) {
  return DriveBackend.remote({ url: instance.url, user, withJwt: (use) => use(jwt) })
}

function issued() {
  const jwt = `jwt-${randomUUID()}`
  instance.state.jwts.add(jwt)
  return jwt
}

const invitee = "u-invitee"
instance.state.drive.people.set(invitee, { user_id: invitee, name: "Ana Ruiz", email: "ana@example.com" })

conformance("fake", () => {
  const backend = DriveFake.make({ user, people: { [invitee]: "Ana Ruiz" } })
  return { backend, user, suggestOnly: backend.suggestOnly, stage: backend.stage, agentShare: backend.agentShare, invitee }
})

conformance("Governance, over sp-client", () => ({
  backend: remote(),
  user,
  suggestOnly: (on) => {
    instance.state.drive.suggestOnly = on
  },
  // The agent's `documents_upload` leaves its bytes where the instance's resumable uploads do.
  stage: (bytes, mime) => {
    const ref = createHash("sha256").update(bytes).digest("hex")
    instance.state.drive.blobs.set(ref, { bytes, mime })
    return ref
  },
  agentShare: (on) => {
    instance.state.drive.agentShare = on
  },
  invitee,
}))

describe("the Governance backend", () => {
  test("a write sends its message and the conversation's x-context-id, with the account's JWT", async () => {
    const jwt = issued()
    const backend = remote(jwt)
    const context = randomUUID()
    const name = `sent-${context}.md`
    const created = await ok(
      backend.upload({ name, bytes: new TextEncoder().encode("# Sent"), mime: "text/markdown", contextId: context }),
    )
    await ok(
      backend.edit(created.document.id, {
        ops: [{ op: "append_markdown", markdown: "more" }],
        message: "Weekly report by DynWork",
        contextId: context,
      }),
    )
    const writes = instance.state.requests.filter(
      (request) =>
        request.method === "POST" &&
        (request.path === `/api/v1/documents/${created.document.id}/edits` ||
          (request.path === "/api/v1/documents" && request.body.includes(name))),
    )
    expect(writes.map((request) => request.headers["x-context-id"])).toEqual([context, context])
    expect(writes.every((request) => request.headers.authorization === `Bearer ${jwt}`)).toBe(true)
    expect(instance.state.drive.documents.get(created.document.id)?.contexts).toEqual([context, context])
    expect((await ok(backend.revisions(created.document.id)))[0]?.message).toBe("Weekly report by DynWork")
  })

  test("a JWT the instance refuses answers signed-out, and so does an account that is signed out", async () => {
    expectFailure(await remote(instance.staleJwt()).folders(), "signed-out")
    const gone = DriveBackend.remote({
      url: instance.url,
      withJwt: () => Promise.reject(new DynWorkAccounts.NotSignedIn({ id: "gone" })),
    })
    expectFailure(await gone.folders(), "signed-out")
  })

  test("an instance that does not answer is unreachable, and only that is retryable", async () => {
    const answer = await DriveBackend.remote({ url: "http://127.0.0.1:1", withJwt: (use) => use("jwt") }).folders()
    expectFailure(answer, "unreachable")
    expect(answer).toMatchObject({ retryable: true })
  })

  test.each([
    { status: 403, key: "agent_forbidden", code: "person" },
    { status: 403, key: "agent_suggest_only", code: "suggest" },
    { status: 403, key: "locked", code: "forbidden" },
    { status: 404, key: "not_found", code: "not-found" },
    { status: 429, key: "rate_limited", code: "unreachable" },
    { status: 503, key: "unavailable", code: "unreachable" },
    { status: 400, key: "invalid_params", code: "invalid" },
    { status: 400, key: "unsupported_op", code: "unsupported" },
    { status: 422, key: "unknown_context", code: "unknown-context" },
    { status: 422, key: "integrity_mismatch", code: "failed" },
    { status: 418, key: "teapot", code: "failed" },
  ] as const)("the instance's $status $key answers $code, without its own words", async (row) => {
    instance.state.override = {
      path: "/api/v1/document-folders",
      status: row.status,
      body: { code: "error", message: "secret detail from the server", error_key: row.key },
    }
    const answer = await remote().folders()
    instance.state.override = undefined
    expectFailure(answer, row.code)
    expect(JSON.stringify(answer)).not.toContain("secret detail")
    expect(answer).toMatchObject({ retryable: row.code === "unreachable" })
  })

  test("a conflict carries the head the write lost to", async () => {
    const backend = remote()
    const created = await ok(
      backend.upload({ name: "raced.md", bytes: new TextEncoder().encode("# One"), mime: "text/markdown" }),
    )
    instance.state.override = {
      path: `/api/v1/documents/${created.document.id}/edits`,
      status: 409,
      body: { code: "conflict_error", message: "stale", error_key: "stale_base", head_revision_id: "rev-head" },
    }
    const answer = await backend.edit(created.document.id, { ops: [{ op: "append_markdown", markdown: "x" }] })
    instance.state.override = undefined
    expectFailure(answer, "conflict")
    expect(answer).toMatchObject({ head: "rev-head" })
  })

  test("who has access reads each grant, and where an inherited one comes from", async () => {
    const backend = remote()
    const created = await ok(
      backend.upload({ name: "granted.md", bytes: new TextEncoder().encode("x"), mime: "text/markdown" }),
    )
    const grant = {
      grant_id: "g1",
      subject_kind: "user",
      subject_value: "u-2",
      display_name: "Ben",
      level: "comment",
      granted_by: user,
      granted_at: "2026-11-18T10:00:00Z",
      folder_id: null,
    }
    instance.state.override = {
      path: `/api/v1/documents/${created.document.id}/access`,
      status: 200,
      body: {
        document_id: created.document.id,
        owner: user,
        my_access: "own",
        grants: [grant],
        inherited: [
          {
            ...grant,
            grant_id: "g2",
            display_name: null,
            folder_id: "f1",
            inherited_from: { folder_id: "f1", name: "Team" },
          },
        ],
      },
    }
    const access = await ok(backend.access(created.document.id))
    instance.state.override = undefined
    expect(access.grants).toEqual([
      { id: grant.grant_id, subject: "user", value: "u-2", name: "Ben", level: "comment", from: undefined },
    ])
    expect(access.inherited).toEqual([
      { id: "g2", subject: "user", value: "u-2", name: undefined, level: "comment", from: { folder: "f1", name: "Team" } },
    ])
  })

  test("an uploaded PDF, which the instance keeps as a file, reads as a PDF", async () => {
    const pdf = await ok(
      remote().upload({ name: "scan.pdf", bytes: new TextEncoder().encode("%PDF-1.4"), mime: "application/pdf" }),
    )
    expect(pdf.document.format).toBe("pdf")
    const other = await ok(
      remote().upload({ name: "data.bin", bytes: new Uint8Array([1, 2]), mime: "application/octet-stream" }),
    )
    expect(other.document.format).toBe("file")
  })

  test("a conversation is registered with the account's JWT, under its title, and renamed in place", async () => {
    const jwt = issued()
    const backend = remote(jwt)
    const id = await ok(backend.createContext("Weekly report"))
    expect(instance.state.drive.contexts.get(id)).toBe("Weekly report")
    await ok(backend.renameContext(id, "Weekly report, final"))
    expect(instance.state.drive.contexts.get(id)).toBe("Weekly report, final")
    const calls = instance.state.requests.filter((request) => request.path.startsWith("/api/v1/core/contexts"))
    expect(calls.slice(-2).map((request) => [request.method, JSON.parse(request.body)])).toEqual([
      ["POST", { name: "Weekly report" }],
      ["PUT", { name: "Weekly report, final" }],
    ])
    expect(calls.slice(-2).every((request) => request.headers.authorization === `Bearer ${jwt}`)).toBe(true)
  })

  test("people are named by id, 20 a call, by their email when they have no name, and left out when unknown", async () => {
    const ids = Array.from({ length: 21 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`)
    ids.forEach((id, index) =>
      instance.state.drive.people.set(id, {
        user_id: id,
        name: index === 0 ? "" : `Person ${index}`,
        email: `p${index}@x.es`,
      }),
    )
    const before = instance.state.requests.length
    const named = await ok(remote().people([...ids, "unknown"]))
    expect(named).toHaveLength(21)
    expect(named.find((person) => person.id === ids[0])?.name).toBe("p0@x.es")
    expect(named.find((person) => person.id === ids[1])?.name).toBe("Person 1")
    expect(
      instance.state.requests.slice(before).filter((request) => request.path === "/api/v1/documents/people"),
    ).toHaveLength(2)
  })

  test("a person is found by email or name prefix through the documents MCP server, with name and email", async () => {
    const id = "e51c808f-4246-4487-9974-43a56298aa0b"
    const jesus = { id, name: "Jesús Pérez", email: "jesus.perez@dynapps.es" }
    instance.state.drive.people.set(id, { user_id: id, name: jesus.name, email: jesus.email })
    const before = instance.state.requests.length
    expect(await ok(remote().findPeople("jesus.perez@dynapps.es", 1))).toEqual([jesus])
    expect(await ok(remote().findPeople("Jesús"))).toEqual([jesus])
    // As 0.83.0: an id finds nobody.
    expect(await ok(remote().findPeople(id))).toEqual([])
    expect(await ok(remote().findPeople("nobody"))).toEqual([])
    expect(instance.state.requests.slice(before).every((request) => request.path === "/api/v1/mcp/documents/mcp")).toBe(
      true,
    )
    // The JWT the instance refuses is a failure, not a throw.
    expectFailure(
      await DriveBackend.remote({ url: instance.url, user, withJwt: (use) => use("refused") }).findPeople(id),
      "signed-out",
    )
  })

  test("a folder whose name a sibling has (0.84 name_taken) is a conflict", async () => {
    instance.state.override = {
      path: "/api/v1/document-folders",
      status: 409,
      body: { code: "conflict", message: "a folder named Artifacts already exists here", error_key: "name_taken" },
    }
    const answer = await remote().createFolder({ name: "Artifacts" })
    instance.state.override = undefined
    expectFailure(answer, "conflict")
  })

  test("the stream says that the Drive changed, with no document, next to the mentions", async () => {
    const stop = new AbortController()
    instance.state.drive.announce("document.drive.changed", { v: 1 }, false)
    const events = await remote().stream?.(stop.signal)
    if (events === undefined || isFailure(events)) throw new Error("the backend has no stream")
    const heard = events[Symbol.asyncIterator]()
    instance.state.drive.announce("document.drive.changed", { v: 1 }, false)
    // The fake instance replays the mentions earlier tests announced first: the change comes after them.
    const change = async (): Promise<unknown> => {
      const next = await heard.next()
      return next.done || next.value.kind === "changed" ? next.value : change()
    }
    expect(await change()).toEqual({ kind: "changed" })
    stop.abort()
  })

  test("a document is the user's own only when its owner is the signed-in user", async () => {
    const created = await ok(
      remote().upload({ name: "owner.md", bytes: new TextEncoder().encode("x"), mime: "text/markdown" }),
    )
    expect(created.document.mine).toBe(true)
    const stranger = DriveBackend.remote({ url: instance.url, user: "someone-else", withJwt: (use) => use(issued()) })
    expect((await ok(stranger.get(created.document.id))).document.mine).toBe(false)
  })
})

describe("the Governance backend on 0.83 and 0.84", () => {
  beforeEach(() => {
    instance.state.drive.version = "0.84"
  })
  afterEach(() => {
    instance.state.drive.version = "0.83"
  })

  test("discovery says whether the instance announces the Drive, and its version", async () => {
    expect(await ok(remote().discovery())).toEqual({ version: "0.84.0", documents: true })
    instance.state.drive.version = "0.83"
    expect(await ok(remote().discovery())).toEqual({ version: "0.83.0", documents: false })
  })

  test("0.84 revisions and comments read their conversation, its title, the agent and the client", async () => {
    const backend = remote()
    const context = await ok(backend.createContext("Q3 report"))
    const created = await ok(
      backend.upload({
        name: `q3-${randomUUID()}.md`,
        bytes: new TextEncoder().encode("# Q3"),
        mime: "text/markdown",
        message: "Q3 report by DynWork",
        contextId: context,
      }),
    )
    // 0.84 keeps the message of the document it makes
    expect(created.revision.message).toBe("Q3 report by DynWork")
    const revisions = (await ok(backend.revisions(created.document.id))).map((item) => crossing(Revision, item))
    expect(revisions[0]).toMatchObject({ context, conversation: "Q3 report", agent: "sp_bridge", client: "sp_bridge" })
    await ok(backend.comment(created.document.id, { body: "Check", anchor: { kind: "node", node: "n1" }, contextId: context }))
    const comments = (await ok(backend.comments(created.document.id))).map((item) => crossing(Comment, item))
    expect(comments[0]).toMatchObject({ context, conversation: "Q3 report", via: "sp_bridge", client: "sp_bridge" })
  })

  test("0.83 revisions and comments carry none of those keys", async () => {
    instance.state.drive.version = "0.83"
    const backend = remote()
    const created = await ok(
      backend.upload({ name: `old-${randomUUID()}.md`, bytes: new TextEncoder().encode("# x"), mime: "text/markdown" }),
    )
    const revision = (await ok(backend.revisions(created.document.id)))[0]
    expect(Object.keys(revision ?? {}).toSorted()).toEqual(
      ["actor", "author", "created", "document", "id", "message", "origin", "parent", "sha256"].toSorted(),
    )
    await ok(backend.comment(created.document.id, { body: "x", anchor: { kind: "node", node: "n1" } }))
    const comment = (await ok(backend.comments(created.document.id)))[0]
    expect(comment).not.toHaveProperty("via")
    expect(comment).not.toHaveProperty("conversation")
  })

  test("a comment on a cell range and a reopened one read their range and who reopened it", async () => {
    const backend = remote()
    const created = await ok(
      backend.upload({ name: `sheet-${randomUUID()}.md`, bytes: new TextEncoder().encode("x"), mime: "text/markdown" }),
    )
    instance.state.drive.comments.set(created.document.id, [
      {
        id: "c-range",
        anchor: { node: "sheet[Sales]", cells: "B2:D9" },
        author_user_id: user,
        body: "Range",
        created_at: "2026-11-20T09:00:00Z",
        reopened_at: "2026-11-20T10:00:00Z",
        reopened_by: "someone",
      },
    ])
    const comment = crossing(Comment, (await ok(backend.comments(created.document.id)))[0])
    expect(comment).toMatchObject({
      anchor: { node: "sheet[Sales]", cells: "B2:D9" },
      reopened: Date.parse("2026-11-20T10:00:00Z"),
      reopener: "someone",
    })
  })

  test("a conversation the instance did not issue answers unknown-context, and nothing is written", async () => {
    const before = instance.state.drive.documents.size
    const answer = await remote().upload({
      name: "x.md",
      bytes: new TextEncoder().encode("x"),
      contextId: randomUUID(),
    })
    expectFailure(answer, "unknown-context")
    expect(instance.state.drive.documents.size).toBe(before)
  })

  test("a template's document keeps the message it is sent", async () => {
    const created = await ok(remote().create({ template: "blank-markdown", name: "Notes", message: "Ana by DynWork" }))
    expect(created.revision.message).toBe("Ana by DynWork")
  })

  test("the directory is searched over REST, word by word", async () => {
    const found = await ok(remote().searchPeople("ana", 5))
    expect(found).toEqual([{ id: invitee, name: "Ana Ruiz", email: "ana@example.com" }])
    expect(instance.state.requests.at(-1)).toMatchObject({ path: "/api/v1/documents/people", query: "?query=ana&limit=5" })
  })
})
