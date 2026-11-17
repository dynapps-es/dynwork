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
| `local/`      | The local backend (anchor and run sessions on DynWork's service, storage in the plugin's), its clock (`clock.ts`) and its Governance sync (`sync.ts`) |
| `farm/`       | The Agent Farm backend's skeleton and its handover `README.md` for Jesús Vargas: off unless `DYNWORK_ROUTINES_FARM=1`    |
| `main.ts`     | The main-process setup: the registry, the local backend and its clock, the demos and the Ipc. From `accounts/main.ts`    |
| `chat.ts`     | Routines from a chat: the routines tools' requests, the approval cards (`Chat` Ipc in `contract.ts`) and Schedule. From `accounts/main.ts` |
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
- `move`: makes this device the one that runs a routine of another device; a backend without owners (the optional
  `Backend.move`) answers `unsupported`.
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

- **Time limit.** The routine's "Time limit (minutes)" (`timeLimit`, default 30) counts from the run's `started`. One
  timer per running run (`Options.timers`) fires at that time, and every read of a run checks it too, so a run left going
  by a closed app is stopped as soon as it is read after the app opens (the backend arms the runs it finds going when it
  is made). A run still going then, even one waiting for a permission nobody answers, is recorded `failed` with
  `reason: "timeout"` (before the session is interrupted, so the interrupt's event cannot read as the user stopping it),
  told like any failure (`Notify me`), and its session is interrupted. Whatever ends a run clears its timer.

`test/routines/local.test.ts` runs the conformance suite and the local backend's own tests against
`test/routines/service.ts`, a fake service over real HTTP; `test/routines/clock.test.ts` runs the clock on a fake clock
and fake timers over the same service.

## Permissions and notifications

- **"Permissions"** (`permissions`): "Ask me" (default) or "Don't ask", per routine, and "Run now" obeys it too. The
  form shows one warning line while "Don't ask" is chosen (`Choice.warning`). No OpenCode patch: the run's child session
  is created with a ruleset (`session.create` `permissions`; the last matching rule wins, `packages/core/src/permission.ts`).
  - "Don't ask": `[{ action: "*", resource: "*", effect: "allow" }, { action: "question", resource: "*", effect: "deny" }]`.
    The `question` deny matters: an allowed question opens a form that waits for a person.
  - "Ask me": OpenCode's agents allow almost everything (`packages/schema/src/agent.ts`), so asking needs rules too:
    `*` asks, then `read`, `glob`, `grep`, `webfetch`, `websearch`, `skill`, `todowrite`, `question` and `subagent` are
    allowed, and `.env` reads ask again. Edits, the shell, other folders and connectors wait for the user, as in Claude
    Code. Subagents inherit the rules (`packages/core/src/session.ts`). A request waits for ever (`permission.ts`), and
    nothing here ever answers one on the user's behalf.
- **Waiting.** `permission.asked` and `permission.replied` events of a run's session put the run in `running` with
  `reason: "permission"` (the contract has no `waiting` state) while any request is open; the views read it as
  "Waiting for your permission" (`stateKey`, `waiting` in `views/agents/routine.ts`), in the warning tone, and it counts
  as unread. The first request of a wait is notified; the open requests are kept in memory only.
- **Denied.** Denying a request ends the step (`packages/core/src/session/runner/step.ts`), but core never marks the
  session idle, so `permission.replied` with `reply: "reject"` ends the run as `cancelled` / `user`, like "Stop run".
- **Notify me** (`notify`): "Only when something fails" (default), "Every run" or "Never", for a run that finished
  (`ok`) or failed. A cancelled run is never notified. A run waiting for a permission is always notified. The backend
  decides (`Options.notify`, a `Notice`); `accounts/main.ts` shows an Electron notification (`RoutinesMain.words`), and
  its click calls `notice.open`: main focuses a window and emits the `open` event of the `Routines` Ipc, and the window in
  focus follows the run's link (`views/runs/open.ts`), so it opens in place.
- **Awake.** `Options.busy` is called when the first run starts and when the last one ends; `accounts/main.ts` holds a
  `powerSaveBlocker("prevent-app-suspension")` while it is true.

## Connectors

- **"Connectors"** (`connectors`, a `multiselect` whose lookup is `connectors`): `"all"` (the default, and what a routine
  made before the option reads as) or the names of the MCP servers a run may use. The form lists the servers
  `mcp.list` returns (Governance's and the user's own), all checked, and saves `"all"` while every one is checked, so a
  server added later is allowed; with an explicit list it is not. Without the service the tab says there are none.
- **No OpenCode patch.** A run's session is created with the "Ask me" or "Don't ask" rules and, after them, one
  `{ action: "<namespace>_*", resource: "*", effect: "deny" }` per server of `mcp.list` (read when the run starts, in the
  routine's folder) that the list leaves out. The namespace is the server's name with everything but letters, digits,
  `_` and `-` replaced by `_`, as core computes it (`normalizedName`, `McpTool.name`); `denyConnectors` mirrors it. A
  server whose tools are all denied is hidden from the model. Limit: `a_*` also matches the tools of a server named
  `a_b`, so a server whose name starts with another's followed by `_` shares its fate.

## Sync with Governance

`local/sync.ts` (`RoutinesSync.make`) shares the local routines' definitions with the user's other computers through
Governance's `dynwork-routines` API (`/api/dynwork/routines/v1`), in main, with the active signed-in account's session:
the JWT never reaches a window. `main.ts` sets it up when `accounts/main.ts` passes `sync` (the account, and this
computer).

- **Feed.** `GET /changes?since=<cursor>` at launch, every 5 minutes (every 30 s while Governance does not answer), when
  the accounts change, on wake, and at once on the relay's `routines.changed` hint. Each page is applied to the store and
  its cursor kept with the account it belongs to (`Saved.sync`); another account reads from the beginning, and a cursor
  Governance refuses starts over. A tombstone removes the routine and its runs; a newer revision replaces its definition
  and owner, and its `updated` becomes Governance's `updated_at`, so the clock counts nothing missed before the change.
- **Outbox.** Every create, edit, pause, resume, move and remove made here writes the store and its outbox
  (`Saved.outbox`, `enqueue`) in one store write, so a restart loses nothing. The outbox is sent in order: a routine with
  `If-Match` at the revision it was last synced at (none to create), a removal with the revision it had. A `put` with a
  later change of the same routine behind it is skipped: the later one sends the routine as it is then. While a routine
  has a change waiting, the feed leaves it alone: its `If-Match` settles it.
- **Conflicts.** A `409` takes Governance's row (`current`), keeps it, drops the later changes made on top of the replaced
  edit and sets `SavedRoutine.conflict`; the routine says "Changed on another computer" (`Routine.conflict`) until the
  next edit here. A `409` whose row already holds what was sent (an answer lost on the way) is taken quietly. A removal
  answered with a newer row brings the routine back, flagged the same way.
- **Run summaries.** Each change of a run of a routine this computer owns and Governance has goes to the outbox as
  `PUT /runs/{id}` (state, reason, start and end). Only the owner sends them.
- **First sync.** A routine without a revision (made before the sync, or while signed out) is uploaded with this
  computer as its owner.
- **Governance down.** Everything keeps working here; the outbox waits, `Capabilities.synced` is false and the Agents
  status line says "Not synced". A refusal for good (a bad body, another device's run) drops the entry.
- **Owner computer.** The device id is the desktop's relay peer id (`RemoteTunnel.peer()`, 32 hex digits, also sent as
  `X-Dynwork-Peer` so Governance does not hint the writer), kept whether or not remote control is on; the name is the
  computer's. A routine owned elsewhere reads "Runs on <name>", can be edited and paused, its "Run now" is refused with
  that reason, and the detail offers "Move to this computer" (`move`: the owner changes through the same `If-Match`
  write; nothing counts as missed before the move). The clock fires only routines owned here (`Local.here`).
- **Hint.** Governance's change hint arrives as a relay control message (`@dynwork/remote`'s `events.control`, surfaced by
  `RemoteTunnel.onControl`) only while the remote-control tunnel is connected; without it the poll catches up.

- **Accounts.** Each routine carries the Governance account it belongs to (`SavedRoutine.account`), set when it is
  created while signed in or when it is synced, and each outbox entry carries its routine's. The view, the clock and
  the outbox act only on the active account's routines (`Options.account`); one with no account yet (never synced)
  counts as the active account's and is tagged on its first sync. Switching accounts leaves the other account's routines
  stored, hidden and not firing, and its outbox entries waiting: they are never sent with another account's token.
  The feed's cursor is kept per account.

Known limits: a routine moved to another computer can still fire here until
this computer reads the move (seconds with the hint, at most one poll without).

`test/routines/sync.test.ts` runs two computers against `test/routines/governance.ts`, a fake Governance over real HTTP.

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

## Create from a chat

"New routine ▾" in Agents offers **Create with Dynwork** (and **Set up manually**, the form). It opens a conversation in
the user's home with the setup prompt (`chatPrompt`) sent as the user's message; the agent asks what to do, how often,
when (Europe/Madrid unless told otherwise) and how to notify, and where, permissions, folder and connectors only when
they matter.

- **Tools.** The server plugin adds `routines_list` and `routines_create` (`@dynwork/server-plugin/routines`). The
  proposal is in the form's own terms: `name`, `instructions`, `repeat` (`manual`, `daily`, `weekdays`, `weekly`,
  `monthly`, `cron`) with `time`, `days`, `day` or `cron`, `timezone`, `where` (`local` | `farm`), `permissions`,
  `folder`, `connectors` (absent: all) and `notify`.
- **Bridge.** The tools run in the service, the routines live here. The plugin's own RPC (`dynwork.routines-chat`) carries
  them: a tool publishes a `request` event and waits; main follows the plugin's events (`chat.ts` `setup`), answers
  with the `answer` method, reads the requests still waiting with `pending` after each (re)connection, and a stopped
  step publishes `withdraw`. A list waits 10 s for main; a proposal waits for the user as long as it takes.
- **Why not a permission.** The card could have been a permission request (`permission.assert`) that main creates the
  routine from on its "once" reply. It is not, because a permission can be answered by something other than the
  user: the app's auto-approve setting answers every request, an "Always" reply is saved as a rule, and an unattended
  run turns "ask" into "deny". The card looks like the permission prompt and sits where it does, but only its own buttons answer it, and the
  agent has no way to press them.
- **Validation.** `definitionOf` turns the proposal into a `Definition` with the form's presets (`cronOf`), refusing an
  incomplete or unreadable schedule; then the `Definition` schema and the backend's own `validate`, as the form. A
  refusal is the tool's answer, with one line per field, and no card is shown.
- **Card.** A valid proposal becomes a `Card` in the `dynwork.routines.chat` Ipc. The conversation that made it shows
  it in its composer region, in place of the composer, drawn with OpenCode's `DockPrompt` and the permission dock's
  slots (`views/agents/proposal.tsx`, through the `session.composer.dock` slot, DynWork's patch). It shows the prompt,
  Routine, Schedule, Runs on, Permissions, Project folder, Connectors, Notifications, Origin and "Show full input",
  with **Cancel** and **Schedule** (⌘↵).
- **Schedule.** `decide` takes the card out first (a second answer from another window finds nothing), then creates
  through the routines Ipc's own `create`, so every window reads the new routine, and answers the tool with the
  routine's line. Cancel answers "nothing was created". The tool call in the conversation shows the result.
- **Agent Farm.** `where: "farm"` goes through the registry to the `farm` backend only when it is the real one
  (`DYNWORK_ROUTINES_FARM=1`); the skeleton's `validate` answers "not implemented", so the tool reports it and no card
  is shown. With the demo in its place the tool says the farm is not available. See `farm/README.md`.

`test/routines/chat.test.ts` drives `make` with the local demo fake and the farm skeleton;
`dynwork/packages/server-plugin/test/routines.test.ts` drives the tools and their wait.

## What the fake does not do

It reads no cron: a scheduled, enabled routine's `next` is a day after its last change. Runs start only through `start`
and finish when the clock passes their duration and `settle()` runs (`main.ts` calls it every few seconds). Nothing is
persisted, and nothing syncs.
