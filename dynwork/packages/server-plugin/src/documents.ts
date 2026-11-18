export * as DynWorkDocuments from "./documents"

import { Effect, Option, Schema } from "effect"
import type { DynWorkSync } from "./contract"

// What the agent does with the instance's `documents` MCP server, as DynWork's main process needs to hear it. The
// tools run on the instance (this plugin adds the server, `./mapping`); here the service only watches their calls:
// before a write it asks main for the conversation's folder and revision message, and after one it tells main what the
// call touched, so main can file the document, index it for the conversation and open it beside the chat. Calls a Code
// Mode program makes go through the same tool hooks as direct ones. Only `effect` is imported: main bundles this file.

/** The RPC the plugin registers, called at `/api/rpc/<id>/<method>`. */
export const id = "dynwork.documents"

/** The MCP server's name as `DynWorkMapping` slugs it; OpenCode names its tool `documents_<tool>` after it. */
export const server = "documents"

/** The writes main hears of. Reading, listing, searching, commenting and sharing change no document's content. */
const verbs = ["create", "edit", "upload", "update", "copy"] as const
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

/** A write about to run: published as the `ask` event; main answers with `answer`. */
export const Ask = Schema.Struct({ id: Schema.String, session: Schema.String, verb: Schema.Literals(verbs) })
export type Ask = typeof Ask.Type

/** What main adds to the call: the folder for a new document, and the revision message. Each only when it applies. */
export const Answer = Schema.Struct({
  id: Schema.String,
  folder: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
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
 * agent chose stays), and the message after the agent's own, so the revision says which conversation wrote it.
 */
export function apply(write: Verb, input: unknown, answered: Answer) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input
  const given = decodeInput(input)
  if (Option.isNone(given)) return input
  const message = answered.message === undefined ? undefined : joined(given.value.message, answered.message)
  const folder = write === "create" && given.value.folder_id === undefined ? answered.folder : undefined
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

/** The rules the plugin adds to the instance's own when the `documents` server is among its MCP servers. */
export function rules(servers: ReadonlyArray<string>): ReadonlyArray<DynWorkSync.Manifest["rules"][number]> {
  if (!servers.includes(server)) return []
  return [{ id: "dynwork-documents", name: "Documents in Dynwork", instructions, hosts: ["opencode"] }]
}

const instructions = [
  "The `documents` tools write to the user's Drive in Governance. Dynwork files every document you create in a folder",
  "of this conversation (Artifacts/<project>/<conversation>) and lists it in the conversation's panel: leave out",
  "`folder_id` in documents_create unless the user names a folder.",
  "",
  "An HTML page with scripts, charts or animations loses its scripts through documents_create, documents_edit and",
  "set_html. Upload the whole page with documents_upload (mime text/html, a name ending in .html): Dynwork imports it",
  "as a document of this conversation, scripts kept. To change the page, upload it again under a new name.",
  "A file you upload to put inside another document (an image for a Word file) is not imported as a document.",
].join("\n")
