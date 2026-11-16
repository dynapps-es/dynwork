import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { base64Decode } from "@opencode/util/encode"
import { RoutinesBackend } from "../../../src/routines/backend"
import { isFailure, type Routine } from "../../../src/routines/contract"
import { RoutinesDemo } from "../../../src/routines/demo"
import {
  createRunsModel,
  days,
  marker,
  routineHref,
  routineOf,
  runHref,
  sessionHref,
} from "../../../src/views/runs/model"
import { clock, MINUTE } from "../../routines/fixture"
import { connect } from "../../routines/wire"

// The panel's model over the demo local backend, through a window's client that crosses values as the bridge does.
async function setup() {
  const time = clock()
  const registry = RoutinesBackend.make()
  const local = RoutinesDemo.local(time.now)
  registry.register(local)
  const wire = connect(registry)
  await wire.client.refresh()
  const routines = () => wire.client.state()?.routines ?? []
  const find = (name: string) => {
    const found = routines().find((routine) => routine.definition.name === name)
    if (!found) throw new Error(`No routine ${name}`)
    return found
  }
  const [routed, setRouted] = createSignal("")
  const sent: Array<{ session: string; text: string }> = []
  const forked: string[] = []
  const [routine, setRoutine] = createSignal<Routine>()
  const model = createRoot(() =>
    createRunsModel({
      client: () => wire.client,
      routine,
      routed,
      session: {
        prompt: async (session, text) => void sent.push({ session, text }),
        fork: async (session) => {
          forked.push(session)
          return `ses_fork_${session}`
        },
      },
    }),
  )
  return { time, local, wire, model, find, setRouted, setRoutine, sent, forked }
}

describe("which sessions are a routine's", () => {
  test("the marker is read from the session's metadata, and nothing else counts", () => {
    expect(marker({ dynwork: { backend: "local", routine: "r1", role: "anchor" } })).toEqual({
      backend: "local",
      routine: "r1",
      role: "anchor",
    })
    expect(marker({ dynwork: { backend: "local", routine: "r1", role: "run", trigger: "manual" } })?.role).toBe("run")
    expect(marker(undefined)).toBeUndefined()
    expect(marker({ dynwork: { routine: 3 } })).toBeUndefined()
    expect(marker({ other: true })).toBeUndefined()
  })

  test("a session is a routine's by its metadata, else as the routine's anchor or its last run", async () => {
    const { find, wire } = await setup()
    const tickets = find("Weekly ticket summary")
    const routines = wire.client.state()?.routines ?? []
    const byMetadata = routineOf({
      session: "ses-anything",
      metadata: { dynwork: { backend: "local", routine: tickets.ref.id, role: "run" } },
      routines,
    })
    expect(byMetadata?.ref).toEqual(tickets.ref)
    if (tickets.conversation.kind !== "session") throw new Error("no anchor")
    expect(routineOf({ session: tickets.conversation.anchor, routines })?.ref).toEqual(tickets.ref)
    if (tickets.last?.conversation.kind !== "session") throw new Error("no run")
    expect(routineOf({ session: tickets.last.conversation.session, routines })?.ref).toEqual(tickets.ref)
    // An older run, by its parent: the anchor.
    expect(routineOf({ session: "ses-older", parent: tickets.conversation.anchor, routines })?.ref).toEqual(tickets.ref)
    expect(routineOf({ session: "ses-plain", routines })).toBeUndefined()
    expect(routineOf({ session: "ses-plain", parent: "ses-other", routines })).toBeUndefined()
    // A removed routine's sessions stay, but the panel is not listed there.
    const removed = { dynwork: { backend: "local", routine: "gone", role: "anchor" } }
    expect(routineOf({ session: "ses-old", metadata: removed, routines })).toBeUndefined()
  })
})

describe("links", () => {
  test("a session's route is the server key in base64url and the session id", () => {
    const href = sessionHref("sidecar", "ses_123")
    const [, , server, , session] = href.split("/")
    expect(href.startsWith("/server/")).toBe(true)
    expect(base64Decode(server ?? "")).toBe("sidecar")
    expect(session).toBe("ses_123")
    expect(sessionHref("http://127.0.0.1:4096", "ses_1")).not.toContain("+")
  })

  test("only a run read in a session has a route", async () => {
    const { find } = await setup()
    const tickets = find("Weekly ticket summary")
    if (!tickets.last) throw new Error("no run")
    expect(runHref(tickets.last)).toBe(sessionHref("demo", `ses-${tickets.last.ref.id}`))
    expect(runHref({ ...tickets.last, conversation: { kind: "transcript" } })).toBeUndefined()
  })
})

describe("days", () => {
  test("runs fall under today, yesterday or their own day, newest first", async () => {
    const { time, find, wire } = await setup()
    const tickets = find("Weekly ticket summary")
    const page = await wire.client.runs({ backend: "local", routine: tickets.ref.id })
    if (isFailure(page)) throw new Error(page.message)
    const groups = days(page.items, time.now(), "Europe/Madrid")
    expect(groups[0]?.day).toBe("today")
    expect(groups.flatMap((group) => group.runs).map((run) => run.ref.id)).toEqual(page.items.map((run) => run.ref.id))
    expect(groups.slice(1).every((group) => group.day !== "today")).toBe(true)
    const yesterday = days([{ ...page.items[0]!, started: time.now() - 24 * 60 * MINUTE }], time.now(), "Europe/Madrid")
    expect(yesterday[0]?.day).toBe("yesterday")
  })
})

describe("the Runs panel", () => {
  test("lists the routine's runs and follows them as they change", async () => {
    const { model, find, setRoutine, local, time, wire } = await setup()
    const tickets = find("Weekly ticket summary")
    setRoutine(tickets)
    await model.load()
    expect(model.runs().length).toBeGreaterThan(0)
    expect(model.runs().every((run) => run.routine?.id === tickets.ref.id)).toBe(true)

    const watching = new AbortController()
    void wire.client.watch({ signal: watching.signal })
    await model.start()
    const started = model.runs()[0]
    expect(started?.state).toBe("running")
    time.advance(5 * MINUTE)
    local.settle()
    wire.events.forEach((run) => model.received(run))
    expect(model.runs()[0]).toMatchObject({ ref: started?.ref, state: "ok", unread: true })
    // A run of another routine never joins the list.
    model.received({ ...started!, ref: { backend: "local", id: "other" }, routine: { backend: "local", id: "x" } })
    expect(model.runs().some((run) => run.ref.id === "other")).toBe(false)
    watching.abort()
  })

  test("the routed run is the current one; once finished and unread it is marked viewed", async () => {
    const { model, find, setRoutine, setRouted, local } = await setup()
    const tickets = find("Weekly ticket summary")
    setRoutine(tickets)
    await model.load()
    const unread = model.runs().find((run) => run.unread)
    if (!unread || unread.conversation.kind !== "session") throw new Error("no unread run")
    setRouted(unread.conversation.session)
    expect(model.current()?.ref).toEqual(unread.ref)
    await model.seen()
    expect(model.runs().find((run) => run.ref.id === unread.ref.id)?.unread).toBe(false)
    const page = await local.runs({ routine: tickets.ref.id })
    expect(isFailure(page) ? undefined : page.items.find((run) => run.ref.id === unread.ref.id)?.unread).toBe(false)
  })

  test("a reply goes to the routed run's session and a fork answers the new conversation", async () => {
    const { model, find, setRoutine, setRouted, sent, forked } = await setup()
    const tickets = find("Weekly ticket summary")
    setRoutine(tickets)
    await model.load()
    const run = model.runs()[0]
    if (!run || run.conversation.kind !== "session") throw new Error("no run")
    expect(model.canReply()).toBe(false)
    setRouted(run.conversation.session)
    expect(model.canReply()).toBe(true)
    model.setReply("   ")
    expect(await model.reply()).toBe(false)
    model.setReply("Add the totals, please.")
    expect(await model.reply()).toBe(true)
    expect(sent).toEqual([{ session: run.conversation.session, text: "Add the totals, please." }])
    expect(model.state.reply).toBe("")
    expect(await model.fork()).toBe(`ses_fork_${run.conversation.session}`)
    expect(forked).toEqual([run.conversation.session])
  })

  test("pause and resume switch the routine off and on through the Ipc", async () => {
    const { model, find, setRoutine, wire } = await setup()
    setRoutine(find("Weekly ticket summary"))
    await model.toggle()
    expect(find("Weekly ticket summary").state).toBe("paused")
    setRoutine(find("Weekly ticket summary"))
    await model.toggle()
    expect(find("Weekly ticket summary").state).toBe("active")
    expect(wire.pushes.count).toBeGreaterThan(0)
  })

  test("a routine's anchor is opened at its newest run, or at the anchor before any run", async () => {
    const { find } = await setup()
    const tickets = find("Weekly ticket summary")
    if (!tickets.last || tickets.conversation.kind !== "session") throw new Error("no run")
    expect(routineHref(tickets)).toBe(runHref(tickets.last))
    expect(routineHref({ ...tickets, last: undefined })).toBe(sessionHref("demo", tickets.conversation.anchor))
    expect(routineHref({ ...tickets, last: undefined, conversation: { kind: "none" } })).toBeUndefined()
  })

  test("on the anchor there is no current run and nothing to reply to", async () => {
    const { model, find, setRoutine, setRouted } = await setup()
    const tickets = find("Weekly ticket summary")
    if (tickets.conversation.kind !== "session") throw new Error("no anchor")
    setRoutine(tickets)
    setRouted(tickets.conversation.anchor)
    await model.load()
    expect(model.current()).toBeUndefined()
    expect(model.canReply()).toBe(false)
    expect(await model.fork()).toBeUndefined()
  })
})
