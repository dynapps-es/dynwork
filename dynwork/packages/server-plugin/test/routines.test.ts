import { expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
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
