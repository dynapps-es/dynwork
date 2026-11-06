#!/usr/bin/env bun

import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { $ } from "bun"

// Regenerates every file in icons/ from icons/source.svg, the light icon: the PNGs, icon.icns, which macOS before 26
// and the other platforms use, icon.ico for Windows, and icon.icon, the Icon Composer package macOS 26 and later draw
// the icon from. Each PNG size is rendered straight from the SVG, never downsampled from a bigger render (see
// packages/desktop/icons/README.md).
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
// icon.ico, which Windows and its installer use: PNG images inside an ICO directory, as Windows Vista and later read.
const sizes = [16, 24, 32, 48, 64, 128, 256]
const images = await Promise.all(
  sizes.map(async (size) => {
    const file = path.join(temp, `ico-${size}.png`)
    await render(size, file)
    return new Uint8Array(await Bun.file(file).arrayBuffer())
  }),
)
const header = Buffer.alloc(6 + 16 * sizes.length)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(sizes.length, 4)
images.reduce((offset, image, index) => {
  const entry = 6 + 16 * index
  // 0 stands for 256 in the one-byte width and height
  header.writeUInt8(sizes[index] % 256, entry)
  header.writeUInt8(sizes[index] % 256, entry + 1)
  header.writeUInt16LE(1, entry + 4)
  header.writeUInt16LE(32, entry + 6)
  header.writeUInt32LE(image.length, entry + 8)
  header.writeUInt32LE(offset, entry + 12)
  return offset + image.length
}, header.length)
await Bun.write(path.join(root, "icon.ico"), new Blob([header, ...images]))

await rm(temp, { recursive: true, force: true })

// Icon Composer draws the squircle itself and fills it with the document's fill, so the package holds the aperture
// alone. Its canvas is the squircle: source.svg's 824px squircle becomes 1024px, and the aperture grows with it. The
// fills follow the system appearance: black on white, and white on black in dark mode.
const symbol = (await Bun.file(source).text()).match(/<path d="([^"]+)"/)?.[1]
if (!symbol) throw new Error(`No symbol path in ${source}`)
const scale = (3.21 * 1024) / 824
const composer = path.join(root, "icon.icon")
await rm(composer, { recursive: true, force: true })
await Bun.write(
  path.join(composer, "Assets/aperture.svg"),
  [
    `<svg width="1024" height="1024" viewBox="0 0 1024 1024" fill="none" xmlns="http://www.w3.org/2000/svg">`,
    `<g transform="translate(512 512) scale(${scale.toFixed(5)}) translate(-213 -81)">`,
    `<path d="${symbol}" fill="#000000"/>`,
    `</g>`,
    `</svg>`,
    ``,
  ].join("\n"),
)
const black = "srgb:0.00000,0.00000,0.00000,1.00000"
const white = "srgb:1.00000,1.00000,1.00000,1.00000"
const fill = (light: string, dark: string) => [
  { value: { solid: light } },
  { appearance: "dark", value: { solid: dark } },
]
await Bun.write(
  path.join(composer, "icon.json"),
  JSON.stringify(
    {
      "fill-specializations": fill(white, black),
      groups: [
        {
          name: "DynWork",
          layers: [
            {
              name: "Aperture",
              "image-name": "aperture.svg",
              "fill-specializations": fill(black, white),
              glass: false,
            },
          ],
          shadow: { kind: "none", opacity: 0 },
          translucency: { enabled: false, value: 0.5 },
        },
      ],
      "supported-platforms": { squares: ["macOS"] },
    },
    null,
    2,
  ),
)
// The repository's formatter, so a regenerated package matches the committed one.
await $`bun x prettier --write ${path.join(composer, "icon.json")}`.quiet()
