import { expect, test } from "bun:test"
import strings from "../../src/views/en"

// The plugin's `t` interpolates `{{name}}` only: a single-brace placeholder reaches the screen as written.
test("view strings use the {{name}} placeholder syntax", () => {
  const single = Object.entries(strings).filter(([, value]) => /(^|[^{])\{[a-zA-Z]+\}([^}]|$)/.test(value))
  expect(single).toEqual([])
})
