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

describe("signing in again", () => {
  test("runs the browser sign-in for the account's instance, once at a time, and keeps how it ended", async () => {
    const release = Promise.withResolvers<"signed-in" | "denied">()
    const calls: string[] = []
    const reconnect = AccountsController.reconnect({
      client: () => ({
        signInBrowser: async (input: { url: string; keep?: boolean }) => {
          calls.push(JSON.stringify(input))
          return release.promise
        },
        cancel: async () => {
          calls.push("cancel")
        },
      }),
    })
    const first = reconnect.run({ url: "https://sp.dynapps.test" })
    expect(reconnect.state.running).toBe(true)
    await reconnect.run({ url: "https://sp.dynapps.test" })
    reconnect.cancel()
    release.resolve("denied")
    await first
    // No `keep`: main signs the account in again as it was, kept or not.
    expect(calls).toEqual(['{"url":"https://sp.dynapps.test"}', "cancel"])
    expect(reconnect.state).toEqual({ running: false, outcome: "denied" })
  })

  test("without the Ipc client, or when the call rejects, it ends as failed", async () => {
    const gone = AccountsController.reconnect({ client: () => undefined })
    await gone.run({ url: "https://sp.dynapps.test" })
    expect(gone.state.outcome).toBe("failed")
    const broken = AccountsController.reconnect({
      client: () => ({
        signInBrowser: async () => {
          throw new Error("rejected")
        },
        cancel: async () => {},
      }),
    })
    await broken.run({ url: "https://sp.dynapps.test" })
    expect(broken.state).toEqual({ running: false, outcome: "failed" })
  })
})

describe("acting as the person", () => {
  test("signs in once at a time, records how it ended, cancels and signs out", async () => {
    const calls: string[] = []
    const release = Promise.withResolvers<"denied">()
    const person = AccountsController.person({
      client: () => ({
        personSignIn: async (id: string) => {
          calls.push(`signIn:${id}`)
          return release.promise
        },
        personSignOut: async (id: string) => {
          calls.push(`signOut:${id}`)
        },
        personCancel: async () => {
          calls.push("cancel")
        },
      }),
    })
    const first = person.signIn("alpha")
    expect(person.state.running).toBe(true)
    await person.signIn("alpha")
    person.cancel()
    release.resolve("denied")
    await first
    expect(person.state).toEqual({ running: false, outcome: "denied", failed: false })
    await person.signOut("alpha")
    expect(calls).toEqual(["signIn:alpha", "cancel", "signOut:alpha"])
    expect(person.state).toEqual({ running: false, outcome: undefined, failed: false })
  })

  test("without the client, or when a call rejects, it says it failed", async () => {
    const gone = AccountsController.person({ client: () => undefined })
    await gone.signIn("alpha")
    expect(gone.state.outcome).toBe("failed")
    await gone.signOut("alpha")
    expect(gone.state.failed).toBe(true)
    const broken = AccountsController.person({
      client: () => ({
        personSignIn: async () => {
          throw new Error("rejected")
        },
        personSignOut: async () => {
          throw new Error("rejected")
        },
        personCancel: async () => {},
      }),
    })
    await broken.signIn("alpha")
    expect(broken.state.outcome).toBe("failed")
    await broken.signOut("alpha")
    expect(broken.state.failed).toBe(true)
  })
})
