import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { SpClient, SpDrive } from "../src"

// Against a local instance at 0.83 or later, where the Drive exists. Runs only when SP_LOCAL_ENV points at the
// harness's generated env file, relative to the package directory. The seeded PAT of that file signs in as an
// unattended agent, so it can read and is refused writes; the writing tests also need SP_DRIVE_PAT, a PAT of the same
// user minted from a one-time code (the sign-in DynWork does), which makes it an attended agent. They leave a folder
// named `drive-live-<time>` on the instance: an agent cannot delete it.
// Nothing here prints a credential.

const envPath = process.env.SP_LOCAL_ENV === undefined ? undefined : path.resolve(process.env.SP_LOCAL_ENV)
const attendedPat = process.env.SP_DRIVE_PAT

// A local instance under emulation takes seconds per Drive write
setDefaultTimeout(30_000)

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const fail = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(effect))

const env =
  envPath === undefined
    ? {}
    : Object.fromEntries(
        (await Bun.file(envPath).text())
          .split("\n")
          .filter((line) => line.includes("="))
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
      )

const base = env.SP_ALPHA_URL ?? ""

describe.skipIf(envPath === undefined)("live Drive, as an unattended agent", () => {
  const state = { jwt: "" }

  beforeAll(async () => {
    state.jwt = (await run(SpClient.mintJwt(base, env.SP_ALPHA_PAT ?? ""))).token
  })

  test("lists the scopes and the folders with the shapes the schemas read", async () => {
    for (const scope of ["mine", "shared", "recent"] as const) {
      const listing = await run(SpDrive.list(base, state.jwt, { scope, limit: 5 }))
      expect(Array.isArray(listing.documents)).toBe(true)
    }
    expect(Array.isArray(await run(SpDrive.folders(base, state.jwt)))).toBe(true)
  })

  test("a write is refused as an agent capped at suggest, naming what it lacked", async () => {
    const error = await fail(SpDrive.createFolder(base, state.jwt, { name: `drive-live-${Date.now()}` }))
    expect(error).toBeInstanceOf(SpClient.AgentRefused)
    expect(error).toMatchObject({ errorKey: "agent_suggest_only", capability: "edit" })
  })

  test("a document that does not exist is NotFound and a forged JWT is Unauthorized", async () => {
    expect(await fail(SpDrive.get(base, state.jwt, crypto.randomUUID()))).toBeInstanceOf(SpClient.NotFound)
    expect(await fail(SpDrive.list(base, "eyJforged"))).toBeInstanceOf(SpClient.Unauthorized)
  })
})

describe.skipIf(envPath === undefined || attendedPat === undefined)("live Drive, as an attended agent", () => {
  const state = { jwt: "", folder: "", document: "", context: crypto.randomUUID() }
  const page = "<!doctype html><h1 id=x>Hola</h1><script>document.getElementById('x').textContent='JS'</script>"

  beforeAll(async () => {
    state.jwt = (await run(SpClient.mintJwt(base, attendedPat ?? ""))).token
  })

  test("DynWork is an attended agent, so it may edit where an unattended one may only suggest", async () => {
    const folder = await run(SpDrive.createFolder(base, state.jwt, { name: `drive-live-${Date.now()}` }))
    state.folder = folder.id
    const reading = await run(SpDrive.agentCap(base, state.jwt, { kind: "folder", id: folder.id }))
    expect(reading.attended.agent_cap).toBe("edit")
    expect(reading.unattended.agent_cap).toBe("suggest")
    expect((await run(SpDrive.folders(base, state.jwt))).map((entry) => entry.id)).toContain(folder.id)
  })

  test("imports a page with a script and gets it back as designed, under the CSP the instance sends", async () => {
    const created = await run(
      SpDrive.importFile(base, state.jwt, {
        name: "live.html",
        bytes: new TextEncoder().encode(page),
        mime: "text/html",
        folderId: state.folder,
        contextId: state.context,
      }),
    )
    state.document = created.document.id
    expect(created.revision.actor_kind).toBe("agent")
    const shown = await run(SpDrive.rendered(base, state.jwt, state.document))
    expect(shown.html).toBe(page)
    expect(shown.csp).toContain("frame-ancestors")
    expect(shown.revision).toBe(created.document.head_revision_id)
    expect((await run(SpDrive.preview(base, state.jwt, state.document))).html).not.toContain("<script")
    const listing = await run(SpDrive.list(base, state.jwt, { scope: "folder", folder: state.folder }))
    expect(listing.documents.map((entry) => entry.id)).toEqual([state.document])
    expect((await run(SpDrive.search(base, state.jwt, "LIVE"))).documents.map((entry) => entry.id)).toContain(
      state.document,
    )
  })

  test("a blob the agent uploads is imported by reference, in parts, and keeps its bytes", async () => {
    const bytes = new TextEncoder().encode(`<!doctype html><p>${"x".repeat(100)}</p><script>1</script>`)
    const opened = await run(SpDrive.openUpload(base, state.jwt, { name: "blob.html", mime: "text/html", bytes }))
    const blob = await run(SpDrive.finishUpload(base, state.jwt, opened, bytes))
    const created = await run(
      SpDrive.importBlob(base, state.jwt, {
        blobRef: blob.blob_ref,
        name: "blob.html",
        folderId: state.folder,
        contextId: state.context,
      }),
    )
    const shown = await run(SpDrive.rendered(base, state.jwt, created.document.id))
    expect(shown.html).toBe(new TextDecoder().decode(bytes))
  })

  test("an edit is attributed with its message, a proposal waits, and the document's refusals come as data", async () => {
    const created = await run(
      SpDrive.importFile(base, state.jwt, {
        name: "live.md",
        bytes: new TextEncoder().encode("# Live\n\nText\n"),
        mime: "text/markdown",
        folderId: state.folder,
      }),
    )
    const id = created.document.id
    const edited = await run(
      SpDrive.edit(base, state.jwt, id, {
        ops: [{ op: "append_markdown", markdown: "## Added" }],
        message: "Live check by DynWork",
        contextId: state.context,
      }),
    )
    expect(edited._tag).toBe("Landed")
    const revisions = await run(SpDrive.revisions(base, state.jwt, id))
    expect(revisions[0]).toMatchObject({ message: "Live check by DynWork", actor_kind: "agent" })
    const proposed = await run(
      SpDrive.edit(base, state.jwt, id, {
        ops: [{ op: "append_markdown", markdown: "## Maybe" }],
        mode: "propose",
        message: "Suggestion by DynWork",
      }),
    )
    expect(proposed._tag).toBe("Proposed")
    expect((await run(SpDrive.proposals(base, state.jwt, id))).map((entry) => entry.status)).toContain("open")
    const refused = await fail(SpDrive.edit(base, state.jwt, id, { ops: [{ op: "set_html", html: "<b>x</b>" }] }))
    expect(refused).toMatchObject({ _tag: "AgentRefused", errorKey: "agent_forbidden", capability: "person" })
    const shared = await run(SpDrive.access(base, state.jwt, id))
    expect(shared.my_access).toBe("own")
    expect(Buffer.from((await run(SpDrive.pdf(base, state.jwt, id))).bytes.subarray(0, 5)).toString()).toBe("%PDF-")
    const comment = await run(
      SpDrive.createComment(base, state.jwt, id, {
        body: "Check",
        anchor: { node: (await run(SpDrive.outline(base, state.jwt, id))).nodes[0]?.id ?? "" },
        contextId: state.context,
      }),
    )
    const reply = await run(SpDrive.replyComment(base, state.jwt, id, { body: "Done", parentId: comment.id }))
    expect(reply.parent_id).toBe(comment.id)
    expect((await run(SpDrive.resolveComment(base, state.jwt, id, comment.id))).resolved_at).toBeTruthy()
    expect((await run(SpDrive.comments(base, state.jwt, id))).map((entry) => entry.id)).toEqual([comment.id, reply.id])
    const gone = await fail(SpDrive.createComment(base, state.jwt, id, { body: "x", anchor: { node: "gone.1" } }))
    expect(gone).toMatchObject({ _tag: "Conflict", errorKey: "not_found" })
  })
})
