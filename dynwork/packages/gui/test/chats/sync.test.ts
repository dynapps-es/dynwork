import { describe, expect, test } from "bun:test"
import { ChatsSync } from "../../src/chats/sync"
import { instance, settle, timers } from "./fixture"

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
})
