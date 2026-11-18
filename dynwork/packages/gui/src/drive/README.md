# Drive

The Drive is the document store of the active account's Governance instance (`/api/v1/documents`), the same content
Governance's web calls Drive. DynWork works online against it: there is no local copy (D3). This directory is the
service in the main process that reads and writes it with the account's JWT, which never reaches a window; no view.

```
window                                main process
  views ──ctx.use(Drive)──► Ipc ──► DriveIpc ──► Backend (Governance over SpDrive | fake)
  DriveClient (client.ts)   contract.ts  ipc.ts      backend.ts
```

| File              | Role                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `contract.ts`     | The Schema data (`Document`, `Folder`, `Revision`, `Comment`, `Anchor`, `Link`, `Failure`, `State`) and the `dynwork.drive` Ipc |
| `backend.ts`      | `interface Backend` (one account's Drive), `fail`, and `remote`: the real one over `SpDrive` from `@dynwork/sp-client`          |
| `capabilities.ts` | The switches for what the instance has not delivered yet, and every decision they change, as pure functions                     |
| `ipc.ts`          | The service: the active account, its snapshot and polling, attribution, the conversation index, failures as data                |
| `fake.ts`         | An in-memory Drive that behaves as 0.83 where DynWork can tell: `DriveFake.make(options)`                                       |
| `agent.ts`        | What the agent does with the `documents` MCP tools: its folder, its signature, its index, its uploaded pages (phase 07)         |
| `main.ts`         | The main-process setup over the accounts, from `accounts/main.ts`                                                               |
| `client.ts`       | The window's live Ipc client, handed over by the window entry for the views to read                                             |

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

## Who wrote it (D2)

The instance names the agent from the signed token, never from the request, and DynWork's JWT acts as an attended
agent. So the service says the rest:

- A write from a conversation carries the revision message "`<conversation>` by DynWork" and the conversation's
  `x-context-id`: a UUID v4 the service gives each conversation (by session id) once, kept per account in the plugin's
  storage (`DriveIpc.Saved`).
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
- **Switching a capability on.** `mcpFolders` makes `DriveAgent` leave the folder to the agent (no `ask` folder, no
  import of what it uploaded, unless it is HTML without `rawHtmlByMcp`); `conversationLabel` takes the message away;
  `contextByMcp` and `docsByContext` take the index's entry away (`DriveCapabilities.indexed`). The plugin's rule names
  `folder_id` and the upload of pages: it needs rewording when either of the first two goes on.
- **When it is not there.** Main closed or signed out: the plugin's ask times out after 10 seconds and the call runs as
  the agent wrote it, at the Drive's root; the touch is lost, and the document is not in the index.

## Capabilities

Each is a switch per account, off today, with its decisions in `capabilities.ts` and a test in both states
(`test/drive/capabilities.test.ts`, and the service's in `ipc.test.ts`). How one gets switched on, by the core's version
or an announcement in the manifest, is decided when the first one arrives; until then `DriveMain.setup` takes them as an
option.

| Capability          | Gap | Off (today)                                                                              | On                                                                       |
| ------------------- | --- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `personActions`     | G01 | A direct write is "`<user>` by DynWork"; person actions go to Governance                 | A direct write is the person's own, with no message                      |
| `conversationLabel` | G02 | The message names the conversation                                                       | Only the `x-context-id`; Governance shows the conversation               |
| `rangeComments`     | G08 | A comment on a cell range answers `unsupported` without a call                           | It reaches the backend                                                   |
| `pdfComments`       | G08 | A comment on a PDF point answers `unsupported` without a call                            | It reaches the backend                                                   |
| `rawHtmlByMcp`      | G04 | The agent's HTML is imported by DynWork from its `blob_ref`, keeping its scripts         | The agent writes it through the MCP (with `mcpFolders`)                  |
| `mcpFolders`        | G05 | DynWork makes `Artifacts/<project>/<conversation>` and imports the agent's files by REST | The agent does it through the MCP                                        |
| `contextByMcp`      | G06 | An MCP write enters the local index                                                      | Left to the Drive, once it also lists by conversation                    |
| `docsByContext`     | G07 | `documentsOf` reads the local index only                                                 | REST writes are left to the Drive, which adds its list by `x-context-id` |
| `pushChanges`       | G09 | 20 s poll while watched, 5 min otherwise                                                 | 5 min only, as the net for a missed push                                 |

`agentFiling(capabilities, format)` is the decision phase 07 reads for `rawHtmlByMcp` and `mcpFolders`. The real backend
has no `byContext` yet: with `docsByContext` on and no route, `documentsOf` still answers the index.

## Failures

Every method answers a `Failure` instead of rejecting, as routines do. The backend maps the client's errors to codes
(`signed-out`, `unreachable`, `not-found`, `forbidden`, `person`, `suggest`, `conflict` with the `head` it lost to,
`unsupported`, `invalid`, `failed`) with DynWork's own words: the instance's message never reaches a window. Only
`unreachable` is retryable. A backend that rejects anyway is a bug; the service answers `failed` without its message.
There is no reopen for a resolved comment: 0.83 has no route for it (G12).
