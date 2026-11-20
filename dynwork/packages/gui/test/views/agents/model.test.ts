import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import agentsView from "../../../src/views/agents"
import { createAgentsModel, tabs } from "../../../src/views/agents/model"
import { statuses } from "../../../src/views/agents/routine"
import { MINUTE } from "../../routines/fixture"
import { ids, names, setup } from "./fixture"

const local = ["Weekly ticket summary", "Nightly test run", "Timesheet draft", "Sort the Brain inbox"]
const remote = ["Sync CRM", "Merge request review", "Release notes", "Module audit"]

describe("one list, filtered by where it runs", () => {
  test("every routine of both backends is in one list, with a count per chip", async () => {
    const view = await setup()
    expect(names(view.model.visible())).toEqual([...local, ...remote])
    expect([view.model.count("all"), view.model.count("local"), view.model.count("remote")]).toEqual([8, 4, 4])
  })

  test.each([
    ["local", local],
    ["remote", remote],
    ["all", [...local, ...remote]],
  ] as const)("the %s chip shows its routines and keeps the counts", async (where, shown) => {
    const view = await setup()
    view.model.setWhere(where)
    expect(names(view.model.visible())).toEqual([...shown])
    expect(view.model.count("local")).toBe(4)
  })

  test("the routines page opens the same list filtered to Local", async () => {
    const view = await setup("local")
    expect(view.model.state.where).toBe("local")
    expect(names(view.model.visible())).toEqual(local)
  })

  test.each([
    ["active", [...local.filter((name) => name !== "Sort the Brain inbox"), ...remote.slice(0, 3)]],
    ["paused", ["Sort the Brain inbox", "Module audit"]],
    ["failing", ["Nightly test run"]],
    ["running", ["Sync CRM"]],
  ] as const)("the %s status filter", async (status, shown) => {
    const view = await setup()
    view.model.setStatus(status)
    expect(names(view.model.visible())).toEqual([...shown])
  })

  test("search narrows by name, whatever the case, on top of the chips", async () => {
    const view = await setup()
    view.model.setSearch("  REVIEW ")
    expect(names(view.model.visible())).toEqual(["Merge request review"])
    view.model.setWhere("local")
    expect(view.model.visible()).toEqual([])
    expect(view.model.count("local")).toBe(4)
  })

  test("the list follows the Ipc's state as it changes", async () => {
    const view = await setup()
    await view.model.toggle(view.find("Sort the Brain inbox"))
    view.model.setStatus("paused")
    expect(names(view.model.visible())).toEqual(["Module audit"])
  })

  test("every status has a filter and the tabs are the mockup's", () => {
    expect([...statuses]).toEqual(["all", "active", "paused", "failing", "running"])
    expect([...tabs]).toEqual(["mine", "templates", "activity"])
  })

  test("the view is the module's default export", () => {
    expect(typeof agentsView).toBe("function")
  })
})

describe("before and without the Ipc", () => {
  test("without a client the view is not ready, lists nothing and its actions do nothing", async () => {
    const model = createRoot(() => createAgentsModel({ client: () => undefined }))
    expect(model.ready()).toBe(false)
    expect(model.visible()).toEqual([])
    expect(model.backends()).toEqual([])
    await model.loadActivity()
    expect(model.activity()).toEqual([])
  })
})

describe("tabs and Activity", () => {
  test("Activity holds every backend's runs, newest first, through the same chips", async () => {
    const view = await setup()
    view.model.setTab("activity")
    await view.model.loadActivity()
    expect(ids(view.model.activity())).toEqual([
      "crm-0",
      "tickets-1",
      "tests-1",
      "reviews-0",
      "reviews-1",
      "crm-1",
      "notes-1",
      "chat-1",
      "chat-2",
      "crm-3",
      "tickets-2",
      "tickets-3",
      "tickets-4",
      "tickets-5",
    ])
    view.model.setWhere("remote")
    expect(ids(view.model.activity())).toEqual([
      "crm-0",
      "reviews-0",
      "reviews-1",
      "crm-1",
      "notes-1",
      "chat-1",
      "chat-2",
      "crm-3",
    ])
    view.model.setWhere("local")
    expect(view.model.activity().every((run) => run.ref.backend === "local")).toBe(true)
  })

  test("a farm task started outside DynWork is in Activity with no routine", async () => {
    const view = await setup()
    await view.model.loadActivity()
    const chat = view.model.activity().find((run) => run.ref.id === "chat-1")
    expect(chat && view.model.routineOf(chat)).toBeUndefined()
  })

  test("Activity pages through each backend that has more", async () => {
    const view = await setup()
    // Twenty-one more runs make the farm's first page full.
    // One run at a time: a routine does not start while a run of it is going.
    await Array.from({ length: 21 }).reduce<Promise<unknown>>(
      (previous) =>
        previous
          .then(() => view.wire.client.start({ backend: "farm", id: "notes" }))
          .then(() => {
            view.time.advance(10 * MINUTE)
            view.farm.settle()
          }),
      Promise.resolve(),
    )
    await view.model.loadActivity()
    expect(view.model.activityPage().more).toBe(true)
    expect(view.model.activity().length).toBe(6 + 20)
    await view.model.loadActivity(true)
    expect(view.model.activityPage().more).toBe(false)
    expect(view.model.activity().length).toBe(6 + 29)
  })

  test("the selected tab is the model's", async () => {
    const view = await setup()
    tabs.forEach((tab) => {
      view.model.setTab(tab)
      expect(view.model.state.tab).toBe(tab)
    })
  })
})

describe("the detail", () => {
  test("selecting a routine opens it, deselecting goes back to the list", async () => {
    const view = await setup()
    view.model.select(view.find("Sync CRM").ref)
    expect(view.model.selected()?.definition.name).toBe("Sync CRM")
    view.model.deselect()
    expect(view.model.selected()).toBeUndefined()
  })

  test("its history is the routine's runs, newest first", async () => {
    const view = await setup()
    const tickets = view.find("Weekly ticket summary")
    await view.model.loadHistory(tickets.ref)
    expect(ids(view.model.history(tickets.ref).runs)).toEqual([
      "tickets-1",
      "tickets-2",
      "tickets-3",
      "tickets-4",
      "tickets-5",
    ])
    expect(view.model.history(tickets.ref).runs.map((run) => run.state)).toEqual([
      "ok",
      "late",
      "missed",
      "failed",
      "blocked",
    ])
  })

  test("Run now starts a run that leads the history; a run event then finishes it in place", async () => {
    const view = await setup()
    const tickets = view.find("Weekly ticket summary")
    await view.model.loadHistory(tickets.ref)
    await view.model.start(tickets)
    const started = view.model.history(tickets.ref).runs[0]
    expect([started.state, started.trigger]).toEqual(["running", "manual"])
    expect(view.model.busy(`start/local/tickets`)).toBe(false)

    view.time.advance(2 * MINUTE)
    const watching = new AbortController()
    void view.wire.client.watch({ signal: watching.signal })
    view.local.settle()
    watching.abort()
    view.wire.events.forEach(view.model.received)
    const runs = view.model.history(tickets.ref).runs
    expect(runs.length).toBe(6)
    expect(runs[0].state).toBe("ok")
  })

  test("the Active switch pauses and resumes", async () => {
    const view = await setup()
    await view.model.toggle(view.find("Sync CRM"))
    expect(view.find("Sync CRM").state).toBe("paused")
    await view.model.toggle(view.find("Sync CRM"))
    expect(view.find("Sync CRM").state).toBe("active")
  })

  test("removing the open routine closes it", async () => {
    const view = await setup()
    const notes = view.find("Release notes")
    view.model.select(notes.ref)
    await view.model.remove(notes)
    expect(view.model.selected()).toBeUndefined()
    expect(names(view.model.routines())).not.toContain("Release notes")
  })

  test("a failed action shows its failure until dismissed", async () => {
    const view = await setup()
    const crm = view.find("Sync CRM")
    view.farm.setStatus("unreachable", "The Agent Farm does not answer.")
    await view.model.start(crm)
    expect(view.model.state.failure?.code).toBe("unreachable")
    view.model.dismiss()
    expect(view.model.state.failure).toBeUndefined()
  })
})

describe("the run viewer", () => {
  test("opens a remote run with its result, log and usage, and marks it read", async () => {
    const view = await setup()
    await view.model.loadActivity()
    const run = view.model.activity().find((candidate) => candidate.ref.id === "crm-1")!
    expect([run.unread, view.find("Sync CRM").unread]).toEqual([true, 2])

    expect(await view.model.open(run)).toBe("transcript")
    const viewer = view.model.state.viewer
    expect(viewer?.loading).toBe(false)
    expect(viewer?.transcript?.result).toContain("**3 opportunities created**")
    expect(viewer?.transcript?.log).toContain("07:39:05 Finished")
    expect(viewer?.transcript?.usage?.turns).toBe(38)
    expect(view.model.activity().find((candidate) => candidate.ref.id === "crm-1")?.unread).toBe(false)
    expect(view.find("Sync CRM").unread).toBe(1)

    view.model.closeViewer()
    expect(view.model.state.viewer).toBeUndefined()
  })

  test("a run still going has a log and no result yet", async () => {
    const view = await setup()
    await view.model.loadActivity()
    await view.model.open(view.model.activity().find((run) => run.ref.id === "crm-0")!)
    expect(view.model.state.viewer?.run.state).toBe("running")
    expect(view.model.state.viewer?.transcript?.result).toBeUndefined()
    expect(view.model.state.viewer?.transcript?.log).toContain("Reading 41 new opportunities")
  })

  test("a run that waits on a question shows it, and answering clears it in the viewer and in Activity", async () => {
    const view = await setup()
    await view.model.loadActivity()
    const waiting = view.model.activity().find((run) => run.question)!
    expect(await view.model.open(waiting)).toBe("transcript")
    const question = view.model.state.viewer?.run.question
    expect(question?.choices.length).toBeGreaterThan(1)

    await view.model.answer(question?.choices[0] ?? "")
    expect(view.model.state.failure).toBeUndefined()
    expect(view.model.state.viewer?.run.question).toBeUndefined()
    expect(view.model.state.viewer?.run.reason).toBeUndefined()
    expect(view.model.activity().find((run) => run.ref.id === waiting.ref.id)?.question).toBeUndefined()
  })

  test("an answer that is not one of the choices is the backend's to refuse, and its failure stays on screen", async () => {
    const view = await setup()
    await view.model.loadActivity()
    await view.model.open(view.model.activity().find((run) => run.question)!)
    await view.model.answer("Perhaps")
    expect(view.model.state.failure?.code).toBe("invalid")
    expect(view.model.state.viewer?.run.question).toBeDefined()
  })

  test("Continue sends the user's words as a reply: the new run opens in the viewer and joins the history", async () => {
    const view = await setup()
    await view.model.loadActivity()
    const finished = view.model.activity().find((run) => run.ref.id === "crm-1")!
    await view.model.open(finished)
    await view.model.loadHistory(finished.routine!)

    await view.model.reply("Do the same for the other repository.")
    const viewer = view.model.state.viewer
    expect(viewer?.run.ref.id).not.toBe("crm-1")
    expect(viewer?.run.routine).toEqual(finished.routine)
    expect(viewer?.run.state).toBe("running")
    expect(view.model.history(finished.routine!).runs[0]?.ref).toEqual(viewer?.run.ref)
    expect(view.model.activity()[0]?.ref).toEqual(viewer?.run.ref)
  })

  test("Continue with nothing written does nothing", async () => {
    const view = await setup()
    await view.model.loadActivity()
    const finished = view.model.activity().find((run) => run.ref.id === "crm-1")!
    await view.model.open(finished)
    await view.model.reply("   ")
    expect(view.model.state.viewer?.run.ref.id).toBe("crm-1")
    expect(view.model.state.failure).toBeUndefined()
  })

  test("a local run is not opened in the viewer: it belongs to its session", async () => {
    const view = await setup()
    await view.model.loadActivity()
    const local = view.model.activity().find((run) => run.ref.id === "tickets-1")!
    expect(await view.model.open(local)).toBe("session")
    expect(view.model.state.viewer).toBeUndefined()
  })

  test("a run event updates the run the viewer shows", async () => {
    const view = await setup()
    await view.model.loadActivity()
    const running = view.model.activity().find((run) => run.ref.id === "crm-0")!
    await view.model.open(running)
    view.model.received({ ...running, state: "ok", finished: running.started! + 9 * MINUTE })
    expect(view.model.state.viewer?.run.state).toBe("ok")
    expect(view.model.activity().find((run) => run.ref.id === "crm-0")?.state).toBe("ok")
  })

  test("a transcript that fails shows the failure", async () => {
    const view = await setup()
    await view.model.loadActivity()
    const run = view.model.activity().find((candidate) => candidate.ref.id === "crm-1")!
    view.farm.setStatus("signed-out")
    await view.model.open(run)
    expect(view.model.state.viewer?.failure?.code).toBe("signed-out")
  })
})

describe("lookups", () => {
  test("labels are read once per backend and lookup", async () => {
    const view = await setup()
    await view.model.loadChoices("farm", "plugins")
    expect(view.model.choices("farm", "plugins").map((choice) => choice.label)).toEqual([
      "CRM tools",
      "Odoo connector",
      "Review kit",
    ])
    expect(view.model.choices("local", "plugins")).toEqual([])
  })
})
