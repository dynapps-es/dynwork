import { afterAll, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { DynWorkAccounts } from "../../src/accounts/accounts"
import { DriveBackend } from "../../src/drive/backend"
import { DriveFake } from "../../src/drive/fake"
import { startFake } from "../../../sp-client/test/fake"
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
  return { backend, suggestOnly: backend.suggestOnly }
})

conformance("Governance, over sp-client", () => ({
  backend: remote(),
  suggestOnly: (on) => {
    instance.state.drive.suggestOnly = on
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

  test("a document is the user's own only when its owner is the signed-in user", async () => {
    const created = await ok(
      remote().upload({ name: "owner.md", bytes: new TextEncoder().encode("x"), mime: "text/markdown" }),
    )
    expect(created.document.mine).toBe(true)
    const stranger = DriveBackend.remote({ url: instance.url, user: "someone-else", withJwt: (use) => use(issued()) })
    expect((await ok(stranger.get(created.document.id))).document.mine).toBe(false)
  })
})
