import { describe, expect, test } from "bun:test"
import { Act, Failure } from "../../../src/drive/contract"
import en from "../../../src/views/drive/en"
import es from "../../../src/views/drive/es"
import fr from "../../../src/views/drive/fr"
import nl from "../../../src/views/drive/nl"
import { formats, scopes, sorts, typeFilters } from "../../../src/views/drive/model"

const locales: Record<string, Record<string, string>> = { en, es, fr, nl }

describe("the Drive's strings", () => {
  test("every key the Drive builds from data is in every language", () => {
    const keys = [
      ...Failure.fields.code.literals.map((code) => `drive.failure.${code}`),
      ...["none", "read", "suggest", "edit"].map((cap) => `drive.cap.${cap}`),
      ...Act.literals.map((act) => `drive.card.${act}`),
      ...scopes.map((scope) => `drive.scope.${scope}`),
      ...typeFilters.map((type) => `drive.type.${type}`),
      ...sorts.map((sort) => `drive.sort.${sort}`),
      ...formats.map((format) => `drive.format.${format}`),
      ...["details", "comments", "versions", "proposals", "share"].map((tab) => `drive.tab.${tab}`),
      ...["own", "share", "edit", "comment", "view"].map((level) => `drive.level.${level}`),
      ...["open", "accepted", "rejected"].map((status) => `drive.proposals.${status}`),
    ]
    expect(
      Object.entries(locales).flatMap(([locale, table]) =>
        keys.filter((key) => !table[key]).map((key) => `${locale} ${key}`),
      ),
    ).toEqual([])
  })

  test("each translation keeps the English placeholders", () => {
    const placeholders = (value: string) => [...value.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).toSorted()
    const drift = Object.entries(locales).flatMap(([locale, table]) =>
      Object.entries(en)
        .filter(([key, value]) => placeholders(table[key] ?? "").join() !== placeholders(value).join())
        .map(([key]) => `${locale} ${key}`),
    )
    expect(drift).toEqual([])
  })

  test("every string the comments view names is in every language", async () => {
    const source = await Bun.file(new URL("../../../src/views/drive/comments.tsx", import.meta.url)).text()
    const keys = [...new Set([...source.matchAll(/"(drive\.[\w.]+)"/g)].map((match) => match[1]))]
    expect(keys.length).toBeGreaterThan(20)
    expect(
      Object.entries(locales).flatMap(([locale, table]) =>
        keys.filter((key) => !table[key]).map((key) => `${locale} ${key}`),
      ),
    ).toEqual([])
  })

  // The platform and the other products behind Governance are never named on screen.
  test("never name the platform, the farm or routines", () => {
    const named = Object.entries(locales).flatMap(([locale, table]) =>
      Object.entries(table)
        .filter(([, value]) => /system\s*prompt|agent\s*farm|routine/i.test(value))
        .map(([key]) => `${locale} ${key}`),
    )
    expect(named).toEqual([])
  })
})
