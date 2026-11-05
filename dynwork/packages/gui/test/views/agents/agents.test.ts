import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import agentsView from "../../../src/views/agents"
import { catalog, demoAgents, schedules } from "../../../src/views/agents/demo"
import en from "../../../src/views/agents/en"
import {
  buildAgent,
  createAgentsModel,
  emptyNewAgent,
  filters,
  matches,
  startSimulation,
  statusTone,
  tabs,
  triggerKey,
} from "../../../src/views/agents/model"

// A fixed clock keeps the log times of the tests readable.
const at = new Date(2026, 10, 3, 10, 50, 0)
const create = () => createAgentsModel(demoAgents(), () => at)
const ids = (agents: readonly { id: string }[]) => agents.map((agent) => agent.id)
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("the demo agents", () => {
  test("six agents are listed in the mockup's order", () => {
    const model = create()
    expect(ids(model.visible())).toEqual([
      "mr-review",
      "migration-analysis",
      "release-notes",
      "brain-curator",
      "ticket-triage",
      "flow-tester",
    ])
  })

  test("every agent has what the detail tabs show", () => {
    demoAgents().forEach((agent) => {
      expect(agent.log.length).toBeGreaterThan(0)
      expect(agent.runs.length).toBeGreaterThan(0)
      expect(agent.name).not.toBe("")
    })
    expect(demoAgents().find((agent) => agent.id === "flow-tester")?.failure).toBe("It ran out of time")
  })

  test("each mount starts from a fresh copy of the seed", () => {
    const first = create()
    first.stop("mr-review")
    expect(create().state.agents[0].status).toBe("running")
  })

  test("the view is the module's default export", () => {
    expect(typeof agentsView).toBe("function")
  })
})

describe("filters", () => {
  test.each([
    ["all", 6, ["mr-review", "migration-analysis", "release-notes", "brain-curator", "ticket-triage", "flow-tester"]],
    ["running", 3, ["mr-review", "migration-analysis", "release-notes"]],
    ["idle", 2, ["brain-curator", "ticket-triage"]],
    ["failed", 1, ["flow-tester"]],
  ] as const)("%s shows %i agents", (filter, count, shown) => {
    const model = create()
    expect(model.count(filter)).toBe(count)
    model.filter(filter)
    expect(ids(model.visible())).toEqual(shown)
  })

  test("running counts a queued agent too", () => {
    const queued = demoAgents().find((agent) => agent.status === "queued")
    expect(queued && matches("running", queued)).toBe(true)
    expect(queued && matches("idle", queued)).toBe(false)
  })

  test("a filter that hides the selected agent clears the selection", () => {
    const model = create()
    model.select("flow-tester")
    model.filter("idle")
    expect(model.selected()).toBeUndefined()
    model.select("ticket-triage")
    model.filter("idle")
    expect(model.selected()?.id).toBe("ticket-triage")
  })

  test("the counts follow the agents as they change", () => {
    const model = create()
    model.stop("mr-review")
    expect(filters.map((filter) => model.count(filter))).toEqual([6, 2, 3, 1])
  })
})

describe("selection and tabs", () => {
  test("selecting a row selects its agent and opens Overview", () => {
    const model = create()
    model.tab("logs")
    model.select("release-notes")
    expect(model.selected()?.name).toBe("Release notes")
    expect(model.state.tab).toBe("overview")
  })

  test("tabs switch", () => {
    const model = create()
    model.select("mr-review")
    expect(tabs.map((tab) => (model.tab(tab), model.state.tab))).toEqual([...tabs])
  })

  test("the detail opens only once a row is selected, at every width", () => {
    const model = create()
    expect(model.selected()).toBeUndefined()
    model.select("brain-curator")
    expect(model.selected()?.id).toBe("brain-curator")
    // Close, the scrim, Escape or Back clear it and the list shows alone again.
    model.deselect()
    expect(model.selected()).toBeUndefined()
  })

  test("the row's trigger reads from its schedule", () => {
    const keys = ["mr-review", "brain-curator", "ticket-triage"].map((id) =>
      triggerKey(demoAgents().find((agent) => agent.id === id)!),
    )
    expect(keys).toEqual(["agents.trigger.onDemand", "agents.trigger.scheduled", "agents.trigger.paused"])
  })
})

describe("New agent", () => {
  test("running an agent adds a queued row at the top, selected, and shows it under All", () => {
    const model = create()
    model.filter("failed")
    const result = model.add({
      ...emptyNewAgent(),
      repo: "https://gitlab.dynapps.test/odoo/odoo-modules",
      branch: "17.0",
    })

    expect("agent" in result && result.agent.name).toBe("Merge request review")
    expect(model.state.agents).toHaveLength(7)
    expect(model.state.agents[0].status).toBe("queued")
    expect(model.state.agents[0].id).toBe("mr-review-2")
    expect(model.state.filter).toBe("all")
    expect(model.selected()?.id).toBe("mr-review-2")
    expect(model.count("running")).toBe(4)
  })

  test("a prompt needs a name and the prompt", () => {
    const form = { ...emptyNewAgent(), mode: "prompt" } as const
    expect(buildAgent(form, [])).toEqual({ error: "name" })
    expect(buildAgent({ ...form, name: "Release checklist" }, [])).toEqual({ error: "input" })
    const built = buildAgent({ ...form, name: "Release checklist", input: "List what is left.\nThen stop." }, [])
    expect("agent" in built && built.agent).toMatchObject({
      id: "release-checklist",
      slug: "release-checklist",
      task: "List what is left.",
      plugins: "None",
      repo: "No repository",
    })
  })

  test("a repository must be reachable over https", () => {
    expect(buildAgent({ ...emptyNewAgent(), repo: "git@gitlab.dynapps.test:odoo/odoo-modules.git" }, [])).toEqual({
      error: "repo",
    })
  })

  test("a rejected form adds nothing", () => {
    const model = create()
    expect(model.add({ ...emptyNewAgent(), mode: "prompt" })).toEqual({ error: "name" })
    expect(model.state.agents).toHaveLength(6)
  })

  test("repeating gives the agent the chosen schedule", () => {
    const built = buildAgent({ ...emptyNewAgent(), repeat: true, schedule: 1 }, [])
    expect("agent" in built && built.agent.schedule).toEqual({
      words: schedules[1].words,
      cron: schedules[1].cron,
      tz: "Europe/Madrid",
      state: "active",
      next: schedules[1].next,
      runs: 0,
    })
  })

  test("ids stay unique when a name repeats", () => {
    const form = { ...emptyNewAgent(), mode: "prompt", name: "Nightly sweep", input: "Run the tests" } as const
    const model = create()
    const first = model.add(form)
    const second = model.add(form)
    expect([first, second].map((result) => ("agent" in result ? result.agent.id : undefined))).toEqual([
      "nightly-sweep",
      "nightly-sweep-2",
    ])
  })

  test("the agent list offers the farm's six agents", () => {
    expect(catalog.map((item) => item.id)).toEqual(demoAgents().map((agent) => agent.id))
  })
})

describe("running agents", () => {
  test("Stop task turns a running agent idle and records it", () => {
    const model = create()
    model.stop("mr-review")
    const agent = model.state.agents[0]
    expect(agent.status).toBe("idle")
    expect(agent.when).toBe("Just now")
    expect(agent.task).toBe("Cancelled: Review !482: fix VAT rounding on credit notes")
    expect(agent.runs[0].status).toBe("cancelled")
    expect(agent.log.at(-1)).toEqual({ time: "10:50:00", level: "warn", text: "Stopped by you" })
  })

  test("Cancel stops a queued agent too, and stopping an idle one does nothing", () => {
    const model = create()
    model.stop("release-notes")
    expect(model.state.agents[2].status).toBe("idle")
    model.stop("brain-curator")
    expect(model.state.agents[3].task).toBe("Weekly review queue for Odoo Delivery: 7 documents to review")
  })

  test("Run now queues an idle agent, and the farm starts it", () => {
    const model = create()
    model.start("brain-curator")
    expect(model.state.agents[3].status).toBe("queued")
    model.tick()
    const agent = model.state.agents[3]
    expect(agent.status).toBe("running")
    expect(agent.runs[0]).toEqual({ status: "running", title: "Weekly review queue", detail: "Started 10:50:00" })
    expect(agent.log.map((line) => line.text)).toEqual(["Starting up", "Working"])
  })

  test("Retry clears the failure", () => {
    const model = create()
    model.start("flow-tester")
    const agent = model.state.agents[5]
    expect(agent.status).toBe("queued")
    expect(agent.failure).toBeUndefined()
    expect(agent.log).toHaveLength(1)
    expect(agent.runs).toHaveLength(3)
  })

  test("Run now does nothing for an agent that is already running", () => {
    const model = create()
    model.start("mr-review")
    expect(model.state.agents[0].status).toBe("running")
    expect(model.state.agents[0].runs).toHaveLength(4)
  })

  test("a running agent writes its next log line on each tick, then no more than it has", () => {
    const model = create()
    const before = model.state.agents[0].log.length
    model.tick()
    expect(model.state.agents[0].log).toHaveLength(before + 1)
    model.tick()
    model.tick()
    model.tick()
    expect(model.state.agents[0].log).toHaveLength(before + 3)
    expect(model.state.agents[0].upcoming).toEqual([])
  })

  test("a tick leaves idle and failed agents alone", () => {
    const model = create()
    model.tick()
    expect(model.state.agents[3].log).toHaveLength(4)
    expect(model.state.agents[5].log).toHaveLength(4)
  })

  test("pausing and resuming the schedule", () => {
    const model = create()
    model.pause("brain-curator")
    expect(model.state.agents[3].schedule).toMatchObject({ state: "paused", next: "Paused" })
    model.resume("brain-curator")
    expect(model.state.agents[3].schedule).toMatchObject({ state: "active", next: "Mon 10 Nov, 08:00" })
    model.pause("mr-review")
    expect(model.state.agents[0].schedule).toBeUndefined()
  })

  test("removing the selected agent clears the selection", () => {
    const model = create()
    model.select("ticket-triage")
    model.remove("ticket-triage")
    expect(model.state.agents).toHaveLength(5)
    expect(model.selected()).toBeUndefined()
  })

  test("statuses have tones", () => {
    expect(["running", "queued", "idle", "failed", "succeeded"].map((status) => statusTone(status as "idle"))).toEqual([
      undefined,
      "warning",
      undefined,
      "danger",
      "success",
    ])
  })
})

describe("the log timer", () => {
  test("ticks while the view is mounted and stops when it is disposed", async () => {
    let ticks = 0
    const dispose = createRoot((dispose) => {
      startSimulation({ tick: () => ticks++ }, 5)
      return dispose
    })
    await wait(60)
    expect(ticks).toBeGreaterThan(0)

    dispose()
    const stopped = ticks
    await wait(60)
    expect(ticks).toBe(stopped)
  })
})

describe("copy", () => {
  test("every key the view builds from a status, filter, tab, trigger or error exists", () => {
    const table: Record<string, string> = en
    const keys = [
      ...(["running", "queued", "idle", "failed", "succeeded", "cancelled"] as const).map(
        (key) => `agents.status.${key}`,
      ),
      ...filters.map((key) => `agents.filter.${key}`),
      ...tabs.map((key) => `agents.tab.${key}`),
      ...(["name", "input", "repo"] as const).map((key) => `agents.new.error.${key}`),
      ...(["agent", "prompt"] as const).map((key) => `agents.new.mode.${key}`),
      ...demoAgents().map(triggerKey),
    ]
    expect(keys.filter((key) => !table[key])).toEqual([])
  })
})
