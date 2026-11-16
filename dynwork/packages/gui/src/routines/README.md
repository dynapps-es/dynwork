# Routines

Routines are scheduled or recurring agent tasks: a prompt, a skill or a farm agent, with a schedule or none. They run
in one of two places, **local** (this computer) or **remote** (the Agent Farm), and the app shows them in one list.
This directory is the contract between the views and the places they run, the backends, and the clock of the local
ones; no view.

```
window                                    main process
  views ──ctx.use(Routines)──► Ipc ──► RoutinesIpc ──► Registry ──► Backend (local | farm | fake)
  RoutinesClient (client.ts)  contract.ts  ipc.ts      backend.ts
```

| File          | Role                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `contract.ts` | The Schema data (`Definition`, `Routine`, `Run`, `Capabilities`, `Field`, `Failure`, ...) and the `dynwork.routines` Ipc |
| `backend.ts`  | `interface Backend`, the `Registry` of backends and `fail`, which builds a `Failure`                                     |
| `validate.ts` | `check(capabilities, definition)`: the rules the capabilities state, for any backend to run before its own               |
| `ipc.ts`      | The Ipc implementation over a registry: the state snapshot, routing, watching, failures as data                          |
| `fake.ts`     | An in-memory backend with an injectable clock: `Fake.make(options)`                                                      |
| `demo.ts`     | The two seeded fakes (`local`, `farm`) shaped like the approved mockup, and `register`, which adds those not taken       |
| `local/`      | The local backend (anchor and run sessions on DynWork's service, storage in the plugin's) and its clock (`clock.ts`)     |
| `farm/`       | The Agent Farm backend's skeleton and its handover `README.md` for Jesús Vargas: off unless `DYNWORK_ROUTINES_FARM=1`    |
| `main.ts`     | The main-process setup: the registry, the local backend and its clock, the demos and the Ipc. From `accounts/main.ts`    |
| `client.ts`   | The window's live Ipc client, handed over by `accounts/renderer.ts` for the views to read                                |

Everything crossing to a window is a Schema value, with epoch milliseconds for time. Every backend-specific value is in
`Definition.options`, keyed as the backend's `Capabilities.fields` declares it, so a view never special-cases a backend.

## One list, two kinds

`Capabilities.kind` is `local` or `remote`: the list's filter. Everything else a view needs to draw a routine or its form
is data in `Capabilities`: the kinds of instructions (`instructions`), whether the agent and model are chosen, whether a
schedule has a window, whether an edit is in place or replaces the routine (`actions.edit`), whether a reply continues in
place or starts a new run (`actions.reply`), the quota, and `fields`. A field's `kind` is the control (`text`,
`textarea`, `number`, `toggle`, `select`, `multiselect`, `folder`, `repo`, `list`), its `section` the group, `lookup`
the `options()` that fills it, and `when` the field whose value shows it.

## Runs

A `Run` has a `state` (`queued`, `running`, `ok`, `late`, `failed`, `blocked`, `missed`, `skipped`, `cancelled`), a
machine `reason` and a `conversation` that says where to read it: `session` (a local run, opened in place under its
anchor session), `transcript` (read through `transcript(run)`: the farm's result and log, read only), `external` or
`none`. A finished run is `unread` until `viewed(run)`; a `Routine` carries the count and its newest run in `last`.

## Failures are data

A backend never rejects: it answers a `Failure` (`signed-out`, `unreachable`, `invalid` with a message per field,
`quota`, `conflict`, `not-found`, `unsupported`, `failed`) in place of a value, and the Ipc does the same, because an Ipc
rejection reaches a window as plain text (`accounts/ipc.ts`). A backend that does reject anyway answers `failed` without
its message, which may carry a credential. `isFailure` tells the two apart. `capabilities()` is the exception that never
fails: a backend that cannot serve says so in `status`.

## The Ipc

- `state`: `{ backends, routines }`, a snapshot of every registered backend, read at start, when a backend registers or
  leaves, after every method that changes something and while a window watches. A backend whose list fails keeps its
  last routines in the state. A read that answers after a newer one began is dropped.
- `run` event: a run changed state. It comes only from backends a window is watching.
- `watch`: a call a window keeps open while a routines view is on screen and aborts when it leaves. While at least one is
  open, each backend's own `watch` is subscribed once, and a backend that registers meanwhile is subscribed too.
- Every other method names its `backend` and answers the backend's own answer.

## Backends

Register one with `registry.register(backend)`; a second with the same id replaces the first, which is how a real backend
takes the place of its demo. `main.ts` registers the local one and marks where the Agent Farm's goes (`routines/farm/`,
delivered to Jesús Vargas: a skeleton that answers "not implemented" and reports itself `disabled`, registered in place of
the farm's demo only with `DYNWORK_ROUTINES_FARM=1`). The demos are added after them, only for ids nothing took: today
only the farm's, unless that switch is on.

A backend is done when `test/routines/conformance.ts` passes against it: create, list, read back, edit (in place or
replacing), pause, resume, start, finish, unread and viewed, paging, cancel, remove, `not-found` everywhere, `invalid` with
its fields, watch, quota, transcripts, and everything surviving the Ipc's wire. `test/routines/fake.test.ts` shows how to
run it; `test/routines/wire.ts` is a window's client over a registry, with every value crossing as the bridge makes it
cross, for the views' tests.

## The local backend

`local/backend.ts` (`RoutinesLocal.make`) runs a routine on this computer through DynWork's own service, from the main
process: `ctx.serverEndpoints.get("sidecar")` gives the URL and the credential, and `@opencode/client`'s promise client
speaks the public HTTP API. Model (i) of docs/04-ui.md §A.3: one conversation per routine, one child per run.

- **Anchor.** The routine's first run creates it: `POST /api/session` with the routine's name as title, the routine's
  folder (or `~/Dynwork/Routines`, made on first use) as location, and `metadata.dynwork = { backend, routine, role:
"anchor" }`. It is top-level, so it is in the sidebar. It holds no synthetic messages. When a run ends,
  `metadata.dynwork.last = { run, state, at }` is set on it, which also lifts it in the sidebar. A rename retitles it and a
  new folder moves it (`POST /api/session/:id/move`). If the user deleted it, the next run makes a new one.
- **Run.** "Run now" creates a child (`parentID` = anchor) titled `<name> · <when>` (children get no automatic title),
  with the routine's agent and model (`<provider>/<model>`, as `options("models")` answers) and its own `permissions` (see
  "Permissions and notifications") and
  `metadata = { conversation: true, dynwork: { backend, routine, role: "run", trigger } }`, so nothing is inherited from
  the anchor. `conversation: true` has the app show the run as a conversation of its own, with the standard composer,
  instead of a subagent's read-only session (DynWork's patch in `packages/app/src/session/subagent.ts`); runs made before
  it lack the key and stay read-only. Then `POST /api/session/:id/prompt` with the instructions (a skill goes as the prompt's
  `skills`). The run's id is its session's.
- **State.** Read from the session: `queued` until `time.busy`, `running` until `time.idle` catches up with an
  `outcome`, then `ok`, `failed` (`reason: "error"`) or `cancelled`. A session that is gone makes the run `failed` with
  `reason: "deleted"`. A run that ended keeps its state: a reply later goes on in the conversation, not in the run.
- **Events.** While a run is going the backend follows the service's `session.execution.*` events and reads the run they
  name; after every (re)connection it reads every run that is going, so nothing missed while away is lost, and a stream
  that ends is followed again after 2 s. It follows them whether or not a window watches, so a run is always told
  (see "Permissions and notifications"). If the stream was lost and comes back, the runs that were going when it was
  lost are checked at once against `GET /api/session/active`: a run the service no longer runs is `failed`
  (`restart`), without waiting for the next launch.
- **Unread.** A run that ended is unread until `viewed`, which also marks its session viewed at its `time.idle`
  (`POST /api/session/:id/view`): upstream marks only the root.
- **Storage.** `ctx.storage.store("routines")` keeps the definitions (with each routine's anchor and its directory) and
  every run with the last state read, newest first. Removing a routine forgets it and its runs here, and leaves its
  conversation in the service, as the Agents view's confirmation says.
- **Without the service.** `capabilities()` says `unreachable`; the routines still list, edit, pause and resume, and
  `start` answers `unreachable`.

Not here yet: the time limit.
`test/routines/local.test.ts` runs the conformance suite and the local backend's own tests against
`test/routines/service.ts`, a fake service over real HTTP; `test/routines/clock.test.ts` runs the clock on a fake clock
and fake timers over the same service.

## Permissions and notifications

- **"Permissions"** (`permissions`): "Ask me" (default) or "Don't ask", per routine, and "Run now" obeys it too. The
  form shows one warning line while "Don't ask" is chosen (`Choice.warning`). No OpenCode patch: the run's child session
  is created with a ruleset (`session.create` `permissions`; the last matching rule wins, `packages/core/src/permission.ts`).
  - "Don't ask": `[{ action: "*", resource: "*", effect: "allow" }, { action: "question", resource: "*", effect: "deny" }]`.
    The `question` deny matters: an allowed question opens a form that waits for a person.
  - "Ask me": no rule. A request waits for ever (`permission.ts`), and nothing here ever answers one on the user's behalf.
- **Waiting.** `permission.asked` and `permission.replied` events of a run's session put the run in `running` with
  `reason: "permission"` (the contract has no `waiting` state) while any request is open; the views read it as
  "Waiting for your permission" (`stateKey`, `waiting` in `views/agents/routine.ts`), in the warning tone, and it counts
  as unread. The first request of a wait is notified; the open requests are kept in memory only.
- **Notify me** (`notify`): "Only when something fails" (default), "Every run" or "Never", for a run that finished
  (`ok`) or failed. A cancelled run is never notified. A run waiting for a permission is always notified. The backend
  decides (`Options.notify`, a `Notice`); `accounts/main.ts` shows an Electron notification (`RoutinesMain.words`), and
  its click calls `notice.open`: main focuses a window and emits the `open` event of the `Routines` Ipc, and the window in
  focus follows the run's link (`views/runs/open.ts`), so it opens in place.
- **Awake.** `Options.busy` is called when the first run starts and when the last one ends; `accounts/main.ts` holds a
  `powerSaveBlocker("prevent-app-suspension")` while it is true.

## The clock

`local/clock.ts` (`RoutinesClock.make`) fires the local schedules, in the main process, only while Dynwork is open.

- **When.** Each routine's next occurrence comes from its cron in its IANA zone (`RoutinesClock.next`, also the `next`
  the view shows). A local time the clocks skip (DST starts) runs right after the jump; one that happens twice (DST ends)
  runs once, the first time. One timer waits for the nearest occurrence, never longer than a minute so that a change of
  the system clock is noticed. Any change of a routine (the backend's `watch`), waking the computer (`powerMonitor`
  `resume`, in `accounts/main.ts`) and every change of the sync make it look again.
- **Ready.** Nothing fires until DynWork's service answers and the Governance provider is applied: `accounts/main.ts`
  passes `ready`, true once the sync engine reported `synced` (or when no account is signed in, as there is nothing to
  wait for), and calls `check` on each sync change. A run started earlier fails with "No model is available". Until
  then the clock asks again every 30 s.
- **Exactly once.** The occurrence key is `SavedRoutine.due`, the newest occurrence the clock took. It is written to the
  plugin's storage (`take`) in the same synchronous step that decides the occurrence, before its run starts (`fire`), so
  no restart and no second timer starts it again. An occurrence counts only after the key and after the routine last
  changed (`updated`): a routine created, edited or resumed missed nothing before that. There is no other lock.
- **Overlap.** An occurrence whose routine's previous run is still going is recorded `skipped` (`overlap`), not queued.
- **Missed runs.** An occurrence found more than 5 minutes after its time was missed (Dynwork closed, or asleep). Each
  routine says what to do in "Recover missed runs" (`options.recover`, `options.catchUp`): `none` records them `missed`
  (`closed`); `recent` (the default, within 6 hours, 1 to 48) starts **one** run when the newest missed one is within the
  hours, never one per occurrence, unless the next regular run is less than 15 minutes away. That run is the newest
  occurrence's, with `trigger: "catch-up"`; the others are recorded `missed` (`grouped`) into it, and its prompt starts
  with one line saying it is a catch-up and since when (the oldest missed time), so the agent covers the gap. At most the
  newest 100 missed occurrences are recorded.
- **Runs cut by a restart.** The runs going when the app last closed that the service no longer runs
  (`GET /api/session/active`) are recorded `failed` (`restart`) at the next launch: core does not resume a child session.
  Nothing retries them. A service restart while the app stays open is not detected yet.
- **History.** Occurrences that did not run are runs without a session (`conversation: none`, already read), with their
  `due`. The view puts their reason in words (`agents.why.*`).

## What the fake does not do

It reads no cron: a scheduled, enabled routine's `next` is a day after its last change. Runs start only through `start`
and finish when the clock passes their duration and `settle()` runs (`main.ts` calls it every few seconds). Nothing is
persisted. Sync is a later phase of the plan.
