import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Schema } from "effect"
import type { Caller } from "@opencode/plugin/gui"
import type { MainContext } from "@opencode/plugin/gui/main"
import { Drive, State } from "../../src/drive/contract"
import { DriveMain } from "../../src/drive/main"
import { setup as accountsSetup, startFake, until, type Fake } from "../accounts/fixture"
import { storage } from "../routines/fixture"
import { expectFailure, ok } from "./conformance"
import { crossing, manualTimers } from "./wire"

let alpha: Fake
let beta: Fake

beforeAll(() => {
  alpha = startFake()
  beta = startFake()
})

afterAll(() => {
  alpha.stop()
  beta.stop()
})

const caller: Caller = { window: 1, signal: new AbortController().signal }

// Main as the `dynwork` built-in sets it up: real accounts signed in to fake instances, their `changed` reaching the
// Drive as `accounts/main.ts` wires it, and the part of main's context the Drive uses.
async function stand(stored = new Map<string, unknown>()) {
  const provided: { token?: unknown; impl?: Record<string, (input: unknown, caller: Caller) => unknown> } = {}
  const cleanups: Array<() => void> = []
  const pushed = { changed: 0 }
  const drive = { account: () => {} }
  const context = accountsSetup(alpha, { changed: () => drive.account() })
  await context.accounts.signInToken({ url: alpha.url, token: alpha.issuePat() })
  await context.accounts.signInToken({ url: beta.url, token: beta.issuePat() })
  const ctx = {
    provide: (token: unknown, impl: Record<string, (input: unknown, caller: Caller) => unknown>) => {
      provided.token = token
      provided.impl = impl
      return { changed: () => void pushed.changed++ }
    },
    onCleanup: (cleanup: () => void) => void cleanups.push(cleanup),
    storage: {
      store: (key: string, options: { schema: Schema.Codec<unknown, unknown>; initial: unknown }) => {
        if (!stored.has(key)) stored.set(key, storage(options.schema, options.initial))
        return stored.get(key)
      },
    },
  }
  const timers = manualTimers()
  // SAFETY: the Drive's setup reads only `provide`, `onCleanup` and `storage`, which the stand-in provides.
  const service = DriveMain.setup(ctx as unknown as MainContext, context.accounts, { timers })
  drive.account = service.account
  const call = async (name: string, input?: unknown) => provided.impl?.[name]?.(input, caller)
  const state = () => crossing(State, provided.impl?.state?.(1, caller))
  const id = (fake: Fake) => context.accounts.list().find((account) => account.url === fake.url)?.id ?? ""
  return { ...context, provided, cleanups, pushed, call, state, id, service, timers, stored }
}

describe("the Drive's main side", () => {
  test("provides dynwork.drive over the active account's Drive, with that account's JWT", async () => {
    const main = await stand()
    expect(main.provided.token).toBe(Drive)
    await until(() => main.state().status === "ready")
    expect(main.state().account).toBe(main.id(alpha))
    const created = await ok(
      main.call("upload", { name: "from-main.md", bytes: new TextEncoder().encode("# x"), mime: "text/markdown" }),
    )
    const upload = alpha.state.requests.findLast((request) => request.path === "/api/v1/documents")
    expect(alpha.state.jwts.has(upload?.headers.authorization?.replace("Bearer ", "") ?? "")).toBe(true)
    expect(alpha.state.drive.documents.has((created as { document: { id: string } }).document.id)).toBe(true)
    expect(main.pushed.changed).toBeGreaterThan(0)
    main.cleanups.forEach((cleanup) => cleanup())
  })

  test("signs a direct write with the signed-in user's email and DynWork", async () => {
    const main = await stand()
    const created = (await ok(
      main.call("upload", { name: "signed.md", bytes: new TextEncoder().encode("# x"), mime: "text/markdown" }),
    )) as { document: { id: string } }
    await ok(main.call("edit", { id: created.document.id, ops: [{ op: "append_markdown", markdown: "y" }] }))
    const revisions = (await ok(main.call("revisions", { id: created.document.id }))) as Array<{ message?: string }>
    expect(revisions[0]?.message).toBe("dev@dynapps.test by DynWork")
    main.cleanups.forEach((cleanup) => cleanup())
  })

  test("switching the active account empties the Drive and reads the other instance's", async () => {
    const main = await stand()
    await until(() => main.state().status === "ready")
    await ok(
      main.call("upload", { name: "alpha-only.md", bytes: new TextEncoder().encode("x"), mime: "text/markdown" }),
    )
    expect(main.state().documents.map((document) => document.name)).toContain("alpha-only.md")
    main.accounts.activate(main.id(beta))
    expect(main.state()).toMatchObject({ account: main.id(beta), status: "loading", documents: [] })
    await until(() => main.state().status === "ready")
    expect(main.state().documents.map((document) => document.name)).not.toContain("alpha-only.md")
    const reads = beta.state.requests.filter((request) => request.path === "/api/v1/documents").length
    expect(reads).toBeGreaterThan(0)
    main.cleanups.forEach((cleanup) => cleanup())
  })

  test("signing every account out leaves the Drive with none", async () => {
    const main = await stand()
    await until(() => main.state().status === "ready")
    main.accounts.signOut(main.id(alpha))
    main.accounts.signOut(main.id(beta))
    expect(main.state()).toMatchObject({ status: "none", folders: [], documents: [] })
    expectFailure(await main.call("list", {}), "signed-out")
    main.cleanups.forEach((cleanup) => cleanup())
  })

  test("a sign-in the instance refuses empties the Drive at once, and signing in again reads it again", async () => {
    const main = await stand()
    await until(() => main.state().status === "ready")
    alpha.state.pats.clear()
    alpha.state.jwts.clear()
    expectFailure(await main.call("list", {}), "signed-out")
    expect(main.accounts.list().find((account) => account.url === alpha.url)).toMatchObject({
      status: "needsSignIn",
      active: true,
    })
    // The lapsed account stays the active one: the Drive waits for it, and asks the instance nothing meanwhile.
    expect(main.state()).toMatchObject({ status: "none", documents: [] })
    const asked = alpha.state.requests.length
    expectFailure(await main.call("list", {}), "signed-out")
    expect(alpha.state.requests.length).toBe(asked)

    await main.accounts.signInToken({ url: alpha.url, token: alpha.issuePat() })
    expect(main.state()).toMatchObject({ account: main.id(alpha), status: "loading" })
    await until(() => main.state().status === "ready")
    main.cleanups.forEach((cleanup) => cleanup())
  })

  test("keeps each conversation's context, registered by the instance, in the plugin's storage, and stops polling on cleanup", async () => {
    const stored = new Map<string, unknown>()
    const main = await stand(stored)
    await until(() => main.state().status === "ready")
    const bytes = new TextEncoder().encode("# Kept")
    const conversation = { id: "ses_kept", name: "Kept" }
    await ok(main.call("upload", { name: "kept.md", bytes, mime: "text/markdown", conversation }))
    const context = main.service.context("ses_kept")
    expect(alpha.state.drive.contexts.get(context ?? "")).toBe("Kept")
    const drive = stored.get("drive") as {
      value: { accounts: Record<string, { contexts: Record<string, { id: string; name: string }> }> }
    }
    expect(drive.value.accounts[main.id(alpha)]?.contexts.ses_kept).toEqual({ id: context, name: "Kept" })
    await until(() => main.timers.pending().length > 0)
    expect(main.timers.pending()).toEqual([5 * 60_000])
    main.cleanups.forEach((cleanup) => cleanup())
    expect(main.timers.pending()).toEqual([])
  })
})
