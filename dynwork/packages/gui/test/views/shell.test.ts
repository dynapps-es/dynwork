import { afterEach, describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createViewLayout } from "../../src/views/shell"

// happy-dom answers `matchMedia` from its viewport and fires `change` when the viewport resizes. Its lists start from
// "no match" rather than the current answer, so a query that matches when it is created misses its first change: the
// resize tests start medium, where neither query matches.
const resize = (width: number) => window.happyDOM.setViewport({ width })

afterEach(() => resize(1024))

describe("the view shell's layout", () => {
  test.each([
    [1440, "wide"],
    [1200, "wide"],
    [1199, "medium"],
    [1000, "medium"],
    [768, "medium"],
    [767, "narrow"],
    [390, "narrow"],
  ] as const)("at %ipx it is %s", (width, layout) => {
    resize(width)
    createRoot((dispose) => {
      expect(createViewLayout()()).toBe(layout)
      dispose()
    })
  })

  test("follows the window as it resizes", () => {
    resize(1000)
    createRoot((dispose) => {
      const layout = createViewLayout()
      expect(layout()).toBe("medium")
      resize(1440)
      expect(layout()).toBe("wide")
      resize(600)
      expect(layout()).toBe("narrow")
      resize(1000)
      expect(layout()).toBe("medium")
      dispose()
    })
  })

  test("stops following the window once its owner is disposed", () => {
    resize(1000)
    const layout = createRoot((dispose) => {
      const layout = createViewLayout()
      dispose()
      return layout
    })
    resize(1440)
    expect(layout()).toBe("medium")
  })
})
