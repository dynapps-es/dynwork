export * as Project from "./project"

// State into views: the session list and one session's turns, blocks and background work. Pure and cheap enough to call
// on every change. It knows nothing of upstream's events: only of `State`. The grouping rules are in `rules.ts`.

import { Rules } from "./rules"
import type { State } from "./state"
import type { View } from "./view"

/** Root sessions, newest first. Children open from their parent's subagent card. */
export function sessions(state: State.State): View.Row[] {
  return Object.values(state.sessions)
    .filter((session) => session.info.parentID === undefined && session.info.archived === undefined)
    .map((session) => row(state, session))
    .sort((a, b) => b.updated - a.updated || (a.id < b.id ? 1 : -1))
}

export function session(state: State.State, id: string): View.Session | undefined {
  const found = state.sessions[id]
  if (!found) return undefined
  const built = turns(state, found)
  return {
    row: row(state, found),
    turns: built.turns,
    background: background(found, built.reports),
    needs: built.turns.flatMap((turn) => turn.blocks.filter(blocking)),
    children: Object.values(state.sessions)
      .filter((child) => child.info.parentID === id)
      .map((child) => row(state, child))
      .sort((a, b) => a.updated - b.updated),
    info: usage(state, found),
  }
}

/** Tokens, cost and the context window's fill, counted as the desktop's context indicator counts them. */
function usage(state: State.State, found: State.Session): View.Usage {
  const messages = found.order.flatMap((id) => {
    const message = found.messages[id]
    return message ? [message] : []
  })
  // The steps after the last completed compaction: what came before it was summarised away
  const since = messages.reduce(
    (start, message, index) => (message.type === "compaction" && message.status === "completed" ? index + 1 : start),
    0,
  )
  const last = messages
    .slice(since)
    .reverse()
    .find(
      (message): message is State.Assistant & { tokens: State.Tokens } =>
        message.type === "assistant" && message.tokens !== undefined,
    )
  const key = (model: { providerID: string; id: string } | undefined) => model && `${model.providerID}/${model.id}`
  const family = found.info.parentID === undefined ? [...descendants(state, found.info.id)] : []
  const count = (type: State.Message["type"]) => messages.filter((message) => message.type === type).length
  return {
    agent: found.info.agent,
    model: key(found.info.model),
    cost: found.info.cost,
    familyCost:
      found.info.parentID === undefined
        ? family.reduce((total, id) => total + (state.sessions[id]?.info.cost ?? 0), 0)
        : found.info.cost,
    tokens: found.info.tokens,
    context: last && {
      tokens: last.tokens,
      total:
        last.tokens.input +
        last.tokens.output +
        last.tokens.reasoning +
        last.tokens.cache.read +
        last.tokens.cache.write,
      model: key(last.model) ?? key(found.info.model),
      cost: last.cost,
      at: last.time.completed ?? last.time.created,
    },
    messages: { user: count("user"), assistant: count("assistant") },
    compactions: messages.filter((message) => message.type === "compaction" && message.status === "completed").length,
    created: found.info.created,
    updated: found.info.updated,
  }
}

const blocking = (block: View.Block): block is Extract<View.Block, { kind: "permission" | "question" }> =>
  block.kind === "permission" || (block.kind === "question" && block.status === "pending")

function row(state: State.State, found: State.Session): View.Row {
  const family = descendants(state, found.info.id)
  const waiting =
    Object.values(state.permissions).some(
      (permission) => family.has(permission.sessionID) && permission.reply === undefined,
    ) || Object.values(state.forms).some((form) => family.has(form.sessionID) && form.state === "pending")
  const items = background(found, reports(found)).items.length
  return {
    id: found.info.id,
    parentID: found.info.parentID,
    title: found.info.title ?? "",
    project: found.info.directory?.split("/").filter(Boolean).pop() ?? "",
    directory: found.info.directory ?? "",
    desktop: state.desktop,
    status: waiting ? "needs-you" : found.running ? "working" : found.outcome === "failed" ? "error" : "done",
    updated: found.info.updated,
    background: items,
  }
}

function descendants(state: State.State, id: string) {
  const family = new Set([id])
  const all = Object.values(state.sessions)
  while (
    all.some((item) => item.info.parentID !== undefined && family.has(item.info.parentID) && !family.has(item.info.id))
  )
    all.forEach((item) => {
      if (item.info.parentID !== undefined && family.has(item.info.parentID)) family.add(item.info.id)
    })
  return family
}

// ---------------------------------------------------------------------------------------------------------------------

type Report = { state: string; text: string }
type Reports = { subagents: Record<string, Report>; shells: Record<string, Report> }

/** What finished work told the parent: a synthetic message names the child or the shell and the state it ended in. */
function reports(found: State.Session): Reports {
  const result: Reports = { subagents: {}, shells: {} }
  Object.values(found.messages).forEach((message) => {
    if (message.type !== "synthetic") return
    const report = { state: String(message.metadata?.state ?? "completed"), text: unwrap(message.text) }
    if (message.metadata?.source === "subagent" && typeof message.metadata.childID === "string")
      result.subagents[message.metadata.childID] = report
    if (message.metadata?.source === "shell" && typeof message.metadata.shellID === "string")
      result.shells[message.metadata.shellID] = report
  })
  return result
}

/** What is inside the `<subagent ...>` or `<shell ...>` tags a report and a subagent's result wrap their text in. */
const unwrap = (text: string) => text.replace(/^<(subagent|shell)[^>]*>\n?/, "").replace(/\n?<\/(subagent|shell)>$/, "")

const shellID = (tool: State.Tool) => {
  if (tool.state.status !== "completed") return undefined
  return tool.state.content
    .map((item) => (item.type === "text" ? item.text.match(/shell ID: (\S+?)\)/)?.[1] : undefined))
    .find((id) => id !== undefined)
}

const childOf = (tool: State.Tool) => {
  const metadata =
    tool.state.status === "running" || tool.state.status === "completed" || tool.state.status === "error"
      ? tool.state.metadata
      : undefined
  return typeof metadata?.sessionID === "string" ? metadata.sessionID : undefined
}

function background(found: State.Session, reported: Reports): View.Background {
  const items: View.Background["items"] = []
  Object.values(found.messages).forEach((message) => {
    if (message.type === "shell" && message.background && message.status === "running")
      items.push({ kind: "shell", id: message.shellID, label: message.command })
    if (message.type !== "assistant") return
    message.content.forEach((part) => {
      if (part.type !== "tool" || part.state.status !== "completed") return
      if (part.name === "subagent") {
        const child = childOf(part)
        if (part.state.metadata?.status === "running" && child !== undefined && reported.subagents[child] === undefined)
          items.push({
            kind: "subagent",
            id: child,
            sessionID: child,
            label: String(part.state.input.description ?? "subagent"),
          })
      }
      if (part.name === "shell" && part.state.input.background === true) {
        const id = shellID(part)
        if (id !== undefined && reported.shells[id] === undefined)
          items.push({ kind: "shell", id, label: String(part.state.input.command ?? "shell") })
      }
    })
  })
  return { items }
}

// ---------------------------------------------------------------------------------------------------------------------

/** A block before the grouping rules: calls are still single, in the order upstream sent them. */
type Raw = View.Block | { kind: "call"; route: Rules.Route; tool: State.Tool }

function turns(state: State.State, found: State.Session) {
  const reported = reports(found)
  const built: Array<{ view: View.Turn; raw: Raw[]; last?: State.Message }> = []
  const ordered = found.order.flatMap((id) => (found.messages[id] ? [found.messages[id]!] : []))
  const waiting = Object.values(state.permissions).filter((permission) => permission.sessionID === found.info.id)
  const forms = Object.values(state.forms).filter((form) => form.sessionID === found.info.id)

  ordered.forEach((message) => {
    if (message.type === "user") {
      built.push({
        view: {
          id: message.id,
          user: { id: message.id, text: message.text, files: message.files.length },
          blocks: [],
          status: "done",
          startedAt: message.time.created,
        },
        raw: [],
      })
      return
    }
    if (message.type === "other") return
    if (built.length === 0)
      built.push({ view: { id: message.id, blocks: [], status: "done", startedAt: message.time.created }, raw: [] })
    const turn = built[built.length - 1]!
    turn.last = message
    if (message.type === "idle") {
      turn.view.endedAt = message.time.created
      // One error line per failure: the step that failed already told it
      const told = turn.raw.some((block) => block.kind === "error")
      if (message.error && !told && message.error.type !== "aborted") turn.raw.push(error(message.error))
      return
    }
    if (message.type === "compaction") {
      turn.raw.push({ kind: "compaction", status: message.status, reason: message.reason, summary: message.summary })
      return
    }
    if (message.type === "synthetic") {
      const source = message.metadata?.source
      // A finished subagent or shell reports into its own card
      if (source === "subagent" || source === "shell") return
      turn.raw.push({ kind: "unknown", label: message.description ?? "note" })
      return
    }
    if (message.type === "shell") {
      const tool: State.Tool = {
        type: "tool",
        id: message.id,
        name: "shell",
        state:
          message.status === "running"
            ? { status: "running", input: { command: message.command }, metadata: {} }
            : { status: "completed", input: { command: message.command }, content: [] },
        time: { created: message.time.created },
      }
      turn.raw.push({ kind: "call", route: "tool", tool })
      return
    }
    // assistant
    message.content.forEach((part, index) => {
      const last = index === message.content.length - 1
      if (part.type === "text")
        turn.raw.push({
          kind: "text",
          text: part.text,
          streaming: message.time.completed === undefined && last && found.running,
        })
      else if (part.type === "reasoning")
        turn.raw.push({
          kind: "reasoning",
          text: part.text,
          running: part.time?.completed === undefined && message.time.completed === undefined && found.running,
          durationMs: part.time?.completed !== undefined ? part.time.completed - part.time.created : undefined,
        })
      else if (part.type === "tool") turn.raw.push({ kind: "call", route: Rules.route(part.name), tool: part })
      else turn.raw.push({ kind: "unknown", label: part.original })
    })
    if (message.retry)
      turn.raw.push({
        kind: "retry",
        attempt: message.retry.attempt,
        at: message.retry.at,
        message: message.retry.error.message,
      })
    if (message.error && message.error.type !== "aborted") turn.raw.push(error(message.error))
  })

  // Only the latest todo list of the session is drawn
  const latestTodos = built
    .flatMap((turn, at) => turn.raw.map((block, index) => ({ at, index, block })))
    .filter((entry) => entry.block.kind === "call" && entry.block.route === "todos")
    .pop()

  built.forEach((turn, at) => {
    const blocks: View.Block[] = []
    const files = new Map<string, View.DiffFile>()
    turn.raw.forEach((block, index) => {
      if (block.kind !== "call") return void blocks.push(block)
      const call = block.tool
      if (block.route === "diff") changed(files, call)
      if (block.route === "tool" || block.route === "diff") return void group(blocks, tool(call, waiting))
      if (block.route === "todos") {
        if (latestTodos?.at === at && latestTodos.index === index) blocks.push(todos(call))
        return
      }
      if (block.route === "subagent") return void blocks.push(subagent(call, reported))
      blocks.push(question(call, forms))
    })
    if (files.size > 0) {
      const list = [...files.values()]
      blocks.push({
        kind: "diffSummary",
        files: list,
        additions: list.reduce((sum, file) => sum + file.additions, 0),
        deletions: list.reduce((sum, file) => sum + file.deletions, 0),
      })
    }
    turn.view.blocks = blocks
    const last = turn.last
    turn.view.status =
      last?.type === "idle"
        ? last.outcome === "succeeded"
          ? "done"
          : last.outcome === "failed"
            ? "error"
            : "interrupted"
        : at === built.length - 1 && found.running
          ? "running"
          : "done"
  })

  // Waiting permissions are blocking cards at the end of the turn that asked, or of the last one
  waiting
    .filter((permission) => permission.reply === undefined)
    .forEach((permission) => {
      const owner =
        built.find((turn) =>
          turn.raw.some((block) => block.kind === "call" && block.tool.id === permission.source?.id),
        ) ?? built[built.length - 1]
      owner?.view.blocks.push({
        kind: "permission",
        id: permission.id,
        action: permission.action,
        resources: permission.resources,
        message: permission.message,
        tool: permission.source?.id,
      })
    })

  return { turns: built.map((turn) => turn.view), reports: reported }
}

function error(failure: State.Error): View.Block {
  return { kind: "error", message: failure.message, code: failure.type }
}

/** Runs of single calls become one group; anything else in between ends the run. */
function group(blocks: View.Block[], item: View.Tool) {
  const last = blocks[blocks.length - 1]
  if (last?.kind === "toolGroup") {
    last.tools.push(item)
    last.running = last.tools.filter((tool) => tool.status === "running").length
    last.failed = last.tools.filter((tool) => tool.status === "error").length
    return
  }
  blocks.push({
    kind: "toolGroup",
    tools: [item],
    running: item.status === "running" ? 1 : 0,
    failed: item.status === "error" ? 1 : 0,
  })
}

function tool(call: State.Tool, requests: State.Permission[]): View.Tool {
  const input = call.state.status === "streaming" ? {} : call.state.input
  const request = requests.find((item) => item.source?.id === call.id)
  const output =
    call.state.status === "completed" || call.state.status === "error" ? text(call.state.content) : undefined
  return {
    id: call.id,
    name: call.name === "" ? "tool" : call.name,
    label: Rules.label(call.name === "" ? "tool" : call.name, input),
    status: call.state.status === "completed" ? "done" : call.state.status === "error" ? "error" : "running",
    approval:
      request === undefined
        ? undefined
        : request.reply === undefined
          ? "waiting"
          : request.reply === "reject"
            ? "rejected"
            : "granted",
    error: call.state.status === "error" ? call.state.error.message : undefined,
    output,
  }
}

function text(content: State.Content[] | undefined) {
  const joined = (content ?? []).flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n")
  return joined === "" ? undefined : joined
}

/** The files a call changed: the edit tool reports them, the write tool is counted from what it was given. */
function changed(files: Map<string, View.DiffFile>, call: State.Tool) {
  if (call.state.status !== "completed") return
  const reported = call.state.metadata?.files
  const found: View.DiffFile[] = Array.isArray(reported)
    ? reported.flatMap(
        (item: { file?: string; additions?: number; deletions?: number; status?: View.DiffFile["status"] }) =>
          typeof item.file === "string"
            ? [
                {
                  file: item.file,
                  additions: item.additions ?? 0,
                  deletions: item.deletions ?? 0,
                  status: item.status ?? "modified",
                },
              ]
            : [],
      )
    : typeof call.state.input.path === "string" && typeof call.state.input.content === "string"
      ? [
          {
            file: call.state.input.path,
            additions: call.state.input.content
              .split("\n")
              .filter((line, at, all) => line !== "" || at < all.length - 1).length,
            deletions: 0,
            status: (text(call.state.content) ?? "").startsWith("Created") ? "added" : "modified",
          },
        ]
      : []
  found.forEach((file) => {
    const before = files.get(file.file)
    files.set(
      file.file,
      before
        ? {
            file: file.file,
            additions: before.additions + file.additions,
            deletions: before.deletions + file.deletions,
            status: before.status,
          }
        : file,
    )
  })
}

const unwrapped = (state: Extract<State.ToolState, { status: "completed" }>) => {
  const output = text(state.content)
  return output === undefined ? undefined : unwrap(output)
}

function todos(call: State.Tool): View.Block {
  const list = call.state.status === "streaming" ? undefined : call.state.input.todos
  const items = Array.isArray(list)
    ? list.flatMap((item: { content?: string; status?: string }) =>
        typeof item.content === "string"
          ? [
              {
                content: item.content,
                status: (["pending", "in_progress", "completed", "cancelled"].includes(String(item.status))
                  ? item.status
                  : "pending") as "pending" | "in_progress" | "completed" | "cancelled",
              },
            ]
          : [],
      )
    : []
  return { kind: "todos", items, done: items.filter((item) => item.status === "completed").length, total: items.length }
}

function subagent(call: State.Tool, reported: Reports): View.Block {
  const input = call.state.status === "streaming" ? {} : call.state.input
  const child = childOf(call)
  const state: "running" | "background" | "completed" | "error" =
    call.state.status === "error"
      ? "error"
      : call.state.status !== "completed"
        ? "running"
        : call.state.metadata?.status === "running"
          ? child !== undefined && reported.subagents[child] !== undefined
            ? reported.subagents[child]!.state === "completed"
              ? "completed"
              : "error"
            : "background"
          : "completed"
  const told = child === undefined ? undefined : reported.subagents[child]
  const output =
    state === "completed" || state === "error"
      ? (told?.text ?? (call.state.status === "completed" ? unwrapped(call.state) : undefined))
      : undefined
  return {
    kind: "subagent",
    id: call.id,
    sessionID: child,
    agent: String(input.agent ?? ""),
    description: String(input.description ?? ""),
    state,
    output,
  }
}

function question(call: State.Tool, forms: State.Form[]): View.Block {
  const input = call.state.status === "streaming" ? {} : call.state.input
  const asked = Array.isArray(input.questions) ? input.questions : []
  const questions = asked.map(
    (
      item: {
        header?: string
        question?: string
        options?: Array<{ label?: string; description?: string }>
        multiple?: boolean
      },
      index,
    ) => ({
      key: `q${index}`,
      header: item.header,
      question: String(item.question ?? ""),
      options: (item.options ?? []).map((option) => ({
        label: String(option.label ?? ""),
        description: option.description,
      })),
      multiple: item.multiple === true,
    }),
  )
  const form = forms.find(
    (item) => item.metadata.kind === "question" && (item.metadata.tool as { id?: string } | undefined)?.id === call.id,
  )
  const answers =
    call.state.status === "completed" && Array.isArray(call.state.metadata?.answers)
      ? (call.state.metadata.answers as string[][])
      : undefined
  const status = answers
    ? "answered"
    : call.state.status === "error" || form?.state === "cancelled"
      ? "cancelled"
      : form?.state === "answered"
        ? "answered"
        : "pending"
  return {
    kind: "question",
    id: call.id,
    formID: status === "pending" ? form?.id : undefined,
    status,
    questions,
    answers,
  }
}
