import { ChatsClient } from "../../src/chats/client"
import { ChatsFake } from "../../src/chats/fake"

/** Phase 03's recorded cloud reply will replace this hand-written one: OpenCode v2 events of one text reply. */
export const recorded = async () =>
  (await Bun.file(new URL("./cloud-reply.jsonl", import.meta.url)).text())
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as { type: string; durable: { seq: number }; data: Record<string, unknown> })

export const SESSION = "ses_01JCLOUDFIXTURE0000000001"

/** A JWT-shaped secret: the tests look for it in everything that crosses to a window. */
export const TOKEN = "eyJhbGciOiJFZERTQSJ9.chats-test-secret.c2lnbmF0dXJl"

/** A fake instance, and the main-process client of it for an active account whose token is `TOKEN`. */
export function instance(options: Partial<ChatsFake.Options> = {}) {
  const fake = ChatsFake.make({ token: () => TOKEN, ...options })
  const account = { id: "acc_1", url: "https://governance.test/", token: async () => TOKEN }
  const active = { current: account as typeof account | undefined }
  const client = ChatsClient.make({ account: () => active.current, fetch: fake.fetch })
  return { fake, client, active, account }
}

/** Lets pending promises and stream reads settle. */
export const settle = async (rounds = 20) => {
  for (const _ of Array.from({ length: rounds })) await new Promise((resolve) => setTimeout(resolve, 0))
}

/** Timers a test fires by hand: `fire(ms)` runs those due within `ms` from now. */
export function timers() {
  const due: { at: number; fire: () => void }[] = []
  const clock = { now: 0 }
  return {
    set: (fire: () => void, ms: number) => {
      const entry = { at: clock.now + ms, fire }
      due.push(entry)
      return () => {
        const index = due.indexOf(entry)
        if (index >= 0) due.splice(index, 1)
      }
    },
    pending: () => due.map((entry) => entry.at - clock.now),
    advance(ms: number) {
      clock.now += ms
      due
        .filter((entry) => entry.at <= clock.now)
        .forEach((entry) => {
          due.splice(due.indexOf(entry), 1)
          entry.fire()
        })
    },
  }
}
