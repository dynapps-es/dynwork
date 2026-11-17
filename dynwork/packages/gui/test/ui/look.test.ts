import { describe, expect, test } from "bun:test"
import { contrastRatio } from "../../../../../packages/ui/src/theme/color"
import type { HexColor } from "../../../../../packages/ui/src/theme/types"

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text()

const font = await read("../../src/views/font.css")
const bubble = await read("../../src/views/bubble.css")
const brand = await read("../../src/brand.css")
const settings = await read("../../../../../packages/app/src/settings/model.tsx")
const theme = await Bun.file(new URL("../../../branding/theme/dynapps.json", import.meta.url)).json()

// Upstream's default sans stack, as Settings writes it inline on the root when no font is chosen.
const fallback = settings.match(/const sansFallback = '(.+)'/)?.[1] ?? ""

describe("Readex Pro", () => {
  const match = [...font.matchAll(/\[style\*='(.+)'\]/g)].map((found) => found[1])

  test("replaces the default stack and leaves a chosen font alone", () => {
    expect(fallback.startsWith('"Inter", ui-sans-serif')).toBe(true)
    expect(match).toHaveLength(1)
    expect(`--font-family-sans: ${fallback};`).toContain(match[0])
    expect(`--font-family-sans: "Iosevka Aile", ${fallback};`).not.toContain(match[0])
    // Choosing Inter by name writes it twice, which is no longer the default.
    expect(`--font-family-sans: "Inter", ${fallback};`).not.toContain(match[0])
  })

  test("goes first and keeps upstream's stack behind it", () => {
    const stack = font.match(/\{\s*--font-family-sans:\s*([^;]+?)\s*!important;/)?.[1].replace(/\s+/g, " ")
    expect(stack).toBe(`"Readex Pro", ${fallback}`)
  })

  test("is bundled as the variable font, with every weight it carries", async () => {
    const file = new URL("../../src/fonts/ReadexPro.ttf", import.meta.url)
    expect(font).toContain('url("../fonts/ReadexPro.ttf")')
    expect(await Bun.file(new URL("../../src/fonts/OFL.txt", import.meta.url)).text()).toContain("Readex Pro")
    const axis = weightAxis(new DataView(await Bun.file(file).arrayBuffer()))
    expect(axis).toEqual({ min: 160, max: 700 })
    expect(font).toContain(`font-weight: ${axis.min} ${axis.max};`)
    // The UI's body, medium and bold weights fall inside the axis, so they render as distinct instances.
    ;[440, 530, 670].forEach((weight) => {
      expect(weight).toBeGreaterThan(axis.min)
      expect(weight).toBeLessThan(axis.max)
    })
  })
})

describe("user bubble", () => {
  const primary = {
    light: brand.match(/:root \{[^}]*--dynwork-primary: (#[0-9a-f]{6});/)?.[1] as HexColor,
    dark: brand.match(/"dark"\] \{[^}]*--dynwork-primary: (#[0-9a-f]{6});/)?.[1] as HexColor,
  }
  const mixes = [
    ...bubble.matchAll(
      /--dynwork-bubble: color-mix\(in srgb, var\(--dynwork-primary\) (\d+)%, (#[0-9a-f]{6}|var\([^)]+\))\)/g,
    ),
  ]
  const rows = [
    {
      mode: "light",
      color: mix(primary.light, "#ffffff", Number(mixes[0][1])),
      text: primary.light,
      surfaces: ["#ffffff", "#F5F5FA"] as HexColor[],
    },
    {
      mode: "dark",
      color: mix(primary.dark, theme.dark.v2Overrides["v2-background-bg-base"], Number(mixes[1][1])),
      text: "#ffffff" as HexColor,
      surfaces: [theme.dark.v2Overrides["v2-background-bg-base"], theme.dark.v2Overrides["v2-background-bg-layer-01"]],
    },
  ]

  test("mixes from the primary over white on light and over the session's background on dark", () => {
    expect(mixes.map((found) => found[2])).toEqual(["#ffffff", "var(--v2-background-bg-base)"])
    expect(bubble).toContain("--dynwork-bubble-text: var(--dynwork-primary);")
    expect(bubble).toContain("--dynwork-bubble-text: #ffffff;")
  })

  test.each(rows)("$mode: the text reads at 4.5:1 or more and the bubble stands apart from the page", (row) => {
    expect(contrastRatio(row.text, row.color)).toBeGreaterThanOrEqual(4.5)
    row.surfaces.forEach((surface) => expect(distance(row.color, surface)).toBeGreaterThan(12))
  })
})

/** The `wght` axis of a font's `fvar` table. */
function weightAxis(view: DataView) {
  const tables = view.getUint16(4)
  const record = Array.from({ length: tables }, (_, index) => 12 + index * 16).find(
    (at) => String.fromCharCode(...[0, 1, 2, 3].map((byte) => view.getUint8(at + byte))) === "fvar",
  )
  const fvar = view.getUint32((record ?? 0) + 8)
  const axes = view.getUint16(fvar + 8)
  const size = view.getUint16(fvar + 10)
  const at = Array.from({ length: axes }, (_, index) => fvar + view.getUint16(fvar + 4) + index * size).find(
    (offset) => String.fromCharCode(...[0, 1, 2, 3].map((byte) => view.getUint8(offset + byte))) === "wght",
  )
  return { min: view.getInt32((at ?? 0) + 4) / 65536, max: view.getInt32((at ?? 0) + 12) / 65536 }
}

/** CSS `color-mix(in srgb, color percent%, under)`. */
function mix(color: HexColor, under: HexColor, percent: number) {
  const channels = (hex: HexColor) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16))
  const top = channels(color)
  const bottom = channels(under)
  return `#${top
    .map((value, index) =>
      Math.round((value * percent + bottom[index] * (100 - percent)) / 100)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}` as HexColor
}

/** The largest per-channel difference, 0-255: a tinted bubble differs in its hue channel even at close luminance. */
function distance(one: HexColor, two: HexColor) {
  const channels = (hex: HexColor) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16))
  const other = channels(two)
  return Math.max(...channels(one).map((value, index) => Math.abs(value - other[index])))
}
