# Drive

The Drive is the document store of the active account's Governance instance (`/api/v1/documents`), the same content
Governance's web calls Drive. DynWork works online against it: there is no local copy (D3). This directory is the
service in the main process that reads and writes it with the account's JWT, which never reaches a window; no view.

```
window                                main process
  views ──ctx.use(Drive)──► Ipc ──► DriveIpc ──► Backend (Governance over SpDrive | fake)
  DriveClient (client.ts)   contract.ts  ipc.ts      backend.ts
```

| File              | Role                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `contract.ts`     | The Schema data (`Document`, `Folder`, `Revision`, `Comment`, `Anchor`, `Link`, `Failure`, `State`) and the `dynwork.drive` Ipc  |
| `backend.ts`      | `interface Backend` (one account's Drive), `fail`, and `remote`: the real one over `SpDrive` from `@dynwork/sp-client`           |
| `capabilities.ts` | The switches for what the instance has not delivered yet, and every decision they change, as pure functions                      |
| `ipc.ts`          | The service: the active account, its snapshot and polling, attribution, the conversation index, failures as data                 |
| `fake.ts`         | An in-memory Drive that behaves as 0.83 where DynWork can tell: `DriveFake.make(options)`                                        |
| `agent.ts`        | What the agent does with the `documents` MCP tools: its folder, its signature, its index, its uploaded pages (phase 07)          |
| `mentions.ts`     | `@Agent` in a comment: written as a real mention, followed on the bridge stream, and woken to the linked conversation (phase 08) |
| `share.ts`        | The agent's shares: each `documents_share` call waits on a card in its conversation for the user's decision (D24)                |
| `main.ts`         | The main-process setup over the accounts, from `accounts/main.ts`                                                                |
| `client.ts`       | The window's live Ipc client, handed over by the window entry for the views to read                                              |

Everything crossing to a window is a Schema value of DynWork's own, with epoch milliseconds for time; the backend reads
the wire. `test/drive/conformance.ts` is the suite every backend passes: the fake, and the real one against sp-client's
fake instance.

## The active account

The Drive is the active, signed-in account's. `accounts/main.ts` calls `account()` on every change of the accounts:
when the active account is another one (or none), the snapshot and the backend go at once, the state says `loading`
(or `none`) with nothing of the previous account in it, and the new account's Drive is read. A call from a window also
notices a switch before it reaches a backend.

## State and polling (D10)

`state` is a snapshot: the account's folders and the first page of its `recent` documents, the conversation index,
the capabilities, and `status` (`none`, `loading`, `ready`, `signed-out`, `unreachable`). It is read at start, after
every write, on `refresh`, and polled: every 5 minutes, every 20 s while a window holds `watch` open (the Drive view or
a document tab). A read that fails keeps the last folders and documents and says why in `status`. A read that answers
for an account that already left is dropped. Listings, searches and pages of a folder are read live with `list`.

From 0.84 the bridge stream says `document.drive.changed` (`{v: 1}`, no ids) to everyone who can see a document that
got a revision. `DriveMentions` follows that one stream for mentions already, and hands each change to the service's
`reread(account)`: with `pushChanges` on, the account's Drive is read at once (a burst of changes makes at most one more
read) and the poll slows to 5 minutes; off, the event changes nothing and the poll stays as it is. 0.83 sends no such
event.

## Who wrote it (D2)

The instance names the agent from the signed token, never from the request, and DynWork's JWT acts as an attended
agent. So the service says the rest:

- A write from a conversation carries the revision message "`<conversation>` by DynWork" and the conversation's
  `x-context-id`: the id the instance gives the conversation when the service registers it as a context
  (`POST /api/v1/core/contexts {name}`, D20) on its first write, under its title. The id is kept per account and session
  in the plugin's storage (`DriveIpc.Saved.contexts`, `{id, name}`); when the title changes, the next write renames the
  context (`PUT /api/v1/core/contexts/{id}`), and one the instance no longer knows is registered again. Writes of a
  conversation made together share one registration. When the instance does not answer, the write goes without an
  `x-context-id` (never blocked) and the next one tries again. 0.84 refuses an `x-context-id` it did not issue
  (`422 unknown_context`): a context saved as a plain string is a UUID an earlier version made up, never sent again,
  and replaced at the conversation's next write (the index keys conversations by session id, so no link is lost).
- A direct write carries "`<user>` by DynWork", the user's email or name.
- A comment carries no message (the instance has no field for one), only the conversation's `x-context-id`.
- 0.83 records no message on a document it creates from a file; the message is sent anyway.

What the instance keeps to a person (sharing, accepting proposals, restoring, deleting someone else's document) answers
`person`: the window sends the user to Governance.

## The conversation index

What a conversation did to which documents (`created`, `edited`, `proposed`, `attached`, `read`), kept per account on
this computer because the Drive cannot answer it yet. The service records a conversation's own uploads and edits;
`DriveAgent` records what the agent wrote through the `documents` MCP, and `link` a document attached to a chat. A
document a conversation edits again is still one entry per act, at its latest revision. Reads are not recorded: they
change nothing. `documentsOf(conversation)` answers it newest first.

## The agent's documents (phase 07, D4, D8)

The agent's tools are the instance's own, the `documents` MCP server that the server plugin adds from the manifest
(`@dynwork/server-plugin/mapping`): DynWork has no tools of its own for documents. What DynWork adds is around them.

```
OpenCode service                                       main process
  documents_documents_create ─ tool hooks ─ ask ─────► DriveAgent.ask   ─► folder + message
                                           └ touch ──► DriveAgent.touched ─► index, import of a page
```

- **Seeing the calls.** The plugin hooks `execute.before` and `execute.after` for the server's five writes (`create`,
  `edit`, `upload`, `update`, `copy`). Calls a Code Mode program makes pass the same hooks, so `execute` wrapping them
  changes nothing. It publishes `ask` (before a `create` or `edit`) and `touch` (after any write) on the plugin's RPC
  `dynwork.documents`; main follows them like it follows the scheduled-task tools'.
- **The folder.** Before a `documents_create` that names no `folder_id`, main answers with the conversation's folder,
  `Artifacts/<project>/<conversation>` (D8): the project is the session's directory name, the conversation its title (or
  `Untitled conversation`). Main makes the folders by REST on first use, keeps the folder's id per session
  (`DriveIpc.Saved.folders`), makes it again if the user deleted it, and tells apart two conversations with the same
  title by adding the end of the session id. A folder the agent chose stays. Calls run together make the folders once.
- **The signature.** The same answer carries the revision message: "`<conversation>` by DynWork", after the agent's own
  message when it wrote one (D2). The MCP calls carry no `x-context-id` (one header per server, not per call), so the
  index is how DynWork knows which conversation wrote what (G06).
- **The index and the tab.** Each completed write enters the conversation's index (`created` for `create` and `copy`,
  `proposed` when the answer has a `proposal_id` or the call asked to propose, `edited` otherwise). The window opens the
  document as a tab of the chat's side panel, once per document and chat, only for what arrives after the window first
  read the account's index (`views/drive/register.tsx`, `arrivals`).
- **A page with scripts (C7, D14).** `documents_upload` of `text/html` is imported by DynWork from its `blob_ref`
  (`Backend.importBlob`) into the conversation's folder, which keeps the `<script>`; `documents_create` and `set_html`
  cannot. A name the folder already holds becomes `name (2).html`. Other uploads (an image for a Word file) are left
  alone. The agent learns this from a rule the plugin adds to the instance's own when the `documents` server is among
  its MCP servers (`DynWorkDocuments.rules`).
- **What the agent is told (phase 12).** The rule sends the work to the Drive: documents, pages, reports, presentations
  and artifacts are made with the `documents` tools, and a local file only when the user asks for one (code and the
  project's files stay local). A page goes up from one Code Mode call (encoded there, `documents_upload`), never through
  the disk, a local server or a browser tab. `documents_read` and `documents_export` show text, not styles: the agent
  must not judge a page's look from them. `DynWorkDocuments.instructions(switches)` builds the text from `rawHtmlByMcp`
  and `mcpFolders`; the capabilities live in main and do not reach the plugin yet, so the managed block is the 0.83 text
  (both off) until a way to send them is decided. In 0.83 a changed page is a new document next to the old one, and the
  rule has the agent say so in a line.
- **0.84, prepared and off.** `mcpFolders`: the agent calls `documents_import` itself with the blob it uploaded, and
  the plugin asks main about it (`import` verb) so the call goes with the conversation's folder, made by DynWork like
  for a creation (`documents_import` has no `message`: only the folder is added). `touched` files the result as
  `created` by the MCP, and `upload` stops importing the page: `agentFiling` no longer asks for `rawHtmlByMcp`, since
  an import keeps the scripts (0.84 CHANGELOG). `rawHtmlByMcp`: `documents_edit {document_id, content_blob_ref,
base_revision}` rewrites the page whole in the same document; the guard lets it through (with or without the
  capability) and `touched` files it as an `edited` entry, which opens the preview tab like any edit.
- **No edit by ops of a page (D21).** Until `rawHtmlByMcp`, every op on an HTML document (`str_replace`, `set_html`,
  ...) strips its scripts and styles (0.83). The plugin's `ask` for a `documents_edit` names the document and whether it
  replaces the content from a blob (`content_blob_ref`, 0.84); main reads the document's format and, for an edit by ops
  of an HTML one, answers `refuse` (`DriveCapabilities.agentEdits`). The plugin then fails the call in `execute.before`
  with a `Tool.Error`, the hook's own way to reject a call, so it never reaches the instance and the agent reads that it
  should upload the whole page again. A format that cannot be read lets the edit go.
- **A folder made meanwhile (G05).** From 0.84 a folder whose name a sibling has is refused as `name_taken` (409,
  `conflict` here). Making `Artifacts`, the project or the conversation's folder looks for the sibling of that name when
  the instance answers so, and uses it. 0.83 never answers it.
- **Switching a capability on.** `mcpFolders` makes `DriveAgent` leave a creation's folder to the agent (no `ask`
  folder for it) and stop importing what it uploaded; an import the agent makes still gets the conversation's folder; `conversationLabel` takes the message away;
  `contextByMcp` and `docsByContext` take the index's entry away (`DriveCapabilities.indexed`). The plugin's rule names
  `folder_id` and the upload of pages: it needs rewording when either of the first two goes on.
- **When it is not there.** Main closed or signed out: the plugin's ask times out after 10 seconds and the call runs as
  the agent wrote it, at the Drive's root; the touch is lost, and the document is not in the index.

## @Agent in a comment (phase 08, D12, D15)

A comment that asks for the agent (`@Agent`, also `@Agente`, as a word of its own) is a real mention of the user themself
with `attention: agent`: the instance's way to say "my agent, do this". The service writes it (`DriveMentions.write`:
the first `@Agent` becomes `@[Name](user:<id>)`, the form the instance requires in the body, and the write carries
`mention_options`), and every reader gets the text back as `@Agent` with `Comment.agent` set (`DriveMentions.read`). An
account that does not know its user's id keeps the text as typed and wakes nothing.

```
window ──comment "@Agent …"──► DriveIpc ──► Governance (mention of oneself, attention agent)
                                 │  asked ─────────────────────────────┐
                                 │                                     ▼
Governance ──/v1/bridge/stream──► Backend.stream ────► DriveMentions.attend ──► session.prompt ──► the conversation
                                                         (once per comment)        │
                                       documents_comment (the agent's own MCP tool) ◄┘ answers in the thread
```

- **Two sources, one handler.** The service tells `DriveMentions` about each comment it writes with `@Agent`, and
  `Backend.stream` (the bridge stream, `SpDrive.stream`) says every `document.comment.mentioned` of the user. The stream
  is what reaches a comment written elsewhere (the web); the write's own call does not wait for it. Both end in `attend`,
  which reads the comment back from the instance and takes it only when it is the user's own and mentions the user: the
  stream's word is not taken for it.
- **Once per comment.** `attend` is keyed by the comment id: one in flight at a time, and a record per comment kept in the
  plugin's storage (`Saved.mentions`, the newest 200) once decided, so a repeat of the stream, the write, or a restart of the
  app does not prompt twice. A `failed` outcome is kept too: the user sends it again as a new comment.
- **Never another account's.** The conversation comes from the index of the account the comment belongs to
  (`linksOf(account)`); nothing of another account is read for it, and when the active account is no longer that one by the
  time the comment is read, nothing is read or woken. The stream is closed when the account changes and opened for the new
  one.
- **Which conversation.** The latest that worked with the document (any act in the index) and whose session still exists;
  one that is gone is passed over. None: the outcome is `unlinked`, nobody is woken, and the thread says so with "Use in a
  chat" (`AgentNote`, `views/drive/comments.tsx`).
- **The way back.** The prompt carries the thread and where it points; the conversation answers with the `documents` MCP
  tools it already has (D4): `documents_comment` replies in the thread, `documents_edit` changes the document, and
  phase 07's hooks file those writes under the conversation. DynWork posts nothing for the agent. Without the `documents`
  server in the service (the app in development) the conversation is prompted and has no tool to answer with.
- **What the instance does not say (0.83).** The stream's event has no `attention`, a mention of oneself makes no
  notification (`/api/v1/notifications` lists only other people's), and the stream keeps no history and sends no heartbeat.
  So a mention someone else made is not attended even when it says `attention: agent`: it would run another person's words
  as the user's agent, and is left to Governance; only the user mentioning themself is a job. DynWork opens the stream
  again every five minutes and two seconds after it ends, and a mention made while it was closed is lost, except for those
  the service writes (they do not wait for the stream).

## The agent's shares (D24)

Before every `documents_share` call (a grant, a `transfer_to` or a `revoke_all`) the server plugin stops the call and
publishes it (`DynWorkDocuments.confirm`, `confirm` event of `dynwork.documents`); main shows it on a card in the
conversation, tells the plugin the card is up (`shown`) and sends back the user's decision (`decide`). Nothing is shared
without it: once the card is up the call waits as long as the user takes, like a permission prompt; a share no card was
shown for within 10 seconds is refused (below). A main that reconnects reads the shares still waiting (`shares`).
Stopping the step withdraws the card.

```
documents_share ──execute.before──► plugin: confirm ──event──► DriveShare (share.ts) ──Ipc dynwork.drive.shares──► card
       ▲                                  ▲                        │ names: backend.get, the folders read, people
       └──── runs, or fails with ─────────┴──────── decide ◄───────┘ ◄── Reject · Allow in this conversation · Allow once
             "The user declined …"
```

- **The card.** `views/drive/share.tsx`, in the `session.composer.dock` slot, drawn as OpenCode's permission dock. It
  says what, with whom and at which level («Share _Q3 report.md_ with _Luis Martín_ · Edit»); a transfer and a revocation
  have their own words. The document comes by name from the Drive, a folder from the Drive as last read. A person, first found first: the
  conversation's own `documents_people` answer (the plugin keeps it per conversation, `DynWorkDocuments.heard`, and adds
  it to the share); the people the account met (`DriveIpc` `known`: every `documents_people` answer of the agent,
  which the plugin sends as the `people` event, and everyone a card named, in the Drive's store on this computer, the
  latest 500, id, name and email only, so it survives restarts and crosses conversations); then a lookup, by id over
  REST while `peopleByRest` is on (0.84), otherwise through the `documents` MCP server's `documents_people`
  (`Backend.findPeople`, `SpDrive.lookupPeople`). That tool says it searches by "name, email or id", but 0.83.0 compares
  only display name, name, full name and email (`search_active_by_prefix`): an email is named, an id finds nobody. So
  on 0.83 the agent's rules ask it to look a person up with `documents_people` right before each share (dropped once
  `peopleByRest` is on). Only an exact match names them; a lookup that fails or takes over 3 seconds
  (`DriveShare.lookupWithin`) leaves the value as the agent gave it, and the card shows anyway. The card says «Name
  (email)», the email telling two people of one name apart.
- **Allow in this conversation.** Kept in main, per conversation and kind of share (grant, transfer, revoke), while the
  app runs: the next share of that kind there is allowed with no card, and the cards of that kind already waiting there
  go too. Another conversation asks again; a restart asks again. A subagent's share shows in, and counts for, the
  conversation that started it; a conversation child (DynWork's runs, the chats) is a conversation of its own.
- **Reject.** The call fails with a `Tool.Error` the agent reads ("The user declined to share document … with user …
  (edit): nothing was shared. Do not try again unless the user asks you to."), so the step goes on: it is not OpenCode's
  plain rejection, which ends the step.
- **Why not OpenCode's permission prompt.** Its "Allow always" is saved for the whole project
  (`PermissionSaved.add({projectID, …})`), its button cannot say "in this conversation" without an upstream patch, and the
  app's auto-approve answers permission requests unseen. The card is not a permission: the session's permissions ("Don't
  ask" too) and auto-approve play no part. The tool's own permission (`documents_documents_share`) still applies after
  the card; OpenCode's agents allow it, so it does not ask a second time unless the user's config makes it ask.
- **Scheduled tasks.** OpenCode denies a permission that would ask only where it settles unattended work itself
  (`Permission.Unattended`: an automation's code check, its subagent check); in a DynWork run an "Ask me" permission
  waits for the user until the run's time limit, and "Don't ask" allows everything. A share does neither: in a run's
  conversation (`ses_aut_`, OpenCode's automations and DynWork's runs) it is refused at once, with no card, and the agent
  reads why. The instance's policy also denies sharing to unattended agents.
- **Nobody to ask.** Main closed, or no window open (`attended` in `DriveMain.setup`): main does not say `shown`, and
  after 10 seconds (`DynWorkDocuments.heardWithin`) the plugin refuses the share with a `Tool.Error` the agent reads
  ("Dynwork could not ask the user to confirm this share…"). It fails closed: never shared unseen, never left waiting
  for nobody.

## Capabilities

Each is a switch per account, off today, with its decisions in `capabilities.ts` and a test in both states
(`test/drive/capabilities.test.ts`, and the service's in `ipc.test.ts`). How one gets switched on, by the core's version
or an announcement in the manifest, is decided when the first one arrives; until then `DriveMain.setup` takes them as an
option.

| Capability          | Gap | Off (today)                                                                              | On                                                                         |
| ------------------- | --- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `personActions`     | G01 | A direct write is "`<user>` by DynWork"; person actions go to Governance                 | A direct write is the person's own, with no message                        |
| `conversationLabel` | G02 | The message names the conversation                                                       | Only the `x-context-id`; Governance shows the conversation                 |
| `rangeComments`     | G08 | A comment on a cell range answers `unsupported` without a call                           | It reaches the backend                                                     |
| `rawHtmlByMcp`      | G04 | Its edits by ops of an HTML document are refused; a changed page is a new document       | `documents_edit {content_blob_ref}` rewrites the page in the same document |
| `mcpFolders`        | G05 | DynWork makes `Artifacts/<project>/<conversation>` and imports the agent's files by REST | The agent imports with `documents_import` (DynWork gives it the folder)    |
| `contextByMcp`      | G06 | An MCP write enters the local index                                                      | Left to the Drive, once it also lists by conversation                      |
| `docsByContext`     | G07 | `documentsOf` reads the local index only                                                 | REST writes are left to the Drive, which adds its list by `x-context-id`   |
| `pushChanges`       | G09 | 20 s poll while watched, 5 min otherwise; `document.drive.changed` is ignored            | Each change reads the Drive; 5 min poll only, as the net for a miss        |
| `peopleByRest`      | G13 | `people` answers `unsupported`; authors no grant names read "Someone"                    | The window asks the instance for those authors' names by id (20 a call)    |

`agentFiling(capabilities)` is the decision phase 07 reads for `mcpFolders` (HTML included: an import keeps the scripts), and
`agentEdits(capabilities, edit)` the one the edit guard reads. The real backend has no `byContext` yet: with
`docsByContext` on and no route, `documentsOf` still answers the index (and only for a registered conversation).

A PDF takes no comment, and there is no capability for it: the core does not read PDF and refuses an anchor it cannot
check (D22). `Anchor` has no `page` kind.

## Failures

Every method answers a `Failure` instead of rejecting, as routines do. The backend maps the client's errors to codes
(`signed-out`, `unreachable`, `not-found`, `forbidden`, `person`, `suggest`, `conflict` with the `head` it lost to,
`unsupported`, `invalid`, `failed`) with DynWork's own words: the instance's message never reaches a window. Only
`unreachable` is retryable. A backend that rejects anyway is a bug; the service answers `failed` without its message.
There is no reopen for a resolved comment: 0.83 has no route for it (G12).
