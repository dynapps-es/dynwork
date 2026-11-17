import { describe, expect, test } from "bun:test"
import { fail } from "../../src/routines/backend"
import { Capabilities } from "../../src/routines/contract"
import { RoutinesDemo } from "../../src/routines/demo"
import { RoutinesFarm } from "../../src/routines/farm/backend"
import { RoutinesValidate } from "../../src/routines/validate"
import { conformance, sample } from "./conformance"
import { clock } from "./fixture"
import { crossing } from "./wire"

// The skeleton is Jesús's starting point: it has to be what the README says it is. It answers `not implemented` to
// everything and says it is `disabled`, so the views show the farm as unavailable and nothing breaks.
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
    expect(capabilities).toMatchObject({ backend: "farm", kind: "remote", label: "Dynapps Cloud", status: "disabled" })
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

// For whoever writes the farm backend: `DYNWORK_ROUTINES_FARM_CONFORMANCE=1 bun test test/routines/farm.test.ts` runs
// the whole suite against it. It is red until the methods are written, so it is off in the CI's runs. `make` is where
// the suite takes the backend (point it at yours, with a fake farm server in front: see `test/routines/service.ts`) and
// `finish` brings every run that is going to a terminal state (the fake farm server moves its tasks on).
if (process.env.DYNWORK_ROUTINES_FARM_CONFORMANCE === "1")
  conformance("the Agent Farm backend", () => ({ backend: RoutinesFarm.make(), finish: async () => {} }))
