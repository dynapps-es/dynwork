export * as DynWorkDocuments from "./documents"

import { type Duration, Effect, Option, Schema } from "effect"
import type { DynWorkSync } from "./contract"

// What the agent does with the instance's `documents` MCP server, as DynWork's main process needs to hear it. The
// tools run on the instance (this plugin adds the server, `./mapping`); here the service only watches their calls:
// before a write it asks main for the conversation's folder, revision message and, on 0.84, `context_id`, or whether to
// refuse it (an edit by ops of an HTML page, D21), and after one it tells main what the call touched, so main can file
// the document, index it for the conversation and open it beside the chat. Before a share it waits for the user's
// decision (D24, below).
//
// The conversation goes in each call (`context_id`), not in the connection: the `documents` server is one MCP
// connection per instance, with fixed headers, shared by every conversation of the service, so its `x-context-id`
// cannot say whose a call is. The call's own session can: main maps it to the context it registered for that
// conversation, whichever window or tab shows it.
// Calls a Code Mode program makes go through the same tool hooks as direct ones. Only `effect` is imported: main
// bundles this file.

/** The RPC the plugin registers, called at `/api/rpc/<id>/<method>`. */
export const id = "dynwork.documents"

/** The MCP server's name as `DynWorkMapping` slugs it; OpenCode names its tool `documents_<tool>` after it. */
export const server = "documents"

/**
 * The writes main hears of. Reading, listing, searching, commenting and sharing change no document's content.
 * `import` (0.84) makes a document from a blob the agent uploaded, and `folder` (0.84) makes or moves a folder.
 */
const verbs = ["create", "edit", "upload", "update", "copy", "import", "folder"] as const
export type Verb = (typeof verbs)[number]

/**
 * What main is asked about before a call runs: a creation, an import and an edit, which it adds to or may refuse; with
 * `contextByMcp`, the other writes that take a `context_id` (a comment, a proposal's review, a copy); and, after a
 * folder was refused as `name_taken`, which folder of that name is there (`folder`).
 */
const askable = ["create", "edit", "import", "comment", "proposals", "copy", "folder"] as const
export type Askable = (typeof askable)[number]

/** The writes whose revision takes a message: what main signs with the conversation when the instance cannot name it. */
const messaged: ReadonlyArray<Askable> = ["create", "edit", "import"]

/** The writes that take a `context_id` (0.84), and nothing else: with `contextByMcp` each carries its conversation's. */
const signed: ReadonlyArray<string> = ["create", "edit", "comment", "proposals", "copy", "import"]

// `<server>_<tool>`: the server `documents` and the tool `documents_create` make `documents_documents_create`.
const prefix = `${server}_${server}_`
const tool = new RegExp(`^${prefix}(${verbs.join("|")})$`)

/** The write a tool name is, when it is one of the `documents` server's. */
export function verb(name: string) {
  return tool.exec(name)?.[1] as Verb | undefined
}

// The `documents` server's tool a name is, without its prefix: `comment` for `documents_documents_comment`.
const toolOf = (name: string) => (name.startsWith(prefix) ? name.slice(prefix.length) : undefined)

const Text = Schema.optional(Schema.String)

/** What a call said, as far as main reads it. */
const Input = Schema.Struct({
  document_id: Text,
  folder_id: Text,
  name: Text,
  mime: Text,
  mode: Text,
  message: Text,
  /** `documents_edit` (0.84): a blob the agent uploaded becomes the whole new content, in place of `ops`. */
  content_blob_ref: Text,
  /** What a `documents_comment`, `documents_proposals` or `documents_folder` call does (`create`, `list`, `accept`...). */
  action: Text,
  /** The folder a `documents_folder` call makes a folder in; null or absent for the Drive's root. */
  parent_id: Schema.optional(Schema.NullOr(Schema.String)),
  /** The conversation a write is attributed to (0.84): only ever the one main gave the call. */
  context_id: Text,
})

/** What the server answered, as far as main reads it. A proposal has `proposal_id`; an upload, the `blob_ref` to import. */
const Output = Schema.Struct({
  document_id: Text,
  revision_id: Text,
  head_revision_id: Text,
  blob_ref: Text,
  mime: Text,
  format: Text,
  name: Text,
  proposal_id: Text,
  /** The folder a `documents_folder` call made or changed. */
  folder_id: Text,
})

/** A write that completed: published as the `touch` event. */
export const Touch = Schema.Struct({
  /** The conversation. */
  session: Schema.String,
  call: Schema.String,
  verb: Schema.Literals(verbs),
  input: Input,
  output: Output,
})
export type Touch = typeof Touch.Type

/**
 * A call about to run, or a folder name the instance refused: published as the `ask` event; main answers with
 * `answer`. An edit names its `document`, and `replace` when it rewrites the whole content from a blob rather than by
 * ops. A `folder` ask names the folder that was refused (`name`, in `parent`, the root when absent).
 */
export const Ask = Schema.Struct({
  id: Schema.String,
  session: Schema.String,
  verb: Schema.Literals(askable),
  document: Schema.optional(Schema.String),
  replace: Schema.optional(Schema.Boolean),
  name: Schema.optional(Schema.String),
  parent: Schema.optional(Schema.String),
})
export type Ask = typeof Ask.Type

/**
 * What main adds to the call: the folder for a new document, the revision message and the conversation's `context`
 * (the id DynWork registered for it in the instance, 0.84). Each only when it applies. `refuse` stops the call before
 * it reaches the instance, and is what the agent reads instead of an answer. To a `folder` ask, `folder` is the one of
 * that name already there.
 */
export const Answer = Schema.Struct({
  id: Schema.String,
  folder: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  context: Schema.optional(Schema.String),
  refuse: Schema.optional(Schema.String),
})
export type Answer = typeof Answer.Type
export const Accepted = Schema.Struct({ accepted: Schema.Boolean })

/** The tool event's own fields this file reads: what `ctx.tool.hook("execute.after")` hands over. */
export interface Executed {
  readonly tool: string
  readonly sessionID: string
  readonly id: string
  readonly input: unknown
  readonly status: "completed" | "error"
  readonly result?: { readonly output?: unknown }
  readonly error?: { readonly message: string }
}

const decodeInput = Schema.decodeUnknownOption(Input)
const decodeOutput = Schema.decodeUnknownOption(Output)

/** What a completed write touched, or undefined for any other call, a failed one, or an answer that is not a record. */
export function touch(event: Executed): Touch | undefined {
  const write = verb(event.tool)
  if (write === undefined || event.status !== "completed") return undefined
  return Option.getOrUndefined(
    Option.all({ input: decodeInput(event.input), output: decodeOutput(event.result?.output) }).pipe(
      Option.map((read) => ({ session: event.sessionID, call: event.id, verb: write, ...read })),
    ),
  )
}

/**
 * What main is asked about a call about to run: a creation, an import and an edit always; with `contextByMcp` (0.84),
 * also a comment that writes, a proposal's acceptance or rejection and a copy, so that each carries its conversation.
 * Reading comments or proposals writes nothing, and is not asked about.
 */
export function asking(
  event: {
    readonly tool: string
    readonly sessionID: string
    readonly id: string
    readonly input: unknown
  },
  switches: DynWorkSync.Documents = {},
): Ask | undefined {
  const write = toolOf(event.tool)
  const given = Option.getOrUndefined(decodeInput(event.input))
  const always = write === "create" || write === "edit" || write === "import"
  const attributed =
    switches.contextByMcp === true &&
    ((write === "comment" && given?.action !== "list") ||
      (write === "proposals" && (given?.action === "accept" || given?.action === "reject")) ||
      write === "copy")
  if (write === undefined || (!always && !attributed)) return undefined
  return {
    id: event.id,
    session: event.sessionID,
    verb: write as Askable,
    ...(write === "edit" && given?.document_id !== undefined ? { document: given.document_id } : {}),
    ...(write === "edit" && given?.content_blob_ref !== undefined ? { replace: true } : {}),
  }
}

/** How long a write waits for main: it may make the conversation's folders. Past it the call goes as the agent wrote it. */
export const timeout = "10 seconds"

export interface Emitter {
  readonly ask: (ask: Ask) => Effect.Effect<void>
}

// The service activates the plugin once per Location and imports the module afresh each time, but main answers on
// whichever Location takes the call: the waiting asks live in one process-wide slot.
const slot = globalThis as typeof globalThis & { __dynworkDocuments?: Map<string, (answer: Answer) => void> }
const waiting: Map<string, (answer: Answer) => void> = (slot.__dynworkDocuments ??= new Map())

/**
 * Asks main what to add to a write that is about to run, and waits for its answer. Main not answering (the app closed,
 * its Drive signed out) is no answer: the call goes as it was.
 */
export function ask(emitter: Emitter, request: Ask) {
  return Effect.callback<Answer>((resume) => {
    waiting.set(request.id, (answer) => resume(Effect.succeed(answer)))
    Effect.runFork(emitter.ask(request))
    return Effect.sync(() => void waiting.delete(request.id))
  }).pipe(Effect.timeoutOption(timeout), Effect.map(Option.getOrUndefined))
}

/** Main's `answer`: settles the ask it names; false when nothing waits for it (it timed out, or was answered before). */
export function answer(input: Answer) {
  const found = waiting.get(input.id)
  if (!found) return { accepted: false }
  waiting.delete(input.id)
  found(input)
  return { accepted: true }
}

/**
 * The input of a write with what main added: the folder only for a new document the agent left unplaced (a folder the
 * agent chose stays), the message after the agent's own, so the revision says which conversation wrote it, and the
 * conversation's `context_id`. A `context_id` the agent wrote itself never goes: it can only name a conversation main
 * did not give this call, another one's included. Main not answering is an answer with nothing (`{ id }`).
 */
export function apply(write: Askable, input: unknown, answered: Answer) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input
  const given = decodeInput(input)
  if (Option.isNone(given)) return input
  const message =
    answered.message === undefined || !messaged.includes(write)
      ? undefined
      : joined(given.value.message, answered.message)
  const placed = write === "create" || write === "import"
  const folder = placed && given.value.folder_id === undefined ? answered.folder : undefined
  const context = signed.includes(write) ? answered.context : undefined
  return {
    ...Object.fromEntries(Object.entries(input).filter((entry) => entry[0] !== "context_id")),
    ...(folder === undefined ? {} : { folder_id: folder }),
    ...(message === undefined ? {} : { message }),
    ...(context === undefined ? {} : { context_id: context }),
  }
}

/**
 * A folder the agent tried to make where there is one of that name (0.84 refuses it as `name_taken`): the ask main
 * answers with that folder, so the agent reads its id in the refusal and uses it instead of making a second one (G05).
 * The instance says so in its message only ("a folder named … already exists there"); any other failure is undefined.
 */
export function taken(event: Executed): Ask | undefined {
  if (toolOf(event.tool) !== "folder" || event.status !== "error") return undefined
  const given = Option.getOrUndefined(decodeInput(event.input))
  if (given?.action !== "create" || given.name === undefined) return undefined
  if (!event.error?.message.includes("already exists there")) return undefined
  return {
    id: `${event.id}:taken`,
    session: event.sessionID,
    verb: "folder",
    name: given.name,
    ...(typeof given.parent_id === "string" ? { parent: given.parent_id } : {}),
  }
}

/** The refusal of a folder that is already there, with its id, which main found. */
export function reuse(refusal: string, folder: string) {
  return `${refusal} It is folder_id ${folder}: use that folder.`
}

/**
 * A write the instance refused because it does not know the conversation main gave it (0.84 `unknown_context`: the
 * conversation was deleted in Governance, say), published as the `stale` event: main forgets that context, and the
 * next write registers the conversation again. The instance says which in its message only.
 */
export const Stale = Schema.Struct({ session: Schema.String, context: Schema.String })
export type Stale = typeof Stale.Type

export function stale(event: Executed): Stale | undefined {
  const write = toolOf(event.tool)
  if (write === undefined || !signed.includes(write) || event.status !== "error") return undefined
  const context = Option.getOrUndefined(decodeInput(event.input))?.context_id
  if (context === undefined || !event.error?.message.includes(`context ${context} is not one of your conversations`))
    return undefined
  return { session: event.sessionID, context }
}

function joined(written: string | undefined, label: string) {
  const text = written?.trim()
  if (!text) return label
  return text.includes(label) ? text : `${text} (${label})`
}

// Sharing (D24). Before every `documents_share` call the user decides on a card in the conversation: Reject, Allow once
// or Allow in this conversation. The call waits for that answer as long as it takes; main keeps what a conversation
// allowed and answers its next shares at once. OpenCode's permission prompt is not used: its "always" is saved for the
// whole project, its button cannot say "in this conversation", and the app's auto-approve would answer it unseen.

const shareTool = `${server}_${server}_share`

const ShareInput = Schema.Struct({
  document_id: Text,
  folder_id: Text,
  subject_kind: Text,
  subject_value: Text,
  level: Text,
  valid_until: Text,
  transfer_to: Text,
  revoke_all: Schema.optional(Schema.Boolean),
})
const decodeShare = Schema.decodeUnknownOption(ShareInput)

/**
 * A share about to run: published as the `confirm` event, shown on a card, and answered by main with `decide`. `grant`
 * gives `subject` `level` on a document or a folder (until `until`), `transfer` makes `subject` the document's owner, and
 * `revoke` removes every grant on the document. What the call did not say, or said wrong, is absent: it is still asked.
 */
export const Share = Schema.Struct({
  id: Schema.String,
  session: Schema.String,
  kind: Schema.Literals(["grant", "transfer", "revoke"]),
  document: Schema.optional(Schema.String),
  folder: Schema.optional(Schema.String),
  /** Whom: as the agent named it in `value`, and the `name` and `email` a `documents_people` call of the conversation gave. */
  subject: Schema.optional(
    Schema.Struct({
      kind: Schema.String,
      value: Schema.String,
      name: Schema.optional(Schema.String),
      email: Schema.optional(Schema.String),
    }),
  ),
  level: Schema.optional(Schema.String),
  until: Schema.optional(Schema.String),
})
export type Share = typeof Share.Type
export type Subject = NonNullable<Share["subject"]>

/** The user's decision on a share: `allow` runs the call, otherwise it fails with what the user declined. */
export const Decision = Schema.Struct({ id: Schema.String, allow: Schema.Boolean })
export type Decision = typeof Decision.Type
export const Shares = Schema.Struct({ shares: Schema.Array(Share) })
export type Shares = typeof Shares.Type
export const Withdrawn = Schema.Struct({ id: Schema.String })
export const Shown = Schema.Struct({ id: Schema.String })

/** The share a call is about to make, or undefined for any other call. */
export function sharing(event: {
  readonly tool: string
  readonly sessionID: string
  readonly id: string
  readonly input: unknown
}): Share | undefined {
  if (event.tool !== shareTool) return undefined
  const given = Option.getOrUndefined(decodeShare(event.input))
  const base = { id: event.id, session: event.sessionID }
  // The instance reads a transfer before a revocation, and both before a grant (`ShareHandler.handle`).
  if (given?.transfer_to !== undefined)
    return {
      ...base,
      kind: "transfer",
      ...(given.document_id === undefined ? {} : { document: given.document_id }),
      subject: person(event.sessionID, { kind: "user", value: given.transfer_to }),
    }
  if (given?.revoke_all === true)
    return { ...base, kind: "revoke", ...(given.document_id === undefined ? {} : { document: given.document_id }) }
  return {
    ...base,
    kind: "grant",
    ...(given?.document_id === undefined ? {} : { document: given.document_id }),
    ...(given?.folder_id === undefined ? {} : { folder: given.folder_id }),
    ...(given?.subject_kind === undefined || given.subject_value === undefined
      ? {}
      : { subject: person(event.sessionID, { kind: given.subject_kind, value: given.subject_value }) }),
    ...(given?.level === undefined ? {} : { level: given.level }),
    ...(given?.valid_until === undefined ? {} : { until: given.valid_until }),
  }
}

// The people the agent looked up with `documents_people`, by conversation and user id: the instance names nobody by id
// over REST before 0.84 (`peopleByRest`), and the agent passes a person to `documents_share` as the id it got there, which
// would leave the card with a UUID. One process-wide slot, as for the asks; only the most recent conversations are kept.
const peopleTool = `${server}_${server}_people`

/**
 * The people a `documents_people` call answered (user id, name, email: nothing else), published as the `people` event:
 * main keeps them per account, so a later card names them even in another conversation or after a restart.
 */
export const Seen = Schema.Struct({
  people: Schema.Array(Schema.Struct({ user_id: Schema.String, name: Schema.String, email: Text })),
})
export type Seen = typeof Seen.Type
const decodePeople = Schema.decodeUnknownOption(Seen)
interface Known {
  readonly name: string
  readonly email?: string
}
const peopleSlot = globalThis as typeof globalThis & { __dynworkPeople?: Map<string, Map<string, Known>> }
const seen: Map<string, Map<string, Known>> = (peopleSlot.__dynworkPeople ??= new Map())

/**
 * Keeps the people a completed `documents_people` call of the conversation answered, and answers them, only their id,
 * name and email, for main; any other call is ignored.
 */
export function heard(event: Executed): Seen | undefined {
  if (event.tool !== peopleTool || event.status !== "completed") return undefined
  const found = Option.getOrUndefined(decodePeople(event.result?.output))
  if (!found || found.people.length === 0) return undefined
  const known = seen.get(event.sessionID) ?? new Map<string, Known>()
  seen.delete(event.sessionID)
  seen.set(event.sessionID, known)
  if (seen.size > 256) seen.delete(seen.keys().next().value ?? "")
  const people = found.people.map((item) => ({
    user_id: item.user_id,
    name: item.name,
    ...(item.email === undefined ? {} : { email: item.email }),
  }))
  for (const item of people)
    known.set(item.user_id, { name: item.name, ...(item.email === undefined ? {} : { email: item.email }) })
  return { people }
}

// A user the conversation looked up gets their name and email; anything else stays as the agent wrote it.
function person(session: string, subject: { kind: string; value: string }): Subject {
  const known = subject.kind === "user" ? seen.get(session)?.get(subject.value) : undefined
  return known ? { ...subject, ...known } : subject
}

// A scheduled task's run: OpenCode's automation runs and DynWork's own carry this prefix (`Automation.isRunSession` in
// `@opencode/schema/automation`, which main bundles without; mirrored here).
/** Whether the conversation is a scheduled task's run, which nobody watches: a share there is refused at once. */
export const unattended = (session: string) => session.startsWith("ses_aut_")

/** What the agent reads when it shares in a scheduled task. */
export const nobody =
  "Dynwork asks the user before every share, and nobody is there to answer in a scheduled task: nothing was shared. Ask the user to share it from a conversation."

/** What the agent reads when the user rejects its share. */
export function declined(share: Share) {
  const document = `document ${share.document ?? "(none given)"}`
  const target = share.folder === undefined ? document : `folder ${share.folder}`
  const subject = share.subject ? `${share.subject.kind} ${share.subject.value}` : "(nobody given)"
  const after = "Do not try again unless the user asks you to."
  if (share.kind === "transfer")
    return `The user declined to transfer ownership of ${document} to ${subject}: nothing changed. ${after}`
  if (share.kind === "revoke")
    return `The user declined to revoke every grant on ${document}: nothing changed. ${after}`
  const level = share.level === undefined ? "" : ` (${share.level})`
  return `The user declined to share ${target} with ${subject}${level}: nothing was shared. ${after}`
}

/** What the agent reads when no Dynwork window heard the share: nobody could be asked, so it is refused. */
export const unheard =
  "Dynwork could not ask the user to confirm this share, so nothing was shared. Ask the user to share it themselves, or try again with Dynwork open."

/** How long main has to say it shows the card (`shown`) before the share is refused as unheard. */
export const heardWithin = "10 seconds"

export interface Confirmer {
  readonly confirm: (share: Share) => Effect.Effect<void>
  readonly withdraw: (id: string) => Effect.Effect<void>
}

interface Asked {
  readonly share: Share
  /** Main said it shows the card. */
  shown: boolean
  resolve: (allow: boolean) => void
}

// Like the asks: one process-wide slot, as main decides on whichever Location takes the call.
const shareSlot = globalThis as typeof globalThis & { __dynworkShares?: Map<string, Asked> }
const asked: Map<string, Asked> = (shareSlot.__dynworkShares ??= new Map())

/**
 * Publishes the share and waits for the user's decision: `allow` or `reject`. Main says within `within` that it shows
 * the card (`shown`); when it does not (the app closed, no window), the share is `unheard` and refused, never left
 * waiting for nobody. Once shown it waits as long as the user takes, like a permission prompt. An interrupted wait (the
 * user stopped the step) withdraws the card.
 */
export function confirm(confirmer: Confirmer, share: Share, within: Duration.Input = heardWithin) {
  return Effect.suspend(() => {
    const entry: Asked = { share, shown: false, resolve: () => {} }
    const decided = Effect.callback<"allow" | "reject">((resume) => {
      entry.resolve = (allow) => resume(Effect.succeed(allow ? "allow" : "reject"))
      asked.set(share.id, entry)
      Effect.runFork(confirmer.confirm(share))
      return Effect.suspend(() => (asked.delete(share.id) ? confirmer.withdraw(share.id) : Effect.void))
    })
    const nobody = Effect.sleep(within).pipe(
      Effect.andThen(Effect.suspend(() => (entry.shown ? Effect.never : Effect.succeed("unheard" as const)))),
    )
    return Effect.race(decided, nobody)
  })
}

/** Main's `shown`: it shows the share's card, so the share waits for the user. False when nothing waits for it. */
export function shown(input: { readonly id: string }) {
  const found = asked.get(input.id)
  if (!found) return { accepted: false }
  found.shown = true
  return { accepted: true }
}

/** Main's `decide`: settles the share it names; false when nothing waits for it (withdrawn, or decided before). */
export function decide(input: Decision) {
  const found = asked.get(input.id)
  if (!found) return { accepted: false }
  asked.delete(input.id)
  found.resolve(input.allow)
  return { accepted: true }
}

/** Main's `shares`: the shares still waiting, for a main that (re)connected after they were published. */
export function shares(): Shares {
  return { shares: [...asked.values()].map((item) => item.share) }
}

/**
 * What the instance delivers of 0.84, as far as the agent's rules and calls change with it: the switches main reads from
 * the account's instance (`DriveCapabilities` in the app) and sends with each `apply`. All off is the 0.83 instance.
 */
export type Switches = DynWorkSync.Documents

/** The rules the plugin adds to the instance's own when the `documents` server is among its MCP servers. */
export function rules(
  servers: ReadonlyArray<string>,
  switches: Switches = {},
): ReadonlyArray<DynWorkSync.Manifest["rules"][number]> {
  if (!servers.includes(server)) return []
  return [
    {
      id: "dynwork-documents",
      name: "Documents in Dynwork",
      instructions: instructions(switches),
      hosts: ["opencode"],
    },
  ]
}

/**
 * The agent's rules for the Drive, in English and short: the model may be a small one. The work goes to the Drive, not
 * to local files (the model had been writing the page to disk, serving it, and offering the file), and a page goes up
 * from one program, without the disk. What changes with the instance (0.84): who makes the conversation's folder and
 * imports an uploaded page (`mcpFolders`), how a page is changed (`rawHtmlByMcp`), that DynWork gives each write its
 * conversation (`contextByMcp`), whether a person needs looking up before a share (`peopleByRest`), and that a comment
 * reopens (`reopenComments`) and points at cells of a sheet (`rangeComments`).
 */
export function instructions(switches: Switches = {}) {
  const folder = switches.mcpFolders
    ? [
        "Each conversation keeps what you make in its own folder, Artifacts/<project>/<conversation>: <project> is the name of",
        "the working directory, <conversation> a short title for what the conversation is about. Before its first document,",
        "make the three with documents_folder {action: create, name, parent_id} (no parent_id for Artifacts). A folder that is",
        "already there is refused as name_taken with its folder_id (or find it with documents_list {folder_id: <parent>}):",
        "use it, never make a second one under another name. Pass the conversation's folder_id to every documents_import and",
        "documents_create in it, unless the user names another folder.",
      ]
    : [
        "Dynwork files every document you create in a folder of this conversation (Artifacts/<project>/<conversation>) and",
        "lists it in the conversation's panel: leave out `folder_id` in documents_create unless the user names a folder.",
      ]
  const upload = [
    "HTML page (an artifact, a report, anything with styles, scripts or charts): write the whole page inside one Code Mode",
    "call, encode it there (TextEncoder, then btoa over chunks) and send it with documents_upload (mime text/html, a name",
    "ending in .html). Never write it to a file first, never start a local server, never fetch a file to read it back.",
  ]
  const filed = switches.mcpFolders
    ? [
        "Then call documents_import once with the returned blob_ref, the same name and the conversation's folder_id: the",
        "page keeps its scripts and Dynwork opens it in the panel. Do not open it in a browser.",
      ]
    : [
        "Dynwork imports that upload as a document of this conversation, scripts kept, and opens it in the panel: do not look",
        "for it, do not import it yourself and do not open it in a browser.",
      ]
  const change = switches.rawHtmlByMcp
    ? [
        "To change a page, upload the whole changed page with documents_upload, then call documents_edit with document_id,",
        "content_blob_ref and base_revision (the head revision from documents_read): the same document, scripts kept.",
        "An edit by ops (str_replace, set_html) that would strip a page's scripts or styles is refused as unsupported_op:",
        "rewrite the page whole that way instead. On a document that is someone else's, or when an edit is refused because",
        "its policy does not let you change it, send the same documents_edit with mode: propose, and tell the user that the",
        "owner reviews it.",
      ]
    : [
        "documents_create, set_html and str_replace strip a page's scripts and styles, and Dynwork",
        "refuses documents_edit on an HTML document for that reason. To change a page, upload the whole changed page again",
        "under a new name: it becomes a new document next to the old one, and you tell the user so in one line.",
      ]
  // With 0.84 the writes take the conversation, which the plugin adds; one the model wrote is never sent.
  const context = switches.contextByMcp
    ? [
        "Dynwork gives every write the id of this conversation: leave out context_id. Call a write refused as",
        "unknown_context once more, unchanged: Dynwork registers the conversation again.",
      ]
    : []
  // 0.84 comments: a resolved thread opens again, and a spreadsheet's comment can point at cells of a sheet.
  const comments = [
    ...(switches.reopenComments
      ? ["documents_comment {action: reopen, comment_id} opens a resolved thread again when the user asks for it."]
      : []),
    ...(switches.rangeComments
      ? [
          "On a spreadsheet, documents_comment can point at cells: node is the sheet's node (sheet[<name>]) and cells an A1",
          "range such as B2:D9 (top-left first), with no anchor quote.",
        ]
      : []),
  ]
  // 0.83 names nobody by id, so the card can name a person only from a `documents_people` answer DynWork saw.
  const lookup = switches.peopleByRest
    ? []
    : [
        "Right before each documents_share to a person, look them up with documents_people by name or email in the same",
        "Code Mode call, even when you already have their id, so Dynwork can show the user who it is on the card.",
      ]
  return [
    "Documents, pages, reports, presentations and artifacts you make for the user go in their Drive with the `documents`",
    "tools, not in local files. Write a local file only when the user asks for one; code and the project's files stay",
    "local, as always.",
    "",
    ...folder,
    "",
    ...upload,
    ...filed,
    ...change,
    "Styles and scripts are kept in the page, but documents_read (model, outline) and documents_export (preview) show",
    "text only: never judge how a page looks from them.",
    ...context,
    ...comments,
    "",
    "A file you upload to put inside another document (an image for a Word file) is not imported as a document.",
    "Before every documents_share the user allows or rejects it on a card in this conversation: call it without asking",
    "first, and when the user rejects it, do not try again unless they ask.",
    ...lookup,
  ].join("\n")
}
