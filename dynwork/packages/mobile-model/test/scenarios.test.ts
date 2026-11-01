import { describe, expect, test } from "bun:test"
import { goldens } from "#fixtures"
import { Reduce, State } from "../src"
import { desktop, drawn, load, names, replay, view } from "./support"

// Every recorded scenario against its golden, and the ways to the same state that a phone can take: events from the
// start, a snapshot, a snapshot and the events after it, the same events twice, neighbours swapped.

names.forEach((name) =>
  describe(name, () => {
    const recorded = load(name)

    test("the view matches its golden", () => {
      expect(JSON.parse(JSON.stringify(view(replay(recorded), recorded)))).toEqual(goldens[name])
    })

    test("the final snapshot alone draws the same", () => {
      const final = recorded.snapshots[recorded.snapshots.length - 1]!
      const state = Reduce.snapshot(State.empty({ desktop }), final.snapshot)
      expect(drawn(state, recorded, { approvals: false })).toEqual(
        drawn(replay(recorded), recorded, { approvals: false }),
      )
    })

    test("each snapshot plus the events after it draws the same", () => {
      const whole = drawn(replay(recorded), recorded, { approvals: false })
      recorded.snapshots.forEach((taken) => {
        const state = Reduce.events(
          Reduce.snapshot(State.empty({ desktop }), taken.snapshot),
          recorded.events.slice(taken.after),
        )
        expect(drawn(state, recorded, { approvals: false })).toEqual(whole)
      })
    })

    test("a snapshot after the events changes nothing", () => {
      const whole = replay(recorded)
      const final = recorded.snapshots[recorded.snapshots.length - 1]!
      expect(drawn(Reduce.snapshot(whole, final.snapshot), recorded)).toEqual(drawn(whole, recorded))
    })

    test("the same events twice change nothing", () => {
      const once = replay(recorded)
      expect(Reduce.events(once, recorded.events)).toEqual(once)
    })

    test("neighbouring events swapped draw the same", () => {
      const swapped = recorded.events
        .flatMap((_, index, all) => (index % 2 === 0 ? [all[index + 1], all[index]] : []))
        .flatMap((item) => (item ? [item] : []))
      expect(drawn(replay(recorded, swapped), recorded)).toEqual(drawn(replay(recorded), recorded))
    })
  }),
)
