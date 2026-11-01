import { describe, expect, test } from "bun:test"
import { Jcs } from "../src/jcs"

// Vectors from RFC 8785: the section 3.2.2 example, the section 3.2.3 sorting example and number serializations from
// Appendix B.
describe("JCS", () => {
  // The vectors are written with `~` for a backslash and `chars` for the non-ASCII characters, so no formatter can
  // rewrite their escapes.
  const json = (text: string) => text.replaceAll("~", String.fromCharCode(92))
  const chars = {
    control: String.fromCharCode(0x80),
    dalet: String.fromCharCode(0xfb33),
    emoji: String.fromCodePoint(0x1f600),
  }

  test("RFC 8785 section 3.2.2: whitespace, escapes and numbers", () => {
    const input = json(`{
      "numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],
      "string": "~u20ac$~u000F~u000aA'~u0042~u0022~u005c~~~"~/",
      "literals": [null, true, false]
    }`)
    expect(Jcs.canonicalize(JSON.parse(input))).toBe(
      json(
        `{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"${String.fromCharCode(0x20ac)}$~u000f~nA'B~"~~~~~"/"}`,
      ),
    )
  })

  test("RFC 8785 section 3.2.3: keys sort by UTF-16 code units", () => {
    const input = json(`{
      "~u20ac": "Euro Sign",
      "~r": "Carriage Return",
      "~ufb33": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "~ud83d~ude00": "Emoji: Grinning Face",
      "~u0080": "Control",
      "~u00f6": "Latin Small Letter O With Diaeresis"
    }`)
    expect(Jcs.canonicalize(JSON.parse(input))).toBe(
      json(
        `{"~r":"Carriage Return","1":"One","${chars.control}":"Control","${String.fromCharCode(0xf6)}":"Latin Small Letter O With Diaeresis","${String.fromCharCode(0x20ac)}":"Euro Sign","${chars.emoji}":"Emoji: Grinning Face","${chars.dalet}":"Hebrew Letter Dalet With Dagesh"}`,
      ),
    )
  })

  test.each([
    [0, "0"],
    [-0, "0"],
    [5e-324, "5e-324"],
    [1.7976931348623157e308, "1.7976931348623157e+308"],
    [9007199254740992, "9007199254740992"],
    [295147905179352830000, "295147905179352830000"],
    [1e21, "1e+21"],
    [1e20, "100000000000000000000"],
    [0.000001, "0.000001"],
    [1e-7, "1e-7"],
    [-1.5e-8, "-1.5e-8"],
  ])("RFC 8785 Appendix B: %p serializes as %s", (value, expected) => {
    expect(Jcs.canonicalize(value)).toBe(expected)
  })

  test("nested objects sort at every level and drop undefined members", () => {
    expect(Jcs.canonicalize({ b: [{ z: 1, a: undefined, y: { d: 1, c: 2 } }], a: "x" })).toBe(
      '{"a":"x","b":[{"y":{"c":2,"d":1},"z":1}]}',
    )
  })

  test("refuses values JSON cannot carry", () => {
    expect(() => Jcs.canonicalize(Number.NaN)).toThrow(TypeError)
    expect(() => Jcs.canonicalize(Number.POSITIVE_INFINITY)).toThrow(TypeError)
    expect(() => Jcs.canonicalize(1n)).toThrow(TypeError)
  })
})
