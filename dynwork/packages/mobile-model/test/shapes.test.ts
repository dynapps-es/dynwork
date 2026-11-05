import { describe, expect, test } from "bun:test"
import { Shapes } from "../src"
import { load, names } from "./support"

describe("shapes", () => {
  const sample = (events: Array<Record<string, unknown>>): Shapes.Line[] =>
    events.map((event) => ({ kind: "event", event: event as { type: string } }))

  test("keys are unioned over the samples of a type, values never matter", () => {
    const shapes = Shapes.of(
      sample([
        { type: "x", id: "a", n: 1 },
        { type: "x", id: "b", extra: [true] },
      ]),
    )
    expect(shapes["event x"]).toBe("{extra: boolean[], id: string, n: number, type: string}")
  })

  test("a new field, a missing one, a new type and a changed type are each reported", () => {
    const before = Shapes.of(
      sample([
        { type: "x", a: 1 },
        { type: "y", b: "s" },
      ]),
    )
    expect(Shapes.compare(before, before)).toEqual([])
    const after = Shapes.of(sample([{ type: "x", a: "now text", c: 1 }, { type: "z" }]))
    expect(Shapes.compare(before, after)).toEqual([
      "event x: was {a: number, type: string}, now {a: string, c: number, type: string}",
      "event y: in the fixtures, no longer recorded",
      "event z: not in the fixtures, now recorded as {type: string}",
    ])
  })

  test("the recorded scenarios have one stable shape per event and message type", () => {
    const lines = names.flatMap((name) => {
      const recorded = load(name)
      return [
        ...recorded.events.map((event): Shapes.Line => ({ kind: "event", event })),
        ...recorded.snapshots.map(
          (taken): Shapes.Line => ({
            kind: "snapshot",
            snapshot: {
              sessions: taken.snapshot.sessions ?? [],
              messages: { ...taken.snapshot.messages },
              permissions: taken.snapshot.permissions ?? [],
              forms: taken.snapshot.forms ?? [],
            },
          }),
        ),
      ]
    })
    const shapes = Shapes.of(lines)
    expect(Object.keys(shapes)).toContain("event session.text.ended")
    expect(Object.keys(shapes)).toContain("message assistant")
    expect(Shapes.compare(shapes, Shapes.of(lines))).toEqual([])
  })
})
