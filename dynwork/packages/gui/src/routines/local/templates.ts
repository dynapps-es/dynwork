export * as RoutinesTemplatesReader from "./templates"

import { Schema } from "effect"
import { Templates } from "../contract"
import type { Device } from "./backend"
import { PATH, type Account } from "./sync"

// The templates Governance offers the person (`GET /templates`, the plan's `docs/contract.md` §3), read in main with the
// same account and session as `./sync.ts`: on every pass of the sync, and at once on the relay's `templates.changed`
// hint. Each account keeps its own answer and `ETag`: a `304` keeps it, and another account's is never shown. Nothing is
// stored: until the first read answers, the local backend says the templates have not been read.

const decode = Schema.decodeUnknownOption(Templates)

export interface Options {
  /** The active, signed-in account, as the sync has it. */
  account: () => Account | undefined
  /** This computer, sent as `X-Dynwork-Peer` as the sync's requests are. */
  device: () => Device | undefined
  /** A new answer for the active account arrived. */
  changed: () => void
  fetch?: (input: string, init?: RequestInit) => Promise<Response>
}

export function make(options: Options) {
  const send = options.fetch ?? fetch
  const kept = new Map<string, { etag?: string; value: Templates }>()
  const life: { running?: Promise<void>; again: boolean } = { again: false }

  // One read at a time: a request while one runs makes one more read after it, as a hint may follow a publish it missed.
  function read(): Promise<void> {
    if (life.running) {
      life.again = true
      return life.running
    }
    const running = (async () => {
      do {
        life.again = false
        await once()
      } while (life.again)
    })().finally(() => {
      life.running = undefined
    })
    life.running = running
    return running
  }

  async function once() {
    const account = options.account()
    const device = options.device()
    if (!account || !device) return
    const token = await account.token().catch(() => undefined)
    if (token === undefined) return
    const etag = kept.get(account.id)?.etag
    const response = await send(`${account.url.replace(/\/+$/, "")}${PATH}/templates`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
        "x-dynwork-peer": device.id,
        ...(etag === undefined ? {} : { "if-none-match": etag }),
      },
    }).catch(() => undefined)
    // A `304`, Governance down, or one without templates yet (`404`): what was read stays.
    if (response?.status !== 200) return
    const answer = decode(await response.json().catch(() => undefined))
    if (answer._tag === "None") return
    kept.set(account.id, { etag: response.headers.get("etag") ?? undefined, value: answer.value })
    if (options.account()?.id === account.id) options.changed()
  }

  return {
    read,
    /** The active account's templates as last read; undefined while none has answered. */
    current: () => {
      const account = options.account()
      return account ? kept.get(account.id)?.value : undefined
    },
  }
}

export type Reader = ReturnType<typeof make>
