import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { DynWorkDocuments } from "@dynwork/server-plugin/documents"
import { Effect } from "effect"
import { SpClient } from "@dynwork/sp-client"
import { DynWorkPerson } from "../../src/accounts/person"
import type { Person } from "../../src/accounts/contract"
import { DriveBackend } from "../../src/drive/backend"
import { DriveFake } from "../../src/drive/fake"
import { DriveIpc } from "../../src/drive/ipc"
import { DriveShare } from "../../src/drive/share"
import { startPerson } from "../../../sp-client/test/fake"
import { personOf, setup, startFake, until, type Fake } from "../accounts/fixture"
import { storage } from "../routines/fixture"
import { expectFailure, ok } from "./conformance"
import { connect, flush, manualTimers } from "./wire"

// DynWork acting as the person (G01): the user's own acts from a window go through their UI session while it is on,
// with no "… by DynWork"; without it they go as DynWork's agent, as before, and what only the person may do asks them to
// sign in (or, where the instance has no session for DynWork, to go to Governance). The Drive is the in-memory fake,
// whose `person()` is the same Drive through the person's session.

const ana = { id: "account-ana", user: "ana@dynapps.es", userId: "user-ana" }
const chat = { id: "ses_q3", name: "Q3 report" }
const text = (value: string) => new TextEncoder().encode(value)

function stand(options: { session?: Person["status"]; version?: "0.83" | "0.84" } = {}) {
  const fake = DriveFake.make({
    user: "user-ana",
    contexts: true,
    version: options.version ?? "0.84",
    people: { "user-luis": "Luis Martín" },
  })
  const session = { status: options.session ?? ("on" as Person["status"]) }
  const service = DriveIpc.make({
    account: () => ana,
    backend: () => fake,
    person: { status: () => session.status, backend: () => fake.person() },
    store: storage(DriveIpc.Saved, DriveIpc.initial),
    changed: () => {},
    timers: manualTimers(),
  })
  return { fake, session, service, client: connect(service) }
}

// A document made by DynWork's agent, with a proposal on it, to act on.
async function seeded(fake: DriveFake.Fake) {
  const made = await ok(fake.upload({ name: "Q3.md", bytes: text("# Q3\nfirst"), mime: "text/markdown" }))
  await ok(fake.edit(made.document.id, { ops: [{ op: "append_markdown", markdown: "second" }] }))
  const proposed = await ok(
    fake.edit(made.document.id, { ops: [{ op: "append_markdown", markdown: "maybe" }], mode: "propose" }),
  )
  return {
    id: made.document.id,
    first: made.revision.id,
    proposal: proposed.kind === "proposed" ? proposed.proposal.id : "",
  }
}

describe("with the person's session on", () => {
  test("the window says so: the person's state and personActions on, renewing counted as on", async () => {
    const at = stand()
    await flush()
    expect(at.client.state()).toMatchObject({ person: "on", capabilities: { personActions: true } })
    at.session.status = "renewing"
    expect(at.client.state()).toMatchObject({ person: "on", capabilities: { personActions: true } })
    at.session.status = "signingIn"
    expect(at.client.state()).toMatchObject({ person: "off", capabilities: { personActions: false } })
  })

  test("every act from a window goes as the person, with no «… by DynWork»", async () => {
    const at = stand()
    await flush()
    const created = await ok(at.client.upload({ name: "notes.md", bytes: text("# Notes\nline"), mime: "text/markdown" }))
    expect(created.revision).toMatchObject({ actor: "user" })
    expect(created.revision.message).toBeUndefined()
    expect(created.revision.agent).toBeUndefined()
    expect(created.revision.client).toBe(DriveFake.personClient)
    const id = created.document.id
    const node = (await ok(at.fake.outline(id))).nodes[0]?.id ?? ""
    const thread = await ok(at.client.comment({ id, body: "Check this", anchor: { kind: "node", node } }))
    expect(thread.via).toBeUndefined()
    expect(thread.client).toBe(DriveFake.personClient)
    await ok(at.client.reply({ id, parent: thread.id, body: "Done" }))
    await ok(at.client.resolve({ id, comment: thread.id }))
    await ok(at.client.reopen({ id, comment: thread.id }))
    const edited = await ok(at.client.edit({ id, ops: [{ op: "append_markdown", markdown: "more" }] }))
    expect(edited.revision).toMatchObject({ actor: "user" })
    await ok(at.client.create({ template: "blank-markdown", name: "Plan" }))
    await ok(at.client.createFolder({ name: "Mine" }))
    const shared = await ok(at.client.share({ id, kind: "user", value: "user-luis", level: "view" }))
    await ok(at.client.unshare({ id, grant: shared.grants[0]?.id ?? "" }))
    expect(at.fake.acted).toEqual([
      "upload",
      "comment",
      "reply",
      "resolve",
      "reopen",
      "edit",
      "create",
      "createFolder",
      "share",
      "unshare",
    ])
  })

  test("a write from a conversation carries its context, which DynWork's agent registers: never the person's session", async () => {
    const at = stand()
    await flush()
    const created = await ok(at.client.upload({ name: "out.md", bytes: text("# Out"), conversation: chat }))
    expect(at.fake.contexts.get(created.revision.context ?? "")).toBe("Q3 report")
    expect(created.revision).toMatchObject({ actor: "user", conversation: "Q3 report" })
    expect(created.revision.message).toBeUndefined()
    expect(at.fake.acted).toEqual(["upload"])
    expect(at.fake.calls.createContext).toBe(1)
  })

  test("what only the person may do goes as them: restore, review, transfer and trash", async () => {
    const at = stand()
    await flush()
    const doc = await seeded(at.fake)
    const restored = await ok(at.client.restore({ id: doc.id, revision: doc.first }))
    expect(restored).toMatchObject({ actor: "user" })
    expect(await ok(at.client.review({ id: doc.id, proposal: doc.proposal, accept: false, note: "no" }))).toMatchObject({
      status: "rejected",
      note: "no",
    })
    expect(await ok(at.client.transfer({ id: doc.id, to: "user-luis" }))).toMatchObject({ owner: "user-luis" })
    expect(await at.client.trash({ id: doc.id })).toBeUndefined()
    expectFailure(await at.fake.get(doc.id), "not-found")
    expect(at.fake.acted).toEqual(["restore", "review", "transfer", "trash"])
  })

  test("a session that ends under the call says sign in, never a silent failure", async () => {
    const service = DriveIpc.make({
      account: () => ana,
      backend: () => DriveFake.make({ user: "user-ana" }),
      person: {
        status: () => "on",
        backend: () =>
          DriveBackend.remote({
            url: "https://gov.example",
            withJwt: () => Promise.reject(new DynWorkPerson.SignedOut({ id: ana.id })),
          }),
      },
      store: storage(DriveIpc.Saved, DriveIpc.initial),
      changed: () => {},
      timers: manualTimers(),
    })
    const client = connect(service)
    await flush()
    expectFailure(await client.trash({ id: "d1" }), "sign-in")
    expectFailure(await client.resolve({ id: "d1", comment: "c1" }), "sign-in")
  })
})

describe("without the person's session (off: the instance has one for DynWork, not started)", () => {
  test("the user's acts go as DynWork's agent, signed «<user> by DynWork», as before", async () => {
    const at = stand({ session: "off" })
    await flush()
    expect(at.client.state()).toMatchObject({ person: "off", capabilities: { personActions: false } })
    const created = await ok(at.client.upload({ name: "notes.md", bytes: text("# Notes"), mime: "text/markdown" }))
    expect(created.revision).toMatchObject({ actor: "agent", message: "ana@dynapps.es by DynWork" })
    const node = (await ok(at.fake.outline(created.document.id))).nodes[0]?.id ?? ""
    const thread = await ok(
      at.client.comment({ id: created.document.id, body: "Check", anchor: { kind: "node", node } }),
    )
    expect(thread.via).toBe(DriveFake.agent)
    expect(at.fake.acted).toEqual([])
  })

  test("what only the person may do says sign in, and nothing reaches the instance", async () => {
    const at = stand({ session: "off" })
    await flush()
    const doc = await seeded(at.fake)
    expectFailure(await at.client.restore({ id: doc.id, revision: doc.first }), "sign-in")
    expectFailure(await at.client.review({ id: doc.id, proposal: doc.proposal, accept: true }), "sign-in")
    expectFailure(await at.client.transfer({ id: doc.id, to: "user-luis" }), "sign-in")
    expectFailure(await at.client.trash({ id: doc.id }), "sign-in")
    expect([at.fake.calls.restore, at.fake.calls.review, at.fake.calls.transfer, at.fake.calls.trash]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ])
  })

  test("a share the instance keeps to the person says sign in; one it lets the agent make goes as the agent", async () => {
    const at = stand({ session: "off" })
    await flush()
    const doc = await seeded(at.fake)
    expectFailure(await at.client.share({ id: doc.id, kind: "user", value: "user-luis", level: "view" }), "sign-in")
    at.fake.agentShare(true)
    await ok(at.client.share({ id: doc.id, kind: "user", value: "user-luis", level: "view" }))
    expect(at.fake.acted).toEqual([])
  })
})

describe("where the instance has no session for DynWork (unavailable)", () => {
  test("what only the person may do goes to Governance, as before, and nothing is sent", async () => {
    const at = stand({ session: "unavailable", version: "0.83" })
    await flush()
    expect(at.client.state()).toMatchObject({ person: "unavailable", capabilities: { personActions: false } })
    const doc = await seeded(at.fake)
    expectFailure(await at.client.trash({ id: doc.id }), "person")
    expectFailure(await at.client.restore({ id: doc.id, revision: doc.first }), "person")
    expectFailure(await at.client.share({ id: doc.id, kind: "user", value: "user-luis", level: "view" }), "person")
    expect(at.fake.calls.trash).toBeUndefined()
  })

  test("a service with no person session at all stays as it was", async () => {
    const fake = DriveFake.make({ user: "user-ana" })
    const service = DriveIpc.make({
      account: () => ana,
      backend: () => fake,
      store: storage(DriveIpc.Saved, DriveIpc.initial),
      changed: () => {},
      timers: manualTimers(),
    })
    await flush()
    expect(service.acting()).toBe("unavailable")
    expect(service.person()).toBeUndefined()
    expect(connect(service).state().capabilities.personActions).toBe(false)
  })
})

describe("the agent's person-only actions, once the user allows them on the card", () => {
  async function cards(session: Person["status"]) {
    const at = stand({ session })
    await flush()
    const doc = await seeded(at.fake)
    const decisions: DynWorkDocuments.Decision[] = []
    const logic = DriveShare.make({
      service: at.service,
      session: async () => ({}),
      decide: async (decision) => void decisions.push(decision),
      shown: async () => {},
      attended: () => true,
      person: at.service.person,
      changed: () => {},
    })
    return { ...at, doc, decisions, logic }
  }

  test("with the session on, main does each as the person and the plugin gets what to tell the agent", async () => {
    const at = await cards("on")
    const asks: DynWorkDocuments.Share[] = [
      { id: "c1", session: "ses_q3", kind: "restore", document: at.doc.id, revision: at.doc.first },
      { id: "c2", session: "ses_q3", kind: "accept", document: at.doc.id, proposal: at.doc.proposal },
      { id: "c3", session: "ses_q3", kind: "grant", document: at.doc.id, subject: { kind: "user", value: "user-luis" }, level: "edit" },
      { id: "c4", session: "ses_q3", kind: "revoke", document: at.doc.id },
      { id: "c5", session: "ses_q3", kind: "transfer", document: at.doc.id, subject: { kind: "user", value: "user-luis" } },
      { id: "c6", session: "ses_q3", kind: "trash", document: at.doc.id },
    ]
    for (const ask of asks) {
      await at.logic.request(ask)
      expect(at.logic.cards().at(-1)).toMatchObject({ id: ask.id, kind: ask.kind, person: true })
      await at.logic.decide(ask.id, "once")
    }
    expect(at.fake.acted).toEqual(["restore", "review", "share", "revokeAll", "transfer", "trash"])
    expect(at.decisions.map((decision) => [decision.id, decision.allow])).toEqual(asks.map((ask) => [ask.id, true]))
    expect(at.decisions.map((decision) => decision.outcome)).toEqual([
      `The user allowed it on the card and Dynwork did it as the user, not as you: restored revision ${at.doc.first} of document ${at.doc.id} as a new revision. It is done: do not call it again.`,
      `The user allowed it on the card and Dynwork did it as the user, not as you: accepted proposal ${at.doc.proposal} on document ${at.doc.id}. It is done: do not call it again.`,
      `The user allowed it on the card and Dynwork did it as the user, not as you: shared document ${at.doc.id} with user user-luis (edit). It is done: do not call it again.`,
      `The user allowed it on the card and Dynwork did it as the user, not as you: revoked every grant on document ${at.doc.id}. It is done: do not call it again.`,
      `The user allowed it on the card and Dynwork did it as the user, not as you: made user user-luis the owner of document ${at.doc.id}. It is done: do not call it again.`,
      `The user allowed it on the card and Dynwork did it as the user, not as you: moved document ${at.doc.id} to the trash. It is done: do not call it again.`,
    ])
  })

  test("what the instance refuses as the person is told to the agent, and nothing is called again", async () => {
    const at = await cards("on")
    await at.logic.request({ id: "c1", session: "ses_q3", kind: "transfer", document: at.doc.id, subject: { kind: "user", value: "nobody" } })
    await at.logic.decide("c1", "once")
    expect(at.decisions).toEqual([
      {
        id: "c1",
        allow: true,
        outcome:
          "The user allowed it on the card, but Governance refused it as the user (invalid): No such person. Nothing changed.",
      },
    ])
  })

  test("without the session, an allowed call goes as the agent wrote it: no outcome, nothing done as the person", async () => {
    const at = await cards("off")
    await at.logic.request({ id: "c1", session: "ses_q3", kind: "trash", document: at.doc.id })
    expect(at.logic.cards()[0]?.person).toBeUndefined()
    await at.logic.decide("c1", "once")
    expect(at.decisions).toEqual([{ id: "c1", allow: true }])
    expect(at.fake.acted).toEqual([])
    expect(at.fake.calls.trash).toBeUndefined()
  })

  test("a rejected card is never done, and a folder's grant goes as the agent wrote it", async () => {
    const at = await cards("on")
    await at.logic.request({ id: "c1", session: "ses_q3", kind: "trash", document: at.doc.id })
    await at.logic.decide("c1", "reject")
    const folder = await ok(at.fake.createFolder({ name: "Sales" }))
    await at.logic.request({
      id: "c2",
      session: "ses_q3",
      kind: "grant",
      folder: folder.id,
      subject: { kind: "user", value: "user-luis" },
      level: "view",
    })
    await at.logic.decide("c2", "once")
    expect(at.decisions).toEqual([
      { id: "c1", allow: false },
      { id: "c2", allow: true },
    ])
    expect(at.fake.acted).toEqual([])
  })

  test("Allow in this conversation is for sharing only: a trash, a transfer or a restore is asked every time", async () => {
    const at = await cards("off")
    for (const kind of ["trash", "transfer", "revoke", "restore", "accept"] as const) {
      await at.logic.request({ id: `${kind}-1`, session: "ses_q3", kind, document: at.doc.id })
      await at.logic.decide(`${kind}-1`, "conversation")
      await at.logic.request({ id: `${kind}-2`, session: "ses_q3", kind, document: at.doc.id })
      // The second one shows its own card
      expect(at.logic.cards().map((card) => card.id)).toEqual([`${kind}-2`])
      await at.logic.decide(`${kind}-2`, "reject")
    }
    const grant = (id: string): DynWorkDocuments.Share => ({
      id,
      session: "ses_q3",
      kind: "grant",
      document: at.doc.id,
      subject: { kind: "user", value: "user-luis" },
      level: "view",
    })
    await at.logic.request(grant("g-1"))
    await at.logic.decide("g-1", "conversation")
    await at.logic.request(grant("g-2"))
    expect(at.logic.cards()).toEqual([])
    expect(at.decisions.filter((decision) => decision.id.startsWith("g-"))).toEqual([
      { id: "g-1", allow: true },
      { id: "g-2", allow: true },
    ])
  })
})

// The real stack: the person's session (`DynWorkPerson`) against the instance's fake, the Drive's backends over
// `SpDrive`, and the cards' logic. Nothing the instance issued for the person reaches a window or the plugin.
describe("end to end over the instance's fake", () => {
  let instance: Fake

  beforeAll(() => {
    instance = startFake()
  })

  afterAll(() => instance.stop())

  beforeEach(() => {
    instance.state.person = startPerson()
    instance.state.requests.length = 0
  })

  test("a manual comment and an allowed card go with the UI token; the agent and the windows never see a token", async () => {
    const context = setup(instance)
    await context.accounts.signInToken({ url: instance.url, token: instance.issuePat() })
    const account = context.accounts.list()[0]
    if (!account) throw new Error("no account")
    const person = personOf(context, { open: (link) => instance.personBrowser(link).then(() => undefined) })
    const service = DriveIpc.make({
      account: () => ({ id: account.id, user: account.user ?? account.label, url: account.url }),
      backend: (active) =>
        DriveBackend.remote({ url: active.url, withJwt: (use) => context.accounts.withJwt(active.id, use) }),
      person: {
        status: (id) => person.person.status(id).status,
        backend: (active) =>
          DriveBackend.remote({ url: active.url, withJwt: (use) => person.person.withPerson(active.id, use) }),
      },
      store: storage(DriveIpc.Saved, DriveIpc.initial),
      changed: () => {},
      timers: manualTimers(),
    })
    const client = connect(service)
    await flush()
    // The instance declares DynWork's client: the person could sign in
    person.person.reconcile()
    await until(() => person.person.status(account.id).status === "off")
    // Signed out of the person's session: the trash is not sent, and the window is told to sign in
    expectFailure(await client.trash({ id: "nothing" }), "sign-in")
    expect(await person.person.signIn(account.id)).toBe("signed-in")
    expect(client.state()).toMatchObject({ person: "on" })

    const created = await ok(client.upload({ name: "q3.md", bytes: text("# Hola"), mime: "text/markdown" }))
    const thread = await ok(client.comment({ id: created.document.id, body: "Mine", anchor: { kind: "node", node: "n1" } }))
    expect(thread.via).toBeUndefined()
    const decisions: DynWorkDocuments.Decision[] = []
    const logic = DriveShare.make({
      service,
      session: async () => ({}),
      decide: async (decision) => void decisions.push(decision),
      shown: async () => {},
      attended: () => true,
      person: service.person,
      changed: () => {},
    })
    await logic.request({ id: "call_t", session: "ses_q3", kind: "trash", document: created.document.id })
    await logic.decide("call_t", "once")
    expect(decisions[0]?.outcome).toContain("moved document")
    expect(instance.state.person.acted).toEqual([
      "POST /api/v1/documents",
      `POST /api/v1/documents/${created.document.id}/comments`,
      `DELETE /api/v1/documents/${created.document.id}`,
    ])

    const issued = [...instance.state.person.access.keys(), ...instance.state.person.refresh.keys()]
    const seen = JSON.stringify([client.state(), decisions, logic.cards(), created, thread])
    expect(issued.length).toBeGreaterThan(1)
    issued.forEach((token) => expect(seen).not.toContain(token))
    expect(seen).not.toContain("eyJ")
    person.person.dispose()
    context.accounts.dispose()
  })

  test("a recent sign-in the person did not get is sign-in, never signed-out", async () => {
    const backend = DriveBackend.remote({
      url: "https://gov.example",
      withJwt: () => Effect.runPromise(Effect.fail(new SpClient.RecentSignIn({ endpoint: "DELETE /api/v1/documents/{id}", message: "recent sign-in", maxAge: 600 }))),
    })
    expectFailure(await backend.trash("d1"), "sign-in")
  })
})
