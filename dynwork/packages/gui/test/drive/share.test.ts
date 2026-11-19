import { describe, expect, jest, test } from "bun:test"
import type { DynWorkDocuments } from "@dynwork/server-plugin/documents"
import type { Backend } from "../../src/drive/backend"
import type { DriveCapabilities } from "../../src/drive/capabilities"
import { ShareCard } from "../../src/drive/contract"
import { DriveFake } from "../../src/drive/fake"
import { DriveIpc } from "../../src/drive/ipc"
import { DriveShare } from "../../src/drive/share"
import { storage } from "../routines/fixture"
import { ok } from "./conformance"
import { crossing, flush, manualTimers } from "./wire"

// The agent's shares on main's side (D24): what the plugin publishes becomes a card in its conversation, with the
// names the Drive gives, and the user's decision is what the plugin hears. The Drive is the in-memory fake and the
// service the real one; the plugin is the list of decisions it would receive.

const ana = { id: "account-ana", user: "ana@dynapps.es" }

interface Standing {
  capabilities?: Partial<DriveCapabilities.Capabilities>
  sessions?: Record<string, DriveShare.Session>
  around?: (fake: DriveFake.Fake) => Partial<Backend>
  /** No window open to show a card. */
  windowless?: boolean
  /** The Drive's saved store, to read again as after a restart. */
  store?: ReturnType<typeof storage<typeof DriveIpc.Saved>>
}

async function stand(options: Standing = {}) {
  const fake = DriveFake.make({ user: "user-ana", people: { "user-luis": "Luis Martín" } })
  const document = (await ok(fake.upload({ name: "Q3 report.md", bytes: new TextEncoder().encode("# Q3") }))).document
  const folder = await ok(fake.createFolder({ name: "Sales" }))
  const backend: DriveFake.Fake = { ...fake, ...options.around?.(fake) }
  const service = DriveIpc.make({
    account: () => ana,
    backend: () => backend,
    store: options.store ?? storage(DriveIpc.Saved, DriveIpc.initial),
    changed: () => {},
    capabilities: () => options.capabilities ?? {},
    timers: manualTimers(),
  })
  await flush()
  const sessions = options.sessions ?? {}
  const decisions: DynWorkDocuments.Decision[] = []
  const shown: string[] = []
  const changes = { count: 0 }
  const logic = DriveShare.make({
    service,
    session: async (id) => sessions[id] ?? {},
    decide: async (decision) => void decisions.push(decision),
    shown: async (id) => void shown.push(id),
    attended: () => !options.windowless,
    changed: () => void changes.count++,
  })
  return { logic, service, decisions, shown, changes, document: document.id, folder: folder.id }
}

const grant = (id: string, session: string, document: string): DynWorkDocuments.Share => ({
  id,
  session,
  kind: "grant",
  document,
  subject: { kind: "user", value: "user-luis" },
  level: "edit",
})

describe("the card", () => {
  test("a share shows on a card in its conversation, with the document's and the person's names, and waits", async () => {
    const at = await stand({ capabilities: { peopleByRest: true } })
    await at.logic.request(grant("call_1", "ses_q3", at.document))
    expect(at.logic.cards()).toEqual([
      {
        id: "call_1",
        session: "ses_q3",
        kind: "grant",
        target: { kind: "document", id: at.document, name: "Q3 report.md" },
        subject: { kind: "user", value: "user-luis", name: "Luis Martín" },
        level: "edit",
      },
    ])
    expect(at.changes.count).toBe(1)
    expect(at.decisions).toEqual([])
    // The plugin hears the card is up, so the share waits for the user.
    expect(at.shown).toEqual(["call_1"])
  })

  test("with no window to show it, a share is not taken: the plugin refuses it as unheard", async () => {
    const at = await stand({ windowless: true })
    await at.logic.request(grant("call_1", "ses_q3", at.document))
    expect(at.logic.cards()).toEqual([])
    expect(at.shown).toEqual([])
    expect(at.decisions).toEqual([])
  })

  test("a person the conversation looked up shows by name and email; an email or an unseen id as given", async () => {
    const at = await stand({ capabilities: { peopleByRest: true } })
    const looked = { kind: "user", value: "e51c808f-1", name: "Jesús Pérez", email: "jesus.perez@dynapps.es" }
    await at.logic.request({ ...grant("call_1", "ses_q3", at.document), subject: looked })
    await at.logic.request({
      ...grant("call_2", "ses_q3", at.document),
      subject: { kind: "user", value: "luis@dynapps.es" },
    })
    await at.logic.request({
      ...grant("call_3", "ses_q3", at.document),
      subject: { kind: "user", value: "e51c808f-9" },
    })
    expect(at.logic.cards().map((card) => card.subject)).toEqual([
      looked,
      { kind: "user", value: "luis@dynapps.es" },
      { kind: "user", value: "e51c808f-9" },
    ])
  })

  test("what the Drive cannot name keeps the value the agent gave; a folder is named from the Drive as read", async () => {
    const at = await stand()
    await at.logic.request({
      id: "call_1",
      session: "ses_q3",
      kind: "grant",
      folder: at.folder,
      subject: { kind: "user", value: "user-luis" },
      level: "view",
      until: "2026-12-01",
    })
    await at.logic.request({ ...grant("call_2", "ses_q3", "doc-unknown"), subject: { kind: "group", value: "sales" } })
    await at.logic.request({ id: "call_3", session: "ses_q3", kind: "grant" })
    expect(at.logic.cards()).toEqual([
      {
        id: "call_1",
        session: "ses_q3",
        kind: "grant",
        target: { kind: "folder", id: at.folder, name: "Sales" },
        // Without `peopleByRest`, the id is looked up through the `documents` MCP server, which in 0.83 finds no one by id.
        subject: { kind: "user", value: "user-luis" },
        level: "view",
        until: "2026-12-01",
      },
      {
        id: "call_2",
        session: "ses_q3",
        kind: "grant",
        target: { kind: "document", id: "doc-unknown" },
        subject: { kind: "group", value: "sales" },
        level: "edit",
      },
      { id: "call_3", session: "ses_q3", kind: "grant" },
    ])
    for (const card of at.logic.cards()) expect(crossing(ShareCard, card)).toEqual(card)
  })

  test("a transfer and a revocation show as what they are", async () => {
    const at = await stand()
    await at.logic.request({
      id: "call_t",
      session: "ses_q3",
      kind: "transfer",
      document: at.document,
      subject: { kind: "user", value: "user-luis" },
    })
    await at.logic.request({ id: "call_r", session: "ses_q3", kind: "revoke", document: at.document })
    expect(at.logic.cards().map((card) => [card.kind, card.target?.name])).toEqual([
      ["transfer", "Q3 report.md"],
      ["revoke", "Q3 report.md"],
    ])
  })

  test("a subagent's share shows in the conversation that started it; a conversation child keeps its own", async () => {
    const at = await stand({
      sessions: {
        ses_task: { parentID: "ses_sub" },
        ses_sub: { parentID: "ses_q3" },
        ses_chat: { parentID: "ses_q3", conversation: true },
      },
    })
    await at.logic.request(grant("call_1", "ses_task", at.document))
    await at.logic.request(grant("call_2", "ses_chat", at.document))
    expect(at.logic.cards().map((card) => card.session)).toEqual(["ses_q3", "ses_chat"])
  })
})

describe("a person the conversation never looked up", () => {
  const unseen = (id: string, value: string) => ({ ...grant(id, "ses_q3", "doc-x"), subject: { kind: "user", value } })
  const subjects = async (at: Awaited<ReturnType<typeof stand>>) => at.logic.cards().map((card) => card.subject)

  // 0.83.0's `documents_people` does not match ids (the fakes behave so); an instance that does is named this way.
  test("an unseen id is looked up through documents_people and shows by name and email", async () => {
    const asked: Array<[string, number | undefined]> = []
    const at = await stand({
      around: () => ({
        findPeople: async (query, limit) => {
          asked.push([query, limit])
          return [{ id: "e51c808f-4246", name: "Jesús Pérez", email: "jesus.perez@dynapps.es" }]
        },
      }),
    })
    await at.logic.request(unseen("call_1", "e51c808f-4246"))
    expect(await subjects(at)).toEqual([
      { kind: "user", value: "e51c808f-4246", name: "Jesús Pérez", email: "jesus.perez@dynapps.es" },
    ])
    expect(asked).toEqual([["e51c808f-4246", 1]])
  })

  test("an email is looked up the same way, matched by email", async () => {
    const at = await stand({
      around: () => ({
        findPeople: async () => [{ id: "u-luis", name: "Luis Martín", email: "Luis@Dynapps.es" }],
      }),
    })
    await at.logic.request(unseen("call_1", "luis@dynapps.es"))
    expect(await subjects(at)).toEqual([
      { kind: "user", value: "luis@dynapps.es", name: "Luis Martín", email: "Luis@Dynapps.es" },
    ])
  })

  test("a lookup that finds someone else, fails or takes too long leaves the id as the agent gave it", async () => {
    const at = await stand({
      around: () => ({
        findPeople: async (query) => {
          if (query === "e51c808f-1") return [{ id: "e51c808f-10", name: "Prefix Only", email: "p@dynapps.es" }]
          if (query === "e51c808f-2") return { code: "unreachable", message: "no answer", retryable: true }
          throw new Error("the MCP server broke")
        },
      }),
    })
    await at.logic.request(unseen("call_1", "e51c808f-1"))
    await at.logic.request(unseen("call_2", "e51c808f-2"))
    await at.logic.request(unseen("call_3", "e51c808f-3"))
    expect(await subjects(at)).toEqual([
      { kind: "user", value: "e51c808f-1" },
      { kind: "user", value: "e51c808f-2" },
      { kind: "user", value: "e51c808f-3" },
    ])
  })

  test("a lookup that never answers holds the card back no longer than lookupWithin", async () => {
    const at = await stand({ around: () => ({ findPeople: () => new Promise(() => {}) }) })
    jest.useFakeTimers()
    try {
      const shown = at.logic.request(unseen("call_1", "e51c808f-4246"))
      await flush()
      expect(at.logic.cards()).toEqual([])
      jest.advanceTimersByTime(DriveShare.lookupWithin)
      await shown
      expect(await subjects(at)).toEqual([{ kind: "user", value: "e51c808f-4246" }])
    } finally {
      jest.useRealTimers()
    }
  })

  test("with peopleByRest on, an id is read by id over REST, not looked up through the MCP server", async () => {
    const searched: string[] = []
    const at = await stand({
      capabilities: { peopleByRest: true },
      around: () => ({ findPeople: async (query) => (searched.push(query), []) }),
    })
    await at.logic.request(unseen("call_1", "user-luis"))
    expect(await subjects(at)).toEqual([{ kind: "user", value: "user-luis", name: "Luis Martín" }])
    expect(searched).toEqual([])
  })
})

describe("the people the account met, kept across conversations and restarts", () => {
  const jesus = { user_id: "e51c808f-4246", name: "Jesús Pérez", email: "jesus.perez@dynapps.es" }
  const byId = (id: string, session: string) => ({
    ...grant(id, session, "doc-x"),
    subject: { kind: "user", value: jesus.user_id },
  })
  // A lookup that would fail the test: the card must name the person from what the account kept.
  const noLookup = () => ({
    findPeople: async () => {
      throw new Error("looked up")
    },
  })
  const named = { kind: "user", value: jesus.user_id, name: jesus.name, email: jesus.email }

  test("a person the agent looked up in another conversation is named here, with no lookup", async () => {
    const searched: string[] = []
    const at = await stand({ around: () => ({ findPeople: async (query) => (searched.push(query), []) }) })
    at.logic.heard({ people: [jesus] })
    await at.logic.request(byId("call_1", "ses_other"))
    expect(at.logic.cards().map((card) => card.subject)).toEqual([named])
    expect(searched).toEqual([])
  })

  test("after a restart (the store read again) the person is still named", async () => {
    const store = storage(DriveIpc.Saved, DriveIpc.initial)
    const before = await stand({ store })
    before.logic.heard({ people: [jesus] })
    const after = await stand({ store, around: noLookup })
    await after.logic.request(byId("call_1", "ses_q3"))
    expect(after.logic.cards().map((card) => card.subject)).toEqual([named])
  })

  test("whoever a card named is remembered: from the conversation's own lookup, or found by email", async () => {
    const store = storage(DriveIpc.Saved, DriveIpc.initial)
    const first = await stand({ store })
    // The plugin named them from the conversation's own documents_people.
    await first.logic.request({ ...byId("call_1", "ses_a"), subject: named })
    const ana = { id: "u-ana", name: "Ana Ruiz", email: "ana@dynapps.es" }
    const second = await stand({ store, around: () => ({ findPeople: async () => [ana] }) })
    await second.logic.request({ ...grant("call_2", "ses_b", "doc-x"), subject: { kind: "user", value: ana.email } })
    const third = await stand({ store, around: noLookup })
    await third.logic.request(byId("call_3", "ses_c"))
    await third.logic.request({ ...grant("call_4", "ses_c", "doc-x"), subject: { kind: "user", value: "u-ana" } })
    expect(third.logic.cards().map((card) => card.subject?.name)).toEqual(["Jesús Pérez", "Ana Ruiz"])
  })

  test("only id, name and email are kept, for the account, the most recent keptPeople", async () => {
    const at = await stand()
    at.logic.heard({ people: [jesus] })
    expect(at.service.known.find("account-ana", jesus.user_id)).toEqual({
      id: jesus.user_id,
      name: jesus.name,
      email: jesus.email,
    })
    expect(at.service.known.find("account-ana", "JESUS.PEREZ@dynapps.es")?.id).toBe(jesus.user_id)
    expect(at.service.known.find("account-other", jesus.user_id)).toBeUndefined()
    const crowd = Array.from({ length: DriveIpc.keptPeople }, (_, index) => ({ id: `u-${index}`, name: `P${index}` }))
    at.service.known.remember("account-ana", crowd)
    expect(at.service.known.find("account-ana", jesus.user_id)).toBeUndefined()
    // Seen again: kept with what was seen last, and the oldest of the rest makes room.
    at.service.known.remember("account-ana", [
      { id: "u-0", name: "P0 renamed" },
      { id: "u-new", name: "New" },
    ])
    expect(at.service.known.find("account-ana", "u-0")?.name).toBe("P0 renamed")
    expect(at.service.known.find("account-ana", "u-1")).toBeUndefined()
    expect(at.service.known.find("account-ana", "u-2")?.name).toBe("P2")
    expect(at.service.known.find("account-ana", "u-new")?.name).toBe("New")
  })
})

describe("the user's decision", () => {
  test("Allow once runs this share only: the next one in the conversation shows its own card", async () => {
    const at = await stand()
    await at.logic.request(grant("call_1", "ses_q3", at.document))
    expect(await at.logic.decide("call_1", "once")).toBeUndefined()
    expect(at.decisions).toEqual([{ id: "call_1", allow: true }])
    expect(at.logic.cards()).toEqual([])
    await at.logic.request(grant("call_2", "ses_q3", at.document))
    expect(at.logic.cards().map((card) => card.id)).toEqual(["call_2"])
    expect(at.decisions).toHaveLength(1)
  })

  test("Allow in this conversation allows its later shares of that kind at once, and nowhere else", async () => {
    const at = await stand({ sessions: { ses_sub: { parentID: "ses_q3" } } })
    await at.logic.request(grant("call_1", "ses_q3", at.document))
    await at.logic.decide("call_1", "conversation")
    // The same conversation, a subagent of it included: no card.
    await at.logic.request(grant("call_2", "ses_q3", "doc-other"))
    await at.logic.request(grant("call_3", "ses_sub", at.document))
    expect(at.decisions).toEqual([
      { id: "call_1", allow: true },
      { id: "call_2", allow: true },
      { id: "call_3", allow: true },
    ])
    expect(at.logic.cards()).toEqual([])
    // Another conversation, and another kind of share in this one, ask again.
    await at.logic.request(grant("call_4", "ses_other", at.document))
    await at.logic.request({ id: "call_5", session: "ses_q3", kind: "revoke", document: at.document })
    expect(at.logic.cards().map((card) => card.id)).toEqual(["call_4", "call_5"])
    expect(at.decisions).toHaveLength(3)
  })

  test("Allow in this conversation also settles the cards of that kind already waiting there", async () => {
    const at = await stand()
    await at.logic.request(grant("call_1", "ses_q3", at.document))
    await at.logic.request(grant("call_2", "ses_q3", at.document))
    await at.logic.request(grant("call_3", "ses_other", at.document))
    await at.logic.request({ id: "call_4", session: "ses_q3", kind: "transfer", document: at.document })
    await at.logic.decide("call_1", "conversation")
    expect(at.decisions.toSorted((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: "call_1", allow: true },
      { id: "call_2", allow: true },
    ])
    expect(at.logic.cards().map((card) => card.id)).toEqual(["call_3", "call_4"])
  })

  test("Reject tells the plugin no, only that card leaves, and nothing is allowed after it", async () => {
    const at = await stand()
    await at.logic.request(grant("call_1", "ses_q3", at.document))
    await at.logic.request(grant("call_2", "ses_q3", at.document))
    await at.logic.decide("call_1", "reject")
    expect(at.decisions).toEqual([{ id: "call_1", allow: false }])
    expect(at.logic.cards().map((card) => card.id)).toEqual(["call_2"])
  })

  test("a card decided before, in another window, is no longer waiting", async () => {
    const at = await stand()
    await at.logic.request(grant("call_1", "ses_q3", at.document))
    await at.logic.decide("call_1", "once")
    expect(await at.logic.decide("call_1", "reject")).toMatchObject({ code: "not-found" })
    expect(at.decisions).toEqual([{ id: "call_1", allow: true }])
  })
})

describe("shares that stop waiting, and a main that reconnects", () => {
  test("a stopped share leaves its card, even while its names are read", async () => {
    const reading = { release: () => {} }
    const at = await stand({
      around: (fake) => ({
        get: (id) =>
          new Promise((resolve) => {
            reading.release = () => resolve(fake.get(id))
          }),
      }),
    })
    const late = at.logic.request(grant("call_1", "ses_q3", at.document))
    await flush()
    at.logic.withdraw("call_1")
    reading.release()
    await late
    expect(at.logic.cards()).toEqual([])
    await at.logic.request({ id: "call_2", session: "ses_q3", kind: "revoke" })
    at.logic.withdraw("call_2")
    expect(at.logic.cards()).toEqual([])
    expect(at.decisions).toEqual([])
  })

  test("the shares still waiting are shown once, and cards no longer waiting leave", async () => {
    const at = await stand()
    await at.logic.request(grant("call_1", "ses_q3", at.document))
    await at.logic.request(grant("call_2", "ses_q3", at.document))
    await at.logic.sync([grant("call_2", "ses_q3", at.document), grant("call_3", "ses_other", at.document)])
    expect(at.logic.cards().map((card) => card.id)).toEqual(["call_2", "call_3"])
  })
})
