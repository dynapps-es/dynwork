export * as RoutinesFarm from "./backend"

import { fail, type Backend } from "../backend"
import type { Capabilities, Choice, Failure, Field } from "../contract"

/**
 * The Agent Farm's routines backend: a skeleton. It type-checks against `Backend`, declares the farm's fields as the
 * approved mockup shows them, and answers `not implemented` to everything else. `README.md` next to this file is the
 * handover: read it first. There is no farm HTTP client here, and no token handling.
 */

/** The id every `routine.ref.backend` of the farm carries, and the one the demo remote fake holds until this lands. */
export const id = "farm"

/** Set to `1` in the environment of the DynWork app to register this skeleton in place of the remote demo fake. */
export const flag = "DYNWORK_ROUTINES_FARM"

/** Without the flag the remote demo fake is the farm, as it has been since phase 01. */
export function enabled(env: Readonly<Record<string, string | undefined>>) {
  return env[flag] === "1"
}

/** What every method that is not written yet answers. `isNotImplemented` tells it from a real failure. */
const prefix = "Cloud is not implemented yet"

export function isNotImplemented(value: unknown): value is Failure {
  return (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string" &&
    value.message.startsWith(prefix)
  )
}

function notImplemented(method: string) {
  return fail("failed", `${prefix}: ${method}. See routines/farm/README.md.`)
}

const select = (key: string, section: string, label: string, choices: readonly Choice[], fallback?: string): Field => ({
  key,
  section,
  label,
  kind: "select",
  choices,
  default: fallback,
})

/**
 * The fields the form paints under "Agent Farm options" and in the remote sections of the detail, as the mockup shows
 * them. The demo remote fake declares the same ones, so the form behaves the same before and after this lands.
 */
// JESÚS: this is the starting `Capabilities.fields` list. Replace its static choices and `max` values with what the
// farm says at runtime (`GET /whoami` for `limits`, `GET /plugins` through `options("plugins")`, `GET /credentials`
// through `options("credentials:git_token")`) and add the fields the mockup does not show yet: MCP servers (`list`, at
// most 5), CPU, memory, work size and the schedule window. `capped` and `budget` are in the mockup but have no farm
// counterpart (a task has no cost limit): remove both from `fields` unless the farm adds one (README, "What the farm
// is missing").
export const fields: readonly Field[] = [
  { key: "repository", section: "workspace", label: "Repository", kind: "repo", required: true },
  { key: "branch", section: "workspace", label: "Branch or tag", kind: "text", default: "main" },
  {
    key: "access",
    section: "workspace",
    label: "Repository access",
    kind: "select",
    lookup: "credentials:git_token",
    help: "A stored credential the farm uses to clone.",
  },
  { key: "plugins", section: "plugins", label: "Plugins", kind: "multiselect", lookup: "plugins", max: 10 },
  { key: "timeLimit", section: "limits", label: "Time limit (minutes)", kind: "number", min: 1, max: 60, default: 15 },
  { key: "capped", section: "limits", label: "Cap the cost", kind: "toggle", default: false },
  {
    key: "budget",
    section: "limits",
    label: "Most to spend per run (EUR)",
    kind: "number",
    min: 0.1,
    max: 50,
    required: true,
    when: { key: "capped", equals: true },
  },
  select(
    "overlap",
    "schedule",
    "If the previous run is still going",
    [
      { value: "skip", label: "Skip this one" },
      { value: "allow", label: "Run anyway" },
    ],
    "skip",
  ),
  select(
    "profile",
    "advanced",
    "Profile",
    [
      { value: "standard", label: "Standard" },
      { value: "large", label: "Large" },
    ],
    "standard",
  ),
  { key: "label", section: "advanced", label: "Label", kind: "text" },
]

/**
 * What the farm can do, as the views read it. Its `status` is the one thing the skeleton changes: see `make`.
 */
// JESÚS: this is the farm's `Capabilities` as the mockup shows it: prompt or catalogue agent (`instructions`), the
// agent fixes the model (`model: "agent"`, shown from `AgentOut.model_alias`), a schedule window, an edit that
// replaces the schedule (`actions.edit: "replace"`, the farm has no PATCH) and a reply that resumes
// (`actions.reply: "resume"`, `POST /tasks` with `session_ref`). Keep it, and drop `prompt` from `instructions` when
// `GET /whoami` says `free_prompt` is false.
export const base: Omit<Capabilities, "backend" | "quota"> = {
  kind: "remote",
  label: "Cloud",
  status: "ready",
  instructions: ["prompt", "agent"],
  agent: "none",
  model: "agent",
  schedule: { window: true, minimum: 5 },
  actions: { edit: "replace", reply: "resume", cancel: true },
  fields,
}

/**
 * The skeleton, registered only when `enabled(process.env)` says so (see `routines/main.ts`). It reports itself
 * `disabled`, so the views show the farm as unavailable with the reason, and every method answers `not implemented`.
 */
// JESÚS: `make` takes what your client needs (the farm's base URL, a function that reads the token) and returns the
// real `Backend`. Both come from main, never from a window: the token is read in main from `safeStorage` ciphertext
// kept in the plugin's storage, as `accounts/accounts.ts` keeps the PAT, and it is never put in a `Routine`, a
// `Failure`, a log line or anything else the Ipc carries. With no token, `capabilities()` answers
// `status: "signed-out"`.
export function make(): Backend {
  return {
    id,
    // JESÚS: `capabilities()` always answers, whatever the farm does: `ready` when `GET /whoami` works,
    // `signed-out` with no token or a `401`, `unreachable` when the network fails. `quota` is the tenant's schedule
    // limit and how many the team holds (`GET /schedules`): `{ max: 20, used, shared: true }`.
    capabilities: async () => ({
      ...base,
      backend: id,
      status: "disabled",
      detail: "Cloud is not connected yet (routines/farm/README.md).",
    }),
    // JESÚS: `options(lookup)` serves `agents` (`GET /agents`), `plugins` (`GET /plugins`) and
    // `credentials:git_token` (`GET /credentials`, keeping `type: git_token`). Any other lookup is `not-found`.
    options: async () => notImplemented("options"),
    // JESÚS: `validate(definition)` runs `RoutinesValidate.check(capabilities, definition)` first, then adds what only
    // the farm knows (a tenant limit lower than `Field.max`, an unknown agent) as `Failure` `invalid` with `fields`.
    validate: async () => notImplemented("validate"),
    // JESÚS: `list()` is `GET /schedules` plus the table of names (the farm has no schedule name), one `Routine` each,
    // with `state` from `ScheduleOut.state`, `next` from `next_fire_at` and `last` from the newest task.
    list: async () => notImplemented("list"),
    // JESÚS: `get(id)` is `GET /schedules/{id}`; a `404` is `not-found`.
    get: async () => notImplemented("get"),
    // JESÚS: `create(definition)` is `POST /schedules` with `task`, `recurrence` and `overlap` from `Definition` and
    // `Definition.options`. A `Definition` with no `schedule` has no place in the farm: keep it in DynWork's own table
    // and make `start` a `POST /tasks`. A full tenant is `Failure` `quota`.
    // JESÚS: `Definition.template` (`{ id, revision }`, a task activated from a template) has no place in the farm
    // either: keep it in the same DynWork table and give it back untouched from `get`, `list` and `update`.
    create: async () => notImplemented("create"),
    // JESÚS: `update(id, definition)` creates the new schedule and then deletes the old one, answering a `Routine` with
    // a new `ref`: `actions.edit` is `replace`. The table of names keeps the chain of ids so the history stays whole.
    update: async () => notImplemented("update"),
    // JESÚS: `remove(id)` is `DELETE /schedules/{id}`; the finished tasks stay in the farm and in `runs`.
    remove: async () => notImplemented("remove"),
    // JESÚS: `pause(id)` is `POST /schedules/{id}/pause`.
    pause: async () => notImplemented("pause"),
    // JESÚS: `resume(id)` is `POST /schedules/{id}/resume`.
    resume: async () => notImplemented("resume"),
    // JESÚS: `start(id)` is `POST /schedules/{id}/fire`, answering the `Run` the new task makes: `trigger: "manual"`,
    // `conversation: { kind: "transcript" }`. A routine with no schedule starts a task with `POST /tasks` instead.
    start: async () => notImplemented("start"),
    // JESÚS: `cancel(run)` is `DELETE /tasks/{id}` on a task still going; a finished one is `Failure` `conflict`.
    cancel: async () => notImplemented("cancel"),
    // JESÚS: `runs({ routine, cursor })` is `GET /schedules/{id}/tasks` (the farm does not page it, so page it here)
    // and, without `routine`, `GET /tasks` newest first for Activity. Map `Run.state` as README's table says.
    runs: async () => notImplemented("runs"),
    // JESÚS: `transcript(run)` is `GET /tasks/{id}/result` for `Transcript.result` and `GET /tasks/{id}/logs` for the
    // `log` tail; `usage` comes from `TaskOut.usage`. The full log is a signed URL, asked for only when pressed.
    transcript: async () => notImplemented("transcript"),
    // JESÚS: `viewed(run)` marks the run read. The farm has no read state: keep it in DynWork's table with the names.
    viewed: async () => {},
    // JESÚS: `watch(changed)` polls `GET /tasks?updated_since=<cursor minus 30 s>` only while subscribed, calling
    // `changed` with each `Change` (the `Run`, and its `routine` when it is one of ours). The Ipc subscribes once.
    watch: () => () => {},
  }
}
