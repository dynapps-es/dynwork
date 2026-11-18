export * as ChatsIpc from "./ipc"

import type { IpcImpl } from "@opencode/plugin/gui/main"
import { ChatsClient } from "./client"
import type { Chats, Event, Failure, Thread } from "./contract"
import type { ChatsSync } from "./sync"

/** How main tells windows what changed. */
export interface Notify {
  /** A live event of a followed thread: the provider's `emit("event", event)`. */
  event(event: Event): void
}

/**
 * The `dynwork.chats` Ipc over the instance's client and the list in main.
 * - `state` is the list as main holds it; `changed` pushes it.
 * - A call that rejects answers a `failed` failure without its message, which might name what a window must not see.
 * - `follow` holds a window's call open and sends that thread's live events as `event`s until the window aborts it.
 */
export function implementation(
  client: ChatsClient.Client,
  sync: ChatsSync.Sync,
  notify: Notify,
  now: () => number = Date.now,
): IpcImpl<(typeof Chats)["spec"]> {
  // The thread a write is about, or the failure that says it is not known here.
  function known(id: string): Thread | Failure {
    return sync.find(id) ?? ChatsClient.fail("not-found", "This chat is not in the list.")
  }

  return {
    state: () => sync.state(),
    refresh: () => sync.pull(),
    models: () => guard(() => client.models()),
    create: (input) =>
      guard(async () => {
        const answer = await client.put(input.id, { title: input.title, model: input.model }, undefined)
        if ("code" in answer) return answer
        const thread = answer.thread ?? {
          id: input.id,
          title: input.title,
          ...(input.model ? { model: input.model } : {}),
          revision: answer.revision,
          created: now(),
          updated: now(),
        }
        sync.apply(thread)
        return thread
      }),
    update: (input) =>
      guard(async () => {
        const thread = known(input.id)
        if ("code" in thread) return thread
        const answer = await client.put(
          input.id,
          { title: input.title, model: input.model, archived: input.archived },
          thread.revision,
        )
        if ("code" in answer) {
          if (answer.current) sync.apply(answer.current)
          return { code: answer.code, message: answer.message, retryable: answer.retryable }
        }
        const archived = input.archived === undefined ? thread.archived : input.archived ? now() : undefined
        const model = input.model ?? thread.model
        const next: Thread = answer.thread ?? {
          id: thread.id,
          title: input.title ?? thread.title,
          ...(model ? { model } : {}),
          revision: answer.revision,
          ...(archived === undefined ? {} : { archived }),
          created: thread.created,
          updated: now(),
        }
        sync.apply(next)
        return next
      }),
    remove: (input) =>
      guard(async () => {
        const thread = known(input.id)
        if ("code" in thread) return thread
        const failure = await client.remove(input.id, thread.revision)
        if (failure?.code === "conflict") void sync.pull()
        if (!failure) sync.drop(input.id)
        return failure
      }),
    messages: (input) => guard(() => client.messages(input.id, { before: input.before, limit: input.limit })),
    prompt: (input) =>
      guard(async () => {
        const answer = await client.prompt(input.id, {
          messageID: input.messageID,
          text: input.text,
          model: input.model,
        })
        // The thread moved up and its revision changed: read the feed rather than guess the row.
        if (!("code" in answer)) void sync.pull()
        return answer
      }),
    interrupt: (input) => guard(() => client.interrupt(input.id)),
    follow: (input, caller) =>
      sync
        .follow(
          input.id,
          input.after,
          (event) => notify.event({ thread: input.id, event: event as Event["event"] }),
          caller.signal,
        )
        .catch(() => undefined),
  }
}

// The one place a rejection is caught: the client answers failures as data, so a rejection is a bug, and its message
// is not passed on.
function guard<A>(call: () => Promise<A>): Promise<A | Failure> {
  return Promise.resolve()
    .then(call)
    .catch(() => ChatsClient.fail("failed", "The chats service did not answer."))
}
