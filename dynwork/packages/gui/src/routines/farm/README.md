# The Agent Farm backend: handover

For Jesús Vargas. DynWork's Agents view already works end to end against a fake farm. This folder is the place where
the real one plugs in. What is here is a skeleton that type-checks against `Backend`, declares the farm's form fields,
and answers "not implemented" to everything else. You write the methods; the Ipc, the registry, the views and the test
suite need no changes. Search the repository for `JESÚS:` to find every hook: each names the
contract piece it implements.

The long-form design (`docs/04-ui.md`, `docs/mockup-agents.html`) lives in David's local plan folder, which is not in
git. This README repeats what you need from it; ask David for the rest.

Files here:

| File         | What it is                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------ |
| `backend.ts` | `RoutinesFarm`: the skeleton `make()`, the farm's `fields`, its `base` capabilities and the development flag |
| `README.md`  | This document                                                                                                |

Not here, on purpose: any farm HTTP call, any token handling. See "Where the token lives" for where they go.

## 1. What a routine is, and how the user sees it

A **routine** is an agent, its instructions and a trigger (a schedule, or "only when I start it"), plus where it runs:
**Local** (this computer) or **Remote** (the farm). In the UI it is called a "routine", never an "agent": "agent" is the
definition in both worlds (an OpenCode agent, a farm catalogue agent). The view is still called **Agents**.

- One list for every routine, local and remote. Chips `All | Local | Remote` only narrow it; each card has a badge for
  where it runs ("Agent Farm" for yours). Tabs: My routines, Templates, Activity (every run, including farm tasks that
  were started outside DynWork).
- The detail page has the same layout for both kinds: History on the left (every run with its state and reason), and
  on the right Instructions, Repeats (the next three), Where and with what, Permissions, Notifications. For a farm
  routine it adds a dashed "Agent Farm options" block, painted from your `capabilities().fields`.
- Actions: Open (for a farm routine, the read-only viewer of its latest run), Run now, Pause/Resume, Edit, Duplicate,
  Remove. An action your backend cannot do is shown disabled with the reason taken from `capabilities`.
- Clicking a farm run opens a read-only viewer: the result in Markdown, usage and cost, the tail of the log, "Download
  full log" (a signed URL asked for on click) and "Continue" (a new task with `session_ref`). Farm runs are not
  sessions, so the Runs side panel never lists itself for them.
- One form creates and edits, with the same layout for both kinds: common fields (name, what to do, schedule, on/off)
  and then the backend's sections, painted from `capabilities().fields`.

To see it now, start DynWork from this branch: the farm you see in the list is the **demo fake** (`demo.ts`,
`RoutinesDemo.remote`), shaped like the approved mockup. Read it as the target behavior of your backend, from the
fields it declares to the transcripts it serves. Screenshots of the view and the form with the fake are attached to the
PR of the canary review, not committed here.

## 2. The contract

Everything crossing to a window is a Schema value (epoch milliseconds for time). The contract is two files:

- `../contract.ts`: the data (`Definition`, `Routine`, `Run`, `Capabilities`, `Field`, `Failure`, `Transcript`,
  `RunPage`, `Change`) and the `dynwork.routines` Ipc.
- `../backend.ts`: `interface Backend`, the registry, and `fail(code, message, fields?)`, which builds a `Failure`.

`../README.md` is the reference for both; the points that matter to you:

- **Failures are data.** A backend never rejects. It answers a `Failure` (`signed-out`, `unreachable`, `invalid` with a
  message per field, `quota`, `conflict`, `not-found`, `unsupported`, `failed`) instead of the value. An Ipc rejection
  reaches a window as plain text, and the Ipc turns a rejection it did not expect into a `failed` with a fixed message,
  because yours may carry a credential. Methods that touch the network (`options`, `list`, `runs`) can answer one too.
- **`capabilities()` never fails.** A backend that cannot serve says so in `status` (`ready`, `signed-out`,
  `unreachable`, `disabled`) and `detail`. The views read what to enable, disable and paint from it.
- **The field rule: the farm's options are `fields`, not code in a view.** Everything farm-specific the user can set
  (repository, branch, repository access, plugins, MCP servers, limits, overlap, profile, label...) is a
  `Field` in `capabilities().fields`, with a `section`, a `kind` (`text`, `textarea`, `number`, `toggle`, `select`,
  `multiselect`, `folder`, `repo`, `list`), `choices` or a `lookup` that `options(lookup)` answers, `min`/`max`,
  `required`, `default` and `when` (shown only while another field has that value). Its value travels in
  `Definition.options[field.key]`. No view special-cases the farm; if you need a control that does not exist, extend
  `Field.kind` and the form, do not special-case.
- **A `Definition` is what the user edits:** `name`, `instructions` (a `prompt`, a `skill` or a farm `agent` with its
  `input`), optional `agent` and `model`, an optional `schedule` (five-field cron, an IANA zone, optional `starts`,
  `ends`, `max`), `enabled`, and `options`.
- **A `Run`** has a `state` (`queued`, `running`, `ok`, `late`, `failed`, `blocked`, `missed`, `skipped`, `cancelled`),
  a machine `reason`, a `trigger` (`schedule`, `manual`, `catch-up`), times, a `title`, a `summary`, a `cost`, `unread`
  and a `conversation`. Yours is always `{ kind: "transcript" }`: the view reads it through `transcript(run)`.
- **Ids.** A routine or run is addressed by `ref: { backend: "farm", id }`. `update` may answer a routine with a new
  `ref` (see edit below).
- **`watch(changed)`.** The farm has no push. Poll inside, only while subscribed. The Ipc subscribes once however many
  windows watch.

## 3. Contract to farm

The farm's base is `/farm/api/v1` (the short form below). Every call needs `Authorization: Bearer <token>`.

| Contract                     | Farm                                                                                                                                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capabilities()`             | `GET /whoami` (`free_prompt`, scopes, limits). `quota` is the tenant's schedule limit (20, shared) and how many exist.                                                                                               |
| `options("agents")`          | `GET /agents?scope=platform\|team\|personal` (`AgentOut`: `slug`, `description`, `model_alias`, `requires_workspace`...)                                                                                             |
| `options("plugins")`         | `GET /plugins`                                                                                                                                                                                                       |
| `options("credentials:...")` | `GET /credentials?scope=...`, keeping `type: git_token` for repository access                                                                                                                                        |
| `list()`, `get(id)`          | `GET /schedules`, `GET /schedules/{id}` (`ScheduleOut`: `state active\|paused\|finished`, `next_fire_at`, `last_fired_at`, `last_fire_state`, `missed_runs`, `runs_count`)                                           |
| `create` with a `schedule`   | `POST /schedules { task, recurrence { cron, timezone, starts_at?, ends_at?, max_runs? }, overlap skip\|allow }`                                                                                                      |
| `create` with no `schedule`  | The farm has no place for it (only loose tasks and schedules). Keep the definition in DynWork's own table; `start` is then `POST /tasks`.                                                                            |
| `name`                       | The farm has no schedule name. Keep a DynWork table `scheduleId -> { name, description }` (local or in Governance), or ask the farm for `name`/`labels` on `ScheduleCreate` (a backwards-compatible addition to v1). |
| `instructions.prompt`        | `task.prompt`, only when `whoami.free_prompt`                                                                                                                                                                        |
| `instructions.agent`         | `task.agent_id` plus `task.input` (required)                                                                                                                                                                         |
| `instructions.skill`         | No direct equivalent: a marketplace plugin or a `<plugin>:<agent>` agent. `capabilities().instructions` leaves `skill` out.                                                                                          |
| `model`                      | `capabilities().model` is `"agent"`: the agent fixes it. Show `AgentOut.model_alias`. The task has no `model`.                                                                                                       |
| `update(id, definition)`     | `POST /schedules` for the new one, then `DELETE /schedules/{id}` for the old: the `ref` changes (`actions.edit` is `replace`). The history splits across ids, so the DynWork table keeps the chain of ids.           |
| `pause`, `resume`            | `POST /schedules/{id}/pause`, `POST /schedules/{id}/resume`                                                                                                                                                          |
| `start(id)`                  | `POST /schedules/{id}/fire`; answer the `Run` of the task it makes, `trigger: "manual"`                                                                                                                              |
| `remove(id)`                 | `DELETE /schedules/{id}`; its finished tasks stay in the farm, so they stay in `runs`                                                                                                                                |
| `runs({ routine })`          | `GET /schedules/{id}/tasks` (the farm does not page it: page it here)                                                                                                                                                |
| `runs({})` (Activity)        | `GET /tasks`, newest first, paged with `next`; includes tasks started outside DynWork (their `Run.routine` is absent)                                                                                                |
| `watch`                      | `GET /tasks?updated_since=<last cursor minus 30 s>`, only while subscribed                                                                                                                                           |
| `cancel(run)`                | `DELETE /tasks/{id}` (it cancels, it deletes nothing). `409 task_not_cancellable` is `conflict`.                                                                                                                     |
| `transcript(run)`            | `GET /tasks/{id}/result` (plain text, Markdown) plus `GET /tasks/{id}/logs` (the tail; the full `.jsonl` is a signed URL, ~5 minutes, asked for only on click). `usage` comes from `TaskOut.usage`.                  |
| `actions.reply` is `resume`  | A reply is `POST /tasks { session_ref, ... }`: a new run of the same routine. The contract has no method for it yet: add one (see the `JESÚS:` in `views/agents/viewer.tsx`).                                        |
| `viewed(run)`                | The farm has no read state. Keep it in the DynWork table.                                                                                                                                                            |

`RunState`: `pending` and `queued` are `queued`; `running` is `running`; `succeeded` is `ok`; `failed` is `failed` and
`TaskOut.failure_reason` is the `reason`; `cancelled` is `cancelled`; `expired` is `failed`; a schedule's
`last_fire_state` of `skipped_overlap` or `skipped_quota` is `skipped` with `reason` `overlap` or `quota`. `late`,
`blocked` and `missed` are produced by DynWork's own clock for local routines; the farm gives none of them.

Odd cases, decided so that you do not have to:

- **Editing is replacing.** `capabilities().actions.edit` is `replace`: the form tells the user "Edit creates a new
  schedule", and the conformance suite expects the old `ref` to answer `not-found` afterwards.
- **The name is not the farm's.** Until the farm stores one, it is DynWork's table. That table is also where a
  routine with no schedule lives.
- **Tasks with no routine** (started from the chat, from a script) appear only in Activity, with no `Run.routine`.
- **The quota is shared.** The tenant's 20 schedules are the team's. `quota.used` counts everyone's; a full tenant
  answers `Failure` `quota`, and only for a routine with a schedule (one that runs by hand does not use a slot).

## 4. Running it

**The skeleton** is off unless you turn it on. Without the flag, the farm in the list is the demo fake, as it has been
since the contract landed. With the flag, `RoutinesFarm.make()` is registered under the id `farm` in its place (see
`../main.ts`): the farm shows as "disabled" with its reason and an empty list. Set it in the environment of DynWork's
main process, for example:

```bash
DYNWORK_ROUTINES_FARM=1 bun run dev:desktop
```

Only `1` turns it on (`RoutinesFarm.enabled`). When your backend is written, register it in `../main.ts` where its
`JESÚS:` comment says, and the flag can go.

**The tests** run from `dynwork/packages/gui`:

```bash
bun test test/routines/farm.test.ts           # the skeleton is what this README says it is
bun test test/routines                        # the whole routines suite, as the CI runs it
DYNWORK_ROUTINES_FARM_CONFORMANCE=1 bun test test/routines/farm.test.ts   # the full conformance suite against it
bun typecheck
```

The third line runs `test/routines/conformance.ts` against `RoutinesFarm.make()`. It is red now (14 of its 15 tests
fail, as every method answers "not implemented") and it is your definition of done: every test green. That suite is the contract made executable: create, list, read back, edit (in place or replacing, per
`actions.edit`), pause, resume, start and finish, unread and `viewed`, paging, cancel, remove, `not-found` everywhere,
`invalid` with its fields, `watch`, the quota, transcripts, and everything surviving the Ipc's wire.

It needs a way to bring a run to a terminal state (`finish`) and a farm to talk to. For that, write a **fake farm
server** over real HTTP, as `test/routines/service.ts` does for DynWork's own service: the routes you call, the wire
shapes of `farm-api` (`{ error: { code, message, retryable, details } }` for failures) and a `finish` that moves its
tasks on. Point `RoutinesFarm.make(...)` at it in `farm.test.ts` where the `conformance(...)` call is. Do not mock the
farm client: the point of the suite is that the real adapter passes.

`../README.md` ("Backends") and `test/routines/wire.ts` (a window's client over a registry, with every value crossing
as the bridge makes it cross) are the other test helpers.

## 5. Where the token lives

The farm's token is a secret, like the account PAT:

- **It is read and used only in the main process.** `make(...)` takes what your client needs from main: the farm's base
  URL and a function that returns the token. Nothing in a `Routine`, a `Run`, a `Failure`, a log line, an event or the
  Ipc's state may contain it, and a `Failure.message` must never echo a response body that could.
- **Keep it as `safeStorage` ciphertext** in the plugin's main storage (`ctx.storage.store(...)`), decrypted only for the
  moment of a request, as `accounts/accounts.ts` keeps the PAT (base64 of `safeStorage.encryptString(token)`, with a
  check of `safeStorage.isEncryptionAvailable()`). `accounts/main.ts` already passes `secure: safeStorage` there.
- **Where it is entered and how the farm accepts it** is open (see "What the farm is missing", 1). The provisional
  route is a personal farm token the user pastes, stored as above.
- **When it is missing or rejected**, `capabilities()` answers `status: "signed-out"` with a `detail` saying what to do,
  and every method answers `Failure` `signed-out`. The views then show the farm as unavailable with the reason and the
  way to fix it. Do not invent a new state.
- **Registration.** Register `RoutinesFarm.make(...)` in `../main.ts` (the `JESÚS:` comment marks the line). A backend
  registered later (after the user signs in) replaces whatever holds the id `farm`, and the windows are told.

## 6. Errors

The farm's errors are `{ "error": { "code", "message", "retryable", "details" } }`; FastAPI's own validation errors come
as `{ "detail": [...] }`. Map each to a `Failure`, and give a `Failure` `invalid` a `fields` entry for every field it
names, keyed by `Field.key` (or `name`, `instructions`, `schedule`...).

| The farm                                                   | The `Failure`                                                                                                 |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `401 token_expired`, `401 token_invalid`                   | `signed-out`                                                                                                  |
| `403` (a scope is missing)                                 | `failed` with the message, or `unsupported` for what the user's token can never do                            |
| `404` (a schedule or task of another tenant is also `404`) | `not-found`                                                                                                   |
| `409 task_not_cancellable`                                 | `conflict`                                                                                                    |
| `429 quota_exceeded`                                       | `quota`                                                                                                       |
| `422 limits_exceed_tenant_policy`                          | `invalid` with the offending `details` mapped to fields (a time limit above the tenant's maximum), or `quota` |
| any other `422` and FastAPI's `{ "detail": [...] }`        | `invalid`, one `fields` entry per `loc`                                                                       |
| a network error, a `5xx` marked `retryable`                | `unreachable` (the one code that is `retryable`)                                                              |
| anything else                                              | `failed`                                                                                                      |

`RoutinesValidate.check(capabilities, definition)` (`../validate.ts`) already checks everything `capabilities()` states:
instruction kinds, the common fields, the schedule's shape and every `Field`. Your `validate()` runs it first and adds
what only the farm knows.

## 7. What the farm is missing

None of this is solved here; each item has an owner who decides.

1. **Authentication.** The farm accepts static tokens (a person or a service) and Entra ID (off by default). It does
   **not** accept the Governance JWT. Options: the farm validates Governance's JWT (JWKS), a token exchange, or the
   pasted personal token above as a stopgap. Needs the `subject` to Governance user and tenant to instance mapping.
   Minimum scopes: `farm:tasks:read`, `farm:tasks:write`, `farm:tasks:cancel`, `farm:credentials:read`.
2. **A name on schedules** (or `labels`) and, if it can be, **`PATCH /schedules/{id}`** (the farm leaves it for v2).
   Until then: DynWork's table, and edit is replace.
3. **A transcript through the API.** Today only `result` and the log. Either an endpoint or a guaranteed `.jsonl` format.
4. **The 20-schedule quota is per tenant.** DynWork users creating routines will exhaust it: make it per user, or
   raise it.
5. **A model list**, if a task ever takes `model`. Today the agent fixes it.
6. **Notification.** The farm's callback needs a public URL, so the desktop polls `updated_since`. A push or SSE would
   remove the polling (farm v2).
7. **A cost limit per task.** The mockup's "Cap the cost" and "Most to spend per run" fields (`capped`, `budget` in
   `fields`) have nothing to map to. Remove both from `fields` unless the farm adds one.

David decides which of these the farm team takes on.

## 8. Checklist for the PR

- [ ] `cd dynwork/packages/gui && bun test && bun typecheck` green, and the conformance suite green against your backend
      (`DYNWORK_ROUTINES_FARM_CONFORMANCE=1`, then make it unconditional in `farm.test.ts`).
- [ ] CI's job `patch guard and tests` (`.github/workflows/dynwork.yml`) green.
- [ ] Nothing says "systemprompt" in any user-visible text: it is "Governance". `test/views/strings.test.ts` checks it.
- [ ] No upstream line touched: `bun dynwork/script/patches.ts` still says 249 of 250 lines used. New files only.
- [ ] No farm token, no response body that could carry one, in any `Failure`, log or event.
- [ ] Copy goes through the views' i18n files; text a backend supplies (`Field.label`, `help`) is English, as the
      views' translations fall back to it.
- [ ] Every `JESÚS:` comment you finished is deleted or turned into a plain comment, and the ones you did not finish
      are still there.
- [ ] Commits follow upstream's convention with the `dynwork` scope: `feat(dynwork): connect the Agent Farm routines`.
