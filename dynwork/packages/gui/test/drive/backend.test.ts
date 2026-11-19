import { afterAll, describe, expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { DynWorkAccounts } from "../../src/accounts/accounts"
import { DriveBackend } from "../../src/drive/backend"
import { DriveFake } from "../../src/drive/fake"
import { startFake } from "../../../sp-client/test/fake"
import { isFailure } from "../../src/drive/contract"
import { conformance, expectFailure, ok } from "./conformance"

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

conformance("fake", () => {
  const backend = DriveFake.make({ user })
  return { backend, user, suggestOnly: backend.suggestOnly, stage: backend.stage }
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
    expect(access.grants).toEqual([{ subject: "user", value: "u-2", name: "Ben", level: "comment", from: undefined }])
    expect(access.inherited).toEqual([
      { subject: "user", value: "u-2", name: undefined, level: "comment", from: { folder: "f1", name: "Team" } },
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
