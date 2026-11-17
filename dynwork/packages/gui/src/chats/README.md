# Chats

Cloud chats are chat threads stored and answered on the user's active Governance (systemprompt) instance, by its
`dynwork-chats` extension at `/api/dynwork/chats/v1`. The phone and every desktop read the same threads, whether this
computer is on or not, and a reply keeps generating on the server when a window closes. This directory is the desktop's
side: the client of that API in main, the list kept in step with it, the `dynwork.chats` Ipc, and the model a window
renders a chat from. The view is `../views/chats`.

It is the same chat UI as a local session with no OpenCode backend behind it, as Claude Desktop does it: the session
UI's timeline (`@opencode/session-ui`) renders the chat's `SessionDocument`, and the app's composer
(`BuiltinUi.ChatComposer`) sends and stops. No OpenCode service, session, SDK call or config is involved: the view works
with the local service stopped. Only the type shapes of OpenCode's messages and events are imported here, and
`test/chats/boundary.test.ts` fails on anything else.

```
window                                                    main process
  views/chats ── ChatsChat (chat.ts) ── Ipc ── ChatsIpc (ipc.ts) ── ChatsSync (sync.ts) ── ChatsClient (client.ts) ──HTTPS──▶ instance
  SessionTimeline ◀── ChatsDocument (document.ts)   contract.ts      accounts' JWT (never crosses)
  BuiltinUi.ChatComposer ◀── chat.composer
```

| File          | Role                                                                                                                 |
| ------------- | -------------------------------------------------------------------------------------------------------------------- |
| `contract.ts` | The Schema data (`Model`, `Thread`, `State`, `Failure`, `Page`, `Event`) and the `dynwork.chats` Ipc                 |
| `client.ts`   | Main's client of the API: each route, its revision (`If-Match`), its errors as `Failure`s, and the log's SSE         |
| `sync.ts`     | Main's list: the change feed with its cursor, its poll, and following a thread's log with resume                     |
| `ipc.ts`      | The Ipc over the client and the list: the state, writes applied at once, failures as data, `follow`                  |
| `main.ts`     | The main-process setup, called from `../accounts/main.ts`: the active account, the Ipc, `update`, `focus` and `pull` |
| `backend.ts`  | The window's live Ipc client, handed over by `../accounts/renderer.ts` for the view to read                          |
| `document.ts` | The pure fold of a thread's history and live events into the `SessionDocument` the timeline renders                  |
| `chat.ts`     | One chat in a window: its document, loading and following it, and the composer model (send, stop, model)             |
| `fake.ts`     | An in-memory instance behind a `fetch`, for tests: every route, revisions, tombstones and replies streamed over SSE  |

## The API

As the plan's `contract.md` writes it: `GET /models`, `GET /changes?since=<cursor>`, `PUT /threads/{id}` (no
`If-Match` creates; with it, renames, archives or changes the model; `409` answers `{ current }`), `DELETE
/threads/{id}` (`If-Match`), `GET /threads/{id}/messages?before=&limit=`, `POST /threads/{id}/prompt` (`{ messageID,
parts, model? }`, `202` with the assistant message's id), `POST /threads/{id}/interrupt` and `GET
/threads/{id}/log?after=<seq>&follow=1` (SSE, OpenCode's v2 envelope). Errors are `{ "error": { "key", "message" } }`.

Where the contract leaves an encoding open, the client reads both: a row's model as `provider/model` or as an object,
times as ISO strings or epoch milliseconds, a tombstone as `deleted` or `deleted_at`, a write's answer as the row or as
`{ revision }`, the history as OpenCode's `SessionMessageInfo` or as the stored `{ info, parts }`.

Failures: no account or a JWT refused after one fresh mint is `signed-out`; no answer, a `5xx` or a `429` is
`unreachable`; `404` is `not-found`; `409` is `conflict`; `400` and `422` are `invalid`; anything else `failed`. The
instance's own message is kept; its raw body never is.

## Credentials

The JWT stays in main: `client.ts` asks the accounts for it per request (`session(id, fresh)`) and nothing it answers
carries it, a header or a raw body. The renderer only sees Ipc values. `test/chats/ipc.test.ts` runs every method,
failure, state push and event over the bridge and looks for the token in all of it.

## Keeping the list

`sync.ts` reads `/changes` from its cursor to the end of the feed: at start, when the account changes, when a DynWork
window gains focus, every 30 s while one has focus and every 5 minutes while none has (as the live sync), and at once on
the relay's `{"t":"chats.changed"}` hint, which `RemoteTunnel.onControl` passes on while remote control is connected
(`../accounts/main.ts`). A full read replaces the list; a later page replaces the threads it names and drops its
tombstones. A cursor the instance refuses starts over. Without an instance the list keeps its last threads and says
`unreachable`. It lives in memory only: a launch shows it after the first read.

## A chat in a window

`chat.ts` loads the newest page of history, then follows the log from the last durable seq it holds. `document.ts` folds
the events a cloud chat emits (the contract's "Events on /log": a reply's execution, steps, text and reasoning) the way
OpenCode's projection does, so a text delta shows as soon as it arrives; a replayed seq changes nothing, and a message
that did not change keeps its identity. When a reply ends the history is read again, which brings its final parts and
any prompt another device sent (the log carries no user message).

The composer: a new chat is made by its first prompt (`PUT` with the first line as its title and the chosen model), and
each prompt has its own `messageID`, so a retry is not sent twice. The prompt shows at once and goes away again if the
instance refuses it, which puts the draft back. Stop is `interrupt`; the partial text stays. The model chip lists
`/models`; choosing one on an existing chat writes it to the thread.

Not here yet: renaming, archiving and deleting from the view (the Ipc has them), older history pages, attachments, and
reasoning and tools (stage 2 of the contract; the fold already takes reasoning).
