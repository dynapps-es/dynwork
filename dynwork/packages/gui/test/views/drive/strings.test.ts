import { describe, expect, test } from "bun:test"
import { Act, Failure } from "../../../src/drive/contract"
import en from "../../../src/views/drive/en"
import es from "../../../src/views/drive/es"
import fr from "../../../src/views/drive/fr"
import nl from "../../../src/views/drive/nl"
import { emphasized, formats, scopes, shareSubject, sorts, typeFilters } from "../../../src/views/drive/model"

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

  test("every string the Share popover names is in every language", async () => {
    const source = await Bun.file(new URL("../../../src/views/drive/share-popover.tsx", import.meta.url)).text()
    const keys = [...new Set([...source.matchAll(/"(drive\.[\w.]+)"/g)].map((match) => match[1] ?? ""))]
    expect(keys).toContain("drive.share.remove")
    expect(
      Object.entries(locales).flatMap(([locale, table]) =>
        keys.filter((key) => !table[key]).map((key) => `${locale} ${key}`),
      ),
    ).toEqual([])
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

  test("every string the comment popup names is in every language, and the comments view's hint to comment in place", async () => {
    const source = await Bun.file(new URL("../../../src/views/drive/comment-popup.tsx", import.meta.url)).text()
    const keys = [...new Set([...source.matchAll(/"(drive\.[\w.]+)"/g)].map((match) => match[1] ?? ""))]
    expect(keys).toContain("drive.ask.quote")
    expect(
      Object.entries(locales).flatMap(([locale, table]) =>
        [...keys, "drive.comment.inline.hint"].filter((key) => !table[key]).map((key) => `${locale} ${key}`),
      ),
    ).toEqual([])
  })

  test("every key of the share card is in every language, and each sentence names all it shows", async () => {
    const source = await Bun.file(new URL("../../../src/views/drive/share.tsx", import.meta.url)).text()
    const keys = [...new Set([...source.matchAll(/"(drive\.[\w.]+)"/g)].map((match) => match[1] ?? ""))]
    expect(keys).toContain("drive.share.conversation")
    expect(
      Object.entries(locales).flatMap(([locale, table]) =>
        keys.filter((key) => !table[key]).map((key) => `${locale} ${key}`),
      ),
    ).toEqual([])
    const placeholders = (text: string) => [...text.matchAll(/{{\s*(\w+)\s*}}/g)].map((match) => match[1]).toSorted()
    const sentences = ["grant.text", "grant.folder", "transfer.text", "revoke.text"].map((key) => `drive.share.${key}`)
    for (const [locale, table] of Object.entries(locales))
      for (const key of sentences)
        expect([locale, key, placeholders(table[key] ?? "")]).toEqual([
          locale,
          key,
          placeholders(en[key as keyof typeof en]),
        ])
  })

  test("a share sentence keeps each language's order and marks only the values", () => {
    expect(emphasized(nl["drive.share.grant.text"], { target: "Q3.md", subject: "Luis", level: "Bewerken" })).toEqual([
      { text: "Q3.md", strong: true },
      { text: " delen met ", strong: false },
      { text: "Luis", strong: true },
      { text: " · ", strong: false },
      { text: "Bewerken", strong: true },
    ])
    expect(emphasized("Share {{target}}", {})).toEqual([
      { text: "Share ", strong: false },
      { text: "", strong: true },
    ])
  })

  test("the share card names a person looked up by name and email, and anyone else as the agent gave them", () => {
    expect(shareSubject({ kind: "user", value: "e51c808f-1", name: "Jesús Pérez", email: "jesus@dynapps.es" })).toBe(
      "Jesús Pérez (jesus@dynapps.es)",
    )
    expect(shareSubject({ kind: "user", value: "e51c808f-2", name: "Jesús Gil" })).toBe("Jesús Gil")
    expect(shareSubject({ kind: "user", value: "luis@dynapps.es" })).toBe("luis@dynapps.es")
    expect(shareSubject({ kind: "user", value: "e51c808f-9" })).toBe("e51c808f-9")
    expect(shareSubject({ kind: "group", value: "sales" })).toBe("sales (group)")
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
