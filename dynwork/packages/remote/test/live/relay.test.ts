import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js"
import { Effect, Queue, Stream } from "effect"
import { utf8 } from "../../src/bytes"
import { Keys, Remote, Socket } from "../../src"
import {
  claim,
  createPairing,
  devices,
  envPath,
  fixedKey,
  hex,
  instance,
  jwt,
  pairNewPhone,
  phoneSocket,
  relayTraces,
  revoke,
  revokePhones,
  run,
  secrets,
  startDesktop,
  text,
  until,
  desktopSocket,
} from "./support"

// `@dynwork/remote` against the real relay: the systemprompt extension in the mobile sp-local project's image, alpha
// and beta. Phases 04 and 05 each proved their half against fakes; this is the two halves together.

const alpha = instance("alpha")
const beta = instance("beta")
const desktopKey = fixedKey("alpha-desktop")
// Unique per run, so a hit in the relay's traces can only come from this run
const canary = `dynwork-canary-${bytesToHex(randomBytes(12))}`

const state = {} as {
  token: string
  desktop: Awaited<ReturnType<typeof startDesktop>>
  phone: Awaited<ReturnType<typeof pairNewPhone>>
}

describe.skipIf(envPath === undefined)("the remote channel through the local relay", () => {
  beforeAll(async () => {
    state.token = await jwt(alpha)
    await revokePhones(alpha, state.token)
    state.desktop = await startDesktop(alpha, state.token, desktopKey)
  }, 60_000)

  afterAll(async () => {
    state.desktop?.stop()
    if (state.token) await revokePhones(alpha, state.token)
  })

  test("a phone pairs: the desktop mints the relay token, the phone claims it from the QR and completes the handshake", async () => {
    state.phone = await pairNewPhone(alpha, state.token, state.desktop, desktopKey, "Live phone")
    expect(state.phone.relayToken).toMatch(/^dwp1_[A-Za-z0-9_-]{43}$/)
    expect(state.phone.credential.startsWith("dwr1_")).toBe(true)
    await until(() => state.desktop.paired.has(hex(state.phone.phoneKey.publicKey)))
    // The pairing is single use, on the relay as on the desktop
    expect(state.desktop.shown.pairing).toBeUndefined()
    const again = await claim(alpha, { token: state.phone.relayToken, peer_id: hex(randomBytes(16)), name: "Thief" })
    expect([again.status, again.error]).toEqual([410, "pairing_used"])
    const listed = (await devices(alpha, state.token)).find((device) => device.id === state.phone.deviceId)
    expect(listed).toMatchObject({ kind: "phone", peer_id: state.phone.peerId, name: "Live phone", online: true })
  }, 60_000)

  test("an HTTP request makes the round trip", async () => {
    const hello = await run(state.phone.peer.mux.fetch({ method: "GET", path: "/hello" }))
    expect([hello.status, await run(text(hello.body))]).toEqual([200, "hello GET"])
    const body = utf8(`${canary} in a body`)
    const echo = await run(
      state.phone.peer.mux.fetch({ method: "POST", path: `/echo?q=${canary}`, headers: { "x-canary": canary }, body }),
    )
    expect(echo.headers["x-echo"]).toBe(canary)
    expect(await run(text(echo.body))).toBe(`${canary} in a body`)
    expect(state.desktop.seen).toContain(canary)
  }, 30_000)

  test("an SSE stream arrives whole and in order", async () => {
    const response = await run(state.phone.peer.mux.fetch({ method: "GET", path: "/events?count=2000" }))
    expect(response.headers["content-type"]).toBe("text/event-stream")
    const events = (await run(text(response.body))).split("\n\n").filter(Boolean)
    expect(events.length).toBe(2000)
    expect(events[0]).toBe("data: 000001")
    expect(events.at(-1)).toBe("data: 002000")
  }, 60_000)

  test("a WebSocket echoes text and binary messages", async () => {
    const echoed = await run(
      Effect.gen(function* () {
        const socket = yield* state.phone.peer.mux.websocket({ path: "/ws", protocols: ["dynwork.v1"] })
        const binary = new Uint8Array(100_000).fill(9)
        yield* socket.send(`${canary} over a socket`)
        yield* socket.send(binary)
        const messages = yield* socket.messages.pipe(Stream.take(2), Stream.runCollect)
        yield* socket.close
        return { protocol: socket.protocol, messages: [...messages] }
      }),
    )
    expect(echoed.protocol).toBe("dynwork.v1")
    expect(echoed.messages[0]).toBe(`${canary} over a socket`)
    expect((echoed.messages[1] as Uint8Array).length).toBe(100_000)
  }, 30_000)

  test("presence tells the desktop when the phone leaves and comes back, and the phone resumes its session", async () => {
    const session = state.phone.peer.session.id
    const before = state.desktop.presence.length
    state.phone.link.current.close()
    await until(() =>
      state.desktop.presence.slice(before).some((event) => event.phone === state.phone.peerId && !event.online),
    )
    const resumed = await state.phone.reconnect()
    expect(resumed).toBe(state.phone.peer)
    expect(state.phone.peer.session.id).toBe(session)
    await until(() =>
      state.desktop.presence.slice(before).some((event) => event.phone === state.phone.peerId && event.online),
    )
    const hello = await run(state.phone.peer.mux.fetch({ method: "GET", path: "/hello" }))
    expect(await run(text(hello.body))).toBe("hello GET")
  }, 60_000)

  test("the desktop reconnects to the relay and the phone resumes over it", async () => {
    const session = state.phone.peer.session.id
    state.desktop.link.current.close()
    await run(state.desktop.link.current.ended)
    await state.desktop.reconnect()
    // Attaching, the desktop hears of every phone already online
    await until(() => state.desktop.presence.some((event) => event.phone === state.phone.peerId && event.online))
    state.phone.link.current.close()
    await state.phone.reconnect()
    expect(state.phone.peer.session.id).toBe(session)
    const echo = await run(state.phone.peer.mux.fetch({ method: "POST", path: "/echo", body: utf8("after") }))
    expect(await run(text(echo.body))).toBe("after")
  }, 60_000)

  test("a revoked phone is cut off at once, its streams end, and it cannot come back", async () => {
    const phone = await pairNewPhone(alpha, state.token, state.desktop, desktopKey, "Revoked phone")
    const stream = await run(phone.peer.mux.fetch({ method: "GET", path: "/hello" }))
    expect(stream.status).toBe(200)
    // The desktop's half: the key is no longer a device, and its sessions close
    state.desktop.paired.delete(hex(phone.phoneKey.publicKey))
    await run(state.desktop.desktop.revoke(phone.phoneKey.publicKey))
    const after = await run(Effect.flip(phone.peer.mux.fetch({ method: "GET", path: "/hello" })))
    expect(after._tag).toBe("Closed")
    // The relay's half: the device row goes, its socket is closed with 4003 and the credential no longer opens one
    expect(await revoke(alpha, state.token, phone.deviceId)).toBe(204)
    expect((await run(phone.link.current.ended)).code).toBe(4003)
    const refused = await run(Effect.flip(phoneSocket(alpha, phone.credential)))
    expect(refused.reason).toBe("refused")
    expect((await devices(alpha, state.token)).some((device) => device.id === phone.deviceId)).toBe(false)
  }, 60_000)

  test("a phone paired on alpha cannot reach a desktop on beta", async () => {
    const betaToken = await jwt(beta)
    const betaKey = fixedKey("beta-desktop")
    const betaLink = await run(desktopSocket(beta, betaToken, betaKey))
    try {
      // Alpha's credential opens no socket on beta, and alpha's pairing token is unknown there
      expect((await run(Effect.flip(phoneSocket(beta, state.phone.credential)))).reason).toBe("refused")
      const minted = await createPairing(alpha, state.token)
      const stolen = await claim(beta, { token: minted.token, peer_id: hex(randomBytes(16)), name: "Cross" })
      expect([stolen.status, stolen.error]).toEqual([410, "pairing_unknown"])
      // Addressed to beta's desktop from alpha, the handshake goes nowhere: beta's socket receives nothing
      const attempt = await run(phoneSocket(alpha, state.phone.credential))
      const outcome = await run(
        Remote.reconnectPhone({ link: attempt, staticKey: state.phone.phoneKey, desktopKey: betaKey.publicKey }).pipe(
          Effect.timeoutOption("3 seconds"),
        ),
      )
      expect(outcome._tag).toBe("None")
      expect(Queue.sizeUnsafe(betaLink.incoming)).toBe(0)
      attempt.close()
      // Spend the open pairing so runs do not pile up open pairings (five at most)
      const spent = await claim(alpha, { token: minted.token, peer_id: hex(randomBytes(16)), name: "Spent" })
      expect(spent.status).toBe(201)
      await revokePhones(alpha, state.token)
      // The revoke above took the live phone too; pair it again for the scan below
      state.desktop.paired.clear()
      state.phone = await pairNewPhone(alpha, state.token, state.desktop, desktopKey, "Live phone")
    } finally {
      betaLink.close()
      await revokePhones(beta, betaToken)
    }
  }, 60_000)

  test("no plaintext, token or credential reaches the relay's database or logs", async () => {
    // One more pass of the canary through each kind of stream, then read everything the relay keeps
    const echo = await run(
      state.phone.peer.mux.fetch({
        method: "POST",
        path: `/echo?q=${canary}`,
        headers: { "x-canary": canary },
        body: utf8(canary),
      }),
    )
    expect(await run(text(echo.body))).toBe(canary)
    const traces = await relayTraces("alpha")
    expect(traces.length).toBeGreaterThan(10_000)
    // The dump does hold the relay's tables: the scan reads the right database
    expect(traces).toContain("dynwork_relay_devices")
    expect(traces.includes(canary)).toBe(false)
    const leaked = secrets.filter((secret) => traces.includes(secret))
    expect(leaked.length).toBe(0)
    expect(secrets.length).toBeGreaterThan(5)
  }, 60_000)

  test("a socket without a valid credential is refused before the upgrade", async () => {
    const forged = await run(Effect.flip(phoneSocket(alpha, `dwr1_${"A".repeat(43)}`)))
    expect(forged.reason).toBe("refused")
    const anonymous = await run(Effect.flip(Socket.link(new WebSocket(Socket.url(alpha.base, "desktop")))))
    expect(anonymous.reason).toBe("refused")
    expect(Keys.peerId(desktopKey.publicKey).length).toBe(16)
  }, 30_000)
})
