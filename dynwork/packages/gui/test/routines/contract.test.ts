import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Definition, Failure, Field, isFailure, Routines, Run, RunState } from "../../src/routines/contract"

const run = {
  ref: { backend: "local", id: "r1" },
  state: "ok",
  trigger: "schedule",
  title: "Run",
  unread: false,
  conversation: { kind: "none" },
}

describe("the routines contract", () => {
  test("its Ipc lives under the dynwork built-in and has every method the backends have, plus refresh", () => {
    expect(Routines.id).toBe("dynwork.routines")
    expect(Object.keys(Routines.spec.methods).sort()).toEqual(
      [
        "cancel",
        "answerQuestion",
        "create",
        "get",
        "list",
        "move",
        "options",
        "pause",
        "refresh",
        "remove",
        "reply",
        "resume",
        "runs",
        "start",
        "transcript",
        "update",
        "validate",
        "viewed",
        "watch",
      ].sort(),
    )
    expect(Object.keys(Routines.spec.events ?? {})).toEqual(["run", "open"])
  })

  test("a run state is one of the nine the views know", () => {
    expect(RunState.literals).toEqual([
      "queued",
      "running",
      "ok",
      "late",
      "failed",
      "blocked",
      "missed",
      "skipped",
      "cancelled",
    ])
    expect(() => Schema.decodeUnknownSync(Run)({ ...run, state: "succeeded" })).toThrow()
    expect(Schema.decodeUnknownSync(Run)({ ...run, state: "late" }).state).toBe("late")
  })

  test("a definition takes JSON options and the three kinds of instructions, and nothing else", () => {
    const base = { name: "N", enabled: true, options: { list: ["a"], nested: { n: 1 }, nothing: null } }
    expect(Schema.decodeUnknownSync(Definition)({ ...base, instructions: { kind: "prompt", text: "x" } })).toBeDefined()
    expect(Schema.decodeUnknownSync(Definition)({ ...base, instructions: { kind: "skill", skill: "s" } })).toBeDefined()
    expect(
      Schema.decodeUnknownSync(Definition)({ ...base, instructions: { kind: "agent", agent: "a", input: "i" } }),
    ).toBeDefined()
    expect(() =>
      Schema.decodeUnknownSync(Definition)({ ...base, instructions: { kind: "macro", text: "x" } }),
    ).toThrow()
    expect(() => Schema.decodeUnknownSync(Definition)({ ...base, instructions: { kind: "prompt" } })).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Definition)({
        ...base,
        instructions: { kind: "prompt", text: "x" },
        options: { fn: () => 1 },
      }),
    ).toThrow()
  })

  test("a field's kind is one of the nine the form paints, and `when` carries a key and a value", () => {
    const field = { key: "k", section: "s", label: "L", kind: "repo", when: { key: "other", equals: true } }
    expect(Schema.decodeUnknownSync(Field)(field).when).toEqual({ key: "other", equals: true })
    expect(() => Schema.decodeUnknownSync(Field)({ ...field, kind: "colour" })).toThrow()
  })

  test("a failure is data with a code, and every answer that may fail takes one in place of its value", () => {
    const failure: Failure = { code: "not-found", message: "No.", retryable: false }
    expect(Schema.decodeUnknownSync(Failure)(failure)).toEqual(failure)
    expect(() => Schema.decodeUnknownSync(Failure)({ ...failure, code: "boom" })).toThrow()
    const { get, list, start, validate, options, transcript } = Routines.spec.methods
    // A transcript has only optional fields: a failure must not pass for an empty one.
    expect(Schema.decodeUnknownSync(transcript.output)(failure)).toEqual(failure)
    expect(Schema.decodeUnknownSync(transcript.output)({ result: "Done." })).toEqual({ result: "Done." })
    expect(Schema.decodeUnknownSync(get.output)(failure)).toEqual(failure)
    expect(Schema.decodeUnknownSync(list.output)(failure)).toEqual(failure)
    expect(Schema.decodeUnknownSync(start.output)(failure)).toEqual(failure)
    expect(Schema.decodeUnknownSync(options.output)(failure)).toEqual(failure)
    expect(Schema.decodeUnknownSync(validate.output)(undefined)).toBeUndefined()
    expect(Schema.decodeUnknownSync(validate.output)(failure)).toEqual(failure)
    expect(() => Schema.decodeUnknownSync(get.output)({ code: "not-found" })).toThrow()
  })

  test("isFailure tells a failure from a routine, a run and nothing", () => {
    expect(isFailure({ code: "failed", message: "x", retryable: false })).toBe(true)
    expect(isFailure(run)).toBe(false)
    expect(isFailure(undefined)).toBe(false)
    expect(isFailure(null)).toBe(false)
    expect(isFailure("failed")).toBe(false)
    expect(isFailure([])).toBe(false)
  })
  test("a run may carry the question it waits on, with choices and an optional expiry, and nothing half-written", () => {
    const question = { id: "q1", text: "Delete the branch?", choices: ["Yes", "No"] }
    const waiting = Schema.decodeUnknownSync(Run)({ ...run, state: "running", reason: "question", question })
    expect(waiting.question).toEqual(question)
    const expiring = Schema.decodeUnknownSync(Run)({ ...run, question: { ...question, expires: 1_800_000_000_000 } })
    expect(expiring.question?.expires).toBe(1_800_000_000_000)
    expect(Schema.decodeUnknownSync(Run)(run).question).toBeUndefined()
    expect(() => Schema.decodeUnknownSync(Run)({ ...run, question: { id: "q1", text: "x" } })).toThrow()
    expect(() => Schema.decodeUnknownSync(Run)({ ...run, question: { ...question, choices: [1] } })).toThrow()
  })

  test("a definition may name the template it follows, by id and revision, and no field is required for it", () => {
    const base = { name: "N", enabled: true, options: {}, instructions: { kind: "prompt", text: "x" } }
    expect(Schema.decodeUnknownSync(Definition)(base).template).toBeUndefined()
    expect(Schema.decodeUnknownSync(Definition)({ ...base, template: { id: "weekly", revision: 3 } }).template).toEqual(
      {
        id: "weekly",
        revision: 3,
      },
    )
    expect(() => Schema.decodeUnknownSync(Definition)({ ...base, template: { id: "weekly", revision: "3" } })).toThrow()
    expect(() => Schema.decodeUnknownSync(Definition)({ ...base, template: { id: "weekly" } })).toThrow()
  })
})
