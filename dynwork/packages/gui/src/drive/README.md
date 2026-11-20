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
| `capabilities.ts` | The switches for what an instance delivers, read from its discovery, and every decision they change, as pure functions           |
| `ipc.ts`          | The service: the active account, its snapshot and polling, attribution, the conversation index, failures as data                 |
| `fake.ts`         | An in-memory Drive that behaves as 0.83, or 0.84 with `version`, where DynWork can tell: `DriveFake.make(options)`               |
| `agent.ts`        | What the agent does with the `documents` MCP tools: its folder, its signature, its index, its uploaded pages (phase 07)          |
| `mentions.ts`     | `@Agent` in a comment: written as a real mention, followed on the bridge stream, and woken to the linked conversation (phase 08) |
| `share.ts`        | The agent's shares: each `documents_share` call waits on a card in its conversation for the user's decision (D24)                |
| `frames.ts`       | The viewer's HTML frames: main's navigation guard, and the observer main runs in their isolated world                            |
| `watch.ts`        | Main's observer of a window's viewer frames over the DevTools protocol (`dynwork.drive.frames`)                                  |
| `present.ts`      | Present: main holds a window full screen for a document alone (`dynwork.drive.frames`, `present`)                                |
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

What the account's instance delivers (its capabilities) goes with the switch too, and is read again from the instance
itself once its Drive answers: on the first read that succeeds, and on each one that succeeds after one that failed (a
reconnect, or an upgrade that restarted the instance). See [Capabilities](#capabilities).

## State and polling (D10)

`state` is a snapshot: the account's folders and the first page of its `recent` documents, the conversation index,
the capabilities, and `status` (`none`, `loading`, `ready`, `signed-out`, `unreachable`). It is read at start, after
every write, on `refresh`, and polled: every 5 minutes, every 20 s while a window holds `watch` open (the Drive view or
a document tab). A read that fails keeps the last folders and documents and says why in `status`. A read that answers
for an account that already left is dropped. Listings, searches and pages of a folder are read live with `list`.

From 0.84 the bridge stream says `document.drive.changed` (`{v: 1}`, no ids) to everyone who can see a document that
got a revision. `DriveMentions` follows that one stream for mentions already, and hands each change to the service's
`reread(account)`: with `pushChanges` on, the account's Drive is read at once (a burst of changes makes at most one more
read); off, the event changes nothing and the poll stays as it is. 0.83 sends no such event. `DriveMentions` also tells
the service while the stream is open (`streamed(account, open)`): with `pushChanges` on and the stream open, a watched
Drive keeps the 5-minute poll only, as the net for a change the push missed; while the stream is down the 20 s poll is
back at once. The stream keeps no history, so the poll armed before it opened still fires once and reads what it could
not have told.

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
- 0.83 records no message on a document it creates from a file or a template; the message is sent anyway, and 0.84
  keeps it on the first revision.
- 0.84 records the conversation itself (`conversationLabel`): a write that carries the conversation's `x-context-id`
  goes without the message, and the instance answers each revision's and comment's `context_id`, `agent_name`
  (`via_agent` on a comment), `client_id` and, to the conversation's owner only, `context_name`. A write without the
  context (its registration failed, or the agent's through the MCP until `contextByMcp`) keeps "`<conversation>` by
  DynWork". The service marks what is DynWork's own (`ours`: a context it registered for the account, or a revision
  signed "… by DynWork") and fills the title it knows. Versions show "`<conversation>` · DynWork" (or the other agent),
  the agent's name where there is no title, and "DynWork" where the instance says nothing; a comment of the user's own
  from a conversation shows "`<conversation>` · DynWork" in place of "You" (`DriveCapabilities.writer`,
  `views/drive/model.ts` `revisionBy` and `writerOf`).
- 0.84 refuses a write whose `x-context-id` it does not hold for the user (`422 unknown_context`, `SpClient.UnknownContext`,
  failure `unknown-context`): deleted there, say. The service forgets the context, registers the conversation again and
  makes the write once more (`attributed`); nothing was written the first time. A second refusal reaches the window.

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
  latest 500, id, name and email only, so it survives restarts and crosses conversations); then a lookup, by id (or an
  email by search, `Backend.searchPeople`) over REST while `peopleByRest` is on (0.84), otherwise through the
  `documents` MCP server's `documents_people`
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

## Sharing from the window (phase 17)

The Share popover (`views/drive/share-popover.tsx`) changes who has access with the window's own Ipc calls, `share`
(an upsert: `POST /documents/{id}/grants`, kind, value, level) and `unshare` (`DELETE …/grants?grant_id=`), each
answering who has access then; `findPeople` searches the directory to invite: over REST with `peopleByRest` (0.84,
`GET /documents/people?query=`, word by word, accents ignored), otherwise the `documents` MCP's `documents_people`. They are the user's acts, not the agent's: no card, no plugin RPC. The instance decides each with
DynWork's credential, an attended agent's: the Dynapps extension lets it share a document that agent created from 0.85
(`created_by_agent`, Direct channel, cap `edit`); anything else, and every share on 0.83, is `person`. The popover
offers them live only where that should hold (`madeByAgent`, `sharing`) and shows a refusal beside the list it keeps.
`created_by_agent` is not in any answer of the instance, so another agent of the user's writing through the API looks
the same, and is refused.

## The viewer's frames (phase 16)

The viewer shows an HTML page (and the Drive's previews) in a sandboxed `srcdoc` frame without `allow-same-origin`,
under the policy the instance served it with (D5); its scripts may run, and an agent may have written it (G11). The app
cannot read it, but the index follows the heading being read, a click on a comment's mark opens its thread, and the
comments' bubbles sit beside their marks. What the window learns of the frame is ids it gave the page and numbers, and
nothing of DynWork reaches the page:

0.84 serves a page an agent has ever written under its own tier (`renderedHtml.agentAuthored`: `scripts`,
`remoteOrigins`, never wider than the top level), as a different `Content-Security-Policy` on the same `/rendered`
answer. Nothing changes here: the frame takes that answer's `sandbox` flags and the rest as its meta policy
(`frameOf`), so a page with scripts on and `remoteOrigins` cdnjs and jsdelivr runs its scripts and loads from those two
only, and the navigation guard keeps it on its `srcdoc` whatever the policy lets it load (0.84 says a scripted page can
send its content out by navigating its own frame; tests in `test/views/drive/store.test.ts` and
`test/drive/frames.test.ts`).

- **Where it runs.** Electron 44 runs a sandboxed frame out of process, so the window's `webFrame` cannot reach it.
  `WebFrameMain.executeJavaScript` runs in the page's own world, where its scripts see and can replace what runs, and
  not at all in a frame whose policy runs no scripts (measured). Main uses the DevTools protocol instead (`watch.ts`):
  while a window shows a frame and holds `watch({ frame })` for it, main attaches to the window
  (`webContents.debugger`), auto-attaches to its sub-frames (`Target.setAutoAttach`, flat sessions), lets go of every
  frame whose name is not a viewer's (`DriveFrames.isViewer`), and in a viewer frame adds a binding
  (`Runtime.addBinding`, `executionContextName: dynwork-drive`) and the observer (`Page.addScriptToEvaluateOnNewDocument`
  in the world `dynwork-drive`, `runImmediately`) to every document. Both exist only in that isolated world: the page's
  scripts cannot see, call or replace them, and the frame's policy does not apply to them. Measured in Electron 44: it
  runs in frames with no scripts and `default-src 'none'`, survives a new `srcdoc`, and a page's own
  `window.dynworkDriveFrame` is not the binding.
- **What it reports** (`DriveFrames.observer`): the id of the heading being read when it changes (`DriveFrames.reading`:
  the last heading whose top has passed the upper third of the frame, else the first); where the page is scrolled
  (phase 19), once it moves from the top and then each time it changes, as `{ kind: "scroll", x, y }` in whole pixels of
  the document's own scroller (`document.scrollingElement`) clamped to `DriveFrames.farthest`; where the first mark of each
  thread sits when that changes (on scroll, resize and load: the thread's id and its top in whole pixels from the top
  of the frame's visible area, clamped to `DriveFrames.farthest`, the first `DriveFrames.maxMarks` of the page); and the
  comment of a mark the user clicked, only for a trusted click, so the page's scripts cannot click one for the user.
  With the marks shown it also reports a pick (phase 18), for the comment popup: a selection, read on the trusted
  click that ends it (Chromium sends it after the mouseup has settled the selection, to the common ancestor after a
  drag; a timer is not needed, and a frame's timers did not run in the hidden development window), or a trusted
  click without one that lands on no mark, link or control (`DriveFrames.controls`), inside a block the viewer
  numbered (`data-dynwork-block`, an opaque index the viewer gave the page, never a node id). A pick is
  `{ kind: "pick", block, quote?, rect }`: the block's index, the part of the selection inside its first block (spaces
  collapsed, `DriveFrames.maxQuote` at most) and where that part or the block sits, in whole pixels of the frame's
  visible area clamped like the marks. The observer only listens, in the capture phase: it never calls
  `preventDefault` or `stopPropagation`, so the page's own click and selection handlers work as before. Nothing else.
- **What main takes.** A binding call from a viewer frame's session whose name a call of that window watches, at most
  32 KB, parsed as `{ kind: "heading" | "mark", id }` with an id of 1 to 256 characters, or as
  `{ kind: "marks", items: [{ id, top }] }` with at most `maxMarks` items, each such an id and a whole number within
  `farthest`, or as `{ kind: "scroll", x, y }` with two whole numbers within `farthest`, or as `{ kind: "pick", block, quote?, rect: { left, top, width, height } }` with a whole block index up
  to `DriveFrames.maxBlocks`, a quote of 1 to `maxQuote` characters, sides that are whole numbers within `farthest`
  (sizes from 0), and not a key more, at any level (`DriveWatch.report`); anything else is dropped whole. It goes to that window alone,
  as the `seen` event of `dynwork.drive.frames`.
- **What the window takes** (`views/drive/viewer.tsx`, `fromFrame`): a report for its own frame's name whose id is a
  heading id or a mark it gave that page; of a `marks` report, the items whose id is a thread it marked there; of a
  `scroll`, two whole numbers within `farthest`; of a
  `pick`, a block index it numbered in that page (its node from the table `frameOf` keeps, `blocks`) and a quote that,
  spaces collapsed, is in the text the app knows of that node (`holds`). The window then moves the rectangle into its
  own coordinates (the frame's place and scale, cut to what the frame shows: `framed`) to place the popup. A page
  that forges a report can at most move the index to one of its own headings, open one of its own threads, move
  the bubble of one of its own threads, or open the comment popup on one of the document's own nodes and quotes,
  where the user still writes and sends the comment. The bubbles' names and initials are drawn by the window, beside the frame:
  nothing of a comment goes into the page, nor comes out of it.
- **Where a page loaded again starts** (phase 19). A comment added or resolved, or the marks shown or hidden, writes the
  frame a new `srcdoc`, which loads from its top. The window keeps showing the old page and asks main to put the next
  one where the observer last saw the reader (`restore({ frame, x, y })` of `dynwork.drive.frames`); main answers, and
  only then does the window load the new page. Main (`DriveWatch.restore`) takes only whole numbers within `farthest`
  (the Ipc's schema, then `DriveFrames.restorer`), for a frame a call of that window watches and whose session it holds:
  anything else answers `false` and sends nothing. It adds to that frame's session, in the world `dynwork-drive`, a
  script it builds itself from the two numbers (`DriveFrames.restorer`: nothing of the window or of the page goes into
  it) with `Page.addScriptToEvaluateOnNewDocument`, without `runImmediately`, so it runs only in the next document. It
  scrolls the document's own scroller there when the document is parsed (`DOMContentLoaded`), before it is drawn, and
  again on `load` unless the reader moved meanwhile, since images and fonts may make the page taller; it does nothing
  in a frame inside the page (`parent !== top`). Main removes the script when the frame's own frame navigates
  (`Page.frameNavigated` for the id the session's frame tree named), so later documents start at their top. Only the
  last restore asked for a frame arms it: one a later one overtook, or one the frame has not taken within 2 s (a busy
  renderer), answers `false` and takes its script away whenever it lands. The window, for its part, loads the new page
  anyway after 3 s without an answer. `Runtime.evaluate` once the page has loaded would have shown
  the page at its top first; this needs no evaluation in the page's context at all. The page sees nothing of it: no
  binding, no message, no change to its policy or its sandbox. When main cannot (no observer for the frame), the window
  goes back to the heading the reader was at, as before. Only the document's own scroller is kept: a page that scrolls
  an inner box of its own (a layout with `overflow: auto`) starts that box at its top.
- **When it stops.** When the window's last frame stops watching, main detaches if it attached; if another client had
  attached first (the force-focus helper), main leaves it attached and lets its own sessions go. If another client
  detaches while the window watches, main attaches again. Each frame of a window has its own name
  (`dynwork-drive-frame:<n>`), which the navigation guard keeps on its page as before.
- **Limits.** A frame that runs in its window's process (no site isolation) is not reached: the index then does not
  follow the reading and a mark opens nothing, and the rest works. A page may rename its frame (`window.name`) before
  main reads it: it is then not observed.

## Present

A page cannot take its window full screen: the app's windows give a page no `fullscreen` permission
(`packages/desktop/src/main/windows/security.ts` grants only clipboard writes and notifications), so
`requestFullscreen` is refused there, which is why Present did nothing in phase 16. The window asks main instead,
with the `present` method of `dynwork.drive.frames`, and holds the call while it presents (`DrivePresent`,
`present.ts`): main takes the caller's window full screen (`BrowserWindow.setFullScreen`) and back when the call is
let go, and ends it itself, before the page sees the key, on Escape anywhere in the window (`before-input-event`: the
document's frame included), when the window leaves full screen another way, or when it closes. A window the user had
full screen stays so. The view meanwhile shows the document alone over the window (`data-presenting`, a manual popover
in the top layer), and also ends it on an Escape the window itself receives.

## Capabilities

Each is a switch per account, with its decisions in `capabilities.ts` and a test in both states
(`test/drive/capabilities.test.ts`, and the service's in `ipc.test.ts`). The service reads what an instance delivers from
the instance itself, in one place (`DriveCapabilities.delivered`), never from a version DynWork assumes:

1. its root discovery (`GET /api/v1`, public, `SpDrive.discovery`): 0.84 announces the Drive there
   (`endpoints.documents`, whether the store is on), which 0.83 does not; and the core's `version`;
2. only where discovery tells neither, a probe: `GET /documents/people?ids=<the user's own id>` answering (0.84) or not.

0.84 turns on `conversationLabel`, `pushChanges` and `peopleByRest` (the REST side of G02, G09 and G13); 0.83 and older,
none. The rest of what 0.84 delivers is turned on by the phases that use it. An instance whose discovery does not answer
keeps what was read before (nothing, for a new account), and the next read that succeeds asks again. `DriveMain.setup`
still takes an option that forces a switch on or off over what was read.

| Capability          | Gap | Off (0.83)                                                                               | On                                                                          |
| ------------------- | --- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `personActions`     | G01 | A direct write is "`<user>` by DynWork"; person actions go to Governance                 | A direct write is the person's own, with no message                         |
| `conversationLabel` | G02 | The message names the conversation                                                       | Only the `x-context-id`; the instance names it, as do versions and comments |
| `rangeComments`     | G08 | A comment on a cell range answers `unsupported` without a call                           | It reaches the backend                                                      |
| `rawHtmlByMcp`      | G04 | Its edits by ops of an HTML document are refused; a changed page is a new document       | `documents_edit {content_blob_ref}` rewrites the page in the same document  |
| `mcpFolders`        | G05 | DynWork makes `Artifacts/<project>/<conversation>` and imports the agent's files by REST | The agent imports with `documents_import` (DynWork gives it the folder)     |
| `contextByMcp`      | G06 | An MCP write enters the local index                                                      | Left to the Drive, once it also lists by conversation                       |
| `docsByContext`     | G07 | `documentsOf` reads the local index only                                                 | REST writes are left to the Drive, which adds its list by `x-context-id`    |
| `pushChanges`       | G09 | 20 s poll while watched, 5 min otherwise; `document.drive.changed` is ignored            | Each change reads the Drive; 5 min poll only while the stream is open       |
| `peopleByRest`      | G13 | `people` answers `unsupported`; authors no grant names read "Someone"; search by MCP     | Authors named by id (20 a call); the directory and the cards over REST      |

`agentFiling(capabilities)` is the decision phase 07 reads for `mcpFolders` (HTML included: an import keeps the scripts), and
`agentEdits(capabilities, edit)` the one the edit guard reads. The real backend has no `byContext` yet: with
`docsByContext` on and no route, `documentsOf` still answers the index (and only for a registered conversation).

A PDF takes no comment, and there is no capability for it: the core does not read PDF and refuses an anchor it cannot
check (D22). `Anchor` has no `page` kind.

## Failures

Every method answers a `Failure` instead of rejecting, as routines do. The backend maps the client's errors to codes
(`signed-out`, `unreachable`, `not-found`, `forbidden`, `person`, `suggest`, `conflict` with the `head` it lost to,
`unsupported`, `invalid`, `unknown-context`, `failed`) with DynWork's own words: the instance's message never reaches a window. Only
`unreachable` is retryable. A backend that rejects anyway is a bug; the service answers `failed` without its message.
There is no reopen for a resolved comment: 0.83 has no route for it (G12).
