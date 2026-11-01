import { describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import path from "node:path"
import { fixtures as bundled, goldens as bundledGoldens } from "./fixtures.hermes"
import { fixtures, goldens } from "#fixtures"

// Bun only: it reads the directories, which Hermes cannot.

describe("fixtures", () => {
  const files = async (dir: string, extension: string) =>
    (await readdir(path.join(import.meta.dir, dir)))
      .filter((file) => file.endsWith(extension))
      .map((file) => file.slice(0, -extension.length))
      .sort()

  test("the Hermes bundle lists exactly the recorded scenarios and goldens", async () => {
    expect(Object.keys(bundled).sort()).toEqual(await files("fixtures", ".jsonl"))
    expect(Object.keys(bundledGoldens).sort()).toEqual(await files("golden", ".json"))
    expect(Object.keys(fixtures).sort()).toEqual(Object.keys(goldens).sort())
  })

  test("the scenarios the phase asks for are all recorded", () => {
    const wanted = [
      "plain",
      "tools",
      "edit",
      "subagent-foreground",
      "subagent-background",
      "permission",
      "question",
      "retry",
      "compaction",
      "todos",
      "abort",
    ]
    wanted.forEach((name) => expect(Object.keys(fixtures)).toContain(name))
    expect(Object.keys(fixtures).length).toBeGreaterThanOrEqual(12)
  })

  test("no recording holds this machine, a user, a credential or the fake provider's address", () => {
    Object.entries(fixtures).forEach(([name, text]) => {
      const leaks = [
        process.env.HOME ?? "~~",
        "/Users/",
        "/var/folders",
        "/private/",
        "127.0.0.1",
        "localhost",
        "Basic ",
        "apiKey",
        "password",
        "OPENCODE_",
      ].filter((needle) => text.includes(needle))
      expect([name, leaks]).toEqual([name, []])
    })
  })

  test("every line of a fixture is JSON of a known kind", () => {
    Object.values(fixtures).forEach((text) => {
      text
        .trim()
        .split("\n")
        .forEach((line) => expect(["meta", "event", "snapshot"]).toContain(JSON.parse(line).kind))
    })
  })
})
