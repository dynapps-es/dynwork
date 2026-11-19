import { describe, expect, test } from "bun:test"
import path from "node:path"
import { composerProviderName } from "../../../../packages/app/src/composer/model-label"
import { FIRST_TIP_DELAY_MS, selectTip } from "../../../../packages/app/src/tips/queue"
import { DynWorkGateway } from "../../server-plugin/src/gateway"

// DynWork's patches to the app's own texts (rows in dynwork/PATCHES.md): an upstream merge that drops one fails here.

const repo = path.join(import.meta.dir, "..", "..", "..", "..")

describe("the composer's provider name", () => {
  test("names the gateway's provider Governance while the service does not list it", () => {
    expect(composerProviderName(DynWorkGateway.providerID, new Map())).toBe("Governance")
  })

  test("names another missing provider by its id, and a listed gateway by its label", () => {
    const listed = new Map([[DynWorkGateway.providerID, { id: DynWorkGateway.providerID, name: "Dynapps", models: {} }]])

    expect(composerProviderName("acme", new Map())).toBe("acme")
    expect(composerProviderName(DynWorkGateway.providerID, listed)).toBe("Dynapps")
  })
})

describe("OpenCode's browser tip", () => {
  // The tips are built inside `createTipToasts`, which needs the app's providers: the tip is read from its source.
  test("ends at the epoch", async () => {
    const source = await Bun.file(path.join(repo, "packages/app/src/tips/model.ts")).text()
    const browse = source.slice(source.indexOf('id: "browse"')).split(/\n\s*\{\n/)[0]

    expect(browse).toContain('id: "browse"')
    expect(browse).toMatch(/\n\s*end: 0,/)
  })

  test("a tip that ends at the epoch is never picked, also when it is the one showing", () => {
    const now = Date.UTC(2026, 10, 19)
    const history = { current: "", shownAt: 0, dismissed: [], dismissedAt: 0, firstSeen: now - FIRST_TIP_DELAY_MS }
    const tip = { id: "browse", title: "tips.browse.title", description: "tips.browse.description" } as const

    expect(selectTip([tip], history, now)?.id).toBe("browse")
    expect(selectTip([{ ...tip, end: 0 }], history, now)).toBeUndefined()
    expect(selectTip([{ ...tip, end: 0 }], { ...history, current: "browse", shownAt: now - 1 }, now)).toBeUndefined()
  })
})
