# The Agent Farm backend: handover

For Jesús Vargas. DynWork's Agents view already works end to end against a fake farm. This folder is the place where
the real one plugs in. What is here is a skeleton that type-checks against `Backend`, declares the farm's form fields,
and answers "not implemented" to everything else. You write the methods; the Ipc, the registry, the views and the test
suite need no changes. Search the repository for `JESÚS:` to find every hook: each names the
contract piece it implements.

The long-form design (`docs/04-ui.md`, `docs/mockup-agents.html`) lives in David's local plan folder, which is not in
git. This README repeats what you need from it; ask David for the rest.

Files here:

| File         | What it is                                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| `backend.ts` | `RoutinesFarm`: `make({ client, cloud, models })`, the farm's fields, its `base` capabilities and the flag |
| `client.ts`  | `FarmClient`: the connection mode and the `FarmTransport` every farm call goes through (see "Transport")   |
| `cloud.ts`   | `FarmCloud`: gives the farm the account's PAT through a one-time upload link (see "Cloud access")          |
| `README.md`  | This document                                                                                              |

The backend never handles a credential itself: `client.ts` reads the account's JWT from `accounts/` at the moment of
each request. See "Transport" and "Where the token lives".

## 1. What a routine is, and how the user sees it

A **routine** is an agent, its instructions and a trigger (a schedule, or "only when I start it"), plus where it runs:
local (this computer) or remote (the farm). In the UI it is called a **task**, never an "agent" or a "routine": "agent"
is the definition in both worlds (an OpenCode agent, a farm catalogue agent). The view is called **Tasks**; where a task
runs reads **This Mac** (This PC) or **Cloud**, and "Agent Farm" and "Remote" never reach the UI.

- One list for every task, local and remote. Chips `All | This Mac | Cloud` only narrow it; each card has a
  badge for where it runs ("Cloud" for yours). Tabs: My tasks, Templates, Activity (every run, including farm tasks that
  were started outside DynWork).
- The detail page has the same layout for both kinds: History on the left (every run with its state and reason), and
  on the right Instructions, Repeats (the next three), Where and with what, Permissions, Notifications. For a farm
  routine it adds a dashed "Cloud options" block, painted from your `capabilities().fields`.
- Actions: Open (for a farm routine, the read-only viewer of its latest run), Run now, Pause/Resume, Edit, Duplicate,
  Remove. An action your backend cannot do is shown disabled with the reason taken from `capabilities`.
- Clicking a farm run opens a read-only viewer: the result in Markdown, usage and cost, the tail of the log, "Download
  full log" (a signed URL asked for on click) and "Continue" (a new task with `session_ref`). Farm runs are not
  sessions, so the Runs side panel never lists itself for them.
- One form creates and edits, with the same layout for both kinds: common fields (name, what to do, schedule, on/off)
  and then the backend's sections, painted from `capabilities().fields`.

To see it now, start a development build (`bun dynwork/script/desktop.ts --channel dev`): the farm you see in the list
is the **demo fake** (`demo.ts`, `RoutinesDemo.remote`), shaped like the approved mockup. Released builds (internal and
canary) seed no demo, so until your backend registers they show no Cloud tasks and no Cloud filter. Read it as the target behavior of your backend, from the
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

The table names the farm's MCP tools, the way DynWork reaches the farm (see "Transport"), with the REST route each one
calls as the caller (base `/farm/api/v1`). `make({ client, cloud, models })` takes the transport, the Cloud access
(`cloud.ts`) and a reader of the models Governance admits for the user (`profileModels(accounts)`, which reads
`GET /v1/bridge/profile`). Without them, `make()` is the unconnected backend: `disabled`, and `not implemented`
elsewhere.

| Contract                     | Farm                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capabilities()`             | `cloud.ensure("capabilities")` first, then `farm_whoami` (`GET /whoami`): `free_prompt` (no `prompt` instructions without it), `permission_ceiling` (no "Don't ask" under `ask`), `schedules {used, max_per_user, max_tenant}` as `quota` (`shared` only without a per-person cap).                                                                                    |
| `model`                      | `choose` with the models of the user's `profile.models` in Governance, as they come (no filter by prefix); `agent` when there are none. `options("models")` serves them; `Definition.model` is `task.model`.                                                                                                                                                           |
| `options("agents")`          | `farm_list_agents` (`GET /agents`): one choice per `slug`                                                                                                                                                                                                                                                                                                              |
| `options("plugins")`         | `farm_list_plugins` (`GET /plugins`). Served, but no field uses it: a farm task loads every plugin of its image and cannot choose among them.                                                                                                                                                                                                                          |
| `options("credentials:...")` | `farm_list_credentials` (`GET /credentials`), the user's own credentials of that `type` (`git_token` for repository access, `mcp_url` for connectors)                                                                                                                                                                                                                  |
| `validate(definition)`       | `RoutinesValidate.check`, then the model among the user's models, the agent in `farm_list_agents`, and no `bypass` for an agent whose `capabilities.permission_ceiling` is `ask`.                                                                                                                                                                                      |
| `list()`, `get(id)`          | `farm_list_schedules {owner: me}`, `farm_get_schedule` (`GET /schedules`, `GET /schedules/{id}`). `name` and `metadata` are the farm's: there is no DynWork table. `last` and `unread` come from the routine's runs (below).                                                                                                                                           |
| `create(definition)`         | `farm_create_schedule` (`POST /schedules`): `name`, `metadata`, `task` with `gateway_identity: "user"` always, `recurrence` (absent for a routine with no schedule: it runs only when started), `overlap`. `enabled: false` is a pause right after.                                                                                                                    |
| `update(id, definition)`     | `farm_update_schedule` (`PATCH /schedules/{id}`): in place, the `ref` stays (`actions.edit` is `in-place`). `task` and `metadata` are sent whole, keeping what DynWork does not write (other keys of `metadata`, the task's `scope`, `limits.cpu`...; not `notify`, whose URLs the farm never returns).                                                                |
| `remove`, `pause`, `resume`  | `farm_delete_schedule`, `farm_pause_schedule`, `farm_resume_schedule`                                                                                                                                                                                                                                                                                                  |
| `start(id)`                  | `farm_fire_schedule` (`POST /schedules/{id}/fire`): the `Run` of the task it makes, `trigger: "manual"`, `conversation: { kind: "transcript" }`. A paused schedule is `conflict`.                                                                                                                                                                                      |
| `runs({ routine })`          | `farm_list_schedule_runs` (`GET /schedules/{id}/tasks`, not paged by the farm, so paged here by `RoutinesFarm.page`) plus the replies sent to them (see `reply`), newest first.                                                                                                                                                                                        |
| `runs({})` (Activity)        | `farm_list_tasks {owner: me}`, newest first, with the farm's own `cursor`. A task's routine is the one it was seen under (the farm does not say it on a task), or the one its `origin_context` names.                                                                                                                                                                  |
| `watch(changed)`             | While subscribed, one poll every `RoutinesFarm.interval` of `farm_list_tasks {owner: me, updated_since}`, from the newest change seen minus `RoutinesFarm.lookback`; each change once, as its `Run` and routine. A run that failed with `farm_access_revoked` gives Cloud the PAT again (`cloud.retry`); the routine stays as it is.                                   |
| `cancel(run)`                | `farm_cancel_task` (`DELETE /tasks/{id}`); `task_not_cancellable` is `conflict`                                                                                                                                                                                                                                                                                        |
| `transcript(run)`            | `farm_get_task` (`not-found`), then for a finished run `farm_get_task_result`, whose `result.url` is downloaded (https, or http on this computer; no redirect) for `Transcript.result`, the summary when it cannot be; `farm_get_task_transcript` page by page as `log`, one line per message and per tool; `usage.duration` from the task, `turns` from the document. |
| `viewed(run)`                | `farm_mark_task_viewed` (`POST /tasks/{id}/viewed`): the farm keeps the read state per owner and resets it when the task finishes.                                                                                                                                                                                                                                     |
| `reply({ run, text })`       | `farm_launch_task` with the run's `session_ref`, `gateway_identity: "user"`, the routine's task (`model`, `permission_mode`, `workspace`, `mcp_servers`, `limits`), the words as `prompt` or as the agent's `input`, and `origin_context.dynwork_routine` naming the routine. A run still going, or not resumable, is `conflict`.                                      |
| `answerQuestion(...)`        | `farm_answer_task` with the question's `seq` (`Question.id` is `q-<seq>`); a choice not among `options` is `invalid`, a question that is no longer open `conflict`. A question without `options` (`kind: ask`) takes the user's words.                                                                                                                                 |

A definition and its schedule:

| `Definition`                           | Schedule                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `name`                                 | `name`                                                                                                 |
| `instructions` `prompt` / `agent`      | `task.prompt` / `task.agent_id` + `task.input`. `skill` is not offered.                                |
| `schedule`                             | `recurrence {cron, timezone, starts_at, ends_at, max_runs}`; none is a routine run only when started   |
| `enabled`                              | `state` is not `paused`                                                                                |
| `template`                             | `metadata.template`, as it is                                                                          |
| `options`                              | as sent in `metadata.dynwork.options`, with what the task holds over it (an edit made elsewhere shows) |
| `options.repository`/`branch`/`access` | `task.workspace {repo, ref, credentials_ref}`                                                          |
| `options.permissions`                  | `task.permission_mode` (`ask` "Ask me", `bypass` "Don't ask")                                          |
| `options.connectors`                   | `task.mcp_servers`, one `{name, credential}` per `mcp_url` credential (at most 5)                      |
| `options.timeLimit`                    | `task.limits.timeout_s` (minutes × 60)                                                                 |
| `options.overlap`                      | `overlap`                                                                                              |

A farm error reaches the `Failure` as "Errors" says; a task refused on a field (`model_unknown`,
`limits_exceed_tenant_policy`, `prompt_not_enabled_for_tenant`, an unknown agent, `cron_invalid`) is `invalid` on that
field. `user_gateway_credential_missing` or `farm_access_revoked` on a create, an edit or a start gives the farm the
PAT again (`cloud.retry`) and makes the call once more; when Cloud cannot take it, the `Failure` says so.

`RunState`: `pending` and `queued` are `queued`; `running` is `running`; `succeeded` is `ok`; `failed` is `failed` and
`TaskOut.failure_reason` is the `reason` (`farm_access_revoked`, `gateway_unavailable`, `timeout`...); `cancelled` is
`cancelled`; `expired` is `failed` with `question_unanswered`. A task waiting for its owner (`question`) is `running`
with the reason `question` and unread; a finished one is unread until its owner marks it seen. The farm makes no task
for a skipped firing, so a farm run is never `skipped`. `late`, `blocked` and `missed` are produced by DynWork's own
clock for local routines; the farm gives none of them.

Odd cases, decided so that you do not have to:

- **Tasks with no routine** (started from the chat, from a script) appear only in Activity, with no `Run.routine`.
- **Replies.** A reply is a task of no schedule. Dynwork finds a routine's replies among the user's newest 300 tasks
  by `origin_context.dynwork_routine`; an older reply is still in Activity.
- **One list.** Cloud routines are listed with the local ones, told apart by `ref.backend`. They are not local
  routines, so they never enter the local routines' sync with Governance ("My routines", `../local/sync.ts`).
- **Cost.** A farm task has no cost limit: the connected backend declares no cost field. The demo still shows
  `capped`/`budget`, which the views' tests use as their example of a field under `when`.

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
bun test test/routines/farm.test.ts           # the conformance suite against the connected backend, and the unconnected one
bun test test/routines/farm-backend-crud.test.ts test/routines/farm-backend-runs.test.ts
bun test test/routines                        # the whole routines suite, as the CI runs it
bun typecheck
```

`farm.test.ts` runs `test/routines/conformance.ts` against `RoutinesFarm.make({ client, cloud, models })` over the real
transport and accounts, with `test/routines/farm-server.ts` playing the Governance MCP proxy and the farm over real HTTP
(`signedIn` builds the backend as main will). Its `finish` moves the fake's tasks to `succeeded` and waits for a poll
of `watch`; its `ask` puts a question on a task. That suite is the contract made executable: create, list, read back,
edit in place, pause, resume, start and finish, unread and `viewed`, paging, cancel, remove, `not-found` everywhere,
`invalid` with its fields, `watch`, the quota, transcripts, replies, questions, and everything surviving the Ipc's wire.

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
- **Nothing is entered.** Cloud uses the Governance account's own PAT, already held by `accounts/`: it mints the JWT
  each farm call carries (see "Transport"). There is no farm token to paste or store.
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

1. **Notification.** The farm's callback needs a public URL, so the desktop polls `updated_since`. A push or SSE would
   remove the polling (farm v2).
2. **The schedule of a task.** A task does not say which schedule fired it, and a reply belongs to none: `list()` reads
   each routine's runs and the user's recent tasks, one call per routine. A `schedule_id` on every task, kept by a
   reply, would make it one call.
3. **Manual routines and the quota.** The farm counts a routine with no schedule against the schedule quota, so a user
   at the limit cannot add one to run by hand; the contract expects they can.
4. **Overlap on a manual start.** `overlap: skip` (the default) refuses a start while a run is going
   (`schedule_overlap`, `conflict`); the contract expects a start to run whatever the schedule says.

## 8. Checklist for the PR

- [ ] `cd dynwork/packages/gui && bun test && bun typecheck` green, the conformance suite in `farm.test.ts` included.
- [ ] CI's job `patch guard and tests` (`.github/workflows/dynwork.yml`) green.
- [ ] Nothing says "systemprompt" in any user-visible text: it is "Governance". `test/views/strings.test.ts` checks it.
- [ ] No upstream line touched: `bun dynwork/script/patches.ts` still says 249 of 250 lines used. New files only.
- [ ] No farm token, no response body that could carry one, in any `Failure`, log or event.
- [ ] Copy goes through the views' i18n files. Text a backend supplies (`Field.label`, `help`, choices, warnings,
      fixed `Failure` messages) is English; add each one to `routines/i18n/en.ts`, `es.ts`, `fr.ts` and `nl.ts` so
      the window shows it in the app's language (`test/ui/languages.test.ts` checks the fields).
- [ ] No `JESÚS:` comment left under `routines/farm/` (`test/routines/handover.test.ts` checks it).
- [ ] Commits follow upstream's convention with the `dynwork` scope: `feat(dynwork): connect the Agent Farm routines`.

## Transport

`client.ts` is the only way to the farm. `FarmClient.mode(process.env)` reads the connection mode in one place
(`DYNWORK_ROUTINES_FARM_CONNECTION`; absent or empty is `sp`) and `FarmClient.select(mode, ...)` answers the
`FarmTransport` for it, whose `callTool(name, args)` answers `{ ok: true, value }` or `{ ok: false, code, failure }`
and never rejects.

- **`sp` (the one implemented): the farm's MCP server through Governance.** A stateless Streamable HTTP `tools/call`
  to `<account instance>/api/v1/mcp/dynapps-farm/mcp`, with the JWT the account mints from its PAT
  (`accounts.session`) in `Authorization` and nowhere else. Governance checks on every call that the user may use the
  farm's MCP server, mints the short-lived token the farm accepts and forwards the call, and records it. The farm
  never accepts anything the user holds, so a fault in the farm cannot open it to every Governance user, and removing
  someone from the farm's group takes effect on their next call. A call takes about 0.2 s, so a list is one call
  (`farm_list_schedules`), never one per routine.
- **`direct`: a farm reached with its own credentials, without Governance.** Not available yet: choosing it answers
  `unsupported` (`direct_not_available`) on every call and never falls back to `sp`. An unknown mode answers
  `mode_unknown` the same way.

What the proxy answers, and what `callTool` makes of it:

| The proxy                               | The answer                                                                                                     |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `503` `service_not_running`             | `unavailable`, `failed`: Governance does not give this account the farm (show Cloud as not available)          |
| `401`                                   | mints a new JWT once and repeats the call; a second `401` is `unauthorized`, `signed-out`                      |
| `413` (a request over 4 MiB)            | `too_large`, `failed`. The tools page what they return, so it should not happen                                |
| `429`                                   | waits for `retry-after` (at most 10 s) and tries again, three tries in all; then `rate_limited`, `unreachable` |
| other `5xx`, a network error, a timeout | `http_<status>`, `network` or `timeout`, `unreachable`                                                         |
| a tool result with `isError`            | the farm's own `code` and a `Failure` as in "Errors"; tried again only when the farm marks it `retryable`      |

Rules the transport keeps:

- **No credential in an argument.** Governance stores the arguments and the result of every `tools/call`. An argument
  named `value`, `token` or `pat` at any depth, in any case, is refused before any request (`secret_argument`); the
  type of `args` refuses the lowercase top-level ones at compile time. A credential reaches the farm by a one-time
  upload ticket the farm hands out through a tool, then a direct `PUT` to the farm, never through Governance.
- **The JWT stays in main and in the header.** It is not in the URL, a `Failure`, a log line or anything the Ipc
  carries; a failure never repeats a proxy's body, and anything a server sends back is cleared of the JWT before it is
  used. The PAT is never read here at all: only `cloud.ts` reads it (see "Cloud access").
- **Results and logs that can be large travel as links** the farm signs (a result, the full log), not inline, so they
  are neither copied into Governance nor near the 4 MiB limit.

## Cloud access

Cloud runs the user's tasks as the user: with their models, their cost and their connectors in Governance. For that the
farm keeps the PAT this Dynwork account already signs in with, as the user's `gateway_pat` credential named
`sp-gateway`. The user does nothing: no link to open, no button. `cloud.ts` (`FarmCloud.make({ transport, accounts })`)
puts it there with `ensure(cause)`:

1. `farm_whoami`. If `gateway_identity.user_credential` is true, the farm holds a PAT and nothing more happens.
2. `farm_request_credential_upload({ type: "gateway_pat", name: "sp-gateway" })` answers an `upload_url` that works
   once, for this user, for about a minute.
3. The account lends the PAT (`accounts.withPat`, decrypted from `safeStorage` in main only for that call) and it goes
   in one `PUT upload_url` with the body `{ "value": ... }`, straight to the farm: no `Authorization`, never following
   a redirect, and only to an `https` link on the upload route (plain `http` only on this machine). Then nothing
   holds it.

When it runs (`cause`):

| Cause          | When                                                                                                        | Uploads                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `capabilities` | the backend prepares `capabilities()`                                                                       | only when the farm holds no PAT for the user                 |
| `refused`      | a task or a launch failed with `farm_access_revoked` or `user_gateway_credential_missing` (`retry(reason)`) | always (steps 2 and 3), whatever the farm says it holds      |
| `account`      | the account mints a session (accounts' `renewed`), which follows every sign-in                              | when this PAT is not the one last uploaded from this process |

Calls for one account share one run, so two at once upload once. `ensure` never rejects: it answers `present`,
`uploaded` or `unchanged`, or a refusal with a `code`. `unavailable` (the proxy's `503 service_not_running`) means
Governance does not give this account the farm: nothing is asked or uploaded and Cloud shows as not available.
`signed_out` means there is no PAT to give. To tell a new PAT from the uploaded one, `cloud.ts` keeps in memory only a
hash of it keyed with a random key of this process; nothing is stored.

The PAT never goes through the farm's MCP server (Governance records every tool call), a log line, a `Failure`, the Ipc
or the store. A log line never carries the upload link either: until it is used, it is as good as the PAT.

**The shared PAT, and its risk.** The farm and this Mac hold the same credential. It is a Device key, interactive, and
it does not expire. Revoking it in Governance (or the instance refusing it) cuts both: Dynwork signs out, and every
Cloud task, scheduled ones included, fails with `farm_access_revoked` until the user signs in again; then the `account`
cause uploads the new PAT under the same name and the next task runs. Signing out of Governance in Dynwork leaves the
farm holding the old PAT; the tasks fail the same way once that PAT is revoked. Anyone who reads the farm's copy of the
key (the tasks' pods carry it) can act as the user in Governance as long as it is valid.

## Tasks from a chat

The scheduled-task tools (`@dynwork/server-plugin/routines`, "Create from a chat" in `routines/README.md`) let the
agent manage the user's tasks in a chat; the user sees them as tasks, and yours as **Cloud** (your
`capabilities().label`; "Agent Farm" never reaches the UI). Every tool goes through the registry to the task's own
backend, so a `farm:<id>` task reaches yours:

| Tool                                            | Your methods                                                                           |
| ----------------------------------------------- | -------------------------------------------------------------------------------------- |
| `list_scheduled_tasks`                          | `list()`, with `capabilities().label`                                                  |
| `list_running_tasks`                            | `runs({})` (the `queued` and `running` ones) and `list()` for the names                |
| `get_scheduled_task`                            | `get(id)`, `runs({ routine: id })`                                                     |
| `create_scheduled_task` (`where: "farm"`)       | `validate(definition)` before the card, `create(definition)` after Schedule            |
| `update_scheduled_task`                         | `get(id)`, `validate(definition)` before the card, `update(id, definition)` after Save |
| `delete_scheduled_task`                         | `get(id)`, `remove(id)` after Delete                                                   |
| `pause_scheduled_task`, `resume_scheduled_task` | `get(id)`, then `pause(id)` or `resume(id)` at once                                    |
| `run_scheduled_task`                            | `get(id)`, then `start(id)`: at once for "Ask me", after the card for "Don't ask"      |

- **What it sends.** A `Definition` built by `RoutinesChat.definitionOf` (create) or `RoutinesChat.changed` (update:
  your routine with only the given fields changed, its other options kept): `name`, `instructions` of kind `prompt`,
  `schedule` (`cron` and `timezone`, Europe/Madrid by default; absent for a manual task), `enabled`, and `options` with
  `permissions` (`ask` | `bypass`), `notify` (`failures` | `every` | `never`), and `folder` and `connectors` (MCP server
  names) when the user gave them. No `agent`, no `model` on a new one.
- **What you implement.** The methods above, as for the views; nothing else changes (`JESÚS:` in `routines/chat.ts`). A
  `Failure` goes back to the agent as the tool's answer, with its `fields`, and no card is shown. Until you write a
  method its "not implemented" is the answer. An `update` that answers a new ref (`edit: "replace"`) is reported with
  the new id.
- **How to test it.** `test/routines/chat.test.ts` has "a farm proposal reaches the farm backend" and "a farm task
  reaches the farm backend": point them at your backend and expect a card or a change instead of "not implemented".
  Live: run Dynwork with `DYNWORK_ROUTINES_FARM=1`, open Tasks › New task › Create with Dynwork, ask for a task on
  Cloud, press Schedule, and see it in the list; then ask the chat to rename, pause and run it.
