import { describe, expect, test } from "bun:test"
import type { Backend } from "../../src/routines/backend"
import {
  Capabilities,
  isFailure,
  Routine,
  RunPage,
  Templates,
  type Change,
  type Definition,
  type Failure,
  type Field,
  type Personal,
  type Template,
} from "../../src/routines/contract"
import { RoutinesTemplates } from "../../src/routines/templates"
import { crossing } from "./wire"

/** What the suite needs of a backend under test, besides the backend. */
export interface Subject {
  readonly backend: Backend
  /** Brings every run that is going to a terminal state, however the backend does it (a clock, a poll, a service). */
  finish(): Promise<void>
}

// The keys the form keeps for itself: a backend field with one of them would shadow it in `Failure.fields`.
const reserved = ["name", "instructions", "agent", "model", "schedule", "enabled", "template"]

/**
 * The suite every routines backend passes before it is registered: the local one with a fake service, the farm's with
 * a fake farm server, the fakes in `src/routines/fake.ts`. It reads what the backend can do from `capabilities()` and
 * checks only that.
 */
export function conformance(name: string, make: () => Promise<Subject> | Subject) {
  describe(`routines backend conformance: ${name}`, () => {
    test("capabilities describe the backend and every field consistently", async () => {
      const { backend } = await make()
      const capabilities = await backend.capabilities()
      expect(capabilities.backend).toBe(backend.id)
      expect(capabilities.instructions.length).toBeGreaterThan(0)
      const keys = capabilities.fields.map((field) => field.key)
      expect(new Set(keys).size).toBe(keys.length)
      expect(keys.filter((key) => reserved.includes(key))).toEqual([])
      for (const field of capabilities.fields) {
        if (field.when) expect(keys).toContain(field.when.key)
        if (field.kind === "select") expect(field.choices !== undefined || field.lookup !== undefined).toBe(true)
        if (field.lookup) expect(isFailure(await backend.options(field.lookup))).toBe(false)
      }
      // A kind of instruction is only offered with the lookup that fills it.
      if (capabilities.instructions.includes("skill")) expect(isFailure(await backend.options("skills"))).toBe(false)
      if (capabilities.instructions.includes("agent")) expect(isFailure(await backend.options("agents"))).toBe(false)
    })

    test("a created routine is answered, listed and read back", async () => {
      const { backend } = await make()
      const before = await listed(backend)
      const definition = await sample(backend, "Created")
      const created = await ok(backend.create(definition))
      expect(created.ref.backend).toBe(backend.id)
      expect(created.definition).toEqual(definition)
      expect(created.state).toBe("active")
      expect((await listed(backend)).map((routine) => routine.ref.id)).toContain(created.ref.id)
      expect((await listed(backend)).length).toBe(before.length + 1)
      expect(await ok(backend.get(created.ref.id))).toEqual(created)
    })

    test("a routine without a schedule is allowed and runs only when started", async () => {
      const { backend } = await make()
      const created = await ok(backend.create({ ...(await sample(backend, "Manual only")), schedule: undefined }))
      expect(created.definition.schedule).toBeUndefined()
      expect(created.next).toBeUndefined()
    })

    test("an update follows what the backend says about editing", async () => {
      const { backend } = await make()
      const capabilities = await backend.capabilities()
      const created = await ok(backend.create(await sample(backend, "Before")))
      const count = (await listed(backend)).length
      const updated = await ok(backend.update(created.ref.id, { ...created.definition, name: "After" }))
      expect(updated.definition.name).toBe("After")
      expect(await listed(backend)).toHaveLength(count)
      if (capabilities.actions.edit === "in-place") {
        expect(updated.ref).toEqual(created.ref)
        return
      }
      expect(updated.ref.id).not.toBe(created.ref.id)
      expect(updated.ref.backend).toBe(backend.id)
      expectFailure(await backend.get(created.ref.id), "not-found")
      expect(await ok(backend.get(updated.ref.id))).toEqual(updated)
    })

    test("pause and resume switch a routine off and on", async () => {
      const { backend } = await make()
      const created = await ok(backend.create(await sample(backend, "Switch")))
      expect(await backend.pause(created.ref.id)).toBeUndefined()
      const paused = await ok(backend.get(created.ref.id))
      expect(paused.state).toBe("paused")
      expect(paused.definition.enabled).toBe(false)
      expect(paused.next).toBeUndefined()
      expect(await backend.resume(created.ref.id)).toBeUndefined()
      const resumed = await ok(backend.get(created.ref.id))
      expect(resumed.state).toBe("active")
      expect(resumed.definition.enabled).toBe(true)
      expect(resumed.next).toBeNumber()
    })

    test("a run starts now, finishes, is unread until viewed, and the routine follows it", async () => {
      const subject = await make()
      const { backend } = subject
      const created = await ok(backend.create(await sample(backend, "Run")))
      const run = await ok(backend.start(created.ref.id))
      expect(run.ref.backend).toBe(backend.id)
      expect(run.routine).toEqual(created.ref)
      expect(run.trigger).toBe("manual")
      expect(["queued", "running"]).toContain(run.state)

      await subject.finish()
      const page = await ok(backend.runs({ routine: created.ref.id }))
      expect(page.items[0]?.ref).toEqual(run.ref)
      const finished = page.items[0]
      expect(["queued", "running"]).not.toContain(finished?.state ?? "queued")
      expect(finished?.unread).toBe(true)
      expect((await ok(backend.get(created.ref.id))).last?.ref).toEqual(run.ref)
      expect((await ok(backend.get(created.ref.id))).unread).toBe(1)

      await backend.viewed(run.ref.id)
      expect((await ok(backend.runs({ routine: created.ref.id }))).items[0]?.unread).toBe(false)
      expect((await ok(backend.get(created.ref.id))).unread).toBe(0)
    })

    test("runs come newest first, page by page, without repeats", async () => {
      const subject = await make()
      const { backend } = subject
      const created = await ok(backend.create(await sample(backend, "Pages")))
      const started = [await ok(backend.start(created.ref.id)), await ok(backend.start(created.ref.id))]
      await subject.finish()

      const seen: string[] = []
      const times: number[] = []
      const cursor = { value: undefined as string | undefined }
      // A backend that pages forever is a bug: stop long after any real list would end.
      for (let turn = 0; turn < 200; turn++) {
        const page = await ok(backend.runs({ cursor: cursor.value }))
        page.items.forEach((run) => {
          seen.push(run.ref.id)
          times.push(run.started ?? run.due ?? 0)
        })
        cursor.value = page.next
        if (cursor.value === undefined) break
      }
      expect(cursor.value).toBeUndefined()
      expect(new Set(seen).size).toBe(seen.length)
      expect(seen.slice(0, 2)).toEqual(started.map((run) => run.ref.id).reverse())
      expect(times).toEqual([...times].sort((left, right) => right - left))
    })

    test("a running run is cancelled once, where the backend can", async () => {
      const { backend } = await make()
      const capabilities = await backend.capabilities()
      const created = await ok(backend.create(await sample(backend, "Cancel")))
      const run = await ok(backend.start(created.ref.id))
      if (!capabilities.actions.cancel) {
        expectFailure(await backend.cancel(run.ref.id), "unsupported")
        return
      }
      expect(await backend.cancel(run.ref.id)).toBeUndefined()
      const cancelled = (await ok(backend.runs({ routine: created.ref.id }))).items[0]
      expect(cancelled?.state).toBe("cancelled")
      expect(cancelled?.finished).toBeNumber()
      expectFailure(await backend.cancel(run.ref.id), "conflict")
    })

    test("a removed routine is gone", async () => {
      const { backend } = await make()
      const created = await ok(backend.create(await sample(backend, "Remove")))
      expect(await backend.remove(created.ref.id)).toBeUndefined()
      expect((await listed(backend)).map((routine) => routine.ref.id)).not.toContain(created.ref.id)
      expectFailure(await backend.get(created.ref.id), "not-found")
      expectFailure(await backend.remove(created.ref.id), "not-found")
    })

    test("what does not exist answers not-found, as data", async () => {
      const { backend } = await make()
      const definition = await sample(backend, "Ghost")
      expectFailure(await backend.get("nope"), "not-found")
      expectFailure(await backend.update("nope", definition), "not-found")
      expectFailure(await backend.remove("nope"), "not-found")
      expectFailure(await backend.pause("nope"), "not-found")
      expectFailure(await backend.resume("nope"), "not-found")
      expectFailure(await backend.start("nope"), "not-found")
      expectFailure(await backend.cancel("nope"), "not-found")
      expectFailure(await backend.transcript("nope"), "not-found")
      expectFailure(await backend.runs({ routine: "nope" }), "not-found")
      expectFailure(await backend.options("no-such-lookup"), "not-found")
    })

    test("an invalid definition answers invalid with its fields, in validate and in create, and is not saved", async () => {
      const { backend } = await make()
      const capabilities = await backend.capabilities()
      const good = await sample(backend, "Valid")
      expect(await backend.validate(good)).toBeUndefined()

      const count = (await listed(backend)).length
      const unnamed = await backend.validate({ ...good, name: "   " })
      expectFailure(unnamed, "invalid")
      expect(unnamed?.fields?.name).toBeString()
      expectFailure(await backend.create({ ...good, name: "" }), "invalid")
      expectFailure(
        await backend.validate({ ...good, schedule: { cron: "* *", timezone: "Europe/Madrid" } }),
        "invalid",
      )
      expect(
        (await backend.validate({ ...good, schedule: { cron: "* *", timezone: "Europe/Madrid" } }))?.fields,
      ).toHaveProperty("schedule")
      const missing = (["prompt", "skill", "agent"] as const).find((kind) => !capabilities.instructions.includes(kind))
      if (missing)
        expect((await backend.validate({ ...good, instructions: instructionsOf(missing) }))?.fields).toHaveProperty(
          "instructions",
        )
      expect(await listed(backend)).toHaveLength(count)
    })

    test("watch reports what changes until it is stopped", async () => {
      const subject = await make()
      const { backend } = subject
      const seen: Change[] = []
      const stop = backend.watch((change) => seen.push(change))
      const created = await ok(backend.create(await sample(backend, "Watched")))
      await ok(backend.start(created.ref.id))
      await subject.finish()
      expect(seen.some((change) => change.routine?.id === created.ref.id)).toBe(true)
      expect(seen.some((change) => change.run?.routine?.id === created.ref.id)).toBe(true)

      stop()
      const count = seen.length
      await ok(backend.start(created.ref.id))
      await subject.finish()
      expect(seen).toHaveLength(count)
    })

    test("the quota stops a scheduled routine, but not one that runs only by hand", async () => {
      const { backend } = await make()
      const quota = (await backend.capabilities()).quota
      if (!quota) return
      const room = quota.max - quota.used
      for (let index = 0; index < room; index++) await ok(backend.create(await sample(backend, `Fill ${index}`)))
      const full = await backend.create(await sample(backend, "One too many"))
      expectFailure(full, "quota")
      expect((await backend.capabilities()).quota?.used).toBe(quota.max)
      await ok(backend.create({ ...(await sample(backend, "By hand")), schedule: undefined }))
    })

    test("a transcript is read where the run says so, and nowhere else", async () => {
      const subject = await make()
      const { backend } = subject
      const created = await ok(backend.create(await sample(backend, "Transcript")))
      const run = await ok(backend.start(created.ref.id))
      await subject.finish()
      const answer = await backend.transcript(run.ref.id)
      if (run.conversation.kind === "transcript") {
        expect(isFailure(answer)).toBe(false)
        expect(isFailure(answer) ? undefined : answer.result).toBeString()
        return
      }
      expectFailure(answer, "unsupported")
    })

    test("templates are listed and each is activated once, or the backend has none", async () => {
      const { backend } = await make()
      const answer = backend.templates ? await backend.templates() : undefined
      if (answer === undefined || isFailure(answer)) {
        if (answer) expectFailure(answer, "unsupported")
        if (backend.activate) expectFailure(await backend.activate("any", { timezone: "Europe/Madrid" }), "unsupported")
        return
      }
      expect(crossing(Templates, answer)).toEqual(answer)
      const linked = new Set(answer.links.map((link) => link.id))
      const free = answer.templates.find((template) => template.where === "local" && !linked.has(template.id))
      if (!free || !backend.activate) throw new Error("a backend with templates offers one to activate")
      const created = await ok(backend.activate(free.id, personalFor(free)))
      expect(created.definition.template).toEqual({ id: free.id, revision: free.revision })
      expect(created.template).toMatchObject({
        id: free.id,
        name: free.name,
        locked: RoutinesTemplates.locked(free),
        state: "published",
        mandatory: free.mandatory,
      })
      expect(await ok(backend.get(created.ref.id))).toEqual(created)
      expect((await ok(backend.templates())).links).toContainEqual({ id: free.id, state: "published", retire: null })
      expectFailure(await backend.activate(free.id, personalFor(free)), "conflict")
      expectFailure(await backend.activate("no-such-template", personalFor(free)), "not-found")
    })

    test("everything it answers survives the wire", async () => {
      const subject = await make()
      const { backend } = subject
      const created = await ok(backend.create(await sample(backend, "Wire")))
      await ok(backend.start(created.ref.id))
      await subject.finish()
      expect(crossing(Capabilities, await backend.capabilities())).toEqual(await backend.capabilities())
      const routines = await listed(backend)
      routines.forEach((routine) => expect(crossing(Routine, routine)).toEqual(routine))
      const page = await ok(backend.runs({}))
      expect(crossing(RunPage, page)).toEqual(page)
    })
  })
}

function instructionsOf(kind: "prompt" | "skill" | "agent"): Definition["instructions"] {
  if (kind === "prompt") return { kind, text: "Do it." }
  if (kind === "skill") return { kind, skill: "any" }
  return { kind, agent: "any", input: "Do it." }
}

// A definition the backend takes: its first kind of instructions, a schedule, and a value for every required field.
export async function sample(backend: Backend, name: string): Promise<Definition> {
  const capabilities = await backend.capabilities()
  const kind = capabilities.instructions[0] ?? "prompt"
  const agents = await backend.options("agents")
  const agent = isFailure(agents) ? undefined : agents[0]?.value
  const skills = await backend.options("skills")
  const skill = isFailure(skills) ? undefined : skills[0]?.value
  const instructions: Definition["instructions"] =
    kind === "skill"
      ? { kind, skill: skill ?? "any" }
      : kind === "agent"
        ? { kind, agent: agent ?? "any", input: `Run ${name}.` }
        : { kind, text: `Do ${name}.` }
  const entries = await Promise.all(
    capabilities.fields
      .filter((field) => field.required && !field.when)
      .map(async (field) => [field.key, await valueFor(backend, field)] as const),
  )
  return {
    name,
    instructions,
    ...(capabilities.agent === "required" && agent ? { agent } : {}),
    schedule: { cron: "0 9 * * 1-5", timezone: "Europe/Madrid" },
    enabled: true,
    options: Object.fromEntries(entries),
  }
}

async function valueFor(backend: Backend, field: Field) {
  if (field.kind === "toggle") return true
  if (field.kind === "number") return field.min ?? 1
  if (field.kind === "folder") return "/tmp/work"
  if (field.kind === "repo") return "https://git.example.com/acme/app.git"
  if (field.kind === "list") return ["one"]
  const choices = field.choices ?? (field.lookup ? await backend.options(field.lookup) : [])
  const first = isFailure(choices) ? undefined : choices[0]?.value
  if (field.kind === "multiselect") return first ? [first] : []
  if (field.kind === "select") return first ?? ""
  return "text"
}

// What a person fills in to activate `template`: the zone, a folder where it needs one, the confirmation of "Don't ask".
function personalFor(template: Template): Personal {
  return {
    timezone: "Europe/Madrid",
    ...(template.personal.folder === "required" ? { folder: "/tmp/work" } : {}),
    ...(template.definition.options.permissions === "bypass" ? { approved: true } : {}),
  }
}

async function ok<A>(answer: Promise<A | Failure>): Promise<A> {
  const value = await answer
  if (isFailure(value)) throw new Error(`Expected an answer, got ${value.code}: ${value.message}`)
  return value
}

async function listed(backend: Backend) {
  return ok(backend.list()).then((routines) => [...routines])
}

// A failure is data with the code the contract promises for it, a message, and retryable only where it can clear up.
export function expectFailure(value: unknown, code: Failure["code"]): asserts value is Failure {
  expect(isFailure(value)).toBe(true)
  const failure = value as Failure
  expect(failure.code).toBe(code)
  expect(failure.message.length).toBeGreaterThan(0)
  expect(failure.retryable).toBe(code === "unreachable")
}
