import { describe, expect, test } from "bun:test"
import { ChatsSync } from "../../src/chats/sync"
import { ChatsClient } from "../../src/chats/client"
import { ChatsDocument } from "../../src/chats/document"
import { instance, RECORDED_TEXT, recorded, SESSION, settle, timers } from "./fixture"

function setup() {
  const world = instance()
  const clock = timers()
  const pushes = { count: 0 }
  const sync = ChatsSync.make({
    client: world.client,
    account: () => world.active.current?.id,
    changed: () => void pushes.count++,
    focused: true,
    timers: clock,
  })
  return { ...world, clock, pushes, sync }
}

describe("the chats list in main", () => {
  test("a poll applies the feed: new threads, renames and tombstones from another device", async () => {
    const { fake, client, sync } = setup()
    await client.put("ses_a", { title: "First" }, undefined)
    await client.put("ses_b", { title: "Second" }, undefined)
    await sync.pull()
    expect(sync.state().status).toBe("ready")
    expect(
      sync
        .state()
        .threads.map((thread) => thread.title)
        .toSorted(),
    ).toEqual(["First", "Second"])

    fake.edit("ses_a", { deleted: true })
    fake.edit("ses_b", { title: "Renamed elsewhere" })
    await sync.pull()
    expect(sync.state().threads.map((thread) => [thread.id, thread.title])).toEqual([["ses_b", "Renamed elsewhere"]])
    // Only the changes since the cursor were asked for.
    expect(
      fake.requests.filter((request) => request.path.startsWith("/changes")).map((request) => request.path),
    ).toEqual(["/changes", "/changes?since=2"])
  })

  test("reads every 30 s with focus and every 5 minutes without; gaining focus reads at once", async () => {
    const { fake, clock, sync } = setup()
    await sync.pull()
    expect(clock.pending()).toEqual([ChatsSync.FOCUSED])
    sync.focus(false)
    expect(clock.pending()).toEqual([ChatsSync.BLURRED])
    const reads = () => fake.requests.filter((request) => request.path.startsWith("/changes")).length
    const before = reads()
    clock.advance(ChatsSync.FOCUSED)
    await settle()
    expect(reads()).toBe(before)
    clock.advance(ChatsSync.BLURRED - ChatsSync.FOCUSED)
    await settle()
    expect(reads()).toBe(before + 1)
    sync.focus(true)
    await settle()
    expect(reads()).toBe(before + 2)
    expect(clock.pending()).toEqual([ChatsSync.FOCUSED])
  })

  test("signing out empties the list; an instance that does not answer keeps the last one", async () => {
    const { fake, client, active, sync } = setup()
    await client.put("ses_a", { title: "Kept" }, undefined)
    await sync.pull()
    fake.down(true)
    await sync.pull()
    expect(sync.state()).toMatchObject({ status: "unreachable", threads: [{ id: "ses_a" }] })
    fake.down(false)
    active.current = undefined
    await sync.pull()
    expect(sync.state()).toEqual({ status: "signed-out", threads: [] })
  })

  test("following a thread resumes after a dropped stream from the last seq, without repeating an event", async () => {
    const { fake, client, sync, clock } = setup()
    await client.put("ses_a", { title: "Live" }, undefined)
    await client.prompt("ses_a", { messageID: "msg_1", text: "Hello there" })
    const seen: number[] = []
    const stop = new AbortController()
    const following = sync.follow(
      "ses_a",
      undefined,
      (event) => seen.push((event as { durable: { seq: number } }).durable.seq),
      stop.signal,
    )
    fake.flush("ses_a", 3)
    await settle()
    fake.drop()
    await settle()
    fake.flush("ses_a")
    clock.advance(ChatsSync.RECONNECT)
    await settle()
    fake.finish("ses_a")
    await settle()
    stop.abort()
    await following
    expect(seen).toEqual(fake.log("ses_a").map((event) => event.durable.seq))
    expect(fake.requests.filter((request) => request.path.includes("/log")).map((request) => request.path)).toEqual([
      "/threads/ses_a/log?follow=1",
      "/threads/ses_a/log?follow=1&after=4",
    ])
  })

  test("a drop mid-reply resumes after the last delta of the recorded reply: the text is never doubled", async () => {
    // The instance sends a delta with no `durable`, only the SSE id (its seq in the thread): the fixture's events, in
    // order, are seq 1, 2, ... (the deltas and the usage event hold 5-7 and 10).
    const events = await recorded()
    const run = async (cut: number | undefined) => {
      const requests: string[] = []
      const dropped = { done: cut === undefined }
      const fetch = (async (input: Request | URL | string) => {
        const url = new URL(String(input))
        requests.push(`${url.pathname}${url.search}`)
        const after = Number(url.searchParams.get("after") ?? 0)
        const slice = events.map((event, index) => ({ event, seq: index + 1 })).filter((item) => item.seq > after)
        const sent = dropped.done ? slice : slice.slice(0, cut)
        dropped.done = true
        const encoder = new TextEncoder()
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            sent.forEach((item) =>
              controller.enqueue(
                encoder.encode(`id: ${item.seq}\nevent: message\ndata: ${JSON.stringify(item.event)}\n\n`),
              ),
            )
            controller.close()
          },
        })
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
      }) as typeof globalThis.fetch
      const client = ChatsClient.make({
        account: () => ({ id: "acc_1", url: "https://governance.test/", token: async () => "t" }),
        fetch,
      })
      const clock = timers()
      const sync = ChatsSync.make({
        client,
        account: () => "acc_1",
        changed: () => undefined,
        focused: true,
        timers: clock,
      })
      const chat = { current: ChatsDocument.empty(SESSION) }
      const texts: string[] = []
      const stop = new AbortController()
      const following = sync.follow(
        SESSION,
        undefined,
        (event) => {
          chat.current = ChatsDocument.event(chat.current, event)
          texts.push(ChatsDocument.reply(chat.current))
        },
        stop.signal,
      )
      await settle()
      clock.advance(ChatsSync.RECONNECT)
      await settle()
      stop.abort()
      await following
      return { texts, requests, chat: chat.current }
    }
    const whole = await run(undefined)
    // Cut after the second delta (6 events: created, started, step, text started, two deltas).
    const cut = await run(6)
    expect(whole.chat.status).toEqual({ type: "idle" })
    expect(ChatsDocument.reply(whole.chat)).toBe(RECORDED_TEXT)
    // The final text and every intermediate text equal an uninterrupted run's.
    expect(ChatsDocument.reply(cut.chat)).toBe(RECORDED_TEXT)
    expect(cut.texts).toEqual(whole.texts)
    expect(cut.chat.messages).toEqual(whole.chat.messages)
    // It resumed after the second delta (seq 6), not after the last durable event (seq 4).
    expect(cut.requests).toEqual([
      "/api/dynwork/chats/v1/threads/" + SESSION + "/log?follow=1",
      "/api/dynwork/chats/v1/threads/" + SESSION + "/log?follow=1&after=6",
    ])
  })
})
