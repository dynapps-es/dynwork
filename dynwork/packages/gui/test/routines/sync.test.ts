import { afterAll, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { OpenCode } from "@opencode/client/promise"
import type { MainContext, Persisted } from "@opencode/plugin/gui/main"
import { isFailure, type Definition } from "../../src/routines/contract"
import { RoutinesMain } from "../../src/routines/main"
import { RoutinesLocal } from "../../src/routines/local/backend"
import { RoutinesClock } from "../../src/routines/local/clock"
import { RoutinesSync } from "../../src/routines/local/sync"
import { clock, MINUTE, storage } from "./fixture"
import { fakeGovernance, type FakeGovernance } from "./governance"
import { fakeService, until } from "./service"

const home = await mkdtemp(path.join(tmpdir(), "routines-sync-"))
const stops: Array<() => void> = []
afterAll(() => stops.forEach((stop) => stop()))

type Store = Persisted<RoutinesLocal.Saved, RoutinesLocal.Saved>

const governance = (now?: () => number) => {
  const made = fakeGovernance(now)
  stops.push(made.stop)
  return made
}

const peer = (digit: string) => digit.repeat(32)

// One computer: its local backend and its sync over its own store, with timers the test never fires. `client` is the
// service, for the tests that run routines.
function computer(
  gov: FakeGovernance,
  name: string,
  input: {
    store?: Store
    id?: string
    now?: () => number
    client?: ReturnType<typeof OpenCode.make>
    /** The active account; one fixed account on `gov` by default. */
    account?: () => RoutinesSync.Account | undefined
  } = {},
) {
  const account = input.account ?? (() => ({ id: "account", url: gov.url, token: async () => gov.token }))
  const store = input.store ?? storage(RoutinesLocal.Saved, RoutinesLocal.initial)
  const device = { id: input.id ?? peer(name === "Mac A" ? "a" : "b"), name }
  const armed: number[] = []
  const shared: { sync?: RoutinesSync.Sync } = {}
  const local = RoutinesLocal.make({
    label: name,
    store,
    client: () => input.client,
    server: "sidecar",
    home,
    now: input.now ?? Date.now,
    device: () => device,
    account: () => account()?.id,
    synced: () => shared.sync?.synced(),
    queued: () => void shared.sync?.sync(),
  })
  const sync = RoutinesSync.make({
    store,
    local,
    account,
    device: () => device,
    now: input.now ?? Date.now,
    timers: { set: (_, ms) => (armed.push(ms), () => {}) },
  })
  shared.sync = sync
  stops.push(local.dispose, sync.dispose)
  return {
    store,
    local,
    sync,
    device,
    armed,
    close: () => {
      sync.dispose()
      local.dispose()
    },
  }
}

const routine = (name: string, extra: Partial<Definition> = {}): Definition => ({
  name,
  instructions: { kind: "prompt", text: "Summarise." },
  enabled: true,
  options: { permissions: "ask" },
  ...extra,
})

async function create(local: RoutinesLocal.Local, definition: Definition) {
  const made = await local.create(definition)
  if (isFailure(made)) throw new Error(made.message)
  return made.ref.id
}

async function read(local: RoutinesLocal.Local, id: string) {
  const found = await local.get(id)
  if (isFailure(found)) throw new Error(found.message)
  return found
}

const names = async (local: RoutinesLocal.Local) => {
  const list = await local.list()
  if (isFailure(list)) throw new Error(list.message)
  return list.map((item) => item.definition.name).toSorted()
}

describe("the routines sync", () => {
  test("two computers converge after edits on each", async () => {
    const gov = governance()
    const a = computer(gov, "Mac A")
    const b = computer(gov, "Mac B")
    const first = await create(a.local, routine("Digest"))
    await a.sync.sync()
    await b.sync.sync()
    expect((await read(b.local, first)).owner).toEqual({ label: "Mac A", online: false, here: false })
    expect((await read(a.local, first)).owner?.here).toBe(true)

    await b.local.update(first, routine("Digest v2"))
    const second = await create(b.local, routine("Inbox"))
    await b.sync.sync()
    await a.sync.sync()
    await a.local.pause(second)
    await a.sync.sync()
    await b.sync.sync()

    expect(await names(a.local)).toEqual(["Digest v2", "Inbox"])
    expect(await names(b.local)).toEqual(["Digest v2", "Inbox"])
    expect((await read(b.local, second)).state).toBe("paused")
    // The edit kept the owner: Mac A still runs the first, Mac B the second.
    expect([(await read(a.local, first)).owner?.here, (await read(a.local, second)).owner?.here]).toEqual([true, false])
    const revisions = (store: Store) => store.value.routines.map((stored) => [stored.id, stored.revision]).toSorted()
    expect(revisions(a.store)).toEqual(revisions(b.store))
    expect([a.store.value.outbox, b.store.value.outbox]).toEqual([[], []])
    expect([a.sync.synced(), b.sync.synced()]).toEqual([true, true])
  })

  test("the outbox survives a restart and flushes in order", async () => {
    const gov = governance()
    const a = computer(gov, "Mac A")
    const first = await create(a.local, routine("Digest"))
    await a.sync.sync()
    gov.state.down = true
    await a.local.update(first, routine("Digest v2"))
    const second = await create(a.local, routine("Inbox"))
    await a.local.update(first, routine("Digest v3"))
    await a.sync.sync()
    a.close()
    expect(a.store.value.outbox?.map((op) => `${op.kind} ${op.routine === first ? "first" : "second"}`)).toEqual([
      "put first",
      "put second",
      "put first",
    ])

    gov.state.down = false
    gov.state.requests.length = 0
    const again = computer(gov, "Mac A", { store: a.store })
    await again.sync.sync()
    // The first entry is covered by the later edit of the same routine: one write each, in the order they were made.
    expect(gov.state.requests.filter((request) => !request.startsWith("GET"))).toEqual([
      `PUT /routines/${second} -`,
      `PUT /routines/${first} 1`,
    ])
    expect((gov.state.routines.get(first)?.definition as Definition).name).toBe("Digest v3")
    expect(again.store.value.outbox).toEqual([])
  })

  test("a 409 keeps the server's row and flags it; a lost answer is taken quietly", async () => {
    const gov = governance()
    const a = computer(gov, "Mac A")
    const b = computer(gov, "Mac B")
    const id = await create(a.local, routine("Digest"))
    await a.sync.sync()
    await b.sync.sync()
    await b.local.update(id, routine("Edited on B"))
    await b.sync.sync()
    // Mac A edits before it read Mac B's change: Governance refuses its revision.
    await a.local.update(id, routine("Edited on A"))
    await a.sync.sync()
    const kept = await read(a.local, id)
    expect(kept.definition.name).toBe("Edited on B")
    expect(kept.conflict).toBeNumber()
    expect((gov.state.routines.get(id)?.definition as Definition).name).toBe("Edited on B")
    expect(a.store.value.outbox).toEqual([])
    // The next edit here clears the note.
    await a.local.update(id, routine("Edited on A again"))
    await a.sync.sync()
    expect((await read(a.local, id)).conflict).toBeUndefined()
    expect((gov.state.routines.get(id)?.definition as Definition).name).toBe("Edited on A again")

    // Governance takes the create but its answer is lost: the outbox sends it again, and the 409 that answers holds
    // what was sent.
    gov.state.lose = true
    const lost = await create(a.local, routine("Lost answer"))
    await a.sync.sync()
    expect(gov.state.requests.filter((request) => request === `PUT /routines/${lost} -`)).toHaveLength(2)
    expect(a.sync.synced()).toBe(true)
    expect((await read(a.local, lost)).conflict).toBeUndefined()
    expect(a.store.value.routines.find((stored) => stored.id === lost)?.revision).toBe(1)
  })

  test("a tombstone removes the routine and its runs; a removal here reaches the other computer", async () => {
    const gov = governance()
    const a = computer(gov, "Mac A")
    const b = computer(gov, "Mac B")
    const first = await create(a.local, routine("Digest"))
    const second = await create(a.local, routine("Inbox"))
    await a.sync.sync()
    a.local.take(first, { due: Date.now(), records: [{ due: Date.now(), state: "missed", reason: "closed" }] })
    await b.sync.sync()
    expect(await names(b.local)).toEqual(["Digest", "Inbox"])

    expect(await a.local.remove(first)).toBeUndefined()
    await a.sync.sync()
    expect(gov.state.routines.get(first)?.deleted).toBe(true)
    // The "My routines" page deletes without If-Match.
    gov.remove(second)
    await b.sync.sync()
    await a.sync.sync()
    expect(await names(b.local)).toEqual([])
    expect(await names(a.local)).toEqual([])
    expect(a.store.value.runs).toEqual([])
  })

  test("a hint triggers a fetch at once: main's pull", async () => {
    const gov = governance()
    const other = computer(gov, "Mac B")
    const stored = new Map<string, unknown>()
    const cleanups: Array<() => void> = []
    const ctx = {
      provide: () => ({ changed: () => {}, emit: () => {} }),
      onCleanup: (cleanup: () => void) => void cleanups.push(cleanup),
      storage: {
        store: (key: string, options: { schema: never; initial: unknown }) => {
          if (!stored.has(key)) stored.set(key, storage(options.schema, options.initial as never))
          return stored.get(key)
        },
      },
      serverEndpoints: { get: () => undefined },
      windows: { focused: () => undefined, list: () => [] },
    }
    // SAFETY: the routines' setup reads only `provide`, `onCleanup`, `storage`, `serverEndpoints` and `windows`.
    const main = RoutinesMain.setup(ctx as unknown as MainContext, {
      label: "Mac A",
      sync: {
        account: () => ({ id: "account", url: gov.url, token: async () => gov.token }),
        device: () => ({ id: peer("a"), name: "Mac A" }),
      },
    })
    stops.push(() => cleanups.forEach((cleanup) => cleanup()))
    const local = main.registry.get("local") as RoutinesLocal.Local
    await until(() => gov.state.requests.length > 0)
    await create(other.local, routine("From B"))
    await other.sync.sync()
    await Bun.sleep(30)
    expect(await names(local)).toEqual([])
    main.pull()
    const deadline = Date.now() + 3_000
    while ((await names(local)).length === 0 && Date.now() < deadline) await Bun.sleep(5)
    expect(await names(local)).toEqual(["From B"])
  })

  test("only the owner fires a schedule, and Run now is refused elsewhere", async () => {
    const time = clock(Date.UTC(2026, 10, 16, 8, 59))
    // Governance's clock is the test's: Mac B's copy changed before 09:00 too, so only ownership keeps it from firing.
    const gov = governance(time.now)
    const service = () => {
      const made = fakeService({ now: time.now })
      stops.push(made.stop)
      return { made, client: OpenCode.make({ baseUrl: made.url, headers: { authorization: "Basic c2VjcmV0" } }) }
    }
    const serviceA = service()
    const serviceB = service()
    const a = computer(gov, "Mac A", { now: time.now, client: serviceA.client })
    const b = computer(gov, "Mac B", { now: time.now, client: serviceB.client })
    const id = await create(a.local, routine("Daily", { schedule: { cron: "0 9 * * *", timezone: "UTC" } }))
    await a.sync.sync()
    await b.sync.sync()
    expect([a.local.here(id), b.local.here(id)]).toEqual([true, false])
    const never: RoutinesClock.Timers = { set: () => () => {} }
    const clocks = [a, b].map((each) =>
      RoutinesClock.make({ local: each.local, store: each.store, now: time.now, ready: () => true, timers: never }),
    )
    stops.push(...clocks.map((each) => each.dispose))
    time.advance(2 * MINUTE)
    await Promise.all(clocks.map((each) => each.check()))
    // A look the routine's change started may still be starting the run.
    await until(() => serviceA.made.prompts().length > 0)
    await Promise.all(clocks.map((each) => each.check()))
    expect([serviceA.made.prompts().length, serviceB.made.prompts().length]).toEqual([1, 0])
    const refused = await b.local.start(id)
    expect(isFailure(refused) && [refused.code, refused.message]).toEqual(["conflict", "It runs on Mac A."])
    // The owner reports the run; a run summary never comes from the other computer.
    await until(() => gov.state.runs.size > 0)
    await a.sync.sync()
    expect([...gov.state.runs.values()].map((run) => [run.routine_id, run.device])).toEqual([[id, peer("a")]])
  })

  test("move to this computer: the owner changes with the same If-Match write", async () => {
    const gov = governance()
    const a = computer(gov, "Mac A")
    const b = computer(gov, "Mac B")
    const id = await create(a.local, routine("Digest"))
    await a.sync.sync()
    await b.sync.sync()
    expect(await b.local.move(id)).toBeUndefined()
    await b.sync.sync()
    await a.sync.sync()
    expect(gov.state.routines.get(id)).toMatchObject({ owner_device: peer("b"), owner_name: "Mac B", revision: 2 })
    expect(gov.state.requests).toContain(`PUT /routines/${id} 1`)
    expect([a.local.here(id), b.local.here(id)]).toEqual([false, true])
    expect((await read(a.local, id)).owner).toEqual({ label: "Mac B", online: false, here: false })
    // Run summaries now go only from Mac B.
    a.local.take(id, { due: Date.now(), records: [{ due: Date.now(), state: "missed", reason: "closed" }] })
    b.local.take(id, { due: Date.now(), records: [{ due: Date.now(), state: "skipped", reason: "overlap" }] })
    await a.sync.sync()
    await b.sync.sync()
    expect([...gov.state.runs.values()].map((run) => [run.state, run.device])).toEqual([["skipped", peer("b")]])
  })

  test("first sync uploads the routines Governance does not have, owned by this computer", async () => {
    const gov = governance()
    const store = storage(RoutinesLocal.Saved, RoutinesLocal.initial)
    // Made before the sync existed: no owner, no revision, no outbox.
    const before = RoutinesLocal.make({ label: "Mac A", store, client: () => undefined, server: "sidecar", home, now: Date.now })
    const id = await create(before, routine("Legacy"))
    before.dispose()
    store.update((draft) => void delete draft.outbox)
    const a = computer(gov, "Mac A", { store })
    await a.sync.sync()
    expect(gov.state.routines.get(id)).toMatchObject({ owner_device: peer("a"), owner_name: "Mac A", revision: 1 })
    expect(a.store.value.routines[0]).toMatchObject({ revision: 1, owner: { device: peer("a"), name: "Mac A" } })
  })

  test("switching the account keeps each account's routines apart, and switching back restores them", async () => {
    const time = clock(Date.UTC(2026, 10, 16, 8, 50))
    const govs = { A: governance(time.now), B: governance(time.now) }
    const active = { id: "A" as "A" | "B" }
    const made = fakeService({ now: time.now })
    stops.push(made.stop)
    const a = computer(govs.A, "Mac A", {
      now: time.now,
      client: OpenCode.make({ baseUrl: made.url, headers: { authorization: "Basic c2VjcmV0" } }),
      account: () => ({ id: active.id, url: govs[active.id].url, token: async () => govs[active.id].token }),
    })
    const engine = RoutinesClock.make({
      local: a.local,
      store: a.store,
      now: time.now,
      ready: () => true,
      timers: { set: () => () => {} },
    })
    stops.push(engine.dispose)
    const daily = await create(a.local, routine("A daily", { schedule: { cron: "0 9 * * *", timezone: "UTC" } }))
    await a.sync.sync()
    // Account A's change made while its Governance does not answer waits in the outbox.
    govs.A.state.down = true
    const waiting = await create(a.local, routine("A offline"))
    await a.sync.sync()

    active.id = "B"
    await a.sync.sync()
    const own = await create(a.local, routine("B routine"))
    await a.sync.sync()
    expect(await names(a.local)).toEqual(["B routine"])
    expect([...govs.B.state.routines.keys()]).toEqual([own])
    expect(govs.B.state.requests.filter((request) => request.includes(daily) || request.includes(waiting))).toEqual([])
    expect(a.local.here(daily)).toBe(false)
    time.advance(11 * MINUTE)
    await engine.check()
    await Bun.sleep(20)
    expect(made.prompts()).toEqual([])

    active.id = "A"
    govs.A.state.down = false
    await a.sync.sync()
    expect(await names(a.local)).toEqual(["A daily", "A offline"])
    expect([...govs.A.state.routines.keys()].toSorted()).toEqual([daily, waiting].toSorted())
    expect(a.store.value.routines.map((stored) => [stored.definition.name, stored.account]).toSorted()).toEqual([
      ["A daily", "A"],
      ["A offline", "A"],
      ["B routine", "B"],
    ])
    expect(a.store.value.outbox).toEqual([])
    // Back on A within the grace: its 09:00 fires now, once.
    await engine.check()
    await until(() => made.prompts().length > 0)
    expect(made.prompts()).toHaveLength(1)
  })

  test("offline edits are kept, said Not synced, retried sooner, and flushed when Governance is back", async () => {
    const gov = governance()
    const a = computer(gov, "Mac A")
    gov.state.down = true
    const id = await create(a.local, routine("Digest"))
    await a.local.update(id, routine("Digest offline"))
    await a.sync.sync()
    expect(a.sync.synced()).toBe(false)
    expect((await a.local.capabilities()).synced).toBe(false)
    expect(a.armed.at(-1)).toBe(RoutinesSync.RETRY)
    expect(await names(a.local)).toEqual(["Digest offline"])

    gov.state.down = false
    await a.sync.sync()
    expect(a.sync.synced()).toBe(true)
    expect((await a.local.capabilities()).synced).toBe(true)
    expect(a.armed.at(-1)).toBe(RoutinesSync.POLL)
    expect((gov.state.routines.get(id)?.definition as Definition).name).toBe("Digest offline")
    expect(a.store.value.outbox).toEqual([])
  })
})

// A task made for a user straight in Governance's table comes unclaimed (owner `""`, or null) and the first of the
// user's computers to sync claims it with the usual `If-Match` write.
describe("a task made for the user in Governance", () => {
  const daily = (name: string) => routine(name, { schedule: { cron: "0 9 * * *", timezone: "UTC" } })
  const service = (now: () => number) => {
    const made = fakeService({ now })
    stops.push(made.stop)
    return { made, client: OpenCode.make({ baseUrl: made.url, headers: { authorization: "Basic c2VjcmV0" } }) }
  }
  const engine = (each: ReturnType<typeof computer>, now: () => number) => {
    const made = RoutinesClock.make({
      local: each.local,
      store: each.store,
      now,
      ready: () => true,
      timers: { set: () => () => {} },
    })
    stops.push(made.dispose)
    return made
  }
  const puts = (gov: FakeGovernance) => gov.state.requests.filter((request) => request.startsWith("PUT /routines/"))

  test("is claimed by this computer and then runs here; before the claim it runs nowhere", async () => {
    const time = clock(Date.UTC(2026, 10, 16, 8, 50))
    const gov = governance(time.now)
    const host = service(time.now)
    const a = computer(gov, "Mac A", { now: time.now, client: host.client })
    const clockA = engine(a, time.now)
    const id = randomUUID()
    gov.assign(id, daily("Welcome"))

    // Governance does not take the claim yet: the task is listed as not claimed, and nothing runs it.
    gov.state.readOnly = true
    await a.sync.sync()
    expect((await read(a.local, id)).owner).toEqual({ label: "", online: false, here: false, unclaimed: true })
    expect(a.local.here(id)).toBe(false)
    const refused = await a.local.start(id)
    expect(isFailure(refused) && [refused.code, refused.message]).toEqual([
      "conflict",
      "No computer has claimed it yet.",
    ])
    time.advance(11 * MINUTE)
    await clockA.check()
    await Bun.sleep(20)
    expect(host.made.prompts()).toEqual([])

    gov.state.readOnly = false
    await a.sync.sync()
    expect(puts(gov)).toEqual([`PUT /routines/${id} 1`])
    expect(gov.state.routines.get(id)).toMatchObject({ owner_device: peer("a"), owner_name: "Mac A", revision: 2 })
    expect(a.store.value.routines).toMatchObject([{ id, revision: 2, owner: { device: peer("a"), name: "Mac A" } }])
    expect((await read(a.local, id)).owner).toEqual({ label: "Mac A", online: true, here: true })
    expect((await read(a.local, id)).conflict).toBeUndefined()
    // Claimed within the grace: its 09:00 runs here, once.
    await clockA.check()
    await until(() => host.made.prompts().length > 0)
    expect(host.made.prompts()).toHaveLength(1)
  })

  test("two computers of the user race to claim it: one wins, the other takes its row on a 409 and never runs it", async () => {
    const time = clock(Date.UTC(2026, 10, 16, 8, 50))
    const gov = governance(time.now)
    const hosts = { A: service(time.now), B: service(time.now) }
    const a = computer(gov, "Mac A", { now: time.now, client: hosts.A.client })
    const b = computer(gov, "Mac B", { now: time.now, client: hosts.B.client })
    const clocks = [engine(a, time.now), engine(b, time.now)]
    const id = randomUUID()
    gov.assign(id, daily("Welcome"))
    // Both read it unclaimed before either claim lands.
    gov.state.readOnly = true
    await a.sync.sync()
    await b.sync.sync()
    expect([a.store.value.outbox?.length, b.store.value.outbox?.length]).toEqual([1, 1])

    gov.state.readOnly = false
    await a.sync.sync()
    await b.sync.sync()
    // The same If-Match from both: Mac A's is taken, Mac B's is a 409.
    expect(puts(gov)).toEqual([`PUT /routines/${id} 1`, `PUT /routines/${id} 1`])
    expect(gov.state.routines.get(id)).toMatchObject({ owner_device: peer("a"), owner_name: "Mac A", revision: 2 })
    expect([a.local.here(id), b.local.here(id)]).toEqual([true, false])
    const lost = await read(b.local, id)
    expect([lost.owner, lost.conflict]).toEqual([{ label: "Mac A", online: false, here: false }, undefined])
    expect(b.store.value.routines).toMatchObject([{ id, revision: 2, owner: { device: peer("a"), name: "Mac A" } }])
    expect([a.store.value.outbox, b.store.value.outbox]).toEqual([[], []])

    time.advance(11 * MINUTE)
    await Promise.all(clocks.map((each) => each.check()))
    await until(() => hosts.A.made.prompts().length > 0)
    await Promise.all(clocks.map((each) => each.check()))
    expect([hosts.A.made.prompts().length, hosts.B.made.prompts().length]).toEqual([1, 0])
  })

  test("a task another computer claimed is never claimed again, and an edit keeps its owner", async () => {
    const gov = governance()
    const a = computer(gov, "Mac A")
    const id = randomUUID()
    gov.assign(id, routine("Welcome"))
    await a.sync.sync()
    // Mac B first reads it once Mac A owns it.
    const b = computer(gov, "Mac B")
    await b.sync.sync()
    await a.sync.sync()
    await b.sync.sync()
    expect(puts(gov)).toEqual([`PUT /routines/${id} 1`])
    expect((await read(b.local, id)).owner).toEqual({ label: "Mac A", online: false, here: false })

    await b.local.update(id, routine("Welcome v2"))
    await b.sync.sync()
    expect(puts(gov)).toEqual([`PUT /routines/${id} 1`, `PUT /routines/${id} 2`])
    expect(gov.state.routines.get(id)).toMatchObject({ owner_device: peer("a"), owner_name: "Mac A", revision: 3 })
    expect([a.local.here(id), b.local.here(id)]).toEqual([true, false])
  })

  test("an unclaimed task of another account is left alone", async () => {
    const govs = { A: governance(), B: governance() }
    const active = { id: "A" as "A" | "B" }
    const a = computer(govs.A, "Mac A", {
      account: () => ({ id: active.id, url: govs[active.id].url, token: async () => govs[active.id].token }),
    })
    const id = randomUUID()
    // A Governance whose column became nullable says null: it is unclaimed all the same.
    govs.A.assign(id, routine("For A"), null)
    // Read under account A; its claim waits for A's Governance.
    govs.A.state.readOnly = true
    await a.sync.sync()

    active.id = "B"
    await a.sync.sync()
    await a.sync.sync()
    expect(await names(a.local)).toEqual([])
    expect(a.local.here(id)).toBe(false)
    expect(govs.B.state.requests.filter((request) => request.includes(id))).toEqual([])
    expect(govs.A.state.routines.get(id)).toMatchObject({ owner_device: null, owner_name: null, revision: 1 })
    expect(a.store.value.routines).toMatchObject([{ id, account: "A", owner: null }])
    expect(a.store.value.outbox?.map((op) => [op.kind, op.routine, op.account])).toEqual([["put", id, "A"]])

    // Back on A, this computer claims it there.
    active.id = "A"
    govs.A.state.readOnly = false
    await a.sync.sync()
    expect(govs.A.state.routines.get(id)).toMatchObject({ owner_device: peer("a"), revision: 2 })
    expect(a.local.here(id)).toBe(true)
  })
})
