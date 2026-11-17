import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Queue } from "effect"
import { utf8 } from "../src/bytes"
import { Closed, Control, Keys, Presence, Remote } from "../src"

const to = new Uint8Array(16).fill(1)

describe("Control", () => {
  test("reads a relay control message's JSON body, and nothing that is not one", () => {
    const bytes = Control.encode(to, { t: "routines.changed" })
    expect(Presence.kind(bytes)).toBe("presence")
    expect(Presence.decode(bytes)).toBeUndefined()
    expect(Control.decode(bytes)).toEqual({ to, message: { t: "routines.changed" } })
    // Other keys of the body are kept as sent
    expect(Control.decode(Control.encode(to, { t: "chats.changed", chat: "c1" }))?.message).toEqual({
      t: "chats.changed",
      chat: "c1",
    })
    // A 34-byte hint ({"t":"x.changed"}) is not presence
    const short = Control.encode(to, { t: "x.changed" })
    expect(short.length).toBe(Presence.length)
    expect(Presence.decode(short)).toBeUndefined()
    expect(Control.decode(short)?.message).toEqual({ t: "x.changed" })

    const raw = (body: string) => new Uint8Array([0xff, ...to, ...utf8(body)])
    expect(Control.decode(raw("not json"))).toBeUndefined()
    expect(Control.decode(raw('{"t":1}'))).toBeUndefined()
    expect(Control.decode(raw("[]"))).toBeUndefined()
    expect(Control.decode(new Uint8Array([0xff, ...to, 0xc3]))).toBeUndefined()
    expect(Control.decode(new Uint8Array([0xff, ...to]))).toBeUndefined()
    expect(Control.decode(Presence.encode({ to, phone: new Uint8Array(16).fill(2), event: "connected" }))).toBeUndefined()
  })

  test("a desktop reports control messages addressed to it, apart from presence", async () => {
    const key = Keys.generate()
    const id = Keys.peerId(key.publicKey)
    const control: Control.Control[] = []
    const presence: boolean[] = []
    const desktop = new Remote.Desktop({
      staticKey: key,
      pairing: () => undefined,
      device: () => false,
      events: {
        control: (message) => control.push(message),
        presence: (_, online) => presence.push(online),
      },
    })
    const incoming = Effect.runSync(Queue.unbounded<Uint8Array, Closed>())
    const listening = Effect.runFork(desktop.listen({ send: () => {}, incoming }))
    const deliver = (bytes: Uint8Array) => Queue.offerUnsafe(incoming, bytes)
    deliver(Control.encode(id, { t: "routines.changed" }))
    deliver(Presence.encode({ to: id, phone: new Uint8Array(16).fill(2), event: "connected" }))
    // Addressed to another desktop, or not a control message: ignored
    deliver(Control.encode(new Uint8Array(16).fill(9), { t: "other.changed" }))
    deliver(new Uint8Array([0xff, ...id, ...utf8("garbage")]))
    deliver(Control.encode(id, { t: "chats.changed" }))
    await Bun.sleep(20)
    expect(control).toEqual([{ t: "routines.changed" }, { t: "chats.changed" }])
    expect(presence).toEqual([true])
    await Effect.runPromise(Fiber.interrupt(listening))
  })
})
