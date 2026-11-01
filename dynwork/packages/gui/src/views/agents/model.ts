import { onCleanup } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type { ViewLayout } from "../shell"
import { catalog, demoAgents, schedules, timezone, type Agent, type AgentRun, type AgentStatus } from "./demo"

export const filters = ["all", "running", "idle", "failed"] as const
export type Filter = (typeof filters)[number]

export const tabs = ["overview", "logs", "runs", "schedule"] as const
export type Tab = (typeof tabs)[number]

/** Running includes queued agents: both are in flight on the farm. */
export function matches(filter: Filter, agent: Agent) {
  if (filter === "all") return true
  if (filter === "running") return agent.status === "running" || agent.status === "queued"
  return agent.status === filter
}

export function active(status: AgentStatus) {
  return status === "running" || status === "queued"
}

/** What the New agent dialog collects. */
export interface NewAgent {
  /** Run one of the farm's agents, or write a prompt of one's own. */
  mode: "agent" | "prompt"
  agent: string
  name: string
  repo: string
  branch: string
  access: string
  input: string
  repeat: boolean
  /** Index into the repeat options. */
  schedule: number
}

export function emptyNewAgent(): NewAgent {
  return {
    mode: "agent",
    agent: catalog[0].id,
    name: "",
    repo: "",
    branch: "",
    access: "None",
    input: "",
    repeat: false,
    schedule: 0,
  }
}

/** Why a New agent form cannot start, as the suffix of the `agents.new.error.` copy. */
export type NewAgentError = "name" | "input" | "repo"

/**
 * Turns the dialog's form into the agent it starts, queued, or says what is missing. `taken` are the ids already in the
 * list: a new agent never reuses one.
 */
export function buildAgent(input: NewAgent, taken: readonly string[], now = new Date()) {
  const definition = catalog.find((item) => item.id === input.agent)
  const name = input.name.trim() || (input.mode === "agent" ? definition?.name : undefined)
  if (!name) return { error: "name" } satisfies { error: NewAgentError }
  if (input.mode === "prompt" && !input.input.trim()) return { error: "input" } satisfies { error: NewAgentError }
  const repo = input.repo.trim()
  if (repo && !repo.startsWith("https://")) return { error: "repo" } satisfies { error: NewAgentError }

  const slug = input.mode === "agent" ? input.agent : slugify(name)
  const id = unique(slug, taken)
  const branch = input.branch.trim()
  const task = firstLine(input.input) || definition?.description || name
  const repeat = schedules[input.schedule] ?? schedules[0]

  return {
    agent: {
      id,
      slug,
      name,
      status: "queued",
      task,
      repo: repo || "No repository",
      branch: repo ? branch : "",
      started: "Just now",
      when: "Just now",
      cost: "Not started",
      plugins: (input.mode === "agent" ? definition?.plugins : undefined) ?? "None",
      access: input.access === "None" ? "None" : `${input.access} (saved access)`,
      schedule: input.repeat
        ? { words: repeat.words, cron: repeat.cron, tz: timezone, state: "active", next: repeat.next, runs: 0 }
        : undefined,
      log: [{ time: clock(now), level: "info", text: "Starting up" }],
      runs: [{ status: "queued", title: name, detail: "Starting up" }],
      upcoming: [repo ? `Cloning ${repo}${branch ? ` at ${branch}` : ""}` : "Reading the task", `Working on: ${task}`],
    } satisfies Agent,
  }
}

/** The agent the detail pane shows: the selected one, or in a wide window the first listed while none is selected. */
export function detailAgent(layout: ViewLayout, selected: Agent | undefined, visible: readonly Agent[]) {
  if (layout === "wide") return selected ?? visible[0]
  return selected
}

/** The in-memory state of the Agents view, seeded from the demo data. Every change stays in this store. */
export function createAgentsModel(seed = demoAgents(), now = () => new Date()) {
  const [state, setState] = createStore({
    agents: seed,
    filter: "all" as Filter,
    selected: undefined as string | undefined,
    tab: "overview" as Tab,
  })
  const update = (id: string, change: (agent: Agent) => void) =>
    setState("agents", (agent) => agent.id === id, produce(change))
  const find = (id: string) => state.agents.find((agent) => agent.id === id)
  const visible = () => state.agents.filter((agent) => matches(state.filter, agent))
  const advance = (id: string) =>
    update(id, (agent) => {
      const time = clock(now())
      if (agent.status === "queued") {
        agent.status = "running"
        agent.cost = "0.00 EUR so far"
        agent.runs[0] = { status: "running", title: agent.runs[0]?.title ?? agent.task, detail: `Started ${time}` }
        agent.log.push({ time, level: "info", text: "Working" })
        return
      }
      const line = agent.upcoming.shift()
      if (line) agent.log.push({ time, level: "info", text: line })
    })

  return {
    state,
    visible,
    count: (filter: Filter) => state.agents.filter((agent) => matches(filter, agent)).length,
    running: () => state.agents.some((agent) => active(agent.status)),
    selected: () => (state.selected ? find(state.selected) : undefined),
    select(id: string) {
      setState({ selected: id, tab: "overview" })
    },
    deselect() {
      setState("selected", undefined)
    },
    filter(filter: Filter) {
      setState("filter", filter)
      // A selection the filter hides would leave the detail pane showing a row that is not listed.
      if (state.selected && !visible().some((agent) => agent.id === state.selected)) setState("selected", undefined)
    },
    tab(tab: Tab) {
      setState("tab", tab)
    },
    /** Stop task, or Cancel while queued. */
    stop(id: string) {
      const found = find(id)
      if (!found || !active(found.status)) return
      update(id, (agent) => {
        agent.status = "idle"
        agent.when = "Just now"
        agent.task = `Cancelled: ${agent.task}`
        agent.log.push({ time: clock(now()), level: "warn", text: "Stopped by you" })
        const latest = agent.runs[0]
        if (latest && (latest.status === "running" || latest.status === "queued"))
          agent.runs[0] = { status: "cancelled", title: latest.title, detail: "Stopped by you" }
      })
    },
    /** Start, Retry or Run now: the agent queues, and the simulation takes it from there. */
    start(id: string) {
      const found = find(id)
      if (!found || active(found.status)) return
      update(id, (agent) => {
        const task = agent.task.replace(/^Cancelled: /, "")
        agent.status = "queued"
        agent.failure = undefined
        agent.when = "Just now"
        agent.started = "Just now"
        agent.task = task
        agent.log = [{ time: clock(now()), level: "info", text: "Starting up" }]
        agent.runs.unshift({ status: "queued", title: agent.runs[0]?.title ?? task, detail: "Starting up" })
        agent.upcoming = [
          agent.branch ? `Cloning ${agent.repo} at ${agent.branch}` : "Reading the task",
          `Working on: ${task}`,
        ]
      })
    },
    pause(id: string) {
      update(id, (agent) => {
        if (agent.schedule) {
          agent.schedule.state = "paused"
          agent.schedule.next = "Paused"
        }
      })
    },
    resume(id: string) {
      update(id, (agent) => {
        if (agent.schedule) {
          agent.schedule.state = "active"
          agent.schedule.next = "Mon 10 Nov, 08:00"
        }
      })
    },
    remove(id: string) {
      setState("agents", (agents) => agents.filter((agent) => agent.id !== id))
      if (state.selected === id) setState("selected", undefined)
    },
    /** Adds the agent the form describes at the top of the list and selects it, or returns what the form lacks. */
    add(input: NewAgent) {
      const built = buildAgent(
        input,
        state.agents.map((agent) => agent.id),
        now(),
      )
      if ("error" in built) return built
      setState("agents", (agents) => [built.agent, ...agents])
      setState({ filter: "all", selected: built.agent.id, tab: "overview" })
      return built
    },
    /** One step of the farm: queued agents start, running ones write their next log line. */
    tick() {
      state.agents.filter((agent) => active(agent.status)).forEach((agent) => advance(agent.id))
    },
  }
}

export type AgentsModel = ReturnType<typeof createAgentsModel>

/** Runs the farm's simulation while the view is mounted: the timer is cleared when its owner is disposed. */
export function startSimulation(model: Pick<AgentsModel, "tick">, interval = 2500) {
  const timer = setInterval(model.tick, interval)
  onCleanup(() => clearInterval(timer))
}

/** The tone of a status dot or tag; running and idle have none. */
export function statusTone(status: AgentStatus | AgentRun["status"]) {
  if (status === "queued") return "warning"
  if (status === "failed") return "danger"
  if (status === "succeeded") return "success"
  return undefined
}

/** The copy key of what starts an agent: on demand, on a schedule, or on a schedule that is paused. */
export function triggerKey(agent: Agent) {
  if (!agent.schedule) return "agents.trigger.onDemand"
  return agent.schedule.state === "paused" ? "agents.trigger.paused" : "agents.trigger.scheduled"
}

function clock(date: Date) {
  return date.toTimeString().slice(0, 8)
}

function firstLine(text: string) {
  return text.trim().split("\n", 1)[0]
}

function slugify(name: string) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "agent"
  )
}

function unique(slug: string, taken: readonly string[]) {
  const next = (attempt: number): string => {
    const id = attempt === 1 ? slug : `${slug}-${attempt}`
    return taken.includes(id) ? next(attempt + 1) : id
  }
  return next(1)
}
