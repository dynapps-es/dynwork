export * as ChatsSync from "./sync"

import type { ChatsClient } from "./client"
import type { State, Status, Thread } from "./contract"

// The chats list in main, kept in step with the active instance (the plan's contract, "The change hint"):
//
// - Read: `GET /changes?since=<cursor>` to its end, at start, when the account changes, on the relay's `chats.changed`
//   hint (while remote control is connected), and every 30 s while a DynWork window has focus, every 5 minutes without
//   (as the live sync polls). Each page's rows replace the threads they name, and its tombstones drop them.
// - Writes made here apply their answer at once, so a window does not wait for the next read.
// - The open chat: `follow` reads `GET /threads/{id}/log?after=<seq>&follow=1` and hands each event over, once by its
//   durable seq, and reconnects after the last seq it handed over when the stream drops.
//
// The list is held in memory only: a launch shows it after the first read.

/** How often the feed is read while a window has focus. */
export const FOCUSED = 30_000
/** How often the feed is read while none has. */
export const BLURRED = 5 * 60_000
/** How long a dropped log stream waits before it reconnects. */
export const RECONNECT = 2_000

export interface Timers {
  set: (fire: () => void, ms: number) => () => void
}

export interface Options {
  client: ChatsClient.Client
  /** The active, signed-in account's id; undefined while there is none. */
  account: () => string | undefined
  /** The state changed: push it to the windows. */
  changed: () => void
  focused: boolean
  timers?: Timers
}

const real: Timers = {
  set: (fire, ms) => {
    const timer = setTimeout(fire, ms)
    return () => clearTimeout(timer)
  },
}

export function make(options: Options) {
  const timers = options.timers ?? real
  const life: {
    account?: string
    cursor?: string
    status: Status
    threads: Map<string, Thread>
    focused: boolean
    running?: Promise<void>
    again: boolean
    cancel?: () => void
    disposed: boolean
  } = {
    account: options.account(),
    status: options.account() === undefined ? "signed-out" : "loading",
    threads: new Map(),
    focused: options.focused,
    again: false,
    disposed: false,
  }

  function state(): State {
    return {
      status: life.status,
      threads: [...life.threads.values()].toSorted((a, b) => b.updated - a.updated || (a.id < b.id ? 1 : -1)),
    }
  }

  // One read at a time: asking while one runs makes one more after it.
  function pull(): Promise<void> {
    if (life.disposed) return Promise.resolve()
    if (life.running) {
      life.again = true
      return life.running
    }
    const running = (async () => {
      do {
        life.again = false
        await read()
      } while (life.again && !life.disposed)
    })().finally(() => {
      life.running = undefined
      arm()
    })
    life.running = running
    return running
  }

  function arm() {
    life.cancel?.()
    life.cancel = life.disposed ? undefined : timers.set(() => void pull(), life.focused ? FOCUSED : BLURRED)
  }

  async function read() {
    const account = options.account()
    if (account !== life.account) {
      life.account = account
      life.cursor = undefined
      life.threads = new Map()
      set(account === undefined ? "signed-out" : "loading")
    }
    if (account === undefined) return
    for (;;) {
      const page = await options.client.changes(life.cursor)
      if (options.account() !== account) return
      if ("code" in page) {
        // A cursor the instance no longer knows (its data was reset) starts over.
        if (page.code === "invalid" && life.cursor !== undefined) {
          life.cursor = undefined
          continue
        }
        return set(page.code === "signed-out" ? "signed-out" : "unreachable")
      }
      // The first page of a full read is the whole list: whatever it lacks is gone.
      if (life.cursor === undefined) life.threads = new Map()
      page.threads.forEach((thread) => life.threads.set(thread.id, thread))
      page.deleted.forEach((id) => life.threads.delete(id))
      life.cursor = page.cursor
      if (!page.more) break
    }
    life.status = "ready"
    options.changed()
  }

  function set(status: Status) {
    life.status = status
    options.changed()
  }

  return {
    state,
    pull,
    find: (id: string) => life.threads.get(id),
    /** A write answered this row. */
    apply(thread: Thread) {
      life.threads.set(thread.id, thread)
      options.changed()
    },
    drop(id: string) {
      if (life.threads.delete(id)) options.changed()
    },
    /** Focus moved: the next read is due at the new pace, and gaining focus reads at once. */
    focus(focused: boolean) {
      if (life.focused === focused) return
      life.focused = focused
      if (focused) return void pull()
      arm()
    },
    /**
     * Hands over each live event of the thread after `after`, until `signal` aborts. A dropped stream reconnects from
     * the last durable seq it handed over; an event it already handed over is not handed over again.
     */
    async follow(id: string, after: number | undefined, emit: (event: unknown) => void, signal: AbortSignal) {
      const last = { seq: after }
      while (!signal.aborted && !life.disposed) {
        const ended = await options.client.log(
          id,
          last.seq,
          (event) => {
            const seq = seqOf(event)
            if (seq !== undefined && last.seq !== undefined && seq <= last.seq) return
            if (seq !== undefined) last.seq = seq
            emit(event)
          },
          signal,
        )
        if (signal.aborted) return
        if (ended !== "ended" && (ended.code === "not-found" || ended.code === "signed-out")) return
        await new Promise<void>((resolve) => {
          const cancel = timers.set(resolve, RECONNECT)
          signal.addEventListener(
            "abort",
            () => {
              cancel()
              resolve()
            },
            { once: true },
          )
        })
      }
    },
    dispose() {
      life.disposed = true
      life.cancel?.()
    },
  }
}

export type Sync = ReturnType<typeof make>

function seqOf(event: unknown) {
  if (typeof event !== "object" || event === null || !("durable" in event)) return undefined
  const durable = event.durable
  if (typeof durable !== "object" || durable === null || !("seq" in durable)) return undefined
  return typeof durable.seq === "number" ? durable.seq : undefined
}
