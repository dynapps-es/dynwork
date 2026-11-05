import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DynWorkService } from "../src/service"

// `opencode service start` (what the pairing settings run after turning remote access on) starts the service from its
// settings file, not from the desktop's arguments. Without DynWork's address there, it comes up on OpenCode's port.

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function profile() {
  const userData = await mkdtemp(path.join(tmpdir(), "dynwork-service-"))
  dirs.push(userData)
  const own = DynWorkService.layout("prod", { isPackaged: true, getPath: () => userData, getAppPath: () => "/app.asar" })
  if (!own) throw new Error("the packaged prod build has a layout")
  return { own, file: path.join(own.env.OPENCODE_CONFIG_DIR, "service.json") }
}

test("pins the service's address in its own settings, keeping the rest", async () => {
  const target = await profile()
  await Bun.write(target.file, JSON.stringify({ password: "kept", remote: { route: "abc" } }))
  await DynWorkService.pin(target.own)
  expect(await Bun.file(target.file).json()).toEqual({
    password: "kept",
    remote: { route: "abc" },
    hostname: "127.0.0.1",
    port: 17495,
  })
  expect((await Bun.file(target.file).stat()).mode & 0o777).toBe(0o600)
})

test("creates the settings when there are none, and leaves pinned settings untouched", async () => {
  const target = await profile()
  await DynWorkService.pin(target.own)
  expect(await Bun.file(target.file).json()).toEqual({ hostname: "127.0.0.1", port: 17495 })
  const before = (await Bun.file(target.file).stat()).mtimeMs
  await Bun.sleep(5)
  await DynWorkService.pin(target.own)
  expect((await Bun.file(target.file).stat()).mtimeMs).toBe(before)
})

test("a settings file that is not an object is replaced, as the CLI reads it as empty", async () => {
  const target = await profile()
  await Bun.write(target.file, "[1, 2]")
  await DynWorkService.pin(target.own)
  expect(await Bun.file(target.file).json()).toEqual({ hostname: "127.0.0.1", port: 17495 })
})
