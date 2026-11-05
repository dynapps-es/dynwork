import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { Keys } from "@dynwork/remote"
import { RemoteProxy } from "../../src/remote/proxy"
import { RemoteStore } from "../../src/remote/store"
import { fakeSecure } from "../accounts/fixture"
import {
  fakeRelay,
  fakeService,
  memoryStore,
  pairPhone,
  tunnel,
  until,
  type FakeRelay,
  type FakeService,
} from "./fixture"

const open: { relays: FakeRelay[]; service?: FakeService; dispose: (() => void)[] } = { relays: [], dispose: [] }

const world = (
  options: { store?: ReturnType<typeof memoryStore>; secure?: ReturnType<typeof fakeSecure>; now?: () => number } = {},
) => {
  const alpha = fakeRelay("alpha")
  const beta = fakeRelay("beta")
  const service = fakeService()
  open.relays.push(alpha, beta)
  open.service = service
  const made = tunnel({ relays: { alpha, beta }, service, ...options })
  open.dispose.push(made.remote.dispose)
  return { alpha, beta, service, ...made }
}

const connected = (relay: FakeRelay) => until(() => relay.state.desktops.length === 1)

const text = (stream: Stream.Stream<Uint8Array, unknown>) =>
  Effect.runPromise(
    stream.pipe(
      Stream.runCollect,
      Effect.map((chunks) => chunks.map((chunk) => new TextDecoder().decode(chunk)).join("")),
    ),
  )

afterEach(() => {
  open.dispose.splice(0).forEach((dispose) => dispose())
  open.relays.splice(0).forEach((relay) => relay.stop())
  open.service?.stop()
})

describe("the remote tunnel", () => {
  test("is off by default and opens nothing", async () => {
    const w = world()
    w.remote.update()
    await Bun.sleep(50)
    expect(w.remote.state()).toMatchObject({ enabled: false, confirmed: false, status: "off", phones: [] })
    expect(w.alpha.state.opened).toEqual([])
  })

  test("turned on, it opens the active instance's relay socket with the account's JWT and its peer id", async () => {
    const w = world()
    w.remote.setEnabled(true)
    await connected(w.alpha)
    await until(() => w.remote.state().status === "connected")
    expect(w.alpha.state.opened[0]?.authorization).toBe(`Bearer ${w.users.minted[0]}`)
    expect(w.alpha.state.opened[0]?.peer).toMatch(/^[0-9a-f]{32}$/)
    expect(w.remote.state()).toMatchObject({ enabled: true, confirmed: true, instance: "alpha" })
    expect(w.beta.state.opened).toEqual([])
  })

  test("the toggle and the desktop's key persist: a restart reconnects as the same peer", async () => {
    const store = memoryStore()
    const first = world({ store })
    first.remote.setEnabled(true)
    await connected(first.alpha)
    const peer = first.alpha.state.opened[0]?.peer
    first.remote.dispose()
    // The key is sealed in the store, never in the clear
    expect(store.disk.json).toContain('"keyCipher"')
    const again = tunnel({ relays: { alpha: first.alpha, beta: first.beta }, service: first.service, store })
    open.dispose.push(again.remote.dispose)
    again.remote.update()
    await until(() => first.alpha.state.opened.length === 2)
    expect(first.alpha.state.opened[1]?.peer).toBe(peer)
    expect(again.remote.state()).toMatchObject({ enabled: true, confirmed: true })
  })

  test("switching the active instance moves the tunnel", async () => {
    const w = world()
    w.remote.setEnabled(true)
    await connected(w.alpha)
    w.users.activate("beta")
    w.remote.update()
    await connected(w.beta)
    await until(() => w.alpha.state.desktops.length === 0)
    await until(() => w.remote.state().status === "connected")
    expect(w.remote.state().instance).toBe("beta")
  })

  test("signing out of the active instance stops the tunnel", async () => {
    const w = world()
    w.remote.setEnabled(true)
    await connected(w.alpha)
    w.users.signOut("alpha")
    w.remote.update()
    await until(() => w.alpha.state.desktops.length === 0)
    expect(w.remote.state().status).toBe("idle")
    await Bun.sleep(100)
    expect(w.alpha.state.opened.length).toBe(1)
  })

  test("turning it off closes the socket and ends the phones' sessions", async () => {
    const w = world()
    w.remote.setEnabled(true)
    await connected(w.alpha)
    const phone = await pairPhone(w.alpha, (await w.remote.pair()).qr)
    w.remote.setEnabled(false)
    await until(() => w.alpha.state.desktops.length === 0)
    await until(() => phone.peer.closed)
    expect(w.remote.state()).toMatchObject({ enabled: false, status: "off" })
  })

  test("a relay lifetime close (4000) reconnects at once", async () => {
    const w = world()
    w.remote.setEnabled(true)
    await connected(w.alpha)
    w.alpha.closeDesktops(4000)
    await until(() => w.alpha.state.opened.length === 2 && w.alpha.state.desktops.length === 1)
    await until(() => w.remote.state().status === "connected")
  })

  test("without a secure store it refuses to make a key", async () => {
    const w = world({ secure: fakeSecure(false) })
    w.remote.setEnabled(true)
    expect(w.remote.state()).toMatchObject({ status: "error", failure: "insecure" })
    expect(w.store.value.keyCipher).toBeUndefined()
  })

  test("pairs a phone from the QR: the relay token rides in it, the phone is stored, the QR goes away", async () => {
    const w = world()
    w.remote.setEnabled(true)
    await until(() => w.remote.state().status === "connected")
    const shown = await w.remote.pair()
    expect(w.remote.state().pairing?.qr).toBe(shown.qr)
    const phone = await pairPhone(w.alpha, shown.qr)
    expect(phone.pairing.relay).toMatch(/^dwp1_/)
    expect(phone.pairing.instance).toBe(w.alpha.url)
    await until(() => w.remote.state().phones.length === 1)
    expect(w.remote.state().pairing).toBeUndefined()
    await until(() => w.remote.state().phones[0]?.name === "Pixel")
    expect(w.remote.state().phones[0]).toMatchObject({
      id: phone.peerId,
      fingerprint: Keys.fingerprint(phone.phoneKey.publicKey),
    })
    expect(w.remote.state().audit.map((entry) => entry.event)).toContain("paired")
  })

  test("used pairing tokens are persisted as hashes and pruned once their pairing has expired", async () => {
    const clock = { now: Date.now() }
    const w = world({ now: () => clock.now })
    w.remote.setEnabled(true)
    await until(() => w.remote.state().status === "connected")
    const phone = await pairPhone(w.alpha, (await w.remote.pair()).qr)
    await until(() => w.store.value.tokens.length === 1)
    const stored = w.store.value.tokens[0]
    expect(stored?.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(w.store.disk.json).not.toContain(Buffer.from(phone.pairing.token).toString("base64url"))
    expect(stored?.expires).toBe(phone.pairing.expires)
    // Single use survives a restart: a new tunnel over the same store refuses the token
    const again = RemoteStore.tokens(w.store, () => clock.now)
    expect(again.used(phone.pairing.token)).toBe(true)
    expect(again.claim(phone.pairing.token, phone.pairing.expires)).toBe(false)
    // Once its pairing has expired, the next claim prunes it
    clock.now = phone.pairing.expires + 1
    expect(again.used(phone.pairing.token)).toBe(false)
    const other = crypto.getRandomValues(new Uint8Array(32))
    expect(again.claim(other, clock.now + 60_000)).toBe(true)
    expect(w.store.value.tokens.length).toBe(1)
    expect(w.store.value.tokens[0]?.hash).not.toBe(stored?.hash)
  })

  test("a paired phone reaches the service through the allowlist with its own session token, and nothing else", async () => {
    const w = world()
    w.remote.setEnabled(true)
    await until(() => w.remote.state().status === "connected")
    const phone = await pairPhone(w.alpha, (await w.remote.pair()).qr)
    const fetch = (method: string, path: string, headers?: Record<string, string>, body?: string) =>
      Effect.runPromise(
        phone.peer.mux.fetch({
          method,
          path,
          headers,
          body: body === undefined ? undefined : new TextEncoder().encode(body),
        }),
      )
    const sessions = await fetch("GET", "/api/session?directory=%2Fwork", {
      authorization: "Basic stolen",
      cookie: "a=b",
    })
    expect(sessions.status).toBe(200)
    expect(JSON.parse(await text(sessions.body))).toEqual([{ id: "ses_1", title: "Remote" }])
    const forwarded = w.service.state.requests.find((request) => request.path.startsWith("/api/session"))
    // The phone's own credentials never pass; the session token minted for the tunnel does, never the password
    expect(forwarded?.cookie).toBeNull()
    expect(forwarded?.authorization).not.toContain("stolen")
    const token = [...w.service.state.tokens][0] ?? ""
    expect(forwarded?.authorization).toBe(`Basic ${Buffer.from(`opencode:${token}`).toString("base64")}`)
    const prompt = await fetch(
      "POST",
      "/api/session/ses_1/prompt",
      { "content-type": "application/json" },
      '{"text":"hi"}',
    )
    expect(JSON.parse(await text(prompt.body))).toEqual({ received: '{"text":"hi"}' })
    // The token reaches the phone only inside the channel, at the desktop's own route
    const handed = await fetch("GET", RemoteProxy.tokenPath)
    expect(JSON.parse(await text(handed.body))).toEqual({ token })
    const before = w.service.state.requests.length
    for (const [method, path] of [
      ["POST", "/api/pty"],
      ["POST", "/api/session/ses_1/shell"],
      ["POST", "/api/experimental/fs/write"],
      ["GET", "/api/config"],
    ] as const)
      expect((await fetch(method, path)).status).toBe(403)
    expect(w.service.state.requests.length).toBe(before)
    // No WebSocket is proxied (terminals are WebSockets)
    const socket = await Effect.runPromise(Effect.flip(phone.peer.mux.websocket({ path: "/api/pty/pty_1/connect" })))
    expect(socket).toMatchObject({ code: "rejected:403" })
  })

  test("a service that does not answer is a 502", async () => {
    const w = world()
    w.remote.setEnabled(true)
    await until(() => w.remote.state().status === "connected")
    const phone = await pairPhone(w.alpha, (await w.remote.pair()).qr)
    w.service.stop()
    expect((await Effect.runPromise(phone.peer.mux.fetch({ method: "GET", path: "/api/session" }))).status).toBe(502)
  })

  test("the event stream flows, and response cookies stay behind", async () => {
    const w = world()
    w.remote.setEnabled(true)
    await until(() => w.remote.state().status === "connected")
    const phone = await pairPhone(w.alpha, (await w.remote.pair()).qr)
    const response = await Effect.runPromise(phone.peer.mux.fetch({ method: "GET", path: "/api/event" }))
    expect(response.headers["content-type"]).toBe("text/event-stream")
    expect(response.headers["set-cookie"]).toBeUndefined()
    const seen = { text: "" }
    await Effect.runPromise(
      response.body.pipe(
        Stream.runForEachWhile((chunk) =>
          Effect.sync(() => {
            seen.text += new TextDecoder().decode(chunk)
            return (seen.text.match(/data: tick/g) ?? []).length < 3
          }),
        ),
      ),
    )
    expect(seen.text.startsWith("data: first\n\n")).toBe(true)
    await Effect.runPromise(response.cancel)
  })

  test("presence marks the phone connected, drives the indicator, and logs it leaving", async () => {
    const w = world()
    w.remote.setEnabled(true)
    await until(() => w.remote.state().status === "connected")
    const phone = await pairPhone(w.alpha, (await w.remote.pair()).qr)
    await until(() => w.remote.state().phones[0]?.online === true)
    phone.link.close()
    await until(() => w.remote.state().phones[0]?.online === false)
    await until(() => w.remote.state().audit[0]?.event === "disconnected")
    expect(w.remote.state().audit[0]?.phone).toBe("Pixel")
  })

  test("revoking a phone closes its streams at once, on the relay too, and it cannot come back", async () => {
    const w = world()
    w.remote.setEnabled(true)
    await until(() => w.remote.state().status === "connected")
    const phone = await pairPhone(w.alpha, (await w.remote.pair()).qr)
    const events = await Effect.runPromise(phone.peer.mux.fetch({ method: "GET", path: "/api/event" }))
    const reading = Effect.runPromise(Effect.flip(Stream.runDrain(events.body)))
    await w.remote.revoke(phone.peerId)
    expect((await reading)._tag).toBe("Closed")
    expect(phone.peer.closed).toBe(true)
    expect(w.alpha.state.deleted.length).toBe(1)
    expect((await Effect.runPromise(phone.link.ended)).code).toBe(4003)
    expect(w.remote.state().phones).toEqual([])
    expect(w.remote.state().audit[0]?.event).toBe("revoked")
    expect(
      await phone.connect().then(
        () => "opened",
        (error: unknown) => error,
      ),
    ).toMatchObject({ reason: "refused" })
  })

  test("never logs or pushes a JWT, a pairing token, a credential, the service password or the session token", async () => {
    const w = world()
    w.remote.setEnabled(true)
    await until(() => w.remote.state().status === "connected")
    const phone = await pairPhone(w.alpha, (await w.remote.pair()).qr)
    await Effect.runPromise(phone.peer.mux.fetch({ method: "GET", path: "/api/session" }))
    // A relay refusal and a reconnect, so the failure paths log too
    w.alpha.state.refuse = 1
    w.alpha.closeDesktops(1011)
    await until(() => w.logs.some((line) => line.includes("did not open")))
    await until(() => w.remote.state().status === "connected")
    await w.remote.revoke(phone.peerId)
    const secrets = [
      ...w.users.minted,
      phone.pairing.relay ?? "",
      Buffer.from(phone.pairing.token).toString("base64url"),
      phone.credential,
      w.service.state.password,
      ...w.service.state.tokens,
    ]
    expect(secrets.length).toBeGreaterThan(5)
    expect(w.logs.length).toBeGreaterThan(3)
    const logged = w.logs.join("\n")
    expect(secrets.filter((secret) => logged.includes(secret))).toEqual([])
    // Windows see the QR while it shows (that is its purpose), and nothing else secret
    const pushed = w.pushed.join("\n")
    expect(
      [...w.users.minted, phone.credential, w.service.state.password, ...w.service.state.tokens].filter((secret) =>
        pushed.includes(secret),
      ),
    ).toEqual([])
    expect(JSON.stringify(w.remote.state())).not.toContain("dwp1_")
  })
})
