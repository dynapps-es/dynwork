import { describe, expect, test } from "bun:test"
import { AccountsModel } from "../../src/accounts/ui/model"
import { account, fingerprints, state, synced } from "./fixture"

const now = 1_000_000 + 2 * 60_000

describe("an instance's status", () => {
  test("the active instance that synced says when and what it holds", () => {
    const row = AccountsModel.rows(state([account({ active: true })], synced("alpha")))[0]
    expect(row?.badges).toEqual(["active"])
    expect(row?.sync).toEqual({ kind: "synced", at: 1_000_000, counts: { skills: 12, agents: 4, mcp: 3, rules: 2 } })
    expect(row?.host).toBe("sp.dynapps.test")
    expect(row?.initial).toBe("D")
  })

  test("the sync status belongs to the account it names, and only the active one syncs", () => {
    const rows = AccountsModel.rows(
      state([account({ active: true }), account({ id: "beta", label: "Beta" })], synced("beta")),
    )
    // The engine has not reported on the active account yet.
    expect(rows[0]?.sync).toEqual({ kind: "waiting" })
    expect(rows[1]?.sync).toEqual({ kind: "idle" })
    expect(rows[1]?.badges).toEqual([])
  })

  test("a sync in flight and a sync that failed", () => {
    const syncing = AccountsModel.rows(state([account({ active: true })], { status: "syncing", account: "alpha" }))[0]
    expect(syncing?.sync).toEqual({ kind: "syncing" })
    const failed = AccountsModel.rows(
      state([account({ active: true })], { status: "error", account: "alpha", kind: "unreachable", at: 5 }),
    )[0]
    expect(failed?.sync).toEqual({ kind: "error", error: "unreachable", at: 5 })
  })

  test("a signed-out instance is not syncing and keeps its URL", () => {
    const row = AccountsModel.rows(state([account({ status: "signedOut", fingerprint: undefined })]))[0]
    expect(row?.badges).toEqual(["signed-out"])
    expect(row?.sync).toEqual({ kind: "signed-out" })
    expect(row?.key).toBeUndefined()
  })

  test("the first key an instance offers waits for trust, with nothing pinned", () => {
    const row = AccountsModel.rows(
      state([account({ active: true, pinned: undefined, trusted: false, fingerprint: fingerprints.offered })]),
    )[0]
    // The instance stays marked active next to the key that waits.
    expect(row?.badges).toEqual(["active", "new-key"])
    expect(row?.key).toEqual({ offered: fingerprints.offered, pinned: undefined })
  })

  test("a rotated key shows the key it replaces next to the one on offer", () => {
    const row = AccountsModel.rows(
      state([account({ active: true, trusted: false, fingerprint: fingerprints.offered })]),
    )[0]
    expect(row?.badges).toEqual(["active", "key-changed"])
    expect(row?.key).toEqual({ offered: fingerprints.offered, pinned: fingerprints.pinned })
  })
})

describe("an instance's name", () => {
  test("a label no other instance carries reads as is", () => {
    const rows = AccountsModel.rows(state([account(), account({ id: "beta", label: "Beta" })]))
    expect(rows.map((row) => row.name)).toEqual(["Dynapps", "Beta"])
  })

  test("instances with the same label show their host, whatever the case or trailing space", () => {
    const value = state([
      account({ active: true, url: "http://127.0.0.1:18101" }),
      account({ id: "beta", label: "dynapps ", url: "http://127.0.0.1:18102" }),
      account({ id: "gamma", label: "Gamma", url: "https://gamma.dynapps.test" }),
    ])
    expect(AccountsModel.rows(value).map((row) => row.name)).toEqual([
      "Dynapps (127.0.0.1:18101)",
      "dynapps  (127.0.0.1:18102)",
      "Gamma",
    ])
    // The titlebar pill names the active instance the same way.
    expect(AccountsModel.pill(value)?.name).toBe("Dynapps (127.0.0.1:18101)")
  })

  test("a signed-out instance with the same label still counts as a collision", () => {
    const value = state([
      account({ active: true }),
      account({ id: "old", status: "signedOut", url: "https://old.test" }),
    ])
    expect(AccountsModel.rows(value).map((row) => row.name)).toEqual([
      "Dynapps (sp.dynapps.test)",
      "Dynapps (old.test)",
    ])
  })
})

describe("the actions an instance offers", () => {
  const actions = (value: ReturnType<typeof account>, status = synced(value.id)) =>
    AccountsModel.rows(state([value], status))[0]?.actions

  test("active: sync now, sign out, remove", () => {
    expect(actions(account({ active: true }))).toEqual(["sync-now", "sign-out", "remove"])
  })

  test("another signed-in instance can be made active", () => {
    expect(actions(account())).toEqual(["make-active", "sign-out", "remove"])
  })

  test("signed out: sign in or remove", () => {
    expect(actions(account({ status: "signedOut" }))).toEqual(["sign-in", "remove"])
  })

  test("a key waiting for trust leads, and the sync that stopped at it cannot be asked to run", () => {
    const waiting = { trusted: false, fingerprint: fingerprints.offered }
    expect(actions(account({ active: true, ...waiting }))).toEqual(["trust", "sign-out", "remove"])
    expect(actions(account(waiting))).toEqual(["trust", "make-active", "sign-out", "remove"])
  })

  test("no second sync while one runs", () => {
    expect(actions(account({ active: true }), { status: "syncing", account: "alpha" })).toEqual(["sign-out", "remove"])
  })
})

describe("the pill", () => {
  test("shows nothing without an active signed-in instance", () => {
    expect(AccountsModel.pill(state([account()]))).toBeUndefined()
    expect(AccountsModel.pill(state([account({ active: true, status: "signedOut" })]))).toBeUndefined()
  })

  test("its icon says how the sync stands", () => {
    const icon = (value: ReturnType<typeof account>, status: Parameters<typeof state>[1]) =>
      AccountsModel.pill(state([value], status))?.icon
    expect(icon(account({ active: true }), synced("alpha"))).toBe("circle-check")
    expect(icon(account({ active: true }), { status: "syncing", account: "alpha" })).toBe("refresh")
    expect(icon(account({ active: true }), { status: "error", account: "alpha", kind: "refused", at: 1 })).toBe(
      "circle-exclamation",
    )
    expect(icon(account({ active: true, trusted: false, fingerprint: fingerprints.offered }), synced("alpha"))).toBe(
      "circle-exclamation",
    )
    expect(icon(account({ active: true }), { status: "idle" })).toBe("server")
  })

  test("the menu lists the signed-in instances that are not active", () => {
    const value = state([account({ active: true }), account({ id: "b" }), account({ id: "c", status: "signedOut" })])
    expect(AccountsModel.others(value).map((item) => item.id)).toEqual(["b"])
    expect(AccountsModel.active(value)?.id).toBe("alpha")
  })
})

describe("what the page says", () => {
  test("relative time, in minutes, hours and days", () => {
    expect(AccountsModel.ago(1_000_000, now, "en")).toBe("2 minutes ago")
    expect(AccountsModel.ago(1_000_000, 1_000_000 + 3 * 3600_000, "en")).toBe("3 hours ago")
    expect(AccountsModel.ago(1_000_000, 1_000_000 + 3 * 86_400_000, "en")).toBe("3 days ago")
    expect(AccountsModel.ago(1_000_000, 1_000_000 + 10_000, "en")).toBe("now")
  })

  test("a failed sync names its kind and when", () => {
    const text = AccountsModel.describe({ kind: "error", error: "key-changed", at: 1_000_000 }, now, "en")
    expect(text).toEqual({ key: "sync.error.key-changed", time: "2 minutes ago" })
    expect(AccountsModel.describe({ kind: "idle" }, now).key).toBe("sync.idle")
  })

  test("a fingerprint shortens to its head and keeps the algorithm", () => {
    expect(AccountsModel.short(fingerprints.pinned)).toBe("sha256:02c4e6a8b0d2f4a6…")
    expect(AccountsModel.short("sha256:abc")).toBe("sha256:abc")
  })
})
