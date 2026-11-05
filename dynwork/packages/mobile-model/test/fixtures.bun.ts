// The recorded sessions and their goldens, read from disk (`#fixtures` in package.json). Under Hermes the same names
// come from `fixtures.hermes.ts`, which bundles the files, because Hermes has no file system.
import path from "node:path"

const read = async (dir: string, extension: string) =>
  Object.fromEntries(
    await Promise.all(
      (await Array.fromAsync(new Bun.Glob(`*.${extension}`).scan({ cwd: dir })))
        .sort()
        .map(
          async (file) => [file.slice(0, -extension.length - 1), await Bun.file(path.join(dir, file)).text()] as const,
        ),
    ),
  )

export const fixtures = await read(path.join(import.meta.dir, "fixtures"), "jsonl")

export const goldens: Record<string, unknown> = Object.fromEntries(
  Object.entries(await read(path.join(import.meta.dir, "golden"), "json")).map(([name, text]) => [
    name,
    JSON.parse(text),
  ]),
)
