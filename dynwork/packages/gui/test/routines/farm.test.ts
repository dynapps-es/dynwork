import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { fail } from "../../src/routines/backend"
import { Capabilities, type Change } from "../../src/routines/contract"
import { RoutinesDemo } from "../../src/routines/demo"
import { RoutinesFarm } from "../../src/routines/farm/backend"
import { RoutinesValidate } from "../../src/routines/validate"
import { startFake, until, type Fake } from "../accounts/fixture"
import { conformance, sample } from "./conformance"
import { fakeFarm, signedIn, type FakeFarm } from "./farm-server"
import { clock } from "./fixture"
import { crossing } from "./wire"

// Without its options the backend is the unconnected one main registers until the farm is wired: it answers
// `not implemented` to everything and says it is `disabled`, so the views show the farm as unavailable and nothing breaks.
describe("the Agent Farm skeleton", () => {
  test("is switched on only by DYNWORK_ROUTINES_FARM=1", () => {
    expect(RoutinesFarm.flag).toBe("DYNWORK_ROUTINES_FARM")
    expect(RoutinesFarm.enabled({})).toBe(false)
    expect(RoutinesFarm.enabled({ DYNWORK_ROUTINES_FARM: "0" })).toBe(false)
    expect(RoutinesFarm.enabled({ DYNWORK_ROUTINES_FARM: "true" })).toBe(false)
    expect(RoutinesFarm.enabled({ DYNWORK_ROUTINES_FARM: "1" })).toBe(true)
  })

  test("reports itself disabled with the reason, as a remote backend that takes the form's farm fields", async () => {
    const backend = RoutinesFarm.make()
    const capabilities = await backend.capabilities()
    expect(capabilities).toMatchObject({ backend: "farm", kind: "remote", label: "Cloud", status: "disabled" })
    expect(capabilities.detail).toContain("README")
    expect(capabilities.fields).toEqual(RoutinesFarm.fields)
    expect(crossing(Capabilities, capabilities)).toEqual(capabilities)
  })

  test("declares the same fields and capabilities as the remote demo, so the form does not change when it lands", async () => {
    const demo = await RoutinesDemo.remote(clock().now).capabilities()
    const mine = await RoutinesFarm.make().capabilities()
    expect(mine).toEqual({ ...demo, quota: undefined, status: "disabled", detail: mine.detail })
  })

  test("declares fields the conformance suite's own consistency rules accept", async () => {
    const reserved = ["name", "instructions", "agent", "model", "schedule", "enabled"]
    const keys = RoutinesFarm.fields.map((field) => field.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys.filter((key) => reserved.includes(key))).toEqual([])
    RoutinesFarm.fields.forEach((field) => {
      if (field.when) expect(keys).toContain(field.when.key)
      if (field.kind === "select") expect(field.choices !== undefined || field.lookup !== undefined).toBe(true)
    })
  })

  test("answers not implemented to every method that can fail, as data, and never rejects", async () => {
    const backend = RoutinesFarm.make()
    const definition = await sample(backend, "Farm")
    const answers = await Promise.all([
      backend.options("agents"),
      backend.validate(definition),
      backend.list(),
      backend.get("any"),
      backend.create(definition),
      backend.update("any", definition),
      backend.remove("any"),
      backend.pause("any"),
      backend.resume("any"),
      backend.start("any"),
      backend.cancel("any"),
      backend.runs({}),
      backend.transcript("any"),
    ])
    expect(answers).toHaveLength(13)
    answers.forEach((answer) => {
      expect(RoutinesFarm.isNotImplemented(answer)).toBe(true)
      expect(answer).toMatchObject({ code: "failed", retryable: false })
    })
    expect(await backend.viewed("any")).toBeUndefined()
    expect(backend.watch(() => {})).toBeFunction()
  })

  test("a real failure is not taken for the skeleton's answer", () => {
    expect(RoutinesFarm.isNotImplemented(fail("failed", "The farm said no."))).toBe(false)
    expect(RoutinesFarm.isNotImplemented(undefined)).toBe(false)
    expect(RoutinesFarm.isNotImplemented({ message: 3 })).toBe(false)
  })

  // The suite reads what a backend can do from `capabilities()`: here it builds a definition the skeleton's fields
  // accept, which the shared validation passes, and the first thing that needs the farm is where it stops.
  test("the conformance suite can be pointed at it: its sample passes the shared validation and stops at create", async () => {
    const backend = RoutinesFarm.make()
    const definition = await sample(backend, "Pointed")
    expect(definition.options.repository).toBeString()
    expect(RoutinesValidate.check(await backend.capabilities(), definition)).toBeUndefined()
    expect(RoutinesFarm.isNotImplemented(await backend.create(definition))).toBe(true)
  })
})

// The whole suite against the connected backend, over the real transport and accounts, with the fake farm behind the
// fake Governance MCP proxy (`farm-server.ts`). `finish` moves every task that is going to `succeeded` with a result and
// waits for a poll of `watch` when one is subscribed; `ask` puts a question on a task as the farm's agent would.
let sp: Fake
let farm: FakeFarm
const stops: Array<() => void> = []

beforeAll(() => {
  sp = startFake()
  farm = fakeFarm({ authorize: (bearer) => sp.state.jwts.has(bearer) })
})

afterAll(() => {
  stops.forEach((stop) => stop())
  farm.stop()
  sp.stop()
})

conformance("the Agent Farm backend", async () => {
  Object.assign(farm.state, {
    ceiling: "bypass",
    userCredential: true,
    freePrompt: true,
    maxPerUser: 20,
    maxTenant: 500,
    catalogue: ["claude-sonnet-5-5", "claude-opus-5-5"],
    agents: [{ slug: "code-reviewer" }],
    credentials: [
      { name: "git-readonly", type: "git_token" },
      { name: "mcp-odoo", type: "mcp_url" },
    ],
  })
  farm.state.schedules.clear()
  farm.state.tasks.clear()
  farm.reset()
  const connected = await signedIn(sp, farm)
  stops.push(connected.accounts.dispose)
  const watching = { count: 0 }
  const backend = {
    ...connected.backend,
    watch: (changed: (change: Change) => void) => {
      watching.count++
      const stop = connected.backend.watch(changed)
      return () => {
        watching.count--
        stop()
      }
    },
  }
  const polls = () =>
    farm.state.calls.filter((call) => call.name === "farm_list_tasks" && call.args.updated_since).length
  return {
    backend,
    finish: async () => {
      ;[...farm.state.tasks.values()]
        .filter((task) => ["pending", "queued", "running"].includes(task.state))
        .forEach((task) =>
          farm.advance(task.task_id, {
            state: "succeeded",
            started_at: task.started_at ?? task.created_at,
            result: `Finished ${task.task_id}.`,
            question: null,
          }),
        )
      if (watching.count === 0) return
      // Two polls begun after the move: the first of them has answered by the time the second starts.
      const seen = polls()
      await until(() => polls() >= seen + 2)
    },
    ask: async (run, question) => {
      farm.advance(run, {
        state: "running",
        question: {
          seq: Number(question.id.replace(/^q-/, "")),
          text: question.text,
          asked_at: new Date().toISOString(),
          kind: "ask",
          options: [...question.choices],
        },
      })
    },
  }
})
