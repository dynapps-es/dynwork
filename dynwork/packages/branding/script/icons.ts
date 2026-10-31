#!/usr/bin/env bun

import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { $ } from "bun"

// Regenerates every file in icons/ from icons/source.svg. Each size is rendered straight from the SVG,
// never downsampled from a bigger render (see packages/desktop/icons/README.md).
const root = path.join(import.meta.dir, "..", "icons")
const source = path.join(root, "source.svg")

async function render(size: number, file: string) {
  await $`rsvg-convert --width ${size} --height ${size} --output ${file} ${source}`
}

const temp = await mkdtemp(path.join(tmpdir(), "dynwork-icons-"))

const iconset = path.join(temp, "icon.iconset")

await mkdir(iconset)

await Promise.all(
  [16, 32, 128, 256, 512].flatMap((size) => [
    render(size, path.join(iconset, `icon_${size}x${size}.png`)),
    render(size * 2, path.join(iconset, `icon_${size}x${size}@2x.png`)),
  ]),
)
await $`iconutil --convert icns --output ${path.join(root, "icon.icns")} ${iconset}`

await Promise.all(
  [
    { size: 512, name: "icon.png" },
    { size: 32, name: "32x32.png" },
    { size: 64, name: "64x64.png" },
    { size: 128, name: "128x128.png" },
    { size: 256, name: "128x128@2x.png" },
    { size: 256, name: "dock.png" },
  ].map((item) => render(item.size, path.join(root, item.name))),
)
await rm(temp, { recursive: true, force: true })
