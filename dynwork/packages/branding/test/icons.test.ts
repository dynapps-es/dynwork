import { expect, test } from "bun:test"
import path from "node:path"

const root = path.join(import.meta.dir, "..", "icons")

// The build picks these files up by name: a wrong size renders blurry or oversized in the Dock and Finder.
test.each([
  { name: "icon.png", size: 512 },
  { name: "32x32.png", size: 32 },
  { name: "64x64.png", size: 64 },
  { name: "128x128.png", size: 128 },
  { name: "128x128@2x.png", size: 256 },
  { name: "dock.png", size: 256 },
])("$name is a $size px square PNG", async (row) => {
  const view = new DataView(await Bun.file(path.join(root, row.name)).arrayBuffer())

  expect(view.getUint32(0)).toBe(0x89504e47)
  expect(view.getUint32(16)).toBe(row.size)
  expect(view.getUint32(20)).toBe(row.size)
})

// macOS needs the 1024 px entry (ic10) to draw the icon sharp on Retina displays.
test("icon.icns is an icns file with the 1024 px entry", async () => {
  const bytes = Buffer.from(await Bun.file(path.join(root, "icon.icns")).arrayBuffer())

  expect(bytes.subarray(0, 4).toString("latin1")).toBe("icns")
  expect(bytes.includes("ic10", 0, "latin1")).toBe(true)
})
