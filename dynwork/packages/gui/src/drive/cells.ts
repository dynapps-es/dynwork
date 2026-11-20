export * as DriveCells from "./cells"

// A cell range of a spreadsheet, as a comment anchors to one from 0.84 (G08): an A1 range on a sheet node. Read as the
// core's `CellRange` reads it, so that the window refuses what the instance would and sends the text it keeps.

/** The last column (`XFD`) and row of a sheet. */
export const MAX_COLUMN = 16_384
export const MAX_ROW = 1_048_576

/** Why a text is not a cell range: not A1, a column past `XFD`, a row past 1 048 576, or a start right of or below the end. */
export const refusals = ["malformed", "column", "row", "reversed"] as const
export type Refused = (typeof refusals)[number]

/**
 * An A1 range, `B2` or `B2:D9`, as the instance writes it: upper-case, and one cell when its start is its end (`C3:C3`
 * is `C3`). Letters are read in any case; nothing else is taken (no spaces, `$`, sheet name or third part).
 */
export function parse(text: string): { cells: string } | { refused: Refused } {
  const parts = text.split(":")
  if (parts.length > 2) return { refused: "malformed" }
  const cells = parts.map(cell)
  const refused = cells.find((part) => typeof part === "string")
  if (refused) return { refused }
  const found = cells.filter((part) => typeof part !== "string")
  const start = found[0]
  const end = found.at(-1)
  if (!start || !end) return { refused: "malformed" }
  if (start.column > end.column || start.row > end.row) return { refused: "reversed" }
  const same = start.column === end.column && start.row === end.row
  return { cells: same ? a1(start) : `${a1(start)}:${a1(end)}` }
}

/** The sheet a node id names when it is a sheet's own node (`sheet[Sales]`), its `]` unescaped; undefined for any other. */
export function sheetOf(node: string) {
  const match = /^sheet\[((?:\\\]|[^\]])*)\]$/.exec(node)
  return match?.[1]?.replace(/\\\]/g, "]")
}

type Cell = { column: number; row: number }

// One cell, as the core's `parse_cell`: letters then digits, no leading zero, at most three letters and seven digits.
function cell(text: string): Cell | Refused {
  const match = /^([A-Za-z]*)(.*)$/.exec(text)
  const letters = match?.[1] ?? ""
  const digits = match?.[2] ?? ""
  if (!letters || !digits || digits.startsWith("0") || !/^\d+$/.test(digits)) return "malformed"
  if (letters.length > 3) return "column"
  if (digits.length > 7) return "row"
  const column = [...letters.toUpperCase()].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0)
  const row = Number(digits)
  if (column > MAX_COLUMN) return "column"
  if (row > MAX_ROW) return "row"
  return { column, row }
}

const a1 = (cell: Cell) => `${columnName(cell.column)}${cell.row}`

const columnName = (column: number): string =>
  column === 0 ? "" : columnName(Math.floor((column - 1) / 26)) + String.fromCharCode(65 + ((column - 1) % 26))
