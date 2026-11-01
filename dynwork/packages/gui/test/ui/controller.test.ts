import { describe, expect, test } from "bun:test"
import { AccountsController } from "../../src/accounts/ui/controller"
import { AccountsModel } from "../../src/accounts/ui/model"
import { account, fingerprints, state } from "./fixture"

// A client that records its calls and rejects the ones named in `reject`.
function fakeClient(reject: string[] = []) {
  const calls: string[] = []
  const call = (name: string) => async (input?: unknown) => {
    calls.push(input === undefined ? name : `${name}:${typeof input === "string" ? input : JSON.stringify(input)}`)
    if (reject.includes(name)) throw new Error("rejected")
  }

  return {
    calls,
    client: {
      activate: call("activate"),
      signOut: call("signOut"),
      remove: call("remove"),
      trust: call("trust"),
      syncNow: call("syncNow"),
    },
  }
}

const rowOf = (...overrides: Parameters<typeof account>) => {
  const row = AccountsModel.rows(state([account(...overrides)]))[0]
  if (!row) throw new Error("no row")
  return row
}

describe("the page's actions", () => {
  test("make active and sync now call main", async () => {
    const fake = fakeClient()
    const controller = AccountsController.create({ client: () => fake.client, confirm: async () => true })
    await controller.run("make-active", rowOf())
    await controller.run("sync-now", rowOf({ active: true }))
    expect(fake.calls).toEqual(["activate:alpha", "syncNow"])
    expect(controller.state.failed).toBeUndefined()
    expect(controller.state.pending).toBeUndefined()
  })

  test("trust pins the fingerprint the page showed, not whatever is offered by then", async () => {
    const fake = fakeClient()
    const controller = AccountsController.create({ client: () => fake.client, confirm: async () => true })
    await controller.run("trust", rowOf({ trusted: false, fingerprint: fingerprints.offered }))
    expect(fake.calls).toEqual([`trust:{"id":"alpha","fingerprint":"${fingerprints.offered}"}`])
  })

  test("signing out and removing ask first, and a no changes nothing", async () => {
    const fake = fakeClient()
    const asked: string[] = []
    const answer = { value: false }
    const controller = AccountsController.create({
      client: () => fake.client,
      confirm: async (question, target) => {
        asked.push(`${question}:${target.id}`)
        return answer.value
      },
    })
    await controller.run("sign-out", rowOf())
    await controller.run("remove", rowOf())
    expect(fake.calls).toEqual([])
    answer.value = true
    await controller.run("sign-out", rowOf())
    await controller.run("remove", rowOf())
    expect(asked).toEqual(["sign-out:alpha", "remove:alpha", "sign-out:alpha", "remove:alpha"])
    expect(fake.calls).toEqual(["signOut:alpha", "remove:alpha"])
    expect(controller.state.failed).toBeUndefined()
  })

  test("a call that fails marks the account, and the next action that works clears it", async () => {
    const fake = fakeClient(["activate"])
    const controller = AccountsController.create({ client: () => fake.client, confirm: async () => true })
    await controller.run("make-active", rowOf())
    expect(controller.state.failed).toEqual({ id: "alpha", action: "make-active" })
    expect(controller.state.pending).toBeUndefined()
    await controller.run("sync-now", rowOf({ active: true }))
    expect(controller.state.failed).toBeUndefined()
  })

  test("without the Ipc client the action fails instead of waiting", async () => {
    const controller = AccountsController.create({ client: () => undefined, confirm: async () => true })
    await controller.run("sync-now", rowOf({ active: true }))
    expect(controller.state.failed).toEqual({ id: "alpha", action: "sync-now" })
  })

  test("one action at a time", async () => {
    const release = Promise.withResolvers<void>()
    const calls: string[] = []
    const controller = AccountsController.create({
      client: () => ({
        activate: async (id: string) => {
          calls.push(id)
          await release.promise
        },
        signOut: async () => {},
        remove: async () => {},
        trust: async () => {},
        syncNow: async () => {},
      }),
      confirm: async () => true,
    })
    const first = controller.run("make-active", rowOf())
    expect(controller.state.pending).toEqual({ id: "alpha", action: "make-active" })
    await controller.run("make-active", rowOf({ id: "beta" }))
    release.resolve()
    await first
    expect(calls).toEqual(["alpha"])
    expect(controller.state.pending).toBeUndefined()
  })
})

describe("the pill's menu", () => {
  function menu(reject = false) {
    const log: string[] = []
    const failure = Promise.withResolvers<void>()
    const actions = AccountsController.menu({
      client: () => ({
        activate: async (id: string) => {
          log.push(`activate:${id}`)
          if (reject) throw new Error("rejected")
        },
        syncNow: async () => {
          log.push("syncNow")
          if (reject) throw new Error("rejected")
        },
      }),
      settings: (page) => log.push(`settings:${page}`),
      failed: () => {
        log.push("failed")
        failure.resolve()
      },
      close: () => log.push("close"),
    })
    return { log, actions, failure: failure.promise }
  }

  test("each action closes the menu first", () => {
    const { log, actions } = menu()
    actions.switchTo("beta")
    actions.syncNow()
    actions.manage()
    expect(log).toEqual(["close", "activate:beta", "close", "syncNow", "close", "settings:accounts"])
  })

  test("a call that fails tells the user", async () => {
    const { log, actions, failure } = menu(true)
    actions.switchTo("beta")
    await failure
    expect(log).toEqual(["close", "activate:beta", "failed"])
  })
})
