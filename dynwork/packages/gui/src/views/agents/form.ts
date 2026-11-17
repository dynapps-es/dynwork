import { createStore, unwrap } from "solid-js/store"
import type { Client } from "../../routines/client"
import {
  isFailure,
  type Capabilities,
  type Definition,
  type Failure,
  type Instructions,
  type Ref,
  type Routine,
  type Schedule,
} from "../../routines/contract"
import { defaults, layout, shown, valueOf, type Options } from "./fields"
import { fromMain, type Translate } from "./format"
import {
  cronOf,
  dayEnd,
  dayOf,
  dayStart,
  onTheHour,
  presetOf,
  scheduleProblem,
  upcoming,
  type Preset,
  type Words,
} from "./schedule"

// The routine form's state, apart from how it is drawn: a draft the user edits, the Definition it makes, the problems a
// save finds and the save itself. A routine's backend decides which fields the draft needs, through its capabilities.

/** What starts a routine: nothing but the user, or one of the schedule presets, or a cron written by hand. */
export type Trigger = "none" | "daily" | "weekdays" | "weekly" | "monthly" | "cron"
export const triggers: readonly Trigger[] = ["none", "daily", "weekdays", "weekly", "monthly", "cron"]

/** What the user is editing. Text inputs hold text, so the window and the count are text until they are saved. */
export interface Draft {
  name: string
  /** The kind of `Instructions`: what `text` is for. */
  what: Instructions["kind"]
  /** The prompt; the extra text of a skill; the input of a catalogue agent. */
  text: string
  skill: string
  /** The catalogue agent that a backend's `agent` instructions run. */
  agentRef: string
  /** `Definition.agent`. */
  agent: string
  model: string
  trigger: Trigger
  /** `HH:MM`. */
  time: string
  /** Weekdays from 0 (Sunday), for `weekly`. */
  days: number[]
  /** Day of the month, for `monthly`. */
  day: number
  /** The cron written by hand, for `cron`. */
  cron: string
  timezone: string
  /** `YYYY-MM-DD` in `timezone`, or empty. */
  starts: string
  ends: string
  /** A whole number, or empty for no limit. */
  max: string
  enabled: boolean
  options: Options
}

/** What is wrong with a field: the backend's own text, or a message of the view's own for `ctx.t`. */
export type Problem = string | Words

export const problemText = (t: Translate, problem: Problem) =>
  typeof problem === "string" ? fromMain(t, problem) : t(problem.key, problem.params)

/** The keys of the common fields, as a backend's `Failure.fields` names them. */
export const common = ["name", "instructions", "agent", "model", "schedule"] as const

type Shape = Pick<Capabilities, "instructions" | "fields">
const nothing: Shape = { instructions: ["prompt"], fields: [] }

/** The zone of this computer, where a schedule starts when the user has not chosen one. */
export const systemZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

/** A new routine for a backend: manual, enabled, and with the backend's defaults. */
export function blank(capabilities: Shape, zone = systemZone()): Draft {
  return {
    name: "",
    what: kindFor(capabilities, "prompt"),
    text: "",
    skill: "",
    agentRef: "",
    agent: "",
    model: "",
    trigger: "none",
    time: "08:45",
    days: [1],
    day: 1,
    cron: "",
    timezone: zone,
    starts: "",
    ends: "",
    max: "",
    enabled: true,
    options: defaults(capabilities),
  }
}

/** A routine to edit: its definition read back into the form, field for field. */
export function fromRoutine(routine: Routine, capabilities: Shape, zone = systemZone()): Draft {
  const definition = routine.definition
  const schedule = definition.schedule
  const timezone = schedule?.timezone ?? zone
  const instructions = definition.instructions
  return {
    ...blank(capabilities, timezone),
    name: definition.name,
    what: instructions.kind,
    text:
      instructions.kind === "prompt"
        ? instructions.text
        : instructions.kind === "skill"
          ? (instructions.text ?? "")
          : instructions.input,
    skill: instructions.kind === "skill" ? instructions.skill : "",
    agentRef: instructions.kind === "agent" ? instructions.agent : "",
    agent: definition.agent ?? "",
    model: definition.model ?? "",
    ...(schedule ? triggerOf(schedule.cron) : {}),
    starts: schedule?.starts === undefined ? "" : dayOf(schedule.starts, timezone),
    ends: schedule?.ends === undefined ? "" : dayOf(schedule.ends, timezone),
    max: schedule?.max === undefined ? "" : String(schedule.max),
    enabled: definition.enabled,
    options: { ...definition.options },
  }
}

/** The definition the draft makes. It is only as valid as `localProblems` and the backend's `validate` say. */
export function toDefinition(draft: Draft, capabilities: Capabilities): Definition {
  const schedule = scheduleOf(draft, capabilities)
  return {
    name: draft.name.trim(),
    instructions: instructionsOf(draft),
    ...(capabilities.agent !== "none" && draft.agent ? { agent: draft.agent } : {}),
    ...(capabilities.model === "choose" && draft.model ? { model: draft.model } : {}),
    ...(schedule ? { schedule } : {}),
    enabled: draft.enabled,
    options: optionsOf(draft.options, capabilities),
  }
}

/**
 * What the form can tell before asking the backend: a schedule that cannot be written, or a count that is not a number.
 * Everything else, the backend checks.
 */
export function localProblems(draft: Draft, capabilities: Pick<Capabilities, "schedule">): Record<string, Problem> {
  const preset = presetOfDraft(draft)
  const key = preset && scheduleProblem(preset)
  if (key) return { schedule: { key, params: {} } }
  const count = draft.max.trim()
  if (
    preset &&
    capabilities.schedule.window &&
    count !== "" &&
    !(Number.isInteger(Number(count)) && Number(count) >= 1)
  )
    return { schedule: { key: "agents.form.error.max", params: {} } }
  return {}
}

/** The keys of `errors` that no field on the form carries, so the form can show their messages apart. */
export function unplaced(errors: Record<string, Problem>, placed: readonly string[]) {
  return Object.keys(errors).filter((key) => !placed.includes(key))
}

/** The schedule the draft describes, or undefined for a manual routine or one that is not written yet. */
export function draftSchedule(draft: Draft): Schedule | undefined {
  const preset = presetOfDraft(draft)
  const cron = preset && cronOf(preset)
  return cron ? { cron, timezone: draft.timezone } : undefined
}

/**
 * The form's model: the draft, the backend it is for, the problems of the last save and the save. `routine` opens an
 * edit; without it the form creates one on `backend`, or on the first backend. It never reaches a backend itself: it
 * calls the window's routines client, and does nothing without one.
 */
export function createFormModel(input: {
  client: () => Client | undefined
  backends: () => readonly Capabilities[]
  routine?: Routine
  backend?: string
  zone: string
  now: () => number
}) {
  const backend = input.routine?.ref.backend ?? input.backend ?? input.backends()[0]?.backend ?? ""
  const find = (id: string) => input.backends().find((candidate) => candidate.backend === id)
  const first = find(backend)
  const [state, setState] = createStore({
    backend,
    draft: input.routine
      ? fromRoutine(input.routine, first ?? nothing, input.zone)
      : blank(first ?? nothing, input.zone),
    errors: {} as Record<string, Problem>,
    failure: undefined as Failure | undefined,
    saving: false,
    // The options of each backend the user has left, so going back to it finds them as they were.
    saved: {} as Record<string, Options>,
  })

  const capabilities = () => find(state.backend)
  const fields = () => layout(capabilities() ?? nothing, state.draft.options)
  const placed = () => [...common, ...Object.values(fields()).flatMap((list) => list.map((field) => field.key))]
  const without = (key: string) => Object.fromEntries(Object.entries(state.errors).filter(([other]) => other !== key))

  const model = {
    state,
    mode: input.routine ? ("edit" as const) : ("create" as const),
    capabilities,
    fields,
    error: (key: string): Problem | undefined => state.errors[key],
    /** The field to take the user to: the first with a problem, in the order the form draws them. */
    firstError: () =>
      [...common, ...(capabilities()?.fields ?? []).map((field) => field.key)].find((key) => key in state.errors),
    /** Problems of fields the form does not draw, such as one a backend invents. */
    orphans: () => unplaced(state.errors, placed()),
    /**
     * Saving an edit makes a new routine and removes the old, as the farm does.
     * JESÚS: the form reads this from your `capabilities().actions.edit === "replace"` and tells the user so; nothing to
     * write here. `update` answers the new ref and the view selects it.
     */
    replaces: () => !!input.routine && capabilities()?.actions.edit === "replace",
    /** The next three runs of the schedule as written, in its zone. */
    preview() {
      const schedule = draftSchedule(state.draft)
      return schedule ? upcoming(schedule, input.now()) : []
    },
    /** A run on the hour can start a little late, when many schedules fire together. */
    late() {
      const schedule = draftSchedule(state.draft)
      return !!schedule && onTheHour(schedule.cron)
    },

    set(patch: Partial<Draft>) {
      setState("draft", patch)
      const touched = new Set(Object.keys(patch).map((key) => touches[key as keyof typeof touches]))
      setState({ errors: Object.fromEntries(Object.entries(state.errors).filter(([key]) => !touched.has(key))) })
    },

    /** A custom cron starts as the cron of the preset it replaces. */
    setTrigger(trigger: Trigger) {
      const current = presetOfDraft(state.draft)
      const cron = state.draft.cron.trim() === "" && trigger === "cron" && current ? cronOf(current) : undefined
      model.set({ trigger, ...(cron ? { cron } : {}) })
    },

    option(key: string, value: Options[string] | undefined) {
      const next = Object.fromEntries(Object.entries(state.draft.options).filter(([other]) => other !== key))
      setState("draft", { options: value === undefined ? next : { ...next, [key]: value } })
      setState({ errors: without(key) })
    },

    /** Moves a new routine to another backend: the common fields stay, the backend's own start over or come back. */
    choose(id: string) {
      const target = find(id)
      if (input.routine || !target || id === state.backend) return
      const draft = state.draft
      setState({
        saved: { ...state.saved, [state.backend]: draft.options },
        backend: id,
        draft: {
          ...draft,
          what: kindFor(target, draft.what),
          agent: "",
          agentRef: "",
          model: "",
          options: state.saved[id] ?? defaults(target),
        },
        errors: {},
        failure: undefined,
      })
    },

    /** Checks the draft with the backend, then creates or updates the routine. Answers its ref, or undefined. */
    async save(): Promise<Ref | undefined> {
      const client = input.client()
      const target = capabilities()
      if (!client || !target || state.saving) return undefined
      setState({ saving: true, failure: undefined, errors: {} })
      const ref = await submit(client, target)
      setState("saving", false)
      return ref
    },
  }

  async function submit(client: Client, target: Capabilities) {
    // The draft leaves the window through the Ipc, and a store's proxies cannot be structured-cloned: send its data.
    const draft = unwrap(state.draft)
    const problems = localProblems(draft, target)
    if (Object.keys(problems).length > 0) return refuse(undefined, problems)
    const definition = toDefinition(draft, target)
    // JESÚS: `validate` then `create` or `update` are your backend's methods: the form only shows what they answer. An
    // `invalid` failure with `fields` keyed by `Field.key` (or `name`, `instructions`, `agent`, `model`, `schedule`)
    // marks each field; any other failure, such as `quota`, shows above the buttons.
    const invalid = await client.validate({ backend: state.backend, definition })
    if (invalid) return refuse(invalid)
    const saved = input.routine
      ? await client.update({ backend: state.backend, id: input.routine.ref.id, definition })
      : await client.create({ backend: state.backend, definition })
    if (isFailure(saved)) return refuse(saved)
    return saved.ref
  }

  // A failure about fields marks them; any other stays whole, for the form to show above its buttons.
  function refuse(failure?: Failure, problems?: Record<string, Problem>) {
    const fields = problems ?? (failure?.code === "invalid" ? failure.fields : undefined)
    if (fields) setState({ errors: fields })
    else setState({ failure })
    return undefined
  }

  return model
}

export type FormModel = ReturnType<typeof createFormModel>

// The error each draft field answers for: editing the field clears its message.
const touches = {
  name: "name",
  what: "instructions",
  text: "instructions",
  skill: "instructions",
  agentRef: "instructions",
  agent: "agent",
  model: "model",
  trigger: "schedule",
  time: "schedule",
  days: "schedule",
  day: "schedule",
  cron: "schedule",
  timezone: "schedule",
  starts: "schedule",
  ends: "schedule",
  max: "schedule",
  enabled: "enabled",
  options: "options",
} satisfies Record<keyof Draft, string>

// The first kind of instructions the backend takes, preferring `preferred`.
function kindFor(capabilities: Pick<Capabilities, "instructions">, preferred: Instructions["kind"]) {
  return capabilities.instructions.includes(preferred) ? preferred : (capabilities.instructions[0] ?? "prompt")
}

// A draft as the preset it writes, or undefined for a manual routine.
function presetOfDraft(draft: Draft): Preset | undefined {
  if (draft.trigger === "none") return undefined
  if (draft.trigger === "cron") return { kind: "cron", cron: draft.cron }
  if (draft.trigger === "weekly") return { kind: "weekly", time: draft.time, days: draft.days }
  if (draft.trigger === "monthly") return { kind: "monthly", time: draft.time, day: draft.day }
  return { kind: draft.trigger, time: draft.time }
}

// A stored cron as the draft's trigger fields. A cron that a preset would write differently stays as typed, so saving
// an edit never rewrites a schedule the user did not touch.
function triggerOf(cron: string): Partial<Draft> {
  const preset = presetOf(cron)
  if (preset.kind === "cron" || cronOf(preset) !== cron.trim().split(/\s+/).join(" ")) return { trigger: "cron", cron }
  if (preset.kind === "weekly") return { trigger: "weekly", time: preset.time, days: [...preset.days] }
  if (preset.kind === "monthly") return { trigger: "monthly", time: preset.time, day: preset.day }
  return { trigger: preset.kind, time: preset.time }
}

// The window (first day, last day, count) is the backend's, and only where its capabilities say it takes one.
function scheduleOf(draft: Draft, capabilities: Pick<Capabilities, "schedule">): Schedule | undefined {
  const preset = presetOfDraft(draft)
  if (!preset) return undefined
  const base = { cron: cronOf(preset) ?? "", timezone: draft.timezone }
  if (!capabilities.schedule.window) return base
  const starts = draft.starts ? dayStart(draft.starts, draft.timezone) : undefined
  const ends = draft.ends ? dayEnd(draft.ends, draft.timezone) : undefined
  const max = draft.max.trim() === "" ? undefined : Number(draft.max)
  return {
    ...base,
    ...(starts === undefined ? {} : { starts }),
    ...(ends === undefined ? {} : { ends }),
    ...(max === undefined ? {} : { max }),
  }
}

function instructionsOf(draft: Draft): Instructions {
  if (draft.what === "prompt") return { kind: "prompt", text: draft.text }
  if (draft.what === "skill")
    return { kind: "skill", skill: draft.skill, ...(draft.text.trim() ? { text: draft.text } : {}) }
  return { kind: "agent", agent: draft.agentRef, input: draft.text }
}

// What is sent: the shown fields with their value or default, left out when empty; keys no field declares ride along.
function optionsOf(options: Options, capabilities: Pick<Capabilities, "fields">): Options {
  const fields = capabilities.fields
  const declared = new Set(fields.map((field) => field.key))
  const own = Object.entries(options).filter(([key]) => !declared.has(key))
  const values = fields.flatMap((field) => {
    const value = valueOf(field, options)
    const empty = value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0)
    return shown(field, fields, options) && !empty ? [[field.key, value] as const] : []
  })
  return Object.fromEntries([...own, ...values])
}
