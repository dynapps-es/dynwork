import { describe, expect, test } from "bun:test"
import { RoutinesBackend, type Backend, type Registry } from "../../src/routines/backend"
import { isFailure, type Routine } from "../../src/routines/contract"
import { RoutinesDemo } from "../../src/routines/demo"
import { RoutinesFake } from "../../src/routines/fake"
import { expectFailure, sample } from "./conformance"
import { clock, flush, MINUTE } from "./fixture"
import { connect } from "./wire"

// A registry with both demo backends, and a window's client over it.
function setup() {
  const time = clock()
  const registry = RoutinesBackend.make()
  const local = RoutinesDemo.local(time.now)
  const farm = RoutinesDemo.remote(time.now)
  registry.register(local)
  registry.register(farm)
  return { time, registry, local, farm, ...connect(registry) }
}

// Counts the subscriptions a backend holds open.
function counted<B extends Backend>(backend: B) {
  const open = { count: 0, total: 0 }
  const watch: Backend["watch"] = (changed) => {
    open.count++
    open.total++
    const stop = backend.watch(changed)
    return () => {
      open.count--
      stop()
    }
  }
  return { backend: { ...backend, watch }, open }
}

type Client = ReturnType<typeof connect>["client"]

const routinesIn = (client: Client) => client.state()?.routines ?? []

describe("the Ipc state", () => {
  test("holds every backend and its routines once read, and a read pushes it", async () => {
    const { client, pushes } = setup()
    await client.refresh()
    const state = client.state()
    expect(state?.backends.map((backend) => backend.backend)).toEqual(["local", "farm"])
    expect(state?.routines).toHaveLength(8)
    expect(new Set(state?.routines.map((routine) => routine.ref.backend))).toEqual(new Set(["local", "farm"]))
    expect(pushes.count).toBeGreaterThan(0)
  })

  test("a backend that is signed out stays in the state, saying so", async () => {
    const { client, farm } = setup()
    await client.refresh()
    farm.setStatus("signed-out", "Sign in to the farm.")
    await client.refresh()
    expect(client.state()?.backends.find((backend) => backend.backend === "farm")).toMatchObject({
      status: "signed-out",
    })
    // Its last answer stays: a window does not blank the list because a token expired.
    expect(routinesIn(client).filter((routine) => routine.ref.backend === "farm")).toHaveLength(4)
  })

  test("a backend that registers or leaves later changes it, with a push", async () => {
    const { client, registry, time, pushes } = setup()
    await client.refresh()
    const extra = RoutinesFake.make({
      id: "extra",
      capabilities: await RoutinesDemo.local(time.now).capabilities(),
      conversation: "session",
      now: time.now,
    })
    const remove = registry.register(extra)
    await flush()
    expect(client.state()?.backends.map((backend) => backend.backend)).toContain("extra")
    const before = pushes.count
    remove()
    await flush()
    expect(client.state()?.backends.map((backend) => backend.backend)).not.toContain("extra")
    expect(pushes.count).toBeGreaterThan(before)
  })
})

describe("the Ipc methods", () => {
  test("go to the backend they name, and answer as it does", async () => {
    const { client } = setup()
    const list = await client.list({ backend: "local" })
    if (isFailure(list)) throw new Error(list.message)
    expect(list.map((routine) => routine.ref.backend)).toEqual(["local", "local", "local", "local"])
    expect(await client.get({ backend: "local", id: list[0]?.ref.id ?? "" })).toEqual(list[0])
    expectFailure(await client.get({ backend: "local", id: "nope" }), "not-found")
    const lookup = await client.options({ backend: "farm", lookup: "plugins" })
    expect(isFailure(lookup) ? [] : lookup.length).toBeGreaterThan(0)
  })

  test("templates and activate go to the backend they name; one without templates answers unsupported", async () => {
    const { client, registry, time } = setup()
    await client.refresh()
    const answer = await client.templates({ backend: "local" })
    if (isFailure(answer)) throw new Error(answer.message)
    const optional = answer.templates.find((template) => !template.mandatory)
    const created = await client.activate({
      backend: "local",
      template: optional?.id ?? "",
      personal: { timezone: "Europe/Madrid", folder: "/work" },
    })
    if (isFailure(created)) throw new Error(created.message)
    expect(routinesIn(client).find((routine) => routine.ref.id === created.ref.id)?.template?.id).toBe(optional?.id)
    expectFailure(await client.templates({ backend: "farm" }), "unsupported")
    expectFailure(await client.templates({ backend: "nowhere" }), "not-found")
    const { templates: _, activate: __, ...bare } = RoutinesDemo.local(time.now)
    registry.register(bare)
    expectFailure(await client.templates({ backend: "local" }), "unsupported")
    expectFailure(
      await client.activate({ backend: "local", template: "x", personal: { timezone: "UTC" } }),
      "unsupported",
    )
  })

  test("a template's change is answered on the backend it names; one without templates answers unsupported", async () => {
    const { client, registry, time } = setup()
    await client.refresh()
    expectFailure(await client.answer({ backend: "local", id: "no-such-task", apply: false }), "not-found")
    const { answer: _, ...bare } = RoutinesDemo.local(time.now)
    registry.register(bare)
    expectFailure(await client.answer({ backend: "local", id: "no-such-task", apply: true }), "unsupported")
  })

  test("create, update, pause, resume and remove change the state before they answer, and push it", async () => {
    const { client, local, pushes } = setup()
    await client.refresh()
    const created = await client.create({ backend: "local", definition: await sample(local, "Ipc") })
    if (isFailure(created)) throw new Error(created.message)
    expect(routinesIn(client).map((routine) => routine.ref.id)).toContain(created.ref.id)

    const before = pushes.count
    const renamed = await client.update({
      backend: "local",
      id: created.ref.id,
      definition: { ...created.definition, name: "Renamed" },
    })
    expect(isFailure(renamed) ? "" : renamed.definition.name).toBe("Renamed")
    expect(pushes.count).toBeGreaterThan(before)
    expect(await client.pause({ backend: "local", id: created.ref.id })).toBeUndefined()
    expect(routinesIn(client).find((routine) => routine.ref.id === created.ref.id)?.state).toBe("paused")
    expect(await client.resume({ backend: "local", id: created.ref.id })).toBeUndefined()
    expect(routinesIn(client).find((routine) => routine.ref.id === created.ref.id)?.state).toBe("active")
    expect(await client.remove({ backend: "local", id: created.ref.id })).toBeUndefined()
    expect(routinesIn(client).map((routine) => routine.ref.id)).not.toContain(created.ref.id)
  })

  test("a farm update answers the new routine and the state drops the old one", async () => {
    const { client } = setup()
    await client.refresh()
    const old = routinesIn(client).find((routine) => routine.ref.backend === "farm") as Routine
    const updated = await client.update({
      backend: "farm",
      id: old.ref.id,
      definition: { ...old.definition, name: "New" },
    })
    if (isFailure(updated)) throw new Error(updated.message)
    const ids = routinesIn(client).map((routine) => routine.ref.id)
    expect(ids).toContain(updated.ref.id)
    expect(ids).not.toContain(old.ref.id)
  })

  test("start, runs, transcript, viewed and cancel work through the same names", async () => {
    const { client } = setup()
    await client.refresh()
    const routine = routinesIn(client).find(
      (item) => item.ref.backend === "farm" && item.definition.schedule,
    ) as Routine
    const run = await client.start({ backend: "farm", id: routine.ref.id })
    if (isFailure(run)) throw new Error(run.message)
    expect(routinesIn(client).find((item) => item.ref.id === routine.ref.id)?.last?.ref).toEqual(run.ref)
    const page = await client.runs({ backend: "farm", routine: routine.ref.id })
    expect(isFailure(page) ? undefined : page.items[0]?.ref).toEqual(run.ref)
    expect(await client.cancel({ backend: "farm", run: run.ref.id })).toBeUndefined()
    expectFailure(await client.cancel({ backend: "farm", run: run.ref.id }), "conflict")
    const transcript = await client.transcript({ backend: "farm", run: run.ref.id })
    expect(isFailure(transcript)).toBe(false)
    await client.viewed({ backend: "farm", run: run.ref.id })
  })

  test("validate answers a failure with its fields, or nothing", async () => {
    const { client, farm } = setup()
    const good = await sample(farm, "Valid")
    expect(await client.validate({ backend: "farm", definition: good })).toBeUndefined()
    const bad = await client.validate({ backend: "farm", definition: { ...good, name: "" } })
    expectFailure(bad, "invalid")
    expect(bad?.fields).toHaveProperty("name")
  })

  test.each([
    ["list", (c: Client) => c.list({ backend: "x" })],
    ["get", (c: Client) => c.get({ backend: "x", id: "1" })],
    ["start", (c: Client) => c.start({ backend: "x", id: "1" })],
    ["runs", (c: Client) => c.runs({ backend: "x" })],
    ["transcript", (c: Client) => c.transcript({ backend: "x", run: "1" })],
    ["options", (c: Client) => c.options({ backend: "x", lookup: "agents" })],
    ["remove", (c: Client) => c.remove({ backend: "x", id: "1" })],
    ["pause", (c: Client) => c.pause({ backend: "x", id: "1" })],
    ["cancel", (c: Client) => c.cancel({ backend: "x", run: "1" })],
    ["answer", (c: Client) => c.answer({ backend: "x", id: "1", apply: true })],
    [
      "validate",
      (c: Client) =>
        c.validate({
          backend: "x",
          definition: { name: "n", instructions: { kind: "prompt", text: "t" }, enabled: true, options: {} },
        }),
    ],
  ])("%s on a backend that is not registered answers not-found, not a rejection", async (_, call) => {
    const { client } = setup()
    expectFailure(await call(client), "not-found")
  })

  test("a backend that rejects answers failed, without its message", async () => {
    const registry = RoutinesBackend.make()
    const farm = RoutinesDemo.remote(clock().now)
    registry.register({
      ...farm,
      get: () => Promise.reject(new Error("token sp-live-secret rejected")),
      create: () => Promise.reject("not even an error"),
    })
    const { client } = connect(registry)
    const failure = await client.get({ backend: "farm", id: "1" })
    expectFailure(failure, "failed")
    expect(JSON.stringify(failure)).not.toContain("secret")
    expectFailure(await client.create({ backend: "farm", definition: await sample(farm, "X") }), "failed")
  })
})

describe("watching", () => {
  test("a run that changes while a window watches arrives as an event and as state", async () => {
    const { client, local, time, events } = setup()
    await client.refresh()
    const stop = new AbortController()
    const watching = client.watch({ signal: stop.signal })
    const routine = routinesIn(client).find((item) => item.ref.backend === "local") as Routine
    await local.start(routine.ref.id)
    await flush()
    expect(events.map((event) => event.state)).toEqual(["running"])
    expect(routinesIn(client).find((item) => item.ref.id === routine.ref.id)?.last?.state).toBe("running")

    time.advance(2 * MINUTE)
    local.settle()
    await flush()
    expect(events.map((event) => event.state)).toEqual(["running", "ok"])
    expect(routinesIn(client).find((item) => item.ref.id === routine.ref.id)?.last?.state).toBe("ok")
    stop.abort()
    await watching
  })

  test("nothing arrives while no window watches", async () => {
    const { client, local, events } = setup()
    await client.refresh()
    const routine = routinesIn(client).find((item) => item.ref.backend === "local") as Routine
    await local.start(routine.ref.id)
    await flush()
    expect(events).toEqual([])
  })

  test("windows share one subscription per backend, which ends with the last window", async () => {
    const time = clock()
    const registry = RoutinesBackend.make()
    const local = counted(RoutinesDemo.local(time.now))
    registry.register(local.backend)
    const { client } = connect(registry)
    const [one, two] = [new AbortController(), new AbortController()]
    const first = client.watch({ signal: one.signal })
    const second = client.watch({ signal: two.signal })
    await flush()
    expect(local.open).toEqual({ count: 1, total: 1 })
    one.abort()
    await first
    expect(local.open.count).toBe(1)
    two.abort()
    await second
    expect(local.open.count).toBe(0)
  })

  test("a call that is already aborted resolves and subscribes to nothing", async () => {
    const registry = RoutinesBackend.make()
    const local = counted(RoutinesDemo.local(clock().now))
    registry.register(local.backend)
    const { client } = connect(registry)
    await client.watch({ signal: AbortSignal.abort() })
    expect(local.open).toEqual({ count: 0, total: 0 })
  })

  test("a backend that replaces another while a window watches is the one watched", async () => {
    const time = clock()
    const registry = RoutinesBackend.make()
    const fake = counted(RoutinesDemo.remote(time.now))
    const real = counted(RoutinesDemo.remote(time.now))
    registry.register(fake.backend)
    const { client, events } = connect(registry)
    const stop = new AbortController()
    const watching = client.watch({ signal: stop.signal })
    await flush()
    registry.register(real.backend)
    await flush()
    expect(fake.open.count).toBe(0)
    expect(real.open.count).toBe(1)

    const routine = routinesIn(client).find((item) => item.definition.schedule) as Routine
    await real.backend.start(routine.ref.id)
    await flush()
    expect(events).toHaveLength(1)
    stop.abort()
    await watching
    expect(real.open.count).toBe(0)
  })
})

describe("reading while things change", () => {
  test("an older read that answers last does not undo a newer one", async () => {
    const farm = RoutinesDemo.remote(clock().now)
    const gates: Array<() => void> = []
    // The first read of the routines, the one the Ipc starts with, waits for the test; the later ones answer at once.
    const slow: Backend = {
      ...farm,
      list: async () => {
        const answer = await farm.list()
        if (gates.length > 0) return answer
        await new Promise<void>((resolve) => gates.push(resolve))
        return answer
      },
    }
    const registry: Registry = RoutinesBackend.make()
    registry.register(slow)
    const { client } = connect(registry)
    await flush()
    const routines = (await farm.list()) as readonly Routine[]
    await farm.remove(routines[0]?.ref.id ?? "")
    await client.refresh()
    expect(routinesIn(client)).toHaveLength(3)
    gates[0]?.()
    await flush()
    expect(routinesIn(client)).toHaveLength(3)
  })

  test("a list that fails keeps the last answer", async () => {
    const registry = RoutinesBackend.make()
    const farm = RoutinesDemo.remote(clock().now)
    const failing = { down: false }
    registry.register({
      ...farm,
      list: () => (failing.down ? Promise.reject(new Error("down")) : farm.list()),
    })
    const { client } = connect(registry)
    await client.refresh()
    failing.down = true
    await client.refresh()
    expect(client.state()?.routines).toHaveLength(4)
  })
})

describe("viewing", () => {
  test("a viewed run stops counting as unread in the state", async () => {
    const { client } = setup()
    await client.refresh()
    const routine = routinesIn(client).find((item) => item.unread > 0 && item.ref.backend === "local") as Routine
    const unread = routine.last?.unread ? routine.last : undefined
    expect(unread).toBeDefined()
    await client.viewed({ backend: "local", run: unread?.ref.id ?? "" })
    expect(routinesIn(client).find((item) => item.ref.id === routine.ref.id)?.unread).toBe(routine.unread - 1)
  })
})

describe("a backend that is unreachable when read", () => {
  test("is read again until it answers, so a service that starts late shows up without a reload", async () => {
    const registry = RoutinesBackend.make()
    const local = RoutinesDemo.local(clock().now)
    const up = { ready: false }
    registry.register({
      ...local,
      capabilities: async () => {
        const capabilities = await local.capabilities()
        return up.ready ? capabilities : { ...capabilities, status: "unreachable" as const }
      },
    })
    const { client } = connect(registry, 20)
    await flush()
    expect(client.state()?.backends[0]?.status).toBe("unreachable")
    up.ready = true
    await Bun.sleep(80)
    expect(client.state()?.backends[0]?.status).toBe("ready")
  })
})
