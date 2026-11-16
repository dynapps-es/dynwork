import { Schema } from "effect"
import { createStore } from "solid-js/store"
import { base64Encode } from "@opencode/util/encode"
import type { Client } from "../../routines/client"
import { isFailure, type Failure, type Routine, type Run } from "../../routines/contract"
import { refKey, sameRef } from "../agents/model"

// The Runs panel's state, apart from how it is drawn (docs/04-ui.md §A.3.3): which sessions are a routine's, the
// routine's runs over the routines Ipc, the run the window routes, and what the panel does with it (reply, fork, mark
// read). The panel lists itself only on a routine's sessions: its anchor and its runs.

/** The panel's host key, `${plugin}:${tab}`. */
export const panelKey = "dynwork:runs"

/** What `metadata.dynwork` says on a routine's session: whose it is, and whether it is the anchor or a run. */
export interface Marker {
  readonly backend: string
  readonly routine: string
  readonly role: "anchor" | "run"
}

const Marked = Schema.Struct({
  dynwork: Schema.Struct({
    backend: Schema.String,
    routine: Schema.String,
    role: Schema.Literals(["anchor", "run"]),
  }),
})
const decodeMarked = Schema.decodeUnknownOption(Marked)

/** The routine marker of a session's metadata, as the local backend writes it; undefined for any other session. */
export function marker(metadata: unknown): Marker | undefined {
  const decoded = decodeMarked(metadata)
  return decoded._tag === "Some" ? decoded.value.dynwork : undefined
}

// JESÚS: a farm routine has no session here (docs/04-ui.md §B.5): its `Run`s carry
// `conversation: { kind: "transcript" }` and are read in the Agents view's viewer through `transcript(run)`, so the panel never lists itself for one. If the
// farm's runs are later imported as sessions under an anchor, write the same `metadata.dynwork` with `backend: "farm"`
// on them and the panel follows with no change.
/**
 * The routine a session belongs to, while the routine exists: by the session's metadata, else (its data not loaded
 * yet) as a routine's anchor, a child of it (`parent`), or its newest run, from the Ipc's state. A removed routine's
 * sessions have none.
 */
export function routineOf(input: {
  session: string
  metadata?: unknown
  /** The session's `parentID`, when its data has loaded. */
  parent?: string
  routines: readonly Routine[]
}) {
  const found = marker(input.metadata)
  if (found)
    return input.routines.find((routine) => sameRef(routine.ref, { backend: found.backend, id: found.routine }))
  return input.routines.find(
    (routine) =>
      (routine.conversation.kind === "session" &&
        (routine.conversation.anchor === input.session || routine.conversation.anchor === input.parent)) ||
      (routine.last?.conversation.kind === "session" && routine.last.conversation.session === input.session),
  )
}

/**
 * A session's route in the app, as `sessionHref` in `packages/app/src/shell/routes/session.ts` builds it. A link to it
 * is followed by the desktop's router in place: a run opens inside its anchor's tab.
 */
export function sessionHref(server: string, session: string) {
  return `/server/${base64Encode(server)}/session/${session}`
}

/** The route of a run read in a session; undefined for any other. */
export function runHref(run: Run) {
  if (run.conversation.kind !== "session") return undefined
  return sessionHref(run.conversation.server, run.conversation.session)
}

/** Where opening a routine's conversation goes: its newest run, as Claude Desktop does, else its anchor. */
export function routineHref(routine: Routine) {
  const last = routine.last && runHref(routine.last)
  if (last) return last
  if (routine.conversation.kind !== "session") return undefined
  return sessionHref(routine.conversation.server, routine.conversation.anchor)
}

/** A day of runs: `today`, `yesterday`, or the day itself as `YYYY-MM-DD` in the zone. */
export interface Day {
  readonly day: string
  readonly runs: readonly Run[]
}

/** The runs by day, in the order given (newest first), in `zone` or the system's. */
export function days(runs: readonly Run[], now: number, zone?: string): Day[] {
  const format = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" })
  const today = format.format(now)
  const yesterday = format.format(now - 24 * 60 * 60 * 1000)
  const name = (at: number) => {
    const day = format.format(at)
    if (day === today) return "today"
    if (day === yesterday) return "yesterday"
    return day
  }
  return runs.reduce<Day[]>((groups, run) => {
    const day = name(run.started ?? run.due ?? run.finished ?? now)
    const last = groups.at(-1)
    if (last?.day === day) return [...groups.slice(0, -1), { day, runs: [...last.runs, run] }]
    return [...groups, { day, runs: [run] }]
  }, [])
}

/** What the panel asks of the routed session's server, through the window's own client. */
export interface Sessions {
  /** Sends `text` to the run's session; its answer shows in the conversation. */
  prompt(session: string, text: string): Promise<unknown>
  /** Copies the run into a top-level conversation and answers its id. */
  fork(session: string): Promise<string>
}

export function createRunsModel(input: {
  client: () => Client | undefined
  routine: () => Routine | undefined
  /** The session the window routes. */
  routed: () => string
  session: Sessions
}) {
  const [state, setState] = createStore({
    /** Whose runs `runs` holds, so another routine's never show. */
    owner: undefined as string | undefined,
    runs: [] as Run[],
    next: undefined as string | undefined,
    loading: false,
    failure: undefined as Failure | undefined,
    reply: "",
    busy: {} as Record<string, boolean>,
  })

  const owned = () => {
    const routine = input.routine()
    return routine && state.owner === refKey(routine.ref) ? state.runs : []
  }

  const act = async <A>(key: string, work: () => Promise<A>) => {
    setState("busy", key, true)
    const answer = await work().catch(() => {
      setState("failure", { code: "failed", message: "The service did not answer.", retryable: false })
      return undefined
    })
    setState("busy", key, false)
    return answer
  }

  const model = {
    state,
    /** The routine's runs, newest first. */
    runs: owned,
    /** The routed run, when the window shows one of the routine's runs rather than its anchor. */
    current: () =>
      owned().find((run) => run.conversation.kind === "session" && run.conversation.session === input.routed()),
    canReply: () => model.current() !== undefined,
    busy: (key: string) => state.busy[key] === true,
    setReply: (text: string) => setState("reply", text),
    dismiss: () => setState("failure", undefined),

    /** The routine's runs, the first page or, with `more`, the next one. */
    async load(more = false) {
      const client = input.client()
      const routine = input.routine()
      if (!client || !routine || (more && state.next === undefined)) return
      const owner = refKey(routine.ref)
      setState("loading", true)
      const page = await client.runs({
        backend: routine.ref.backend,
        routine: routine.ref.id,
        cursor: more ? state.next : undefined,
      })
      // The window may have routed another routine meanwhile.
      if (refKey(input.routine()?.ref ?? routine.ref) !== owner) return
      if (isFailure(page)) return setState({ loading: false, failure: page })
      setState({
        owner,
        runs: more && state.owner === owner ? [...state.runs, ...page.items] : [...page.items],
        next: page.next,
        loading: false,
        failure: undefined,
      })
    },

    /** A run that changed, from the Ipc's `run` event or an action: it takes its place when it is the routine's. */
    received(run: Run) {
      const routine = input.routine()
      if (!routine || !sameRef(run.routine, routine.ref) || state.owner !== refKey(routine.ref)) return
      const index = state.runs.findIndex((candidate) => sameRef(candidate.ref, run.ref))
      if (index >= 0) return setState("runs", index, run)
      setState("runs", (runs) => [run, ...runs])
    },

    /** The routed run is on screen: once it has finished, it stops counting as unread. */
    async seen() {
      const client = input.client()
      const run = model.current()
      if (!client || !run?.unread) return
      model.received({ ...run, unread: false })
      await client.viewed({ backend: run.ref.backend, run: run.ref.id })
    },

    /** Runs the routine now; the run joins the list. */
    async start() {
      const client = input.client()
      const routine = input.routine()
      if (!client || !routine) return
      const run = await act("start", () => client.start({ backend: routine.ref.backend, id: routine.ref.id }))
      if (!run) return
      if (isFailure(run)) return setState("failure", run)
      model.received(run)
    },

    /** Pauses an active routine, resumes a paused one. */
    async toggle() {
      const client = input.client()
      const routine = input.routine()
      if (!client || !routine) return
      const ref = { backend: routine.ref.backend, id: routine.ref.id }
      const failure = await act("toggle", () => (routine.state === "paused" ? client.resume(ref) : client.pause(ref)))
      if (failure) setState("failure", failure)
    },

    /** Sends the reply box to the routed run. Answers whether it went. */
    async reply() {
      const run = model.current()
      const text = state.reply.trim()
      if (!run || run.conversation.kind !== "session" || text === "") return false
      const session = run.conversation.session
      const sent = await act("reply", () => input.session.prompt(session, text).then(() => true))
      if (sent) setState("reply", "")
      return sent === true
    },

    /** Copies the routed run into a conversation of its own; answers the new session's id. */
    async fork() {
      const run = model.current()
      if (!run || run.conversation.kind !== "session") return undefined
      const session = run.conversation.session
      return act("fork", () => input.session.fork(session))
    },
  }
  return model
}

export type RunsModel = ReturnType<typeof createRunsModel>
