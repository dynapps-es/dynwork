// A deterministic stand-in for the model provider, for the session recorder. It speaks the Anthropic Messages API
// (what `@ai-sdk/anthropic` calls) on a private loopback port, and answers each request from the scenario the first
// user message names with `[scenario:<name>]`. Nothing leaves the machine and nothing costs anything.

export type Block = { text: string } | { thinking: string } | { tool: string; input: Record<string, unknown> }

export type Reply =
  | { blocks: Block[]; stop?: "end_turn" | "tool_use"; hold?: number }
  | { status: number; type: string; message: string; retryAfter?: number }

/** What a script sees of one request: how far the conversation has come, never raw randomness. */
export type Call = {
  scenario: string
  /** Assistant turns already in the request: the index of the step being asked for. */
  step: number
  /** Requests this scenario and step have received so far, this one included. */
  attempt: number
  /** The text of the last user message, which carries a tool result or the prompt. */
  last: string
  /** Whether the system prompt or the last message is a compaction request. */
  compaction: boolean
}

export type Script = (call: Call) => Reply

type Message = { role: string; content: string | Array<{ type: string; text?: string }> }

export async function start(scripts: Record<string, Script>) {
  const attempts = new Map<string, number>()
  const requests: Array<{ scenario: string; step: number }> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 255,
    fetch: async (request) => {
      if (new URL(request.url).pathname !== "/v1/messages") return new Response("not found", { status: 404 })
      const body: { model: string; messages: Message[] } = await request.json()
      const first = text(body.messages.find((message) => message.role === "user"))
      const scenario = first.match(/\[scenario:([a-z0-9/-]+)\]/)?.[1]
      const script = scenario ? scripts[scenario] : undefined
      if (!scenario || !script)
        return Response.json(
          { type: "error", error: { type: "not_found_error", message: `no script for ${scenario}` } },
          { status: 404 },
        )
      const step = body.messages.filter((message) => message.role === "assistant").length
      const key = `${scenario}:${step}`
      const attempt = (attempts.get(key) ?? 0) + 1
      attempts.set(key, attempt)
      const last = text(body.messages.at(-1))
      requests.push({ scenario, step })
      const reply = script({
        scenario,
        step,
        attempt,
        last,
        compaction: /summar/i.test(last) && !/\[scenario:/.test(last),
      })
      if ("status" in reply) return failure(reply)
      return stream(body.model, scenario, step, reply)
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    requests,
    stop: () => server.stop(true),
  }
}

function text(message: Message | undefined) {
  if (!message) return ""
  if (typeof message.content === "string") return message.content
  return message.content
    .map((block) => (block.type === "text" ? block.text : block.type === "tool_result" ? "<tool_result>" : ""))
    .join("\n")
}

function failure(reply: Extract<Reply, { status: number }>) {
  return Response.json(
    { type: "error", error: { type: reply.type, message: reply.message } },
    {
      status: reply.status,
      headers: reply.retryAfter === undefined ? {} : { "retry-after": String(reply.retryAfter) },
    },
  )
}

function event(name: string, data: unknown) {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
}

function chunks(value: string) {
  return value.match(/\S+\s*|\s+/g) ?? []
}

function stream(model: string, scenario: string, step: number, reply: Extract<Reply, { blocks: Block[] }>) {
  const stop = reply.stop ?? (reply.blocks.some((block) => "tool" in block) ? "tool_use" : "end_turn")
  const frames = [
    event("message_start", {
      type: "message_start",
      message: {
        id: `msg_${scenario}_${step}`.replaceAll("/", "_"),
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 100 + step, output_tokens: 0 },
      },
    }),
    ...reply.blocks.flatMap((block, index) => {
      if ("text" in block)
        return [
          event("content_block_start", {
            type: "content_block_start",
            index,
            content_block: { type: "text", text: "" },
          }),
          ...chunks(block.text).map((delta) =>
            event("content_block_delta", {
              type: "content_block_delta",
              index,
              delta: { type: "text_delta", text: delta },
            }),
          ),
          event("content_block_stop", { type: "content_block_stop", index }),
        ]
      if ("thinking" in block)
        return [
          event("content_block_start", {
            type: "content_block_start",
            index,
            content_block: { type: "thinking", thinking: "", signature: "" },
          }),
          ...chunks(block.thinking).map((delta) =>
            event("content_block_delta", {
              type: "content_block_delta",
              index,
              delta: { type: "thinking_delta", thinking: delta },
            }),
          ),
          event("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "signature_delta", signature: "fake-signature" },
          }),
          event("content_block_stop", { type: "content_block_stop", index }),
        ]
      const id = `toolu_${scenario}_${step}_${index}`.replaceAll("/", "_")
      return [
        event("content_block_start", {
          type: "content_block_start",
          index,
          content_block: { type: "tool_use", id, name: block.tool, input: {} },
        }),
        ...(JSON.stringify(block.input).match(/.{1,24}/gs) ?? []).map((partial) =>
          event("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: partial },
          }),
        ),
        event("content_block_stop", { type: "content_block_stop", index }),
      ]
    }),
    event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stop },
      usage: { output_tokens: 10 + step },
    }),
    event("message_stop", { type: "message_stop" }),
  ]
  // `hold` keeps the response open in the middle of its first block, so a scenario can interrupt a step that is still
  // streaming: the frames up to the third delta go out, the rest after the pause.
  if (!reply.hold) return new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } })
  const deltas = frames.flatMap((frame, index) => (frame.startsWith("event: content_block_delta") ? [index] : []))
  const cut = (deltas[2] ?? deltas[0] ?? 0) + 1
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode(frames.slice(0, cut).join("")))
        await Bun.sleep(reply.hold)
        controller.enqueue(encoder.encode(frames.slice(cut).join("")))
        controller.close()
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
}
