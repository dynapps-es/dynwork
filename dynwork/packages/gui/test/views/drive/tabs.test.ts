import { describe, expect, test } from "bun:test"
import { fade, shiftToShow } from "../../../src/views/drive/tabs"

// How far the side panel's strip scrolls to bring a document's tab into view, past its fades and the sticky "+".

const strip = { left: 100, right: 700 }
// The "+" is 40px wide at the end: 24px of fade at the start, 24 + 40 at the end.
const inset = { left: fade, right: fade + 40 }
const tab = (left: number, width = 140) => ({ left, right: left + width })

describe("scrolling a tab into view", () => {
  test("a tab that is already inside, past the fades, does not move the strip", () => {
    expect(shiftToShow(strip, tab(200), inset)).toBe(0)
    expect(shiftToShow(strip, tab(124), inset)).toBe(0)
    expect(shiftToShow(strip, tab(496), inset)).toBe(0)
  })

  test("a tab past the end scrolls forward by what hides it, the fade and the plus included", () => {
    expect(shiftToShow(strip, tab(600), inset)).toBe(600 + 140 - (700 - 64))
    expect(shiftToShow(strip, tab(497), inset)).toBe(1)
  })

  test("a tab before the start scrolls back, to just past the fade", () => {
    expect(shiftToShow(strip, tab(60), inset)).toBe(60 - 124)
    expect(shiftToShow(strip, tab(123), inset)).toBe(-1)
  })

  test("a tab only half in view, under the plus, is brought out from under it", () => {
    expect(shiftToShow(strip, tab(620), inset)).toBeGreaterThan(0)
  })

  test("in a right-to-left strip the plus and the larger inset are at the left", () => {
    const rtl = { left: fade + 40, right: fade }
    expect(shiftToShow(strip, tab(110), rtl)).toBe(110 - (100 + 64))
    expect(shiftToShow(strip, tab(530), rtl)).toBe(0)
    expect(shiftToShow(strip, tab(570), rtl)).toBe(570 + 140 - (700 - 24))
  })

  test("a tab wider than the room the strip has left is left where it is", () => {
    expect(shiftToShow(strip, tab(0, 700), inset)).toBe(0)
  })
})
