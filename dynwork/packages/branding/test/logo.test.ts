import { describe, expect, test } from "bun:test"
import path from "node:path"
import { DynWorkOutline } from "../src/outline"

const branding = path.join(import.meta.dir, "..")

const wordmarkSvg = await Bun.file(path.join(branding, "logo", "wordmark.svg")).text()

const lockupSvg = await Bun.file(path.join(branding, "logo", "lockup.svg")).text()

const paths = (svg: string) => [...svg.matchAll(/<path d="([^"]+)"/g)].map((match) => match[1])

// The letters use only M, L, Q and Z, so every number pair is a point and the control points bound the curves.
const points = (d: string) =>
  [...d.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((match) => ({ x: Number(match[1]), y: Number(match[2]) }))

const box = (d: string) => {
  const all = points(d)

  return {
    left: Math.min(...all.map((point) => point.x)),
    right: Math.max(...all.map((point) => point.x)),
    top: Math.min(...all.map((point) => point.y)),
    bottom: Math.max(...all.map((point) => point.y)),
  }
}

describe("wordmark", () => {
  test("is outlined letters with no text or font", () => {
    expect(wordmarkSvg).not.toMatch(/<text|font-family|@font-face|<style/)
    expect(paths(wordmarkSvg)).toEqual(DynWorkOutline.wordmark.letters)
  })

  test("the viewBox is the tight box of the letters", () => {
    const boxes = DynWorkOutline.wordmark.letters.map(box)

    expect(wordmarkSvg).toContain(`viewBox="0 0 ${DynWorkOutline.wordmark.width} ${DynWorkOutline.wordmark.height}"`)
    expect(Math.min(...boxes.map((item) => item.left))).toBe(0)
    expect(Math.min(...boxes.map((item) => item.top))).toBe(0)
    expect(Math.max(...boxes.map((item) => item.right))).toBe(DynWorkOutline.wordmark.width)
    expect(Math.max(...boxes.map((item) => item.bottom))).toBe(DynWorkOutline.wordmark.height)
  })

  // Lowercase "dynwork" at baseline 148: ascenders on d and k, the only descender on y, the rest on the x-height.
  test("reads d-y-n-w-o-r-k left to right", () => {
    const boxes = DynWorkOutline.wordmark.letters.map(box)
    const shapes = boxes.map((item) => {
      if (item.top === 0) return "ascender"
      if (item.bottom === DynWorkOutline.wordmark.height) return "descender"
      return "x-height"
    })

    expect(shapes).toEqual(["ascender", "descender", "x-height", "x-height", "x-height", "x-height", "ascender"])
    boxes.slice(1).forEach((item, index) => expect(item.left).toBeGreaterThan(boxes[index].left))
    boxes
      .filter((item) => item.bottom !== DynWorkOutline.wordmark.height)
      .forEach((item) => expect(item.bottom).toBeLessThanOrEqual(150))
  })
})

describe("lockup", () => {
  test("is the Dynapps symbol in its gradient beside the same letters", async () => {
    const source = await Bun.file(path.join(branding, "icons", "source.svg")).text()

    expect(paths(lockupSvg)).toEqual([paths(source)[0], ...DynWorkOutline.wordmark.letters])
    expect(DynWorkOutline.symbol.path).toBe(paths(source)[0])
    expect(lockupSvg).toContain('fill="url(#symbol)"')
    DynWorkOutline.symbol.stops.forEach((stop) => expect(lockupSvg).toContain(`stop-color="${stop.color}"`))
    expect(lockupSvg).not.toMatch(/<text|font-family|@font-face|<style/)
  })

  // src/lockup.tsx draws the lockup from these numbers, so the component and the SVG must agree.
  test("matches the geometry the Lockup component draws", () => {
    expect(lockupSvg).toContain(`viewBox="0 0 ${DynWorkOutline.lockup.width} ${DynWorkOutline.lockup.height}"`)
    expect(lockupSvg).toContain(`<g transform="${DynWorkOutline.lockup.symbol}">`)
    expect(lockupSvg).toContain(`<g transform="${DynWorkOutline.lockup.wordmark}" fill="currentColor">`)
  })
})
