export * as ChatsClient from "./client"

import { Option, Schema } from "effect"
import type { Failure, Model, ModelRef, Page, Thread } from "./contract"

// The main process's client of the active instance's cloud chats API (`dynwork-chats`, `contract.md` of the plan). It
// holds the account's JWT for one request at a time and answers values or `Failure`s: no answer of it carries the
// token, the request's headers or the instance's raw body, so nothing it returns can leak one to a window.

/** Where the chats API is on an instance. */
export const PATH = "/api/dynwork/chats/v1"

/** The account the chats belong to: the active, signed-in one. */
export interface Account {
  id: string
  url: string
  /** Its session's JWT; `fresh` mints a new one, after the instance refused the held one. */
  token: (fresh: boolean) => Promise<string>
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export interface Options {
  account: () => Account | undefined
  fetch?: Fetch
}

/** One page of the change feed: threads changed since the cursor, tombstones as ids. */
export interface Changes {
  threads: Thread[]
  deleted: string[]
  cursor: string
  more: boolean
}

/** What a `PUT` changes. Absent fields keep their value. */
export interface Write {
  title?: string
  model?: ModelRef
  archived?: boolean
}

// The instance's shapes, read leniently where the contract leaves the encoding open: a model as `provider/model` or
// as an object, times as ISO strings or epoch milliseconds, a tombstone as `deleted` or `deleted_at`.
const Time = Schema.Union([Schema.Number, Schema.String])
const RowModel = Schema.Union([
  Schema.String,
  Schema.Struct({ providerID: Schema.String, id: Schema.String }),
  Schema.Struct({ provider: Schema.String, id: Schema.String }),
])
const Row = Schema.Struct({
  id: Schema.String,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  model: Schema.optional(Schema.NullOr(RowModel)),
  revision: Schema.Number,
  archived_at: Schema.optional(Schema.NullOr(Time)),
  deleted_at: Schema.optional(Schema.NullOr(Time)),
  deleted: Schema.optional(Schema.Boolean),
  created_at: Schema.optional(Time),
  updated_at: Schema.optional(Time),
})
type Row = typeof Row.Type
const decodeFeed = Schema.decodeUnknownOption(
  Schema.Struct({ threads: Schema.Array(Row), cursor: Schema.String, more: Schema.optional(Schema.Boolean) }),
)
const decodeRow = Schema.decodeUnknownOption(Row)
const decodeWrapped = Schema.decodeUnknownOption(Schema.Struct({ thread: Row }))
const decodeConflict = Schema.decodeUnknownOption(Schema.Struct({ current: Row }))
const decodeRevision = Schema.decodeUnknownOption(Schema.Struct({ revision: Schema.Number }))
const ModelRow = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  provider: Schema.Union([Schema.String, Schema.Struct({ id: Schema.String, name: Schema.optional(Schema.String) })]),
  reasoning: Schema.optional(Schema.Boolean),
  tools: Schema.optional(Schema.Boolean),
})
const decodeModels = Schema.decodeUnknownOption(
  Schema.Union([Schema.Array(ModelRow), Schema.Struct({ models: Schema.Array(ModelRow) })]),
)
const decodeMessages = Schema.decodeUnknownOption(
  Schema.Union([
    Schema.Array(Schema.Json),
    Schema.Struct({ messages: Schema.Array(Schema.Json), before: Schema.optional(Schema.NullOr(Schema.String)) }),
  ]),
)
const decodeAccepted = Schema.decodeUnknownOption(
  Schema.Union([
    Schema.Struct({ messageID: Schema.String }),
    Schema.Struct({ assistantMessageID: Schema.String }),
    Schema.Struct({ id: Schema.String }),
  ]),
)
const decodeError = Schema.decodeUnknownOption(
  Schema.Struct({ error: Schema.Struct({ key: Schema.optional(Schema.String), message: Schema.String }) }),
)
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

/** A failure. Only `unreachable` clears up by itself. */
export function fail(code: Failure["code"], message: string): Failure {
  return { code, message, retryable: code === "unreachable" }
}

export function make(options: Options) {
  const send = options.fetch ?? fetch

  // One request with the account's JWT, minted again once when the instance refuses it.
  async function request(route: string, init: RequestInit = {}, revision?: number) {
    const account = options.account()
    if (!account) return fail("signed-out", "Sign in to a Governance instance to use chats.")
    const attempt = async (fresh: boolean) => {
      const token = await account.token(fresh).catch(() => undefined)
      if (token === undefined) return undefined
      return send(`${account.url.replace(/\/+$/, "")}${PATH}${route}`, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          ...(revision === undefined ? {} : { "if-match": `"${revision}"` }),
          ...(init.headers as Record<string, string> | undefined),
        },
      }).catch(() => null)
    }
    const first = await attempt(false)
    const response = first?.status === 401 ? await attempt(true) : first
    if (response === undefined) return fail("signed-out", "The Governance session could not be renewed.")
    if (response === null) return fail("unreachable", "Governance did not answer.")
    return response
  }

  // A JSON answer, or the failure its status means.
  async function json(route: string, init: RequestInit = {}, revision?: number) {
    const response = await request(route, init, revision)
    if (!(response instanceof Response)) return response
    const body: unknown = await response.json().catch(() => undefined)
    if (response.ok) return { status: response.status, body }
    return failure(response.status, body)
  }

  async function changes(since: string | undefined): Promise<Changes | Failure> {
    const answer = await json(`/changes${since === undefined ? "" : `?since=${encodeURIComponent(since)}`}`)
    if ("code" in answer) return answer
    const page = decodeFeed(answer.body)
    if (Option.isNone(page)) return fail("failed", "Governance answered the chats feed in an unknown shape.")
    return {
      threads: page.value.threads.filter((row) => !gone(row)).map(thread),
      deleted: page.value.threads.filter(gone).map((row) => row.id),
      cursor: page.value.cursor,
      more: page.value.more ?? false,
    }
  }

  // `PUT /threads/{id}`: creates without a revision, changes with one. A `409` answers `conflict` and the current row.
  async function put(
    id: string,
    write: Write,
    revision: number | undefined,
  ): Promise<{ thread?: Thread; revision: number } | (Failure & { current?: Thread })> {
    const response = await request(
      `/threads/${encodeURIComponent(id)}`,
      {
        method: "PUT",
        body: JSON.stringify({
          ...(write.title === undefined ? {} : { title: write.title }),
          ...(write.model === undefined ? {} : { model: write.model }),
          ...(write.archived === undefined ? {} : { archived: write.archived }),
        }),
      },
      revision,
    )
    if (!(response instanceof Response)) return response
    const body: unknown = await response.json().catch(() => undefined)
    if (response.status === 409) {
      const current = decodeConflict(body)
      return {
        ...fail("conflict", "This chat changed on another device."),
        ...(Option.isSome(current) ? { current: thread(current.value.current) } : {}),
      }
    }
    if (!response.ok) return failure(response.status, body)
    const row = Option.orElse(decodeRow(body), () => Option.map(decodeWrapped(body), (value) => value.thread))
    if (Option.isSome(row)) return { thread: thread(row.value), revision: row.value.revision }
    const bare = decodeRevision(body)
    if (Option.isSome(bare)) return { revision: bare.value.revision }
    return fail("failed", "Governance answered the write in an unknown shape.")
  }

  return {
    changes,
    put,
    async remove(id: string, revision: number): Promise<Failure | undefined> {
      const answer = await json(`/threads/${encodeURIComponent(id)}`, { method: "DELETE" }, revision)
      return "code" in answer ? answer : undefined
    },
    async models(): Promise<Model[] | Failure> {
      const answer = await json("/models")
      if ("code" in answer) return answer
      const decoded = decodeModels(answer.body)
      if (Option.isNone(decoded)) return fail("failed", "Governance answered the models in an unknown shape.")
      const rows = "models" in decoded.value ? decoded.value.models : decoded.value
      return rows.map((row) => {
        const provider = typeof row.provider === "string" ? { id: row.provider } : row.provider
        return {
          id: row.id,
          name: row.name ?? row.id,
          provider: provider.id,
          providerName: ("name" in provider ? provider.name : undefined) ?? provider.id,
          reasoning: row.reasoning ?? false,
          tools: row.tools ?? false,
        }
      })
    },
    async messages(id: string, page: { before?: string; limit?: number }): Promise<Page | Failure> {
      const query = new URLSearchParams()
      if (page.before !== undefined) query.set("before", page.before)
      if (page.limit !== undefined) query.set("limit", String(page.limit))
      const answer = await json(`/threads/${encodeURIComponent(id)}/messages${query.size ? `?${query}` : ""}`)
      if ("code" in answer) return answer
      const decoded = decodeMessages(answer.body)
      if (Option.isNone(decoded)) return fail("failed", "Governance answered the messages in an unknown shape.")
      if (Array.isArray(decoded.value)) return { messages: decoded.value }
      const value = decoded.value as { messages: Page["messages"]; before?: string | null }
      return { messages: value.messages, ...(value.before ? { before: value.before } : {}) }
    },
    async prompt(
      id: string,
      input: { messageID: string; text: string; model?: ModelRef },
    ): Promise<{ messageID: string } | Failure> {
      const answer = await json(`/threads/${encodeURIComponent(id)}/prompt`, {
        method: "POST",
        body: JSON.stringify({
          messageID: input.messageID,
          parts: [{ type: "text", text: input.text }],
          ...(input.model ? { model: input.model } : {}),
        }),
      })
      if ("code" in answer) return answer
      const accepted = decodeAccepted(answer.body)
      if (Option.isNone(accepted)) return fail("failed", "Governance answered the prompt in an unknown shape.")
      const value = accepted.value
      return {
        messageID:
          "messageID" in value ? value.messageID : "assistantMessageID" in value ? value.assistantMessageID : value.id,
      }
    },
    async interrupt(id: string): Promise<Failure | undefined> {
      const answer = await json(`/threads/${encodeURIComponent(id)}/interrupt`, { method: "POST" })
      return "code" in answer ? answer : undefined
    },
    /**
     * Follows `GET /threads/{id}/log?after=<seq>&follow=1` until the stream ends or `signal` aborts, handing over each
     * event with its seq in the thread: the SSE `id:`, which every event has, a text delta too (a delta's envelope
     * carries no `durable`). Answers how it ended: `ended` (the instance closed it, or the call was aborted) or a
     * failure.
     */
    async log(
      id: string,
      after: number | undefined,
      event: (value: unknown, seq: number | undefined) => void,
      signal: AbortSignal,
    ): Promise<"ended" | Failure> {
      const response = await request(
        `/threads/${encodeURIComponent(id)}/log?follow=1${after === undefined ? "" : `&after=${after}`}`,
        { headers: { accept: "text/event-stream" }, signal },
      )
      if (!(response instanceof Response)) return signal.aborted ? "ended" : response
      if (!response.ok || !response.body) {
        const body: unknown = await response.json().catch(() => undefined)
        return failure(response.status, body)
      }
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
      const buffer = { text: "" }
      for (;;) {
        const chunk = await reader.read().catch(() => undefined)
        if (!chunk || chunk.done) return "ended"
        buffer.text += chunk.value.replace(/\r\n?/g, "\n")
        const blocks = buffer.text.split("\n\n")
        buffer.text = blocks.pop() ?? ""
        blocks.forEach((block) => {
          const data = block
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, ""))
            .join("\n")
          if (!data) return
          const id = Number(
            block
              .split("\n")
              .find((line) => line.startsWith("id:"))
              ?.slice(3),
          )
          const value = decodeJson(data)
          if (Option.isSome(value)) event(value.value, Number.isInteger(id) && id > 0 ? id : undefined)
        })
      }
    },
  }
}

export type Client = ReturnType<typeof make>

function gone(row: Row) {
  return row.deleted === true || (row.deleted_at !== undefined && row.deleted_at !== null)
}

function time(value: number | string | null | undefined) {
  if (value === undefined || value === null) return undefined
  if (typeof value === "number") return value
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

function thread(row: Row): Thread {
  const created = time(row.created_at) ?? 0
  const archived = time(row.archived_at)
  const model = modelOf(row.model)
  return {
    id: row.id,
    title: row.title ?? "",
    ...(model ? { model } : {}),
    revision: row.revision,
    ...(archived === undefined ? {} : { archived }),
    created,
    updated: time(row.updated_at) ?? created,
  }
}

function modelOf(value: Row["model"]): ModelRef | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === "string") {
    const slash = value.indexOf("/")
    return slash < 0 ? undefined : { providerID: value.slice(0, slash), id: value.slice(slash + 1) }
  }
  return "providerID" in value
    ? { providerID: value.providerID, id: value.id }
    : { providerID: value.provider, id: value.id }
}

// The failure a status means. The instance's own message is kept (it names no credential); its raw body is not.
function failure(status: number, body: unknown): Failure {
  const error = decodeError(body)
  const message = Option.isSome(error) ? error.value.error.message : `Governance answered ${status}.`
  if (status === 401 || status === 403) return fail("signed-out", message)
  if (status === 404) return fail("not-found", message)
  if (status === 409 || status === 412) return fail("conflict", message)
  if (status === 400 || status === 422) return fail("invalid", message)
  if (status >= 500 || status === 429) return fail("unreachable", message)
  return fail("failed", message)
}
