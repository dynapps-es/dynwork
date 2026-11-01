import type { OpenCodeEvent } from "@opencode/client"
import { fixtures } from "#fixtures"
import { Project, Reduce, State } from "../src"
import type { Snapshot } from "../src"

// A recorded scenario (`bun dynwork/script/record-session.ts`) parsed back: its events and the snapshots taken while it ran.

export type Recorded = {
  name: string
  root: string
  sessions: string[]
  events: OpenCodeEvent[]
  snapshots: Array<{ label: string; after: number; snapshot: Snapshot }>
}

type Line =
  | { kind: "meta"; scenario: string; root: string; sessions: string[] }
  | { kind: "event"; event: OpenCodeEvent }
  | { kind: "snapshot"; snapshot: Snapshot & { label: string; after: number } }

export const names = Object.keys(fixtures)

export function load(name: string): Recorded {
  const lines = (fixtures[name] ?? "")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Line)
  const meta = lines.find((line) => line.kind === "meta")
  if (meta?.kind !== "meta") throw new Error(`${name}: no meta line`)
  return {
    name,
    root: meta.root,
    sessions: meta.sessions,
    events: lines.flatMap((line) => (line.kind === "event" ? [line.event] : [])),
    snapshots: lines.flatMap((line) =>
      line.kind === "snapshot"
        ? [{ label: line.snapshot.label, after: line.snapshot.after, snapshot: line.snapshot }]
        : [],
    ),
  }
}

export const desktop = "Studio Mac"

/** Every event, from nothing: what a client that was connected all along holds. */
export function replay(recorded: Recorded, events: ReadonlyArray<OpenCodeEvent> = recorded.events) {
  return Reduce.events(State.empty({ desktop }), events)
}

/** Everything the phone would draw for the scenario: the list, the root session and its children. */
export function view(state: State.State, recorded: Recorded) {
  return {
    sessions: Project.sessions(state),
    session: Project.session(state, recorded.root),
    children: recorded.sessions.slice(1).map((id) => Project.session(state, id)),
  }
}

/**
 * The blocks of every turn, without the clock: what must agree between two routes to the same state. A snapshot lists
 * only the permissions still waiting, so a route through one cannot show that a request was granted: those compare
 * with `approvals: false`.
 */
export function drawn(state: State.State, recorded: Recorded, options: { approvals: boolean } = { approvals: true }) {
  const all = recorded.sessions.map((id) => Project.session(state, id))
  return all.map((session) => ({
    turns: session?.turns.map((turn) => ({
      user: turn.user?.text,
      status: turn.status,
      blocks: turn.blocks.map((block) =>
        block.kind === "toolGroup" && !options.approvals
          ? { ...block, tools: block.tools.map((tool) => ({ ...tool, approval: undefined })) }
          : block,
      ),
    })),
    background: session?.background,
    needs: session?.needs,
    status: session?.row.status,
  }))
}
