export * as ChatsChat from "./chat"

import { createSignal } from "solid-js"
import type { ChatsBackend } from "./backend"
import { isFailure, type Failure, type Model, type ModelRef, type Thread } from "./contract"
import { ChatsDocument } from "./document"

// One cloud chat in a window: its document, kept from the history and the live events, and the composer model the
// app's chat composer runs on (`BuiltinUi.ChatComposer`). Every call goes through the `dynwork.chats` Ipc.

export interface Options {
  client: () => ChatsBackend.Client | undefined
  /** The thread, or undefined for a new chat that is made by its first prompt. */
  thread: () => Thread | undefined
  /** The models `/models` lists. */
  models: () => readonly Model[]
  /** A new chat was made: the view selects it. */
  created?: (thread: Thread) => void
  now?: () => number
  id?: (prefix: "ses" | "msg") => string
}

const HISTORY = 50
const TITLE = 60

export function make(options: Options) {
  const now = options.now ?? Date.now
  const id = options.id ?? ascending
  const session = options.thread()?.id ?? id("ses")
  const [chat, setChat] = createSignal(ChatsDocument.empty(session))
  const [failure, setFailure] = createSignal<Failure>()
  const [chosen, setChosen] = createSignal<ModelRef>()
  const [made, setMade] = createSignal(options.thread() !== undefined)

  // The model a prompt goes with: the one chosen here, else the thread's, else the first the user may use.
  const model = (): ModelRef | undefined => {
    const first = options.models()[0]
    return chosen() ?? options.thread()?.model ?? (first ? { providerID: first.provider, id: first.id } : undefined)
  }

  const working = () => chat().status.type !== "idle"

  async function load() {
    const client = options.client()
    if (!client || !made()) return
    const page = await client.messages({ id: session, limit: HISTORY })
    if (isFailure(page)) return setFailure(page)
    setChat((current) => ChatsDocument.load(current, page.messages))
  }

  function event(value: unknown) {
    const before = chat()
    const after = ChatsDocument.event(before, value)
    setChat(after)
    // A reply ended: the history now holds its final parts and any prompt another device sent.
    if (before.status.type !== "idle" && after.status.type === "idle") void load()
  }

  /** Follows the thread's live events until `signal` aborts. */
  function follow(signal: AbortSignal) {
    const client = options.client()
    if (!client || !made()) return
    const stop = client.on("event", (value) => {
      if (value.thread === session) event(value.event)
    })
    signal.addEventListener("abort", stop, { once: true })
    void client.follow({ id: session, after: chat().seq }, { signal }).catch(() => undefined)
  }

  async function submit(text: string): Promise<boolean> {
    const client = options.client()
    if (!client) return false
    setFailure(undefined)
    if (!made()) {
      const created = await client.create({ id: session, title: titleOf(text), model: model() })
      if (isFailure(created)) {
        setFailure(created)
        return false
      }
      setMade(true)
      options.created?.(created)
    }
    const messageID = id("msg")
    setChat((current) => ChatsDocument.prompted(current, { id: messageID, text, created: now() }))
    const answer = await client.prompt({ id: session, messageID, text, model: model() })
    if (!isFailure(answer)) return true
    setFailure(answer)
    setChat((current) => ({
      ...current,
      messages: current.messages.filter((item) => item.id !== messageID),
      status: { type: "idle" },
    }))
    return false
  }

  async function stop() {
    const client = options.client()
    if (!client) return
    const answer = await client.interrupt({ id: session })
    if (answer) setFailure(answer)
  }

  async function choose(next: ModelRef) {
    setChosen(next)
    const client = options.client()
    if (!client || !made()) return
    const answer = await client.update({ id: session, model: next })
    if (isFailure(answer)) setFailure(answer)
  }

  return {
    id: session,
    made,
    chat,
    failure,
    working,
    model,
    document: () => ChatsDocument.document(chat()),
    load,
    follow,
    event,
    submit,
    stop,
    choose,
    /** The props of the app's chat composer. */
    composer: {
      get working() {
        return working()
      },
      get available() {
        return options.client() !== undefined
      },
      get models() {
        return options.models().map((item) => ({
          id: item.id,
          providerID: item.provider,
          name: item.name,
          provider: item.providerName,
        }))
      },
      get model() {
        return model()
      },
      onModel: (next: { providerID: string; id: string }) => void choose({ providerID: next.providerID, id: next.id }),
      onSubmit: submit,
      onStop: () => void stop(),
    },
  }
}

export type Chat = ReturnType<typeof make>

/** A new chat's title: the first line of its first prompt. */
export function titleOf(text: string) {
  const line = text.trim().split("\n", 1)[0] ?? ""
  return line.length > TITLE ? `${line.slice(0, TITLE - 1)}…` : line
}

// An id that sorts by creation, as OpenCode's do: the time, then randomness.
function ascending(prefix: "ses" | "msg") {
  const random = Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(16).padStart(2, "0"))
  return `${prefix}_${Date.now().toString(16).padStart(12, "0")}${random.join("")}`
}
