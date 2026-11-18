import { expect, test } from "bun:test"
import { Effect, Fiber, SchemaAST } from "effect"
import { DynWorkRoutines } from "../src/routines"

// The routines tools only ask main and wait: each test plays main by answering the requests the emitter publishes.

function main() {
  const requests: DynWorkRoutines.Request[] = []
  const withdrawn: string[] = []
  const emitter: DynWorkRoutines.Emitter = {
    request: (request) => Effect.sync(() => void requests.push(request)),
    withdraw: (id) => Effect.sync(() => void withdrawn.push(id)),
  }
  return { requests, withdrawn, tools: DynWorkRoutines.tools(emitter) }
}

const context = (id: string) => ({ sessionID: "ses_chat", id })

const proposal: DynWorkRoutines.Proposal = {
  name: "Daily check",
  instructions: "Check the cluster",
  repeat: "daily",
  time: "08:00",
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

test("the list asks main and returns its answer", async () => {
  const stand = main()
  const running = Effect.runPromise(stand.tools.list.execute({}, context("call_list")))
  await settle()
  expect(stand.requests).toEqual([{ id: "call_list", session: "ses_chat", kind: "list" }])
  expect(DynWorkRoutines.answer({ id: "call_list", text: "- Daily check", error: false })).toEqual({ accepted: true })
  expect(await running).toEqual({ content: "- Daily check", metadata: { error: false } })
})

test("a proposal waits for main's answer, and is pending meanwhile", async () => {
  const stand = main()
  const fiber = Effect.runFork(stand.tools.create.execute(proposal, context("call_propose")))
  await settle()
  expect(stand.requests).toEqual([{ id: "call_propose", session: "ses_chat", kind: "propose", proposal }])
  expect(DynWorkRoutines.pending().requests.map((request) => request.id)).toContain("call_propose")
  expect(fiber.pollUnsafe()).toBeUndefined()
  DynWorkRoutines.answer({ id: "call_propose", text: "Scheduled", error: false })
  expect(await Effect.runPromise(Fiber.join(fiber))).toEqual({ content: "Scheduled", metadata: { error: false } })
  expect(DynWorkRoutines.pending().requests.map((request) => request.id)).not.toContain("call_propose")
  // A second answer finds nothing waiting.
  expect(DynWorkRoutines.answer({ id: "call_propose", text: "again", error: false })).toEqual({ accepted: false })
})

test("a refusal reaches the agent as text it can act on", async () => {
  const stand = main()
  const running = Effect.runPromise(stand.tools.create.execute(proposal, context("call_refused")))
  await settle()
  DynWorkRoutines.answer({ id: "call_refused", text: "The user cancelled", error: true })
  expect(await running).toEqual({ content: "The user cancelled", metadata: { error: true } })
})

test("a stopped proposal is withdrawn, so main drops its card", async () => {
  const stand = main()
  const fiber = Effect.runFork(stand.tools.create.execute(proposal, context("call_stopped")))
  await settle()
  await Effect.runPromise(Fiber.interrupt(fiber))
  expect(stand.withdrawn).toEqual(["call_stopped"])
  expect(DynWorkRoutines.pending().requests.map((request) => request.id)).not.toContain("call_stopped")
  expect(DynWorkRoutines.answer({ id: "call_stopped", text: "late", error: false })).toEqual({ accepted: false })
})

test("the tools carry the scheduled-task names, and stay out of Code Mode", () => {
  const tools = Object.values(main().tools)
  expect(tools.map((tool) => tool.name)).toEqual([
    "list_scheduled_tasks",
    "list_running_tasks",
    "get_scheduled_task",
    "create_scheduled_task",
    "update_scheduled_task",
    "delete_scheduled_task",
    "pause_scheduled_task",
    "resume_scheduled_task",
    "run_scheduled_task",
  ])
  expect(tools.every((tool) => tool.options.codemode === false)).toBe(true)
})

test("every description names a scheduled task in the words people use, in English, Spanish, French and Dutch", () => {
  const tools = Object.values(main().tools)
  const words = [
    "scheduled task",
    "routine",
    "recurring task",
    "automation",
    "tarea programada",
    "tâche planifiée",
    "geplande taak",
  ]
  expect(
    tools.filter((tool) => !words.every((word) => tool.description.includes(word))).map((tool) => tool.name),
  ).toEqual([])
  // The UI word is task: a description never says routine without it, nor Agent Farm without Cloud.
  expect(tools.every((tool) => tool.description.indexOf("scheduled task") < tool.description.indexOf("routine"))).toBe(
    true,
  )
  expect(
    tools.filter((tool) => tool.description.includes("Agent Farm") && !tool.description.includes("Cloud")),
  ).toEqual([])
})

test("the verbs and schedules a request uses lead to the matching tool, in the four languages", () => {
  const tools = main().tools
  const named = {
    list: [
      "every Monday",
      "cada lunes",
      "todos los días",
      "automatización",
      "automatisation",
      "automatisering",
      "tous les jours",
      "elke dag",
    ],
    create: ["every morning", "daily at 8", "cada lunes", "prográmalo", "chaque lundi", "elke maandag"],
    update: ["rename", "renombrar", "renommer", "hernoemen"],
    delete: ["delete", "eliminar", "supprimer", "verwijderen"],
    pause: ["pause", "pausar", "mettre en pause", "pauzeren"],
    resume: ["resume", "reanudar", "reprendre", "hervatten"],
    run: ["now", "ejecutar ahora", "lancer maintenant", "nu uitvoeren"],
  }
  const missing = Object.entries(named).flatMap(([key, words]) =>
    words
      .filter((word) => !tools[key as keyof typeof named].description.includes(word))
      .map((word) => `${key}: ${word}`),
  )
  expect(missing).toEqual([])
})

test("the guidance says where a task runs, what the tools are not for, and how to change one", () => {
  const tools = main().tools
  const rules = tools.list.description
  // Where: this computer, or Cloud, which people still call the Agent Farm.
  expect(rules).toContain("this Mac")
  expect(rules).toContain("Cloud, formerly the Agent Farm")
  expect(rules).toContain("where 'farm'")
  expect(tools.create.description).toContain("\"on the farm\" is where 'farm'")
  expect(SchemaAST.resolveDescription(DynWorkRoutines.Proposal.fields.where.ast)).toContain(
    "'farm' (Cloud, formerly the Agent Farm or 'the farm'",
  )
  // What else a request could reach.
  expect(rules).toContain("never a shell crontab")
  expect(rules).toContain("todowrite")
  expect(rules).toContain("OpenCode's automation_* tools, which only prompt a conversation of this project later")
  expect(rules).toContain("never the agent-farm connector's tools")
  expect(rules).toContain("not in Code Mode's search")
  // Managed only through the tools, and changed rather than duplicated.
  expect(rules).toContain("never edit Dynwork's files or its database")
  expect(rules).toContain("never call its or OpenCode's APIs or CLI")
  expect(rules).toContain("propose update_scheduled_task instead of a new one")
  expect(tools.update.description).toContain("never create a new task to change one")
})

test("an update sends main the task's id and only the fields to change, and waits for the user", async () => {
  const stand = main()
  const fiber = Effect.runFork(
    stand.tools.update.execute({ id: "local:3f2a", name: "es-prod-01 health check" }, context("call_update")),
  )
  await settle()
  expect(stand.requests).toEqual([
    {
      id: "call_update",
      session: "ses_chat",
      kind: "update",
      routine: "local:3f2a",
      changes: { name: "es-prod-01 health check" },
    },
  ])
  expect(fiber.pollUnsafe()).toBeUndefined()
  DynWorkRoutines.answer({ id: "call_update", text: "Changed", error: false })
  expect(await Effect.runPromise(Fiber.join(fiber))).toEqual({ content: "Changed", metadata: { error: false } })
})

test("pause, resume, get and what is running name their kind and task, and answer as main says", async () => {
  const stand = main()
  const calls = [
    stand.tools.pause.execute({ id: "local:a" }, context("call_pause")),
    stand.tools.resume.execute({ id: "local:a" }, context("call_resume")),
    stand.tools.get.execute({ id: "local:a" }, context("call_get")),
    stand.tools.running.execute({}, context("call_running")),
    stand.tools.delete.execute({ id: "local:a" }, context("call_delete")),
    stand.tools.run.execute({ id: "local:a" }, context("call_run")),
  ].map((call) => Effect.runPromise(call))
  await settle()
  expect(stand.requests.map((request) => [request.kind, request.routine])).toEqual([
    ["pause", "local:a"],
    ["resume", "local:a"],
    ["get", "local:a"],
    ["running", undefined],
    ["delete", "local:a"],
    ["run", "local:a"],
  ])
  stand.requests.forEach((request) => DynWorkRoutines.answer({ id: request.id, text: request.kind, error: false }))
  expect((await Promise.all(calls)).map((outcome) => outcome.content)).toEqual([
    "pause",
    "resume",
    "get",
    "running",
    "delete",
    "run",
  ])
})
