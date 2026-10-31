import { describe, expect, test } from "bun:test"
import { readlink } from "node:fs/promises"
import { contrastRatio, hexToOklch } from "../../../../packages/ui/src/theme/color"
import { resolveThemeVariant } from "../../../../packages/ui/src/theme/resolve"
import type { DesktopTheme, HexColor } from "../../../../packages/ui/src/theme/types"
import { resolveThemeVariantV2 } from "../../../../packages/ui/src/theme/v2/resolve"

const theme: DesktopTheme = await Bun.file(new URL("../theme/dynapps.json", import.meta.url)).json()

const deepFile = Bun.file(new URL("../theme/dynapps-deep.json", import.meta.url))

const deep: DesktopTheme = await deepFile.json()

// The theme picker lists this path, so the link is what makes Dynapps Deep visible in the app.
const deepLink = new URL("../../../../packages/ui/src/theme/themes/oc-2-deep.json", import.meta.url)

// "deep" is the dark variant of Dynapps Deep: pure black where Dynapps dark uses the brand navy.
const variants = { light: theme.light, dark: theme.dark, deep: deep.dark }

// The UI writes both token sets into one :root block, so a v1 token may reference a v2 one and the other way round.
const resolved = {
  light: { ...resolveThemeVariant(theme.light, false), ...resolveThemeVariantV2(theme.light, false) },
  dark: { ...resolveThemeVariant(theme.dark, true), ...resolveThemeVariantV2(theme.dark, true) },
  deep: { ...resolveThemeVariant(deep.dark, true), ...resolveThemeVariantV2(deep.dark, true) },
}

describe("default theme", () => {
  // The desktop build swaps oc-2.json for this file, so every upstream path that falls back to "oc-2" loads it.
  test("keeps the oc-2 id and shows the Dynapps name", () => {
    expect(theme.id).toBe("oc-2")
    expect(theme.name).toBe("Dynapps")
  })

  test.each(["light", "dark", "deep"] as const)(
    "%s keeps every override we set instead of a derived fallback",
    (mode) => {
      const variant = variants[mode]
      const tokens = resolved[mode]

      Object.entries({ ...variant.overrides, ...variant.v2Overrides }).forEach((entry) => {
        expect(tokens[entry[0]]).toBe(entry[1])
      })
    },
  )
})

describe("deep theme", () => {
  test("sorts right after oc-2 and shows the Dynapps Deep name", () => {
    expect(deep.id).toBe("oc-2-deep")
    expect(deep.name).toBe("Dynapps Deep")
  })

  test("light is the Dynapps light variant", () => {
    expect(deep.light).toEqual(theme.light)
  })

  test("dark differs from Dynapps dark only in the neutral", () => {
    expect(deep.dark.palette.neutral).toBe("#000000")
    expect(deep.dark).toEqual({ ...theme.dark, palette: { ...theme.dark.palette, neutral: "#000000" } })
  })

  test("the theme folder links to the branding file", async () => {
    expect(await Bun.file(deepLink).text()).toBe(await deepFile.text())
    expect(await readlink(deepLink)).toEndWith("dynwork/packages/branding/theme/dynapps-deep.json")
  })
})

describe("brand roles", () => {
  // Surfaces and ink: the resolved token must be indistinguishable from the brand tone.
  test.each([
    { mode: "light", role: "background-base", brand: "#F5F5FA" },
    { mode: "light", role: "v2-background-bg-base", brand: "#F5F5FA" },
    { mode: "light", role: "text-base", brand: "#050543" },
    { mode: "dark", role: "background-base", brand: "#030330" },
    { mode: "dark", role: "text-base", brand: "#F5F5FA" },
    { mode: "deep", role: "background-base", brand: "#000000" },
    { mode: "deep", role: "v2-background-bg-base", brand: "#000000" },
    { mode: "deep", role: "text-base", brand: "#F5F5FA" },
  ] as const)("$mode $role is the brand tone $brand", (row) => {
    expect(contrastRatio(color(resolved[row.mode], row.role), row.brand)).toBeLessThan(1.1)
  })

  // Accents and states: the resolver changes lightness for contrast but must keep the brand hue.
  test.each([
    { mode: "light", role: "text-interactive-base", brand: "#7B00DC" },
    { mode: "light", role: "v2-background-bg-accent", brand: "#7B00DC" },
    { mode: "light", role: "v2-state-fg-danger", brand: "#F13C42" },
    { mode: "light", role: "v2-state-fg-warning", brand: "#FF911F" },
    { mode: "dark", role: "text-interactive-base", brand: "#951CF3" },
    { mode: "dark", role: "v2-background-bg-accent", brand: "#951CF3" },
    { mode: "dark", role: "v2-state-fg-danger", brand: "#FF575D" },
    { mode: "dark", role: "v2-state-fg-warning", brand: "#FF7E23" },
    { mode: "deep", role: "text-interactive-base", brand: "#951CF3" },
    { mode: "deep", role: "v2-background-bg-accent", brand: "#951CF3" },
    { mode: "deep", role: "v2-state-fg-danger", brand: "#FF575D" },
    { mode: "deep", role: "v2-state-fg-warning", brand: "#FF7E23" },
  ] as const)("$mode $role keeps the hue of $brand", (row) => {
    const delta = Math.abs(hexToOklch(color(resolved[row.mode], row.role)).h - hexToOklch(row.brand).h)

    expect(Math.min(delta, 360 - delta)).toBeLessThan(5)
  })
})

describe("contrast", () => {
  // WCAG 2 ratios: 4.5 for body text, 7 for strong text, 3 for interactive elements.
  test.each(
    (["light", "dark", "deep"] as const).flatMap((mode) => [
      { mode, text: "text-base", background: "background-base", min: 4.5 },
      { mode, text: "text-weak", background: "background-base", min: 4.5 },
      { mode, text: "text-strong", background: "background-base", min: 7 },
      { mode, text: "text-interactive-base", background: "background-base", min: 3 },
      { mode, text: "v2-text-text-base", background: "v2-background-bg-base", min: 7 },
      { mode, text: "v2-text-text-muted", background: "v2-background-bg-base", min: 4.5 },
      { mode, text: "v2-text-text-accent", background: "v2-background-bg-base", min: 3 },
    ]),
  )("$mode $text on $background reaches $min:1", (row) => {
    const tokens = resolved[row.mode]

    expect(contrastRatio(color(tokens, row.text), color(tokens, row.background))).toBeGreaterThanOrEqual(row.min)
  })
})

// Follows var(--token) references until a hex value; a dangling reference fails the test that asked for it.
function color(tokens: Record<string, string>, key: string): HexColor {
  const value = tokens[key]

  if (value === undefined) throw new Error(`Missing token ${key}`)

  if (value.startsWith("var(--")) return color(tokens, value.slice("var(--".length, -1))

  // SAFETY: theme color tokens are hex colors or references to other color tokens.
  return value as HexColor
}
