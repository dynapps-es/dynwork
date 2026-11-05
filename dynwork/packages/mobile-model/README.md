# @dynwork/mobile-model

One pure TypeScript layer that turns OpenCode's session API and event stream into the compact view model DynWork Mobile
draws (decision P2). It is the only code that knows upstream's message, part and event shapes, so a rebase onto a new
OpenCode release breaks here first and nowhere in the app. No React, no `node:` imports, no Bun APIs in `src`: it runs
on Bun, Electron and Hermes, and could feed a desktop compact view as well.

```ts
import { Project, Reduce, State } from "@dynwork/mobile-model"

let state = State.empty({ desktop: "Studio Mac" })
state = Reduce.snapshot(state, { sessions, messages: { [id]: messages }, permissions, forms }) // REST answers
state = Reduce.event(state, event) // each event of /api/event, in any order, more than once

Project.sessions(state) // View.Row[]: root sessions, newest first
Project.session(state, id) // View.Session: turns of blocks, background work, what blocks it
```

## Layers

| File         | Contents                                                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state.ts`   | What the reducer keeps: sessions, messages normalized at the boundary (`State.message`), pending permissions and forms. Plain JSON, so a store can persist it |
| `reduce.ts`  | `snapshot`, `event`, `events`. Mirrors upstream's own message projection (`message-updater.ts` in core) over JSON                                             |
| `rules.ts`   | The grouping rules of decision P2 as one table, and the tool-name routes. `test/rules.test.ts` has a test per row                                             |
| `project.ts` | `sessions` and `session`: state into turns of blocks (`view.ts` has the types the app imports)                                                                |
| `shapes.ts`  | The structure of every event and message type in a set of fixtures, for `record-session.ts --check`                                                           |

## What the reducer tolerates

- **Duplicates.** A durable event is applied once per (aggregate, sequence). Everything else is a set, never an increment,
  so replaying events a snapshot already holds changes nothing.
- **Disorder.** An event for a message that has not started waits for it (at most 256 events for 64 messages). A tool result
  before its call is kept, a reply before its request is remembered, and messages are ordered by the durable sequence of the
  event that created them, not by arrival.
- **Snapshots at any moment.** A snapshot never reopens a step that already finished here, and a status newer than the
  snapshot stays. Text deltas are ephemeral and carry no sequence: one that arrives after the full text, or for text a
  snapshot already holds, is dropped. A snapshot lists only the permissions still waiting, so one taken after a request was
  answered cannot show the mark "granted" on the call.
- **The unknown.** An event it does not know is ignored. A content part or message kind it does not know is a
  `{kind: "unknown"}` block or hidden, never a throw.

## Notes on upstream's shapes (OpenCode 2.2.5)

- A user message exists once `session.inbox.enqueued` (the text) and `session.inbox.delivered` (the moment) have both been
  heard. Its id is the inbox id. Synthetic messages (a finished subagent or background shell reporting back) take the same
  route, with `metadata.source` and `childID` or `shellID`. Upstream orders messages by delivery, which is not the order of
  their ids.
- The `idle` message has no event of its own: it is `session.execution.succeeded`, `failed` or `interrupted` with the event
  id's `evt_` turned into `msg_`.
- There is no `session.status` event on the stream in practice; whether a session works is the execution events (or the
  session's `time.busy` against `time.idle`).
- A subagent call announces its child session with `session.tool.progress` (`metadata.sessionID`); a background one
  completes at once with `metadata.status: "running"` and finishes with a synthetic message. A background shell command
  completes at once with the shell id only in its text ("shell ID: sh\_..."), and finishes the same way.
- Todos exist only with `experimental.todo` on. The `edit` tool reports its diff in `metadata.files`; `write` reports
  nothing, so its card counts the lines it was given.
- A user interruption is `session.step.failed` with the error type `aborted` and an `interrupted` idle: a status, not an error.
- Permission and form events are ephemeral: no durable sequence, so they dedupe by being sets.

## Fixtures and goldens

`test/fixtures/<scenario>.jsonl` are recordings of real OpenCode sessions: a `meta` line, every `/api/event` event for the
scenario's sessions, and `snapshot` lines with what the REST routes returned at named moments (while a permission waits,
while a background subagent runs). `test/golden/<scenario>.json` is what the phone draws for each, from the events alone.
Both are committed.

```bash
bun dynwork/script/record-session.ts [scenario...] # record again (--list names them)
bun run golden                                      # rewrite the goldens, then read the diff
bun dynwork/script/record-session.ts --check        # the shapes still match the committed fixtures?
```

The recorder starts an OpenCode service of its own on a port the OS picks, in a temp HOME, XDG and config directory, with a
fake Anthropic-protocol provider on another loopback port that answers each prompt from a script. It needs no network and
no model, never touches the installed DynWork or its port, and removes its processes and temp directory when it exits.
Scenarios and scripts are in `script/record-session/scenarios.ts`.

`sync-upstream.ts` runs `record-session.ts --check` after a rebase and fails on a changed event or message shape.

## Tests

`bun test` runs the goldens, the ways to the same state (events from nothing, a snapshot, a snapshot plus the events after
it, the events twice, neighbours swapped), one test per grouping rule, the reducer's tolerance and the fixtures' hygiene (no
machine path, user or credential in a recording). `bun run test:hermes` runs the same files under the Hermes engine of
React Native 0.88, through the harness of `@dynwork/remote` (`bun ../remote/script/hermes.ts --package .`).
