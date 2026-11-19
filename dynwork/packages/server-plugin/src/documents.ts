export * as DynWorkDocuments from "./documents"

import { type Duration, Effect, Option, Schema } from "effect"
import type { DynWorkSync } from "./contract"

// What the agent does with the instance's `documents` MCP server, as DynWork's main process needs to hear it. The
// tools run on the instance (this plugin adds the server, `./mapping`); here the service only watches their calls:
// before a write it asks main for the conversation's folder and revision message, or whether to refuse it (an edit by
// ops of an HTML page, D21), and after one it tells main what the call touched, so main can file the document, index
// it for the conversation and open it beside the chat. Before a share it waits for the user's decision (D24, below).
// Calls a Code Mode program makes go through the same tool hooks as direct ones. Only `effect` is imported: main
// bundles this file.

/** The RPC the plugin registers, called at `/api/rpc/<id>/<method>`. */
export const id = "dynwork.documents"

/** The MCP server's name as `DynWorkMapping` slugs it; OpenCode names its tool `documents_<tool>` after it. */
export const server = "documents"

/**
 * The writes main hears of. Reading, listing, searching, commenting and sharing change no document's content.
 * `import` (0.84) makes a document from a blob the agent uploaded.
 */
const verbs = ["create", "edit", "upload", "update", "copy", "import"] as const
export type Verb = (typeof verbs)[number]

// `<server>_<tool>`: the server `documents` and the tool `documents_create` make `documents_documents_create`.
const tool = new RegExp(`^${server}_${server}_(${verbs.join("|")})$`)

/** The write a tool name is, when it is one of the `documents` server's. */
export function verb(name: string) {
  return tool.exec(name)?.[1] as Verb | undefined
}

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
 * A write about to run: published as the `ask` event; main answers with `answer`. An edit names its `document`, and
 * `replace` when it rewrites the whole content from a blob rather than by ops.
 */
export const Ask = Schema.Struct({
  id: Schema.String,
  session: Schema.String,
  verb: Schema.Literals(verbs),
  document: Schema.optional(Schema.String),
  replace: Schema.optional(Schema.Boolean),
})
export type Ask = typeof Ask.Type

/**
 * What main adds to the call: the folder for a new document, and the revision message. Each only when it applies.
 * `refuse` stops the call before it reaches the instance, and is what the agent reads instead of an answer.
 */
export const Answer = Schema.Struct({
  id: Schema.String,
  folder: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
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

/** What main is asked about a write about to run: the writes it adds to or may refuse, a creation, an import and an edit. */
export function asking(event: {
  readonly tool: string
  readonly sessionID: string
  readonly id: string
  readonly input: unknown
}): Ask | undefined {
  const write = verb(event.tool)
  if (write !== "create" && write !== "edit" && write !== "import") return undefined
  const given = Option.getOrUndefined(decodeInput(event.input))
  return {
    id: event.id,
    session: event.sessionID,
    verb: write,
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
 * agent chose stays), and the message after the agent's own, so the revision says which conversation wrote it. An import
 * takes the folder alone: `documents_import` has no message to carry (0.84).
 */
export function apply(write: Verb, input: unknown, answered: Answer) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input
  const given = decodeInput(input)
  if (Option.isNone(given)) return input
  const message =
    answered.message === undefined || write === "import" ? undefined : joined(given.value.message, answered.message)
  const placed = write === "create" || write === "import"
  const folder = placed && given.value.folder_id === undefined ? answered.folder : undefined
  return {
    ...input,
    ...(folder === undefined ? {} : { folder_id: folder }),
    ...(message === undefined ? {} : { message }),
  }
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
const People = Schema.Struct({
  people: Schema.Array(Schema.Struct({ user_id: Schema.String, name: Schema.String, email: Text })),
})
const decodePeople = Schema.decodeUnknownOption(People)
interface Known {
  readonly name: string
  readonly email?: string
}
const peopleSlot = globalThis as typeof globalThis & { __dynworkPeople?: Map<string, Map<string, Known>> }
const seen: Map<string, Map<string, Known>> = (peopleSlot.__dynworkPeople ??= new Map())

/** Keeps the people a completed `documents_people` call of the conversation answered; any other call is ignored. */
export function heard(event: Executed) {
  if (event.tool !== peopleTool || event.status !== "completed") return
  const found = Option.getOrUndefined(decodePeople(event.result?.output))
  if (!found) return
  const known = seen.get(event.sessionID) ?? new Map<string, Known>()
  seen.delete(event.sessionID)
  seen.set(event.sessionID, known)
  if (seen.size > 256) seen.delete(seen.keys().next().value ?? "")
  for (const item of found.people)
    known.set(item.user_id, { name: item.name, ...(item.email === undefined ? {} : { email: item.email }) })
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
 * What the instance delivers of 0.84, as far as the agent's rules change with it: the same two switches the Drive's
 * capabilities have (`rawHtmlByMcp`, `mcpFolders`, `DriveCapabilities` in the app). Both off is the 0.83 instance, and
 * the only one the plugin knows today: the capabilities live in main and are not sent here yet.
 */
export interface Switches {
  /** `documents_edit {content_blob_ref}` rewrites a page whole, scripts kept. */
  readonly rawHtmlByMcp?: boolean
  /** `documents_import` makes a document of an uploaded blob, scripts kept, and `documents_folder` makes folders. */
  readonly mcpFolders?: boolean
}

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
 * from one program, without the disk. Two things change with the instance: how an uploaded page becomes a document,
 * and how a page is changed.
 */
export function instructions(switches: Switches = {}) {
  const folder = switches.mcpFolders
    ? [
        "Dynwork files what you import in a folder of this conversation (Artifacts/<project>/<conversation>) and lists it in",
        "the conversation's panel: leave out `folder_id` in documents_import. In documents_create use the folder the user names.",
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
        "Then call documents_import once with the returned blob_ref and the same name, and leave out folder_id: Dynwork puts",
        "it in this conversation's folder, scripts kept, and opens it in the panel. Do not open it in a browser.",
      ]
    : [
        "Dynwork imports that upload as a document of this conversation, scripts kept, and opens it in the panel: do not look",
        "for it, do not import it yourself and do not open it in a browser.",
      ]
  const change = switches.rawHtmlByMcp
    ? [
        "To change a page, upload the whole changed page with documents_upload, then call documents_edit with document_id,",
        "content_blob_ref and base_revision (the head revision from documents_read): the same document, scripts kept.",
        "Edits by ops on a page with scripts or styles (str_replace, set_html) are refused.",
      ]
    : [
        "documents_create, set_html and str_replace strip a page's scripts and styles, and Dynwork",
        "refuses documents_edit on an HTML document for that reason. To change a page, upload the whole changed page again",
        "under a new name: it becomes a new document next to the old one, and you tell the user so in one line.",
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
    "",
    "A file you upload to put inside another document (an image for a Word file) is not imported as a document.",
    "Before every documents_share the user allows or rejects it on a card in this conversation: call it without asking",
    "first, and when the user rejects it, do not try again unless they ask.",
  ].join("\n")
}
