import { describe, expect, test } from "bun:test"
import en from "../../src/accounts/i18n/en"
import { SyncError } from "../../src/accounts/contract"
import { AccountsModel } from "../../src/accounts/ui/model"

const sources = [
  ...new Bun.Glob("*.{ts,tsx}").scanSync({ cwd: new URL("../../src/accounts/ui/", import.meta.url).pathname }),
]

// Every literal key the page, the pill and their helpers look up.
async function keys(call: "t" | "plural") {
  const found = await Promise.all(
    sources.map(async (file) => {
      const text = await Bun.file(new URL(`../../src/accounts/ui/${file}`, import.meta.url)).text()

      return [...text.matchAll(new RegExp(`\\b${call}\\(\\s*"([^"]+)"`, "g"))].map((match) => match[1] ?? "")
    }),
  )

  return [...new Set(found.flat())]
}

describe("the plugin's copy", () => {
  test("every key the UI looks up exists", async () => {
    const used = await keys("t")
    expect(used.length).toBeGreaterThan(30)
    expect(used.filter((key) => !(key in en))).toEqual([])
  })

  test("every counted key has its one and other forms", async () => {
    const used = await keys("plural")
    expect(used.toSorted()).toEqual(["count.agents", "count.mcp", "count.rules", "count.skills"])
    expect(used.flatMap((key) => [`${key}.one`, `${key}.other`]).filter((key) => !(key in en))).toEqual([])
  })

  test("every sync failure and every status the model can name has copy", () => {
    expect(
      SyncError.members.map((member) => AccountsModel.errorKey(member.literal)).filter((key) => !(key in en)),
    ).toEqual([])
    const statuses = [
      { kind: "signed-out" },
      { kind: "idle" },
      { kind: "waiting" },
      { kind: "syncing" },
      { kind: "synced", at: 0, counts: { skills: 0, agents: 0, mcp: 0, rules: 0 } },
    ] as const
    expect(statuses.map((sync) => AccountsModel.describe(sync, 0).key).filter((key) => !(key in en))).toEqual([])
  })
})
