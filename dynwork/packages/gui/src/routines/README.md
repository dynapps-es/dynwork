# Routines

Routines are scheduled or recurring agent tasks: a prompt, a skill or a farm agent, with a schedule or none. They run
in one of two places, **local** (this computer) or **remote** (the Agent Farm), and the app shows them in one list.
This directory is the contract between the views and the places they run, and nothing else: no view, no clock.

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
| `local/`      | The local backend: anchor and run sessions on DynWork's service, definitions and history in the plugin's storage         |
| `farm/`       | The Agent Farm backend's skeleton and its handover `README.md` for Jesús Vargas: off unless `DYNWORK_ROUTINES_FARM=1`    |
| `main.ts`     | The main-process setup: the registry, the local backend, the demos and the Ipc. Called from `accounts/main.ts`           |
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
  with the routine's agent and model (`<provider>/<model>`, as `options("models")` answers) and its own `permissions` and
  `metadata = { conversation: true, dynwork: { backend, routine, role: "run", trigger } }`, so nothing is inherited from
  the anchor. `conversation: true` has the app show the run as a conversation of its own, with the standard composer,
  instead of a subagent's read-only session (DynWork's patch in `packages/app/src/session/subagent.ts`); runs made before
  it lack the key and stay read-only. The `permissions` field denies tools: read only denies `edit` and `shell`, edit
  files denies `shell`. Then `POST /api/session/:id/prompt` with the instructions (a skill goes as the prompt's
  `skills`). The run's id is its session's.
- **State.** Read from the session: `queued` until `time.busy`, `running` until `time.idle` catches up with an
  `outcome`, then `ok`, `failed` (`reason: "error"`) or `cancelled`. A session that is gone makes the run `failed` with
  `reason: "deleted"`. A run that ended keeps its state: a reply later goes on in the conversation, not in the run.
- **Events.** While a run is going the backend follows the service's `session.execution.*` events and reads the run they
  name; after every (re)connection it reads every run that is going, so nothing missed while away is lost, and a stream
  that ends is followed again after 2 s. It follows them whether or not a window watches, so a failure is always told:
  `failed` is main's system notification, unless the routine says "never".
- **Unread.** A run that ended is unread until `viewed`, which also marks its session viewed at its `time.idle`
  (`POST /api/session/:id/view`): upstream marks only the root.
- **Storage.** `ctx.storage.store("routines")` keeps the definitions (with each routine's anchor and its directory) and
  every run with the last state read, newest first. Removing a routine forgets it and its runs here, and leaves its
  conversation in the service, as the Agents view's confirmation says.
- **Without the service.** `capabilities()` says `unreachable`; the routines still list, edit, pause and resume, and
  `start` answers `unreachable`.

Not here yet (F4 of the plan): the clock that fires a schedule (`next` is computed from the cron and shown, but nothing
fires it), catch-up of missed runs, resuming a run cut by a service restart (core resumes only root sessions), the
permission hook of an unattended run, and the time limit. `test/routines/local.test.ts` runs the conformance suite and the
local backend's own tests against `test/routines/service.ts`, a fake service over real HTTP.

## What the fake does not do

It reads no cron: a scheduled, enabled routine's `next` is a day after its last change. Runs start only through `start`
and finish when the clock passes their duration and `settle()` runs (`main.ts` calls it every few seconds). Nothing is
persisted. The real clock, catch-up, unattended permissions and sync are a later phase of the plan.
