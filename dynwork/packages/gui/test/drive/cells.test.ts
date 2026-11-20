import { describe, expect, test } from "bun:test"
import { DriveCells } from "../../src/drive/cells"

// A cell range is read as the core's `CellRange` reads it (`crates/shared/models/src/documents/cells.rs` of core 0.84,
// and its unit tests in `crates/tests/unit/shared/models/src/documents_cells.rs`): the cases below are the core's own.

const parse = DriveCells.parse

describe("a cell range (G08)", () => {
  test("a single cell and a range parse, and are written as the instance writes them", () => {
    expect(parse("B2")).toEqual({ cells: "B2" })
    expect(parse("B2:D9")).toEqual({ cells: "B2:D9" })
  })

  test("letters are read in any case and written upper-case; a range whose start is its end is that cell", () => {
    expect(parse("b2:aa10")).toEqual({ cells: "B2:AA10" })
    expect(parse("C3:C3")).toEqual({ cells: "C3" })
  })

  test("the sheet's limits are inclusive", () => {
    expect(parse("A1:XFD1048576")).toEqual({ cells: "A1:XFD1048576" })
    expect(DriveCells.MAX_COLUMN).toBe(16_384)
    expect(DriveCells.MAX_ROW).toBe(1_048_576)
    expect(parse("XFE1")).toEqual({ refused: "column" })
    expect(parse("AAAA1")).toEqual({ refused: "column" })
    expect(parse("A1048577")).toEqual({ refused: "row" })
    expect(parse("A99999999")).toEqual({ refused: "row" })
  })

  test("a range that does not start at its top-left cell is refused", () => {
    for (const reversed of ["D9:B2", "D2:B9", "B9:D2"]) expect(parse(reversed)).toEqual({ refused: "reversed" })
  })

  test("anything else is not A1", () => {
    for (const bad of [
      "",
      "B",
      "2",
      "B0",
      "B02",
      "B2:",
      ":B2",
      " B2",
      "B2 ",
      "$B$2",
      "B2:C3:D4",
      "Ä1",
      "B-2",
      "Sheet1!B2",
      "B2..D9",
    ])
      expect([bad, parse(bad)]).toEqual([bad, { refused: "malformed" }])
  })

  test("a sheet's own node names its sheet; a row, a cell or another node does not", () => {
    expect(DriveCells.sheetOf("sheet[Sales]")).toBe("Sales")
    expect(DriveCells.sheetOf("sheet[Q3 \\] draft]")).toBe("Q3 ] draft")
    expect(DriveCells.sheetOf("sheet[Sales]/row[3]")).toBeUndefined()
    expect(DriveCells.sheetOf("sheet[Sales]/B2")).toBeUndefined()
    expect(DriveCells.sheetOf("n1")).toBeUndefined()
  })
})
