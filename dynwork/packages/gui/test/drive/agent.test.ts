import { describe, expect, test } from "bun:test"
import type { DynWorkDocuments } from "@dynwork/server-plugin/documents"
import type { OpenCodeClient } from "@opencode/client/promise"
import { DriveAgent } from "../../src/drive/agent"
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
}

function stand(options: Standing = {}) {
  const sessions: Record<string, DriveAgent.Session> = options.sessions ?? {
    ses_q3: { directory: "/Users/ana/work/Billing", title: "Q3 report" },
  }
  const fake = DriveFake.make({ user: "user-ana" })
  // What reached `importBlob`, attribution included: 0.83 keeps no message on what it imports, so only the call shows it.
  const imports: Array<Parameters<DriveFake.Fake["importBlob"]>[0]> = []
  const backend: DriveFake.Fake = { ...fake, importBlob: (input) => (imports.push(input), fake.importBlob(input)) }
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
  const agent = DriveAgent.make({
    service,
    session: async (id) => sessions[id],
    untitled: "Untitled conversation",
    answer: async (answer) => void answers.push(answer),
  })
  const client = connect(service)
  const asked = async (id: string, session: string, verb: DynWorkDocuments.Verb = "create") => {
    await agent.ask({ id, session, verb })
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
  return { fake, imports, service, agent, answers, asked, paths, folderAt, touch, links, sessions, capabilities }
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

  test("once the instance names the conversation itself there is no message, and once the agent files itself no folder", async () => {
    const named = stand({ capabilities: { conversationLabel: true } })
    expect((await named.asked("call_1", "ses_q3"))?.message).toBeUndefined()
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

  test("the index leaves to the Drive what the Drive knows by conversation, and keeps the MCP's until it carries it too", async () => {
    const listed = stand({ capabilities: { docsByContext: true } })
    await listed.agent.touched(listed.touch({ verb: "create", output: { document_id: "doc-1" } }))
    expect(listed.links()).toHaveLength(1)
    const carried = stand({ capabilities: { docsByContext: true, contextByMcp: true } })
    await carried.agent.touched(carried.touch({ verb: "create", output: { document_id: "doc-1" } }))
    expect(carried.links()).toEqual([])
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

  test("is the agent's own to import once the MCP makes folders and keeps scripts", async () => {
    const filing = stand({ capabilities: { mcpFolders: true, rawHtmlByMcp: true } })
    await upload(filing)
    expect(filing.fake.calls.importBlob).toBeUndefined()
    // With folders but not scripts, the page still has to be imported to keep them.
    const folders = stand({ capabilities: { mcpFolders: true } })
    await upload(folders)
    expect(folders.fake.calls.importBlob).toBe(1)
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
    expect(events.subscribed).toEqual([["rpc.dynwork.documents.ask", "rpc.dynwork.documents.touch"]])
    expect(events.calls).toHaveLength(1)
    expect(events.calls[0]).toMatchObject({
      rpcID: "dynwork.documents",
      method: "answer",
      input: { id: "call_1", message: "Q3 report by DynWork", folder: expect.any(String) },
    })
    expect(subject.links().map((link) => [link.document, link.act])).toEqual([["doc-1", "created"]])
    cleanups.forEach((cleanup) => cleanup())
  })
})
