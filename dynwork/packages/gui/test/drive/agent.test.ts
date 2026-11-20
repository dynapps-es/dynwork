import { describe, expect, test } from "bun:test"
import type { DynWorkDocuments } from "@dynwork/server-plugin/documents"
import type { OpenCodeClient } from "@opencode/client/promise"
import { DriveAgent } from "../../src/drive/agent"
import { fail, type Backend } from "../../src/drive/backend"
import type { DriveCapabilities } from "../../src/drive/capabilities"
import { DriveFake } from "../../src/drive/fake"
import { DriveIpc } from "../../src/drive/ipc"
import { storage } from "../routines/fixture"
import { ok } from "./conformance"
import { connect, flush, manualTimers } from "./wire"

// The agent's documents on the Drive's side: the plugin's asks and touches arrive as it publishes them, and every answer
// it would read is recorded. The Drive is the in-memory fake and the service is the real one, so the index, the saved
// folders and the attribution are the ones a window would see.

const ana = { id: "account-ana", user: "ana@dynapps.es" }
const text = (value: string) => new TextEncoder().encode(value)

interface Standing {
  capabilities?: Partial<DriveCapabilities.Capabilities>
  sessions?: Record<string, DriveAgent.Session>
  /** How the fake Drive behaves (`nameTaken`, as 0.84). */
  drive?: DriveFake.Options
  /** Replaces methods of the Drive the service reads, around the fake. */
  around?: (fake: DriveFake.Fake) => Partial<Backend>
}

function stand(options: Standing = {}) {
  const sessions: Record<string, DriveAgent.Session> = options.sessions ?? {
    ses_q3: { directory: "/Users/ana/work/Billing", title: "Q3 report" },
  }
  const fake = DriveFake.make({ user: "user-ana", ...options.drive })
  // What reached `importBlob`, attribution included: 0.83 keeps no message on what it imports, so only the call shows it.
  const imports: Array<Parameters<DriveFake.Fake["importBlob"]>[0]> = []
  const backend: DriveFake.Fake = {
    ...fake,
    importBlob: (input) => (imports.push(input), fake.importBlob(input)),
    ...options.around?.(fake),
  }
  const capabilities = { value: options.capabilities ?? {} }
  const service = DriveIpc.make({
    account: () => ana,
    backend: () => backend,
    store: storage(DriveIpc.Saved, DriveIpc.initial),
    changed: () => {},
    capabilities: () => capabilities.value,
    timers: manualTimers(),
  })
  const answers: DynWorkDocuments.Answer[] = []
  // What the plugin is told of each page it waits on: the upload's result carries it to the agent.
  const told: DynWorkDocuments.Imported[] = []
  const agent = DriveAgent.make({
    service,
    session: async (id) => sessions[id],
    untitled: "Untitled conversation",
    answer: async (answer) => void answers.push(answer),
    imported: async (imported) => void told.push(imported),
  })
  const client = connect(service)
  const asked = async (
    id: string,
    session: string,
    verb: DynWorkDocuments.Askable = "create",
    edit: Pick<DynWorkDocuments.Ask, "document" | "replace"> = {},
  ) => {
    await agent.ask({ id, session, verb, ...edit })
    return answers.find((answer) => answer.id === id)
  }
  // Every folder from the root, walked as the instance is read: a level at a time.
  const tree = async (parent?: string, prefix: string[] = []): Promise<Array<{ id: string; path: string }>> => {
    const own = await ok(fake.children(parent))
    const below = await Promise.all(
      own.map(async (folder) => [
        { id: folder.id, path: [...prefix, folder.name].join("/") },
        ...(await tree(folder.id, [...prefix, folder.name])),
      ]),
    )
    return below.flat()
  }
  const paths = async () => (await tree()).map((folder) => folder.path).toSorted()
  const folderAt = async (path: string) => (await tree()).find((folder) => folder.path === path)?.id
  const touch = (
    value: Partial<DynWorkDocuments.Touch> & Pick<DynWorkDocuments.Touch, "verb">,
  ): DynWorkDocuments.Touch => ({
    session: "ses_q3",
    call: `call_${Math.random()}`,
    input: {},
    output: {},
    ...value,
  })
  const links = () => client.state().links
  return {
    fake,
    imports,
    service,
    client,
    agent,
    answers,
    told,
    asked,
    paths,
    folderAt,
    touch,
    links,
    sessions,
    capabilities,
  }
}

describe("before a write", () => {
  test("a new document is given the conversation's folder under Artifacts/<project>, made on the way", async () => {
    const { asked, paths, folderAt } = stand()
    const answer = await asked("call_1", "ses_q3")
    expect(await paths()).toEqual(["Artifacts", "Artifacts/Billing", "Artifacts/Billing/Q3 report"])
    expect(answer?.folder).toBe(await folderAt("Artifacts/Billing/Q3 report"))
  })

  test("the revision's message names the conversation, after the DynWork it was written through", async () => {
    const { asked } = stand()
    expect((await asked("call_1", "ses_q3"))?.message).toBe("Q3 report by DynWork")
  })

  test("the conversation keeps its folder: a second document goes to the one the first made", async () => {
    const { asked, fake } = stand()
    const first = await asked("call_1", "ses_q3")
    const second = await asked("call_2", "ses_q3")
    expect(second?.folder).toBe(first?.folder)
    expect(fake.calls.createFolder).toBe(3)
  })

  test("writes of one program run together make the folders once", async () => {
    const { agent, answers, fake, paths } = stand()
    await Promise.all(["call_1", "call_2", "call_3"].map((id) => agent.ask({ id, session: "ses_q3", verb: "create" })))
    expect(new Set(answers.map((answer) => answer.folder)).size).toBe(1)
    expect(fake.calls.createFolder).toBe(3)
    expect(await paths()).toHaveLength(3)
  })

  test("two conversations of a project share its folder, and one of the same title is told apart by its id", async () => {
    const { asked, paths, sessions } = stand()
    sessions.ses_other = { directory: "/Users/ana/work/Billing", title: "Q3 report" }
    sessions.ses_third = { directory: "/Users/ana/work/Billing", title: "Closing" }
    const first = await asked("call_1", "ses_q3")
    const other = await asked("call_2", "ses_other")
    await asked("call_3", "ses_third")
    expect(other?.folder).not.toBe(first?.folder)
    expect(await paths()).toEqual([
      "Artifacts",
      "Artifacts/Billing",
      "Artifacts/Billing/Closing",
      "Artifacts/Billing/Q3 report",
      "Artifacts/Billing/Q3 report (_other)",
    ])
  })

  test("a conversation without a title, or with slashes in it, gets a folder name the Drive takes", async () => {
    const { asked, paths, sessions } = stand()
    sessions.ses_blank = { directory: "/Users/ana/work/Billing" }
    sessions.ses_slash = { directory: "/Users/ana/work/Billing", title: "Q3/Q4 plan\nfinal" }
    await asked("call_1", "ses_blank")
    await asked("call_2", "ses_slash")
    expect(await paths()).toEqual([
      "Artifacts",
      "Artifacts/Billing",
      "Artifacts/Billing/Q3-Q4 plan-final",
      "Artifacts/Billing/Untitled conversation",
    ])
  })

  test("a folder the user deleted is made again at the next write", async () => {
    const { asked, fake, paths, service } = stand()
    const first = await asked("call_1", "ses_q3")
    // The instance no longer lists the folder: the saved one is not trusted blindly.
    service.folder.set(ana.id, "ses_q3", "folder-that-is-gone")
    const second = await asked("call_2", "ses_q3")
    expect(second?.folder).toBe(first?.folder)
    expect(await paths()).toHaveLength(3)
    expect(fake.calls.createFolder).toBe(3)
  })

  test("a revision of an edit is signed, and no folder is made for it", async () => {
    const { asked, fake } = stand()
    const answer = await asked("call_1", "ses_q3", "edit")
    expect(answer).toEqual({ id: "call_1", message: "Q3 report by DynWork" })
    expect(fake.calls.createFolder).toBeUndefined()
  })

  test("the instance cannot name the conversation of an MCP write that carries no context, and once the agent files itself no folder", async () => {
    // With conversationLabel on, the agent's MCP write still names its conversation in the message: it carries no
    // context until contextByMcp, so the instance records none to show.
    const named = stand({ capabilities: { conversationLabel: true } })
    expect((await named.asked("call_1", "ses_q3"))?.message).toBe("Q3 report by DynWork")
    expect((await named.asked("call_2", "ses_q3"))?.folder).toBeDefined()
    const filing = stand({ capabilities: { mcpFolders: true } })
    expect(await filing.asked("call_1", "ses_q3")).toEqual({ id: "call_1", message: "Q3 report by DynWork" })
    expect(await filing.paths()).toEqual([])
  })

  test("a conversation the service does not know leaves the call as it was, and a Drive that does not answer gives it no folder", async () => {
    const { asked, fake } = stand()
    expect(await asked("call_1", "ses_missing")).toEqual({ id: "call_1" })
    fake.down({ code: "unreachable", message: "down", retryable: true })
    // The message needs no Drive; the folder does.
    expect(await asked("call_2", "ses_q3")).toEqual({ id: "call_2", message: "Q3 report by DynWork" })
  })
})

describe("an edit of an HTML page (D21)", () => {
  const page = async (subject: ReturnType<typeof stand>, name = "report.html", mime = "text/html") =>
    (await ok(subject.fake.upload({ name, bytes: text("<h1>R</h1><script>1</script>"), mime }))).document.id

  test("by ops is refused before it reaches the instance, telling the agent to upload the whole page again", async () => {
    const subject = stand()
    const document = await page(subject)
    const answer = await subject.asked("call_1", "ses_q3", "edit", { document })
    expect(answer).toEqual({ id: "call_1", refuse: DriveAgent.htmlRefused })
    expect(answer?.refuse).toContain("documents_upload")
    expect(subject.fake.calls.edit).toBeUndefined()
  })

  test("is refused whether or not the service knows the conversation", async () => {
    const subject = stand()
    const document = await page(subject)
    expect((await subject.asked("call_1", "ses_missing", "edit", { document }))?.refuse).toBe(DriveAgent.htmlRefused)
  })

  test("an edit of another format goes, signed; so does one that replaces the page from a blob, without a read", async () => {
    const subject = stand()
    const notes = await page(subject, "notes.md", "text/markdown")
    expect(await subject.asked("call_1", "ses_q3", "edit", { document: notes })).toEqual({
      id: "call_1",
      message: "Q3 report by DynWork",
    })
    const reads = subject.fake.calls.get
    const html = await page(subject)
    expect(await subject.asked("call_2", "ses_q3", "edit", { document: html, replace: true })).toEqual({
      id: "call_2",
      message: "Q3 report by DynWork",
    })
    expect(subject.fake.calls.get).toBe(reads)
  })

  test("rawHtmlByMcp on: the edit goes without reading the document", async () => {
    const subject = stand({ capabilities: { rawHtmlByMcp: true } })
    const document = await page(subject)
    expect((await subject.asked("call_1", "ses_q3", "edit", { document }))?.refuse).toBeUndefined()
    expect(subject.fake.calls.get).toBeUndefined()
  })

  test("a document that cannot be read lets the edit go: the instance answers it", async () => {
    const subject = stand()
    const answer = await subject.asked("call_1", "ses_q3", "edit", { document: "not-there" })
    expect(answer).toEqual({ id: "call_1", message: "Q3 report by DynWork" })
  })
})

describe("the 0.84 way of working with a page (mcpFolders, rawHtmlByMcp)", () => {
  const page = `<h1>Report</h1><script>document.title = "live"</script>`

  test("an import is given the conversation's folder like a creation", async () => {
    const { asked, paths, folderAt } = stand()
    const answer = await asked("call_1", "ses_q3", "import")
    expect(await paths()).toEqual(["Artifacts", "Artifacts/Billing", "Artifacts/Billing/Q3 report"])
    expect(answer?.folder).toBe(await folderAt("Artifacts/Billing/Q3 report"))
  })

  test("mcpFolders on: DynWork makes no folder; an import or a creation gets the conversation's only once DynWork knows it", async () => {
    const subject = stand({ capabilities: { mcpFolders: true } })
    expect(await subject.asked("call_1", "ses_q3", "import")).toEqual({ id: "call_1", message: "Q3 report by DynWork" })
    expect(await subject.asked("call_2", "ses_q3", "create")).toEqual({ id: "call_2", message: "Q3 report by DynWork" })
    expect(subject.fake.calls.createFolder).toBeUndefined()
    expect(subject.fake.calls.children).toBeUndefined()
    expect(await subject.paths()).toEqual([])
    // A conversation DynWork filed before the instance moved to 0.84 keeps its folder, unread.
    subject.service.folder.set(ana.id, "ses_q3", "folder-before")
    expect((await subject.asked("call_3", "ses_q3", "import"))?.folder).toBe("folder-before")
    expect((await subject.asked("call_4", "ses_q3", "create"))?.folder).toBe("folder-before")
    expect(subject.fake.calls.createFolder).toBeUndefined()
  })

  test("what the agent imported enters the conversation's index as created, by the MCP, and is not imported again", async () => {
    const subject = stand({ capabilities: { mcpFolders: true } })
    const blob = subject.fake.stage(text(page), "text/html")
    await subject.agent.touched(
      subject.touch({ verb: "upload", input: { name: "report.html" }, output: { blob_ref: blob, mime: "text/html" } }),
    )
    await subject.agent.touched(
      subject.touch({
        verb: "import",
        input: { name: "report.html" },
        output: { document_id: "doc-9", revision_id: "rev-1", format: "html", name: "report.html" },
      }),
    )
    expect(subject.fake.calls.importBlob).toBeUndefined()
    expect(subject.links()).toMatchObject([{ document: "doc-9", act: "created", revision: "rev-1", via: "mcp" }])
  })

  test("a page rewritten whole is an edit of that document, in the index at the new revision", async () => {
    const subject = stand({ capabilities: { rawHtmlByMcp: true } })
    await subject.agent.touched(
      subject.touch({
        verb: "edit",
        input: { document_id: "doc-1" },
        output: { document_id: "doc-1", revision_id: "rev-2" },
      }),
    )
    expect(subject.links()).toMatchObject([{ document: "doc-1", act: "edited", revision: "rev-2", via: "mcp" }])
  })

  test("the rewrite passes the HTML guard with rawHtmlByMcp on or off, and an edit by ops passes only with it on", async () => {
    const off = stand()
    const document = (await ok(off.fake.upload({ name: "r.html", bytes: text(page), mime: "text/html" }))).document.id
    expect((await off.asked("call_1", "ses_q3", "edit", { document, replace: true }))?.refuse).toBeUndefined()
    expect((await off.asked("call_2", "ses_q3", "edit", { document }))?.refuse).toBe(DriveAgent.htmlRefused)
    const on = stand({ capabilities: { rawHtmlByMcp: true } })
    expect((await on.asked("call_3", "ses_q3", "edit", { document, replace: true }))?.refuse).toBeUndefined()
    expect((await on.asked("call_4", "ses_q3", "edit", { document }))?.refuse).toBeUndefined()
  })
})

describe("a folder made meanwhile (G05)", () => {
  test("0.84 refuses a second folder of a name as name_taken: the one already there is used", async () => {
    // The Drive's root was read before `Artifacts` was made elsewhere (the web, another computer)
    const stale = { root: true }
    const subject = stand({
      drive: { nameTaken: true },
      around: (fake) => ({
        children: async (parent) => {
          if (parent !== undefined || !stale.root) return fake.children(parent)
          stale.root = false
          return []
        },
      }),
    })
    await ok(subject.fake.createFolder({ name: "Artifacts" }))
    const answer = await subject.asked("call_1", "ses_q3")
    expect(await subject.paths()).toEqual(["Artifacts", "Artifacts/Billing", "Artifacts/Billing/Q3 report"])
    expect(answer?.folder).toBe(await subject.folderAt("Artifacts/Billing/Q3 report"))
    // Made elsewhere, refused here, then the project's and the conversation's
    expect(subject.fake.calls.createFolder).toBe(4)
  })

  test("a refusal with no folder of that name to be found is the answer: no folder for the document", async () => {
    const subject = stand({
      around: () => ({
        createFolder: async () => ({ code: "conflict", message: "taken", retryable: false }) as const,
      }),
    })
    expect(await subject.asked("call_1", "ses_q3")).toEqual({ id: "call_1", message: "Q3 report by DynWork" })
  })
})

describe("the conversation in each write (contextByMcp, 0.84)", () => {
  const at84 = { contextByMcp: true, conversationLabel: true }
  const sessions = {
    ses_q3: { directory: "/Users/ana/work/Billing", title: "Q3 report" },
    ses_week: { directory: "/Users/ana/work/Billing", title: "Weekly" },
  }

  test("each write carries the context DynWork registered for its own conversation, and no message the instance can name", async () => {
    const subject = stand({ capabilities: at84, sessions })
    const q3 = await subject.asked("call_1", "ses_q3", "create")
    const week = await subject.asked("call_2", "ses_week", "comment")
    expect(q3?.context).toBe(subject.service.context("ses_q3"))
    expect(week?.context).toBe(subject.service.context("ses_week"))
    expect(q3?.context).toBeDefined()
    expect(q3?.context).not.toBe(week?.context)
    expect(q3?.message).toBeUndefined()
    expect(subject.fake.calls.createContext).toBe(2)
  })

  test("a conversation open in two tabs is one session: its writes share one registration and one context", async () => {
    const subject = stand({ capabilities: at84, sessions })
    await Promise.all(["call_1", "call_2", "call_3"].map((id) => subject.agent.ask({ id, session: "ses_q3", verb: "edit" })))
    expect(new Set(subject.answers.map((answer) => answer.context))).toEqual(new Set([subject.service.context("ses_q3")]))
    expect(subject.fake.calls.createContext).toBe(1)
  })

  test("a comment, a review and a copy are given only the context: no message, no folder", async () => {
    const subject = stand({ capabilities: at84, sessions })
    const context = (await subject.asked("call_1", "ses_q3", "edit"))?.context
    for (const [index, verb] of (["comment", "proposals", "copy"] as const).entries())
      expect(await subject.asked(`call_${index + 2}`, "ses_q3", verb)).toEqual({ id: `call_${index + 2}`, context })
    expect(subject.fake.calls.createFolder).toBeUndefined()
  })

  test("without contextByMcp (0.83) no context is registered or given, and the message names the conversation", async () => {
    const subject = stand({ capabilities: { conversationLabel: true }, sessions })
    expect(await subject.asked("call_1", "ses_q3", "edit")).toEqual({ id: "call_1", message: "Q3 report by DynWork" })
    expect(subject.fake.calls.createContext).toBeUndefined()
  })

  test("a registration that fails leaves the write without a context, signed by the message instead", async () => {
    const subject = stand({
      capabilities: at84,
      sessions,
      around: () => ({
        createContext: async () => ({ code: "unreachable", message: "down", retryable: true }) as const,
      }),
    })
    expect(await subject.asked("call_1", "ses_q3", "edit")).toEqual({ id: "call_1", message: "Q3 report by DynWork" })
  })

  test("a context the instance refused is registered again at the next write; another conversation's refusal changes nothing", async () => {
    const subject = stand({ capabilities: at84, sessions })
    const first = (await subject.asked("call_1", "ses_q3", "edit"))?.context ?? ""
    const week = (await subject.asked("call_2", "ses_week", "edit"))?.context ?? ""
    // A stale context that is not the conversation's (another's, or one already replaced) is left alone.
    subject.agent.stale({ session: "ses_q3", context: week })
    expect((await subject.asked("call_3", "ses_q3", "edit"))?.context).toBe(first)
    subject.agent.stale({ session: "ses_q3", context: first })
    const again = (await subject.asked("call_4", "ses_q3", "edit"))?.context
    expect(again).toBeDefined()
    expect(again).not.toBe(first)
    expect(again).not.toBe(week)
    expect(subject.service.context("ses_week")).toBe(week)
    expect(subject.fake.calls.createContext).toBe(3)
  })
})

describe("folders the agent makes (mcpFolders, 0.84)", () => {
  test("a folder refused as name_taken is answered with the one of that name already there, at the root or in its parent", async () => {
    const subject = stand({ capabilities: { mcpFolders: true } })
    const artifacts = await ok(subject.fake.createFolder({ name: "Artifacts" }))
    const billing = await ok(subject.fake.createFolder({ name: "Billing", parent: artifacts.id }))
    await subject.agent.ask({ id: "call_1:taken", session: "ses_q3", verb: "folder", name: "Artifacts" })
    await subject.agent.ask({
      id: "call_2:taken",
      session: "ses_q3",
      verb: "folder",
      name: "Billing",
      parent: artifacts.id,
    })
    expect(subject.answers).toEqual([
      { id: "call_1:taken", folder: artifacts.id },
      { id: "call_2:taken", folder: billing.id },
    ])
    // Nothing is made: the agent uses the folder that is there.
    expect(subject.fake.calls.createFolder).toBe(2)
  })

  test("no folder of that name to be found, or a Drive that does not answer, is an answer with nothing", async () => {
    const subject = stand({ capabilities: { mcpFolders: true } })
    await subject.agent.ask({ id: "call_1:taken", session: "ses_q3", verb: "folder", name: "Artifacts" })
    subject.fake.down({ code: "unreachable", message: "down", retryable: true })
    await subject.agent.ask({ id: "call_2:taken", session: "ses_q3", verb: "folder", name: "Artifacts" })
    expect(subject.answers).toEqual([{ id: "call_1:taken" }, { id: "call_2:taken" }])
  })

  // `Artifacts/Billing` as the agent finds it, with the folder ask it makes before `documents_folder {action: create}`.
  async function project(subject: ReturnType<typeof stand>) {
    const artifacts = await ok(subject.fake.createFolder({ name: "Artifacts" }))
    const billing = await ok(subject.fake.createFolder({ name: "Billing", parent: artifacts.id }))
    const making = async (id: string, session: string, parent: string, name: string) => {
      await subject.agent.ask({ id, session, verb: "folder", name, parent, making: true })
      return subject.answers.find((answer) => answer.id === id)
    }
    return { artifacts, billing, making }
  }

  test("the folders the agent makes under Artifacts take the project's and the conversation's names, not its own", async () => {
    const subject = stand({ capabilities: { mcpFolders: true } })
    const { artifacts, billing, making } = await project(subject)
    expect(await making("call_1", "ses_q3", artifacts.id, "billing-module")).toEqual({ id: "call_1", name: "Billing" })
    expect(await making("call_2", "ses_q3", billing.id, "VAT analysis")).toEqual({ id: "call_2", name: "Q3 report" })
    // Asking makes nothing: the agent's call does.
    expect(subject.fake.calls.createFolder).toBe(2)
  })

  test("a folder elsewhere keeps the agent's name, and without Artifacts there is nothing to name", async () => {
    const subject = stand({ capabilities: { mcpFolders: true } })
    const internal = await ok(subject.fake.createFolder({ name: "Internal" }))
    await subject.agent.ask({ id: "call_1", session: "ses_q3", verb: "folder", name: "Notes", parent: internal.id, making: true })
    const { billing, making } = await project(subject)
    const q3 = await ok(subject.fake.createFolder({ name: "Q3 report", parent: billing.id }))
    // Inside the conversation's own folder: a subfolder of the agent's.
    expect(await making("call_2", "ses_q3", q3.id, "Charts")).toEqual({ id: "call_2" })
    expect(subject.answers.find((answer) => answer.id === "call_1")).toEqual({ id: "call_1" })
    // A conversation the service does not know is not named.
    expect(await making("call_3", "ses_unknown", billing.id, "Charts")).toEqual({ id: "call_3" })
  })

  test("the folder the agent makes as the conversation's is kept as its folder, and a namesake is told apart by its id", async () => {
    const subject = stand({ capabilities: { mcpFolders: true } })
    subject.sessions.ses_other = { directory: "/Users/ana/work/Billing", title: "Q3 report" }
    const { billing, making } = await project(subject)
    expect((await making("call_1", "ses_q3", billing.id, "Q3"))?.name).toBe("Q3 report")
    const made = await ok(subject.fake.createFolder({ name: "Q3 report", parent: billing.id }))
    await subject.agent.touched(
      subject.touch({
        call: "call_1",
        verb: "folder",
        input: { action: "create", name: "Q3 report", parent_id: billing.id },
        output: { folder_id: made.id },
      }),
    )
    // The conversation's next document goes there when the agent leaves the folder out.
    expect((await subject.asked("call_2", "ses_q3", "create"))?.folder).toBe(made.id)
    // The same title in another conversation is not this one's folder: the end of its session id tells it apart.
    expect((await making("call_3", "ses_other", billing.id, "Q3 report"))?.name).toBe("Q3 report (_other)")
    // The conversation that holds it is named as before.
    expect((await making("call_4", "ses_q3", billing.id, "Q3 report"))?.name).toBe("Q3 report")
  })

  test("a conversation's folder refused as name_taken becomes the one already there", async () => {
    const subject = stand({ capabilities: { mcpFolders: true } })
    const { billing, making } = await project(subject)
    const there = await ok(subject.fake.createFolder({ name: "Q3 report", parent: billing.id }))
    expect((await making("call_1", "ses_q3", billing.id, "Q3"))?.name).toBe("Q3 report")
    await subject.agent.ask({
      id: "call_1:taken",
      session: "ses_q3",
      verb: "folder",
      name: "Q3 report",
      parent: billing.id,
    })
    expect(subject.answers.at(-1)).toEqual({ id: "call_1:taken", folder: there.id })
    expect((await subject.asked("call_2", "ses_q3", "create"))?.folder).toBe(there.id)
  })

  test("0.83 and 0.84 name a conversation's folder alike: a namesake made over REST tells the new one apart", async () => {
    const subject = stand()
    subject.sessions.ses_other = { directory: "/Users/ana/work/Billing", title: "Q3 report" }
    await subject.asked("call_1", "ses_q3", "create")
    expect(await subject.paths()).toContain("Artifacts/Billing/Q3 report")
    subject.capabilities.value = { mcpFolders: true }
    const billing = await subject.folderAt("Artifacts/Billing")
    await subject.agent.ask({
      id: "call_2",
      session: "ses_other",
      verb: "folder",
      name: "Q3",
      parent: billing,
      making: true,
    })
    expect(subject.answers.at(-1)).toEqual({ id: "call_2", name: "Q3 report (_other)" })
  })

  test("a folder the agent made has the Drive read again, and indexes nothing", async () => {
    const subject = stand({ capabilities: { mcpFolders: true } })
    await flush()
    const reads = subject.fake.calls.folders ?? 0
    await subject.agent.touched(
      subject.touch({ verb: "folder", input: { action: "create", name: "Q3 report" }, output: { folder_id: "f-q3" } }),
    )
    expect(subject.fake.calls.folders).toBe(reads + 1)
    expect(subject.links()).toEqual([])
  })
})

describe("after a write", () => {
  test("a document the agent created enters the conversation's index, newest first", async () => {
    const { agent, touch, links } = stand()
    await agent.touched(touch({ verb: "create", output: { document_id: "doc-1", revision_id: "rev-1" } }))
    expect(links()).toEqual([
      {
        conversation: "ses_q3",
        document: "doc-1",
        act: "created",
        revision: "rev-1",
        via: "mcp",
        at: expect.any(Number),
      },
    ])
  })

  test("an edit is an edit, a proposal is a proposal, and a copy or a rename say what they did", async () => {
    const { agent, touch, links } = stand()
    await agent.touched(touch({ verb: "edit", input: { document_id: "doc-1" }, output: { revision_id: "rev-2" } }))
    await agent.touched(
      touch({ verb: "edit", input: { document_id: "doc-2" }, output: { revision_id: "rev-3", proposal_id: "prop-1" } }),
    )
    await agent.touched(touch({ verb: "edit", input: { document_id: "doc-3", mode: "propose" }, output: {} }))
    await agent.touched(touch({ verb: "copy", input: { document_id: "doc-1" }, output: { document_id: "doc-4" } }))
    await agent.touched(
      touch({ verb: "update", input: { document_id: "doc-1" }, output: { head_revision_id: "rev-9" } }),
    )
    expect(
      links()
        .map((link) => [link.document, link.act])
        .toSorted(),
    ).toEqual([
      ["doc-1", "edited"],
      ["doc-2", "proposed"],
      ["doc-3", "proposed"],
      ["doc-4", "created"],
    ])
  })

  test("a document edited again is one entry, at its latest revision", async () => {
    const { agent, touch, links } = stand()
    await agent.touched(touch({ verb: "edit", input: { document_id: "doc-1" }, output: { revision_id: "rev-1" } }))
    await agent.touched(touch({ verb: "edit", input: { document_id: "doc-1" }, output: { revision_id: "rev-2" } }))
    await agent.touched(touch({ verb: "edit", input: { document_id: "doc-1" }, output: { revision_id: "rev-2" } }))
    expect(links().map((link) => link.revision)).toEqual(["rev-2"])
  })

  test("a call that names no document leaves the index alone", async () => {
    const { agent, touch, links } = stand()
    await agent.touched(touch({ verb: "create", output: {} }))
    await agent.touched(touch({ verb: "edit", input: {}, output: { revision_id: "rev-1" } }))
    expect(links()).toEqual([])
  })

  test("the index keeps the MCP's writes also where the Drive lists by conversation and the MCP carries it (G07)", async () => {
    for (const capabilities of [{ docsByContext: true }, { docsByContext: true, contextByMcp: true }]) {
      const subject = stand({ capabilities })
      await subject.agent.touched(subject.touch({ verb: "create", output: { document_id: "doc-1" } }))
      expect(subject.links()).toEqual([expect.objectContaining({ document: "doc-1", act: "created", via: "mcp" })])
    }
  })
})

describe("an uploaded page", () => {
  const page = `<h1>Report</h1><script>document.title = "live"</script>`

  async function upload(subject: ReturnType<typeof stand>, extra: Partial<DynWorkDocuments.Touch> = {}) {
    const blob = subject.fake.stage(text(page), "text/html")
    await subject.agent.touched(
      subject.touch({
        verb: "upload",
        input: { name: "report.html", mime: "text/html" },
        output: { blob_ref: blob, mime: "text/html" },
        ...extra,
      }),
    )
    return blob
  }

  test("is imported into the conversation's folder with its scripts, signed, and enters the index as created", async () => {
    const subject = stand()
    await upload(subject)
    const folder = { id: await subject.folderAt("Artifacts/Billing/Q3 report") }
    const listed = await ok(subject.fake.list({ scope: "folder", folder: folder.id }))
    expect(listed.documents.map((document) => [document.name, document.format])).toEqual([["report.html", "html"]])
    const id = listed.documents[0]!.id
    expect(new TextDecoder().decode((await ok(subject.fake.content(id))).bytes)).toContain("<script>")
    expect(subject.imports).toMatchObject([
      {
        name: "report.html",
        folder: folder?.id,
        message: "Q3 report by DynWork",
        contextId: subject.service.context("ses_q3"),
      },
    ])
    expect(subject.links()).toMatchObject([{ conversation: "ses_q3", document: id, act: "created", via: "rest" }])
  })

  test("is imported once however many times its call is heard", async () => {
    const subject = stand()
    const blob = await upload(subject)
    await subject.agent.touched(
      subject.touch({ verb: "upload", input: { name: "report.html" }, output: { blob_ref: blob, mime: "text/html" } }),
    )
    expect(subject.fake.calls.importBlob).toBe(1)
  })

  test("takes the next free name when the folder already has one of its own", async () => {
    const subject = stand()
    await upload(subject)
    await upload(subject, {
      output: { blob_ref: subject.fake.stage(text("<p>v2</p>"), "text/html"), mime: "text/html" },
    })
    const listed = await ok(
      subject.fake.list({ scope: "folder", folder: await subject.folderAt("Artifacts/Billing/Q3 report") }),
    )
    expect(listed.documents.map((document) => document.name).toSorted()).toEqual(["report (2).html", "report.html"])
  })

  test("an image or any file that is not a page is left in the instance's blobs, not made a document", async () => {
    const subject = stand()
    const blob = subject.fake.stage(text("png"), "image/png")
    await subject.agent.touched(
      subject.touch({ verb: "upload", input: { name: "logo.png" }, output: { blob_ref: blob, mime: "image/png" } }),
    )
    expect(subject.fake.calls.importBlob).toBeUndefined()
    expect(subject.links()).toEqual([])
  })

  test("is the agent's own to import once the MCP imports (mcpFolders), which keeps the scripts too", async () => {
    const filing = stand({ capabilities: { mcpFolders: true } })
    await upload(filing)
    expect(filing.fake.calls.importBlob).toBeUndefined()
    // The page is rewritten whole through `documents_edit`, which is no reason to stop importing a new one.
    const raw = stand({ capabilities: { rawHtmlByMcp: true } })
    await upload(raw)
    expect(raw.fake.calls.importBlob).toBe(1)
  })

  test("tells the agent, in the upload's own result, which document the page became", async () => {
    const subject = stand()
    await upload(subject, { call: "call_page" })
    const listed = await ok(
      subject.fake.list({ scope: "folder", folder: await subject.folderAt("Artifacts/Billing/Q3 report") }),
    )
    expect(subject.told).toEqual([{ id: "call_page", document: listed.documents[0]!.id, name: "report.html" }])
  })

  test("is told again, the same document, when its call is heard twice", async () => {
    const subject = stand()
    const blob = await upload(subject, { call: "call_page" })
    await subject.agent.touched(
      subject.touch({
        call: "call_page",
        verb: "upload",
        input: { name: "report.html" },
        output: { blob_ref: blob, mime: "text/html" },
      }),
    )
    expect(subject.fake.calls.importBlob).toBe(1)
    expect(subject.told).toHaveLength(2)
    expect(subject.told[1]).toEqual(subject.told[0]!)
  })

  test("whose answer names no mime (0.82) is still a page by the agent's mime or by its name", async () => {
    const subject = stand()
    const blob = subject.fake.stage(text(page), "text/html")
    await subject.agent.touched(
      subject.touch({ verb: "upload", input: { name: "dashboard.html" }, output: { blob_ref: blob } }),
    )
    expect(subject.imports).toMatchObject([{ name: "dashboard.html" }])
    expect(subject.told).toMatchObject([{ document: expect.any(String), name: "dashboard.html" }])
  })

  test("that the instance refuses is told to the agent, kept for the chat's Artifacts tab, and imported by a retry", async () => {
    const refusals = { left: 1 }
    const subject = stand({
      around: (fake) => ({
        importBlob: (input) =>
          refusals.left-- > 0
            ? Promise.resolve(fail("invalid", "The page is larger than the Drive takes."))
            : fake.importBlob(input),
      }),
    })
    await upload(subject, { call: "call_page" })
    expect(subject.told).toEqual([{ id: "call_page", failure: "The page is larger than the Drive takes." }])
    expect(subject.links()).toEqual([])
    expect(subject.client.state().unimported).toMatchObject([
      {
        conversation: "ses_q3",
        call: "call_page",
        name: "report.html",
        failure: { code: "invalid", message: "The page is larger than the Drive takes." },
      },
    ])
    const retried = await ok(subject.client.reimport({ conversation: "ses_q3", call: "call_page" }))
    expect(retried.document.name).toBe("report.html")
    expect(retried.document.folder).toBe(await subject.folderAt("Artifacts/Billing/Q3 report"))
    expect(subject.client.state().unimported).toEqual([])
    expect(subject.links()).toMatchObject([
      { conversation: "ses_q3", document: retried.document.id, act: "created", via: "rest" },
    ])
  })

  test("a retry that fails again stays in the Artifacts tab with the new reason; one for nothing kept is not-found", async () => {
    const subject = stand({
      around: () => ({ importBlob: async () => fail("unreachable", "Governance did not answer.") }),
    })
    await upload(subject, { call: "call_page" })
    const again = await subject.client.reimport({ conversation: "ses_q3", call: "call_page" })
    expect(again).toMatchObject({ code: "unreachable" })
    expect(subject.client.state().unimported).toMatchObject([
      { call: "call_page", failure: { code: "unreachable", message: "Governance did not answer." } },
    ])
    expect(await subject.client.reimport({ conversation: "ses_q3", call: "call_gone" })).toMatchObject({
      code: "not-found",
    })
  })

  test("whose conversation's folder cannot be made fails the same way, said to the agent", async () => {
    const subject = stand({
      around: () => ({ createFolder: async () => fail("forbidden", "Agents may not make folders here.") }),
    })
    await upload(subject, { call: "call_page" })
    expect(subject.fake.calls.importBlob).toBeUndefined()
    expect(subject.told).toEqual([{ id: "call_page", failure: "Agents may not make folders here." }])
    expect(subject.client.state().unimported).toMatchObject([{ call: "call_page", failure: { code: "forbidden" } }])
  })

  test("signed out of Governance, the agent hears that nothing was imported", async () => {
    const subject = stand()
    const signedOut = DriveIpc.make({
      account: () => undefined,
      backend: () => subject.fake,
      store: storage(DriveIpc.Saved, DriveIpc.initial),
      changed: () => {},
      timers: manualTimers(),
    })
    const told: DynWorkDocuments.Imported[] = []
    const agent = DriveAgent.make({
      service: signedOut,
      session: async () => subject.sessions.ses_q3,
      untitled: "Untitled conversation",
      answer: async () => undefined,
      imported: async (imported) => void told.push(imported),
    })
    await agent.touched(
      subject.touch({
        call: "call_page",
        verb: "upload",
        input: { name: "report.html", mime: "text/html" },
        output: { blob_ref: "b" },
      }),
    )
    expect(told).toEqual([{ id: "call_page", failure: "Sign in to Governance to use the Drive." }])
  })

  test("an image says nothing to the agent; on 0.84 (mcpFolders) the page is the agent's to import, and it is told so", async () => {
    const subject = stand()
    const blob = subject.fake.stage(text("png"), "image/png")
    await subject.agent.touched(
      subject.touch({ verb: "upload", input: { name: "logo.png" }, output: { blob_ref: blob, mime: "image/png" } }),
    )
    expect(subject.told).toEqual([])
    const filing = stand({ capabilities: { mcpFolders: true } })
    await upload(filing, { call: "call_page" })
    expect(filing.told).toEqual([{ id: "call_page" }])
    expect(filing.client.state().unimported).toEqual([])
  })

  test("without a known conversation lands in the Drive's root, still signed by its id", async () => {
    const subject = stand()
    await upload(subject, { session: "ses_unknown" })
    const root = await ok(subject.fake.list({ scope: "mine" }))
    expect(root.documents.map((document) => document.name)).toEqual(["report.html"])
    expect(await subject.paths()).toEqual([])
  })
})

describe("following the service", () => {
  // The service's client as far as `DriveAgent.setup` uses it: an event stream that says what it is given, the session
  // read, and the plugin's RPC.
  function client(events: Array<{ type: string; data: unknown }>) {
    const calls: Array<{ rpcID: string; method: string; input: unknown }> = []
    const subscribed: Array<ReadonlyArray<string>> = []
    return {
      calls,
      subscribed,
      // SAFETY: `setup` reads only `event.subscribe`, `session.get` and `rpc.call`, which this provides.
      value: {
        event: {
          subscribe: async function* (input: { types: ReadonlyArray<string>; signal: AbortSignal }) {
            subscribed.push(input.types)
            yield* events
            await new Promise((resolve) => input.signal.addEventListener("abort", resolve))
          },
        },
        session: {
          get: async () => ({ location: { directory: "/Users/ana/work/Billing" }, title: "Q3 report" }),
        },
        rpc: {
          call: async (input: { rpcID: string; method: string; input: unknown }) => void calls.push(input),
        },
      } as unknown as OpenCodeClient,
    }
  }

  test("answers the plugin's ask over its RPC and files what its touch says, until the app closes", async () => {
    const subject = stand()
    const events = client([
      { type: "rpc.dynwork.documents.ask", data: { id: "call_1", session: "ses_q3", verb: "create" } },
      {
        type: "rpc.dynwork.documents.touch",
        data: {
          session: "ses_q3",
          call: "call_1",
          verb: "create",
          input: {},
          output: { document_id: "doc-1", revision_id: "rev-1" },
        },
      },
      { type: "rpc.dynwork.documents.ask", data: { not: "an ask" } },
    ])
    const cleanups: Array<() => void> = []
    DriveAgent.setup(
      { onCleanup: (cleanup) => void cleanups.push(cleanup) },
      { service: subject.service, client: () => events.value, untitled: "Untitled conversation" },
    )
    await flush()
    await flush()
    expect(events.subscribed).toEqual([
      ["rpc.dynwork.documents.ask", "rpc.dynwork.documents.touch", "rpc.dynwork.documents.stale"],
    ])
    expect(events.calls).toHaveLength(1)
    expect(events.calls[0]).toMatchObject({
      rpcID: "dynwork.documents",
      method: "answer",
      input: { id: "call_1", message: "Q3 report by DynWork", folder: expect.any(String) },
    })
    expect(subject.links().map((link) => [link.document, link.act])).toEqual([["doc-1", "created"]])
    cleanups.forEach((cleanup) => cleanup())
  })

  test("tells the plugin over its RPC what became of a page the agent uploaded", async () => {
    const subject = stand()
    const blob = subject.fake.stage(text("<h1>Dash</h1>"), "text/html")
    const events = client([
      {
        type: "rpc.dynwork.documents.touch",
        data: {
          session: "ses_q3",
          call: "call_up",
          verb: "upload",
          input: { name: "dash.html", mime: "text/html" },
          output: { blob_ref: blob, mime: "text/html" },
        },
      },
    ])
    const cleanups: Array<() => void> = []
    DriveAgent.setup(
      { onCleanup: (cleanup) => void cleanups.push(cleanup) },
      { service: subject.service, client: () => events.value, untitled: "Untitled conversation" },
    )
    for (const _ of Array.from({ length: 4 })) await flush()
    expect(events.calls).toEqual([
      {
        rpcID: "dynwork.documents",
        method: "imported",
        input: { id: "call_up", document: expect.any(String), name: "dash.html" },
      },
    ])
    cleanups.forEach((cleanup) => cleanup())
  })
})
