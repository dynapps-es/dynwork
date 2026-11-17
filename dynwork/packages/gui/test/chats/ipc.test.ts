import { describe, expect, test } from "bun:test"
import { isFailure } from "../../src/chats/contract"
import { settle, TOKEN } from "./fixture"
import { connect } from "./wire"

describe("the dynwork.chats Ipc", () => {
  test("no token crosses to a window: not in the state, the answers, the failures or the events", async () => {
    const { client, crossed, fake, active } = connect()
    await client.refresh()
    client.state()
    await client.models()
    const created = await client.create({
      id: "ses_a",
      title: "Secret-free",
      model: { providerID: "anthropic", id: "claude-sonnet-4" },
    })
    expect(isFailure(created)).toBe(false)
    await client.update({ id: "ses_a", title: "Renamed" })
    await client.messages({ id: "ses_a" })
    const following = new AbortController()
    const followed = client.follow({ id: "ses_a" }, { signal: following.signal })
    await client.prompt({ id: "ses_a", messageID: "msg_1", text: "Hello there" })
    fake.flush("ses_a", 2)
    await settle()
    await client.interrupt({ id: "ses_a" })
    await settle()
    following.abort()
    await followed
    await client.messages({ id: "ses_missing" })
    fake.down(true)
    await client.models()
    fake.down(false)
    active.current = { ...active.current!, token: async () => "refused" }
    await client.models()
    await client.remove({ id: "ses_a" })
    client.state()

    expect(crossed.length).toBeGreaterThan(10)
    expect(crossed.some((value) => value.includes("session.execution.interrupted"))).toBe(true)
    expect(crossed.filter((value) => value.includes(TOKEN) || /bearer/i.test(value))).toEqual([])
    // The instance did get it, on every request.
    expect(
      fake.requests.filter((request) => request.headers.authorization === `Bearer ${TOKEN}`).length,
    ).toBeGreaterThan(5)
  })

  test("creating, renaming, archiving and deleting update the state at once", async () => {
    const { client } = connect()
    await client.create({ id: "ses_a", title: "One" })
    expect(client.state()?.threads.map((thread) => thread.title)).toEqual(["One"])
    await client.update({ id: "ses_a", title: "Two", archived: true })
    expect(client.state()?.threads[0]).toMatchObject({ title: "Two", revision: 2 })
    expect(client.state()?.threads[0]?.archived).toBeNumber()
    expect(await client.remove({ id: "ses_a" })).toBeUndefined()
    expect(client.state()?.threads).toEqual([])
  })

  test("a write on a revision another device moved answers conflict and takes the instance's row", async () => {
    const { client, fake } = connect()
    await client.create({ id: "ses_a", title: "Mine" })
    fake.edit("ses_a", { title: "Theirs" })
    expect(await client.update({ id: "ses_a", title: "Mine again" })).toMatchObject({ code: "conflict" })
    expect(client.state()?.threads[0]).toMatchObject({ title: "Theirs", revision: 2 })
    expect(await client.update({ id: "ses_a", title: "Mine again" })).toMatchObject({
      title: "Mine again",
      revision: 3,
    })
  })

  test("a thread the list does not hold answers not-found without asking the instance", async () => {
    const { client, fake } = connect()
    expect(await client.update({ id: "ses_nope", title: "x" })).toMatchObject({ code: "not-found" })
    expect(fake.requests).toEqual([])
  })
})
