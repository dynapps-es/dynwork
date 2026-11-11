import { describe, expect, test } from "bun:test"
import {
  selectSession,
  transitionModelSelection,
  createModelSelectionState,
  type ModelChoice,
  type ModelSelectionEvent,
} from "../../../../../packages/app/src/providers/models/selection-machine"

// The phone switches a Session's model through the prompt API. The desktop composer must then show that model, not the
// one picked there before (the `commit.reconciled` patch in PATCHES.md).
const choice = (modelID: string, variant?: string): ModelChoice => ({
  providerID: "provider",
  modelID,
  variant: variant ? { type: "named", value: variant } : { type: "default" },
})

const durable = (modelID: string, variant?: string) => ({
  agent: "build",
  model: { providerID: "provider", id: modelID, variant },
})

const reconciled = (modelID: string, variant?: string): ModelSelectionEvent => ({
  type: "commit.reconciled",
  sessionID: "ses_a",
  visible: false,
  durable: durable(modelID, variant),
})

const picked = [
  {
    type: "edited",
    sessionID: "ses_a",
    edit: { type: "agent", agent: "build", previous: { agent: "plan", choice: choice("c") } },
  },
  { type: "edited", sessionID: "ses_a", edit: { type: "model", agent: "build", choice: choice("a", "high") } },
] satisfies ModelSelectionEvent[]

const local = picked.reduce(
  (state, event) => transitionModelSelection(state, event).state,
  createModelSelectionState({ status: "ready", sessions: {} }),
)

describe("a model another client commits", () => {
  test("replaces a different local selection and keeps each agent's last model", () => {
    const next = transitionModelSelection(local, reconciled("b"))

    expect(selectSession(next.state, "ses_a")).toEqual({ phase: "committed", choices: { plan: choice("c") } })
    expect(next.effects).toEqual([
      { type: "persist.write", sessionID: "ses_a", selection: { choices: { plan: choice("c") } } },
    ])
  })

  test("leaves a local selection that is the same one", () => {
    expect(transitionModelSelection(local, reconciled("a", "high")).state).toBe(local)
  })
})
