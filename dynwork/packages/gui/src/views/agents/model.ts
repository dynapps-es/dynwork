import { createStore } from "solid-js/store"
import type { Client } from "../../routines/client"
import {
  isFailure,
  type Capabilities,
  type Choice,
  type Failure,
  type Ref,
  type Routine,
  type Run,
  type Template,
  type TemplateLink,
  type Templates,
  type Transcript,
} from "../../routines/contract"
import { fieldSaid, runTime, type Translate } from "./format"
import { matchesStatus, matchesWhere, type Status, type Where } from "./routine"

/** The list's three tabs: the user's routines, Governance's templates, and every run. */
export type Tab = "mine" | "templates" | "activity"
export const tabs: readonly Tab[] = ["mine", "templates", "activity"]

/** A page of runs as the view holds it: newest first, with the cursor of the page after. */
export interface Page {
  readonly runs: readonly Run[]
  readonly next?: string
  readonly loading: boolean
  readonly failure?: Failure
}

/** The run the viewer shows, and its transcript once it arrives. */
export interface Viewer {
  readonly run: Run
  readonly transcript?: Transcript
  readonly failure?: Failure
  readonly loading: boolean
}

/** A backend's templates as the view holds them: the last answer, and the failure of the last read. */
export interface Offered {
  readonly value?: Templates
  readonly failure?: Failure
  readonly loading: boolean
}

/**
 * What a template's card says and offers:
 * - `assigned`: mandatory, Dynapps assigns it and its routine arrives unasked; the card opens it once it is here.
 * - `active`: the person has its routine, here or on another computer, or Governance links one that is not here yet.
 * - `requires`: a connector it uses is not among this computer's; the card links to Connectors.
 * - `available`: "Use template".
 */
export type TemplateCard =
  | { kind: "assigned"; routine?: Routine }
  | { kind: "active"; routine?: Routine }
  | { kind: "requires"; server: string }
  | { kind: "available" }

/**
 * The card of `template` among the routines of its backend and its links. `connectors` are the names of this
 * computer's connectors, undefined while they are not known (nothing is then said to be missing).
 */
export function templateCard(input: {
  template: Template
  links: readonly TemplateLink[]
  routines: readonly Routine[]
  connectors?: readonly string[]
}): TemplateCard {
  const template = input.template
  const routine = input.routines.find((candidate) => candidate.definition.template?.id === template.id)
  const found = routine ? { routine } : {}
  if (template.mandatory) return { kind: "assigned", ...found }
  if (routine || input.links.some((link) => link.id === template.id)) return { kind: "active", ...found }
  const server = template.definition.options.connectors.find((name) => !input.connectors?.includes(name))
  if (input.connectors && server) return { kind: "requires", server }
  return { kind: "available" }
}

export const refKey = (ref: Ref) => `${ref.backend}/${ref.id}`
export const sameRef = (a?: Ref, b?: Ref) => !!a && !!b && a.backend === b.backend && a.id === b.id

/**
 * The Agents view's state over the routines Ipc: filters, the selected routine, its runs, Activity and the run viewer.
 * It reads routines and backends from the Ipc's state, and loads runs, transcripts and lookups on demand. Every read
 * is a plain function rather than a memo, so it follows the client's state wherever it is read.
 *
 * `client` is the window's routines client while the Ipc is active; every action is a no-op without it. `speak` puts
 * the backends' fields, which main writes in English, in the window's language.
 */
export function createAgentsModel(input: {
  client: () => Client | undefined
  where?: Where
  speak?: { t: Translate; locale: () => string }
}) {
  const [state, setState] = createStore({
    tab: "mine" as Tab,
    where: input.where ?? ("all" as Where),
    status: "all" as Status,
    search: "",
    selected: undefined as Ref | undefined,
    history: {} as Record<string, Page>,
    activity: {} as Record<string, Page>,
    choices: {} as Record<string, Choice[]>,
    templates: {} as Record<string, Offered>,
    viewer: undefined as Viewer | undefined,
    busy: {} as Record<string, boolean>,
    failure: undefined as Failure | undefined,
  })

  // One translated copy per backend and language: the form's field lists keep their identity while the user types.
  const spoken = new WeakMap<Capabilities, { locale: string; value: Capabilities }>()
  const speak = (capabilities: Capabilities) => {
    const language = input.speak
    if (!language) return capabilities
    const locale = language.locale()
    const cached = spoken.get(capabilities)
    if (cached?.locale === locale) return cached.value
    const value = { ...capabilities, fields: capabilities.fields.map((field) => fieldSaid(language.t, field)) }
    spoken.set(capabilities, { locale, value })
    return value
  }
  const backends = (): readonly Capabilities[] => (input.client()?.state()?.backends ?? []).map(speak)
  const routines = (): readonly Routine[] => input.client()?.state()?.routines ?? []
  const capabilities = (backend: string) => backends().find((candidate) => candidate.backend === backend)
  const inWhere = (where: Where, ref: Ref) => matchesWhere(where, capabilities(ref.backend))
  const needle = () => state.search.trim().toLocaleLowerCase()

  const model = {
    state,
    backends,
    routines,
    capabilities,
    /** The state has arrived from main; until then the view shows it is loading. */
    ready: () => input.client()?.state() !== undefined,
    count: (where: Where) => routines().filter((routine) => inWhere(where, routine.ref)).length,
    visible: () =>
      routines().filter(
        (routine) =>
          inWhere(state.where, routine.ref) &&
          matchesStatus(state.status, routine) &&
          routine.definition.name.toLocaleLowerCase().includes(needle()),
      ),
    selected: () => routines().find((routine) => sameRef(routine.ref, state.selected)),
    /** The routine a run belongs to, while it is listed. */
    routineOf: (run: Run) => routines().find((routine) => sameRef(routine.ref, run.routine)),
    history: (ref: Ref): Page => state.history[refKey(ref)] ?? { runs: [], loading: false },
    /** Every backend's runs, newest first, through the same Local and Remote filter as the list. */
    activity: () =>
      Object.values(state.activity)
        .flatMap((page) => page.runs)
        .filter((run) => inWhere(state.where, run.ref))
        .toSorted((a, b) => (runTime(b) ?? 0) - (runTime(a) ?? 0)),
    activityPage: () => {
      const pages = Object.values(state.activity)
      return {
        loading: pages.some((page) => page.loading),
        more: pages.some((page) => page.next !== undefined),
        failures: pages.flatMap((page) => (page.failure ? [page.failure] : [])),
      }
    },
    choices: (backend: string, lookup: string) => state.choices[`${backend}/${lookup}`] ?? [],
    /** The values of a lookup once read; undefined until then. */
    values: (backend: string, lookup: string) => state.choices[`${backend}/${lookup}`]?.map((choice) => choice.value),
    /**
     * The templates of every backend that has them, each with its card. A backend shows those that run where it does:
     * a local one `local` templates, a remote one `cloud` ones.
     */
    offered: () =>
      Object.entries(state.templates).flatMap(([backend, offered]) => {
        const where = capabilities(backend)?.kind === "remote" ? "cloud" : "local"
        const own = routines().filter((routine) => routine.ref.backend === backend)
        return (offered.value?.templates ?? [])
          .filter((template) => template.where === where)
          .map((template) => ({
            backend,
            template,
            card: templateCard({
              template,
              links: offered.value?.links ?? [],
              routines: own,
              connectors: model.values(backend, "connectors"),
            }),
          }))
      }),
    /** Whether any backend's templates are still being read, and the failures of the last reads. */
    offeredPage: () => {
      const pages = Object.values(state.templates)
      return {
        loading: pages.some((page) => page.loading),
        failures: pages.flatMap((page) => (page.failure ? [page.failure] : [])),
      }
    },
    busy: (key: string) => state.busy[key] === true,

    setTab: (tab: Tab) => setState("tab", tab),
    setWhere: (where: Where) => setState("where", where),
    setStatus: (status: Status) => setState("status", status),
    setSearch: (search: string) => setState("search", search),
    select: (ref: Ref) => setState("selected", { ...ref }),
    deselect: () => setState({ selected: undefined, viewer: undefined }),
    dismiss: () => setState("failure", undefined),
    /** Shows a failure from outside the model, such as "Create with Dynwork" not opening its conversation. */
    fail: (failure: Failure | undefined) =>
      setState("failure", failure ?? { code: "unreachable", message: "Dynwork's service is not running.", retryable: true }),
    closeViewer: () => setState("viewer", undefined),

    /** The routine's runs, the first page or, with `more`, the next one. */
    async loadHistory(ref: Ref, more = false) {
      const client = input.client()
      const key = refKey(ref)
      const page = model.history(ref)
      if (!client || (more && page.next === undefined)) return
      setState("history", key, { ...page, loading: true })
      const answer = await client.runs({ backend: ref.backend, routine: ref.id, cursor: more ? page.next : undefined })
      setState("history", key, paged(more ? page.runs : [], answer))
    },

    /** Every backend's runs for Activity, the first page or, with `more`, the next of each backend that has one. */
    async loadActivity(more = false) {
      const client = input.client()
      if (!client) return
      await Promise.all(
        backends().map(async (backend) => {
          const page = state.activity[backend.backend] ?? { runs: [], loading: false }
          if (more && page.next === undefined) return
          setState("activity", backend.backend, { ...page, loading: true })
          const answer = await client.runs({ backend: backend.backend, cursor: more ? page.next : undefined })
          setState("activity", backend.backend, paged(more ? page.runs : [], answer))
        }),
      )
    },

    /** The labels of a lookup, read once per backend, or again with `again`. */
    async loadChoices(backend: string, lookup: string, again = false) {
      const client = input.client()
      if (!client || (!again && state.choices[`${backend}/${lookup}`])) return
      const answer = await client.options({ backend, lookup })
      setState("choices", `${backend}/${lookup}`, isFailure(answer) ? [] : [...answer])
    },

    /**
     * Every backend's templates, with its connectors, so a card says which one is missing; `fresh` reads the connectors
     * again. A backend without templates (`unsupported`) shows none and no failure.
     */
    async loadTemplates(fresh = false) {
      const client = input.client()
      if (!client) return
      await Promise.all(
        backends().map(async (backend) => {
          const id = backend.backend
          const before = state.templates[id]
          setState("templates", id, { ...before, loading: true })
          const answer = await client.templates({ backend: id })
          if (!isFailure(answer)) await model.loadChoices(id, "connectors", fresh)
          setState(
            "templates",
            id,
            isFailure(answer)
              ? { value: before?.value, loading: false, ...(answer.code === "unsupported" ? {} : { failure: answer }) }
              : { value: answer, loading: false },
          )
        }),
      )
    },

    /** A run that changed, from the Ipc's `run` event or an action: it takes its place in every list that holds it. */
    received(run: Run) {
      const key = run.routine && refKey(run.routine)
      const history = key ? state.history[key] : undefined
      if (key && history) setState("history", key, { ...history, runs: merge(history.runs, run) })
      const activity = state.activity[run.ref.backend]
      if (activity) setState("activity", run.ref.backend, { ...activity, runs: merge(activity.runs, run) })
      if (state.viewer && sameRef(state.viewer.run.ref, run.ref)) setState("viewer", { ...state.viewer, run })
    },

    /**
     * Opens a run where it is read: a `transcript` in the viewer, which loads it and marks the run read. A `session`
     * run opens in its conversation and an `external` one in the browser, both done by the view; `none` has nothing.
     */
    async open(run: Run) {
      const client = input.client()
      if (!client || run.conversation.kind !== "transcript") return run.conversation.kind
      setState("viewer", { run, loading: true })
      const [transcript] = await Promise.all([
        client.transcript({ backend: run.ref.backend, run: run.ref.id }),
        run.unread ? client.viewed({ backend: run.ref.backend, run: run.ref.id }) : undefined,
      ])
      if (run.unread) model.received({ ...run, unread: false })
      // The user may have opened another run, or closed the viewer, meanwhile.
      if (!sameRef(state.viewer?.run.ref, run.ref)) return "transcript"
      setState(
        "viewer",
        isFailure(transcript) ? { failure: transcript, loading: false } : { transcript, loading: false },
      )
      return "transcript"
    },

    /** Starts a run now; the run joins the routine's history. */
    start: (routine: Routine) =>
      act(`start/${refKey(routine.ref)}`, async (client) => {
        const run = await client.start({ backend: routine.ref.backend, id: routine.ref.id })
        if (isFailure(run)) return run
        model.received(run)
        return undefined
      }),

    /** Pauses an active routine, resumes a paused one. */
    toggle: (routine: Routine) =>
      act(`toggle/${refKey(routine.ref)}`, (client) =>
        routine.state === "paused"
          ? client.resume({ backend: routine.ref.backend, id: routine.ref.id })
          : client.pause({ backend: routine.ref.backend, id: routine.ref.id }),
      ),

    /** Makes this computer the one that runs a routine of another one. */
    move: (routine: Routine) =>
      act(`move/${refKey(routine.ref)}`, (client) => client.move({ backend: routine.ref.backend, id: routine.ref.id })),

    remove: (routine: Routine) =>
      act(`remove/${refKey(routine.ref)}`, async (client) => {
        const failure = await client.remove({ backend: routine.ref.backend, id: routine.ref.id })
        if (!failure && sameRef(state.selected, routine.ref)) model.deselect()
        return failure
      }),

    cancel: (run: Run) =>
      act(`cancel/${refKey(run.ref)}`, (client) => client.cancel({ backend: run.ref.backend, run: run.ref.id })),
  }

  // One action at a time per key; a failure stays on screen until dismissed or the next action.
  async function act(key: string, call: (client: Client) => Promise<Failure | undefined>) {
    const client = input.client()
    if (!client || state.busy[key]) return
    setState("busy", key, true)
    setState("failure", undefined)
    const failure = await call(client)
    setState("busy", key, false)
    if (failure) setState("failure", failure)
  }

  return model
}

export type AgentsModel = ReturnType<typeof createAgentsModel>

function paged(before: readonly Run[], answer: Failure | { items: readonly Run[]; next?: string }): Page {
  if (isFailure(answer)) return { runs: before, loading: false, failure: answer }
  return { runs: [...before, ...answer.items], next: answer.next, loading: false }
}

// The run in place of its older copy, or first when it is new.
function merge(runs: readonly Run[], run: Run) {
  if (!runs.some((candidate) => sameRef(candidate.ref, run.ref))) return [run, ...runs]
  return runs.map((candidate) => (sameRef(candidate.ref, run.ref) ? run : candidate))
}
