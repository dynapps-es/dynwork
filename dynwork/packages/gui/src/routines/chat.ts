export * as RoutinesChat from "./chat"

import { Schema } from "effect"
import type { OpenCodeClient } from "@opencode/client/promise"
import type { MainContext } from "@opencode/plugin/gui/main"
import { DynWorkRoutines } from "@dynwork/server-plugin/routines"
import { fail, type Registry } from "./backend"
import { Chat, chatPrompt, Definition, isFailure, type Card, type Failure, type Routine } from "./contract"
import { RoutinesFarm } from "./farm/backend"
import { RoutinesLocal } from "./local/backend"
import en from "../views/agents/en"
import { scheduleText } from "../views/agents/format"
import { cronOf, scheduleProblem, upcoming, type Preset } from "../views/agents/schedule"

// Routines from a chat ("Create with Dynwork"), main's side. The `routines_list` and `routines_create` tools of the
// server plugin (`@dynwork/server-plugin/routines`) publish requests on its RPC; main follows them, answers a list at
// once, and turns a proposal into a routine `Definition`, validates it with the schema and the backend the form uses,
// and shows it as a card in the windows (the `dynwork.routines.chat` Ipc). Only the card's Schedule creates it, here,
// through the routines Ipc; Cancel, a refusal and a withdrawn request create nothing. The agent never creates a routine:
// the session's permissions ("Don't ask" too) and the app's auto-approve play no part, as the card is not a permission.

export interface Options {
  registry: Registry
  /** Whether the `farm` backend is the Agent Farm's (`RoutinesFarm.enabled`), not its demo. */
  farm: boolean
  /** Sends main's answer to the waiting tool. */
  answer: (answer: DynWorkRoutines.Answer) => Promise<unknown>
  /** Creates through the routines Ipc, so the windows read the new routine. */
  create: (backend: string, definition: Definition) => Promise<Routine | Failure>
  /** The cards changed. */
  changed: () => void
  now: () => number
}

/** The chat's logic, with no service and no window: what `setup` wires, and what the tests drive. */
export function make(options: Options) {
  const cards = new Map<string, Card>()
  // Requests being handled or shown, so the same one arriving by event and by `pending` is handled once.
  const known = new Set<string>()

  const reply = (id: string, text: string, error: boolean) => options.answer({ id, text, error }).catch(() => undefined)

  async function list(request: DynWorkRoutines.Request) {
    const lines = await Promise.all(
      backends().map(async (id) => {
        const backend = options.registry.get(id)
        if (!backend) return []
        const label = (await backend.capabilities()).label
        const routines = await backend.list()
        if (isFailure(routines)) return [`- ${label}: could not be read (${routines.message})`]
        return routines.map((routine) => describe(routine, label))
      }),
    )
    const all = lines.flat()
    // The connectors a local routine may name, so the agent proposes real ones.
    const connectors = await options.registry.get(RoutinesLocal.id)?.options("connectors")
    const available =
      connectors && !isFailure(connectors)
        ? `\nConnectors available to local routines: ${connectors.map((choice) => choice.value).join(", ") || "none"}.`
        : ""
    await reply(request.id, (all.length === 0 ? "The user has no routines yet." : all.join("\n")) + available, false)
  }

  async function propose(request: DynWorkRoutines.Request, proposal: DynWorkRoutines.Proposal) {
    const where = proposal.where ?? "local"
    const id = where === "farm" ? RoutinesFarm.id : RoutinesLocal.id
    const backend = options.registry.get(id)
    if (where === "farm" && !options.farm)
      return refuse(request.id, fail("unsupported", "The Agent Farm is not available in this Dynwork yet."))
    if (!backend) return refuse(request.id, fail("unreachable", "Dynwork cannot reach where this routine would run."))
    const built = definitionOf(proposal, options.now())
    if (isFailure(built)) return refuse(request.id, built)
    // The same checks as the form's: the `Definition` schema, then the backend's own `validate`. JESÚS: a farm proposal
    // reaches your `validate` here and, once the user presses Schedule, your `create`.
    const decoded = Schema.decodeUnknownExit(Definition)(built)
    if (decoded._tag === "Failure") return refuse(request.id, fail("invalid", "The proposal is not a routine."))
    const invalid = await backend.validate(decoded.value).catch(() => fail("failed", "The routine could not be checked."))
    if (invalid) return refuse(request.id, invalid)
    if (!known.has(request.id)) return
    const label = (await backend.capabilities()).label
    cards.set(request.id, { id: request.id, session: request.session, backend: id, label, definition: decoded.value, proposal })
    options.changed()
  }

  async function refuse(id: string, failure: Failure) {
    known.delete(id)
    const fields = Object.entries(failure.fields ?? {}).map(([key, message]) => `\n- ${key}: ${message}`)
    await reply(id, `Not proposed: ${failure.message}${fields.join("")}\nNothing was created.`, true)
  }

  function request(input: DynWorkRoutines.Request) {
    if (known.has(input.id)) return Promise.resolve()
    known.add(input.id)
    if (input.kind === "list") return list(input).finally(() => known.delete(input.id))
    if (!input.proposal) return refuse(input.id, fail("invalid", "The proposal is missing."))
    return propose(input, input.proposal)
  }

  function withdraw(id: string) {
    known.delete(id)
    if (cards.delete(id)) options.changed()
  }

  return {
    request,
    withdraw,
    /** The requests still waiting in the service, read after (re)connecting: new ones are handled, gone ones dropped. */
    sync: async (waiting: readonly DynWorkRoutines.Request[]) => {
      const ids = new Set(waiting.map((item) => item.id))
      cards.forEach((card) => {
        if (!ids.has(card.id)) withdraw(card.id)
      })
      await Promise.all(waiting.map(request))
    },
    cards: () => [...cards.values()],
    /** The card's answer. The card leaves before anything is created, so a second answer (another window) finds none. */
    decide: async (id: string, schedule: boolean) => {
      const card = cards.get(id)
      if (!card) return fail("not-found", "This proposal is no longer waiting.")
      cards.delete(id)
      known.delete(id)
      options.changed()
      if (!schedule) {
        await reply(id, "The user cancelled: nothing was created. Ask what to change before proposing again.", true)
        return undefined
      }
      const created = await options.create(card.backend, card.definition)
      if (isFailure(created)) {
        await reply(id, `The routine could not be created: ${created.message}`, true)
        return created
      }
      await reply(id, `Created the routine. It is in Agents.\n${describe(created, card.label)}`, false)
      return undefined
    },
  }
}

export type Logic = ReturnType<typeof make>

// The service's events main follows, and how long it waits before following them again after the stream ended.
const REQUEST = `rpc.${DynWorkRoutines.id}.request` as const
const WITHDRAW = `rpc.${DynWorkRoutines.id}.withdraw` as const
const RETRY = 2_000
const decodeRequest = Schema.decodeUnknownOption(DynWorkRoutines.Request)
const decodeWithdrawn = Schema.decodeUnknownOption(DynWorkRoutines.Withdrawn)
const decodePending = Schema.decodeUnknownOption(DynWorkRoutines.Pending)

/**
 * Sets the chat up in main, beside the routines (`RoutinesMain.setup`): the `dynwork.routines.chat` Ipc, and the
 * following of the server plugin's requests on DynWork's service for as long as the app runs.
 */
export function setup(
  ctx: MainContext,
  input: {
    registry: Registry
    farm: boolean
    client: () => OpenCodeClient | undefined
    create: Options["create"]
    server: string
    home: string
  },
) {
  const call = async (method: string, value: unknown) => {
    const client = input.client()
    if (!client) return undefined
    return (await client.rpc.call({ rpcID: DynWorkRoutines.id, method, input: value as never })).output
  }
  const provider = { changed: () => {} }
  const chat = make({
    registry: input.registry,
    farm: input.farm,
    answer: (answer) => call("answer", answer),
    create: input.create,
    changed: () => provider.changed(),
    now: Date.now,
  })
  const ipc = ctx.provide(Chat, {
    state: () => ({ cards: chat.cards() }),
    decide: (value) => chat.decide(value.id, value.schedule),
    start: async () => {
      const client = input.client()
      if (!client) return fail("unreachable", "Dynwork's service is not running.")
      const session = await client.session
        .create({ title: "New routine", location: { directory: input.home } })
        .catch(() => undefined)
      if (!session) return fail("failed", "The conversation could not be opened.")
      const sent = await client.session
        .prompt({ sessionID: session.id, text: chatPrompt })
        .then(() => true)
        .catch(() => false)
      if (!sent) return fail("failed", "The conversation could not be started.")
      return { server: input.server, session: session.id }
    },
  })
  provider.changed = () => ipc.changed()

  const life = new AbortController()
  ctx.onCleanup(() => life.abort())
  void (async () => {
    while (!life.signal.aborted) {
      const client = input.client()
      if (client) await follow(client, chat, call, life.signal).catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, RETRY))
    }
  })()
}

// One subscription: after each (re)connection the requests published while main was away are read with `pending`.
async function follow(
  client: OpenCodeClient,
  chat: Logic,
  call: (method: string, value: unknown) => Promise<unknown>,
  signal: AbortSignal,
) {
  for await (const event of client.event.subscribe({ types: [REQUEST, WITHDRAW], signal })) {
    if (event.type === "server.connected") {
      const pending = decodePending(await call("pending", {}).catch(() => undefined))
      if (pending._tag === "Some") void chat.sync(pending.value.requests)
    }
    if (event.type === REQUEST) {
      const request = decodeRequest(event.data)
      if (request._tag === "Some") void chat.request(request.value)
    }
    if (event.type === WITHDRAW) {
      const withdrawn = decodeWithdrawn(event.data)
      if (withdrawn._tag === "Some") chat.withdraw(withdrawn.value.id)
    }
  }
}

function backends() {
  return [RoutinesLocal.id, RoutinesFarm.id]
}

/** A proposal in the form's terms as a routine `Definition`, or what keeps it from being one. */
export function definitionOf(proposal: DynWorkRoutines.Proposal, now: number): Definition | Failure {
  const timezone = proposal.timezone ?? DynWorkRoutines.zone
  const preset = presetOf(proposal)
  const problem = preset && scheduleProblem(preset)
  if (problem) return fail("invalid", "The schedule is not complete.", { schedule: words(problem) })
  const cron = preset && cronOf(preset)
  const schedule = cron ? { cron, timezone } : undefined
  if (schedule && upcoming(schedule, now, 1).length === 0)
    return fail("invalid", "The schedule cannot be read.", { schedule: `"${cron}" in ${timezone}` })
  return {
    name: proposal.name.trim(),
    instructions: { kind: "prompt", text: proposal.instructions },
    ...(schedule ? { schedule } : {}),
    enabled: true,
    options: {
      permissions: proposal.permissions ?? "ask",
      notify: proposal.notify ?? "failures",
      ...(proposal.folder ? { folder: proposal.folder } : {}),
      ...(proposal.connectors ? { connectors: [...proposal.connectors] } : {}),
    },
  }
}

function presetOf(proposal: DynWorkRoutines.Proposal): Preset | undefined {
  const time = proposal.time ?? ""
  if (proposal.repeat === "manual") return undefined
  if (proposal.repeat === "cron") return { kind: "cron", cron: proposal.cron ?? "" }
  if (proposal.repeat === "weekly") return { kind: "weekly", time, days: proposal.days ?? [] }
  if (proposal.repeat === "monthly") return { kind: "monthly", time, day: proposal.day ?? 0 }
  return { kind: proposal.repeat, time }
}

/** One line of a routine for the agent, in the Agents view's own English words. */
function describe(routine: Routine, label: string) {
  const text = routine.definition.instructions.kind === "prompt" ? routine.definition.instructions.text : ""
  const what = text.split("\n")[0]?.slice(0, 120) ?? ""
  return `- ${routine.definition.name} · ${label} · ${scheduleText(words, routine.definition.schedule)} · ${routine.state}${what ? ` · ${what}` : ""}`
}

// The English table of the Agents view, read without a window.
function words(key: string, params: Record<string, string | number> = {}) {
  const table: Record<string, string> = en
  return (table[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(params[name] ?? ""))
}
